import { ensureDir } from "https://deno.land/std@0.142.0/fs/mod.ts";
import { serveFile } from "https://deno.land/std@0.142.0/http/file_server.ts";
import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { join } from "https://deno.land/std@0.142.0/path/mod.ts";
import { Database } from "https://denopkg.com/canac/AloeDB@0.9.1/mod.ts";
import {
  Cron,
  IntervalBasedCronScheduler,
  parseCronExpression,
} from "https://cdn.skypack.dev/cron-schedule@3.0.6?dts";
import { sleep } from "https://deno.land/x/sleep@v1.2.1/mod.ts";
import { Mailbox } from "./mailbox.ts";
import { handleFsError, logStderr, writeAllString } from "./util.ts";

export type ScheduleOptions = {
  makeUpMissedRuns: number | "all";
};

type RunStatusEntry = {
  id: string;
  name: string;
  timestamp: number;
  statusCode?: number; // undefined while the command is running
};

// Represents either a startup job or a scheduled job
type Job =
  & {
    // The name of the job
    name: string;

    // The shell command that this job executes
    command: string;

    // The path of the log file that command output will be written to
    logFile: string;

    // The process of this job if it is currently running
    process: Deno.Process | undefined;

    // Signal to terminate the execution of the job
    abortSignal: AbortSignal;
  }
  & ({
    type: "startup";
  } | {
    type: "scheduled";

    // The job scheduler
    schedule: Cron;

    // The job's task ID
    schedulerTaskId: number;
  });

export class ChronService {
  #chronDir: string;
  #logDir: string;
  #port: number | undefined;

  #statusDb: Database<RunStatusEntry>;
  #jobs = new Map<string, Job>();
  #abortController = new AbortController();
  #scheduler = new IntervalBasedCronScheduler(1000);
  #mailbox: Mailbox;

  // `port` is the port that the HTTP server will listen on, or null to not start the server
  // `chronDir` is the directory to store data and logs, defaulting to the current directory
  constructor(options: { port?: number; chronDir?: string } = {}) {
    this.#chronDir = options.chronDir ?? ".";
    this.#logDir = join(this.#chronDir, "logs");
    this.#statusDb = new Database<RunStatusEntry>(
      join(this.#chronDir, "jobStatus.json"),
    );
    this.#mailbox = new Mailbox(this.#chronDir);

    this.#port = options.port;
    if (typeof this.#port !== "undefined") {
      serve((req) => this.#httpHandler(req), {
        port: this.#port,
        onListen: undefined,
      });
    }
  }

  // Register a job to run on startup
  async startup(
    name: string,
    command: string,
  ) {
    this.#validateName(name);

    // Save the current abort controller
    const abortController = this.#abortController;

    const job: Job = {
      type: "startup",
      name,
      command,
      logFile: join(this.#logDir, `${name}.log`),
      process: undefined,
      abortSignal: abortController.signal,
    };
    this.#jobs.set(name, job);

    // Re-run the job if it ever fails
    while (true) {
      if (abortController.signal.aborted) {
        break;
      }

      await this.#executeJob(job);

      // Wait a few seconds before running again
      await sleep(5);
    }
  }

  // Register a job to run on a certain schedule
  async schedule(
    name: string,
    schedule: string,
    command: string,
    options: ScheduleOptions,
  ) {
    this.#validateName(name);

    // Save the current abort controller
    const abortController = this.#abortController;

    const cronSchedule = parseCronExpression(schedule);
    const schedulerTaskId = this.#scheduler.registerTask(
      cronSchedule,
      () => this.#executeJob(job),
    );
    const job: Job = {
      type: "scheduled",
      name,
      command,
      logFile: join(this.#logDir, `${name}.log`),
      process: undefined,
      abortSignal: abortController.signal,
      schedule: cronSchedule,
      schedulerTaskId,
    };
    this.#jobs.set(name, job);

    // Count how many runs have been missed
    // If the job hasn't run before, then 0 runs have been missed
    let missedRuns: number = 0;
    const lastRunTime = (await this.#getLastRuns(name))[0]?.timestamp;
    if (typeof lastRunTime !== "undefined") {
      // Starting with the last run time, the number of runs it takes to get to
      // a future time is the number of missed runs
      const now = Date.now();
      const runs = cronSchedule.getNextDatesIterator(new Date(lastRunTime));
      for (const nextRun of runs) {
        if (nextRun.getTime() > now) {
          break;
        }

        ++missedRuns;
      }
    }

    // Make up the missed runs, maxing out at makeUpMissedRuns if it is a
    // number or no max if it is the string "all"
    const makeUpRuns = options.makeUpMissedRuns === "all"
      ? missedRuns
      : Math.min(missedRuns, options.makeUpMissedRuns);
    if (makeUpRuns > 0) {
      await logStderr(
        `Making up ${makeUpRuns} of ${missedRuns} missed runs for ${name}\n`,
      );
    }
    for (let run = 0; run < makeUpRuns; ++run) {
      await this.#executeJob(job);
    }
  }

  // Stop and remove all jobs
  reset() {
    this.#abortController.abort();
    this.#jobs.forEach((job) => {
      if (job.type === "scheduled") {
        this.#scheduler.unregisterTask(job.schedulerTaskId);
      }
    });
    this.#jobs.clear();

    // All future jobs will be linked to a new abort controller
    this.#abortController = new AbortController();
  }

  // Helper function to execute a command with the environment and logging configured
  async #executeJob(job: Job) {
    if (job.abortSignal.aborted) {
      // Abort because the job is already marked as aborted
      return;
    }

    const startTime = new Date();

    await logStderr(
      `${startTime.toISOString()} Running ${job.name}: ${job.command}\n`,
    );

    // Record the run in the database
    const id = crypto.randomUUID();
    await this.#statusDb.insertOne({
      id,
      name: job.name,
      timestamp: startTime.getTime(),
    });

    // Open the log file and write the header
    await ensureDir(this.#logDir);
    const logFile = await Deno.open(
      job.logFile,
      { append: true, create: true },
    );
    const divider = "-".repeat(80);
    await writeAllString(logFile, `${startTime.toString()}\n${divider}\n`);

    // Run the shell command and clone the log file after the it completes
    const env = this.#port
      ? {
        CHRON_MAILBOX_URL: `http://0.0.0.0:${this.#port}/mailbox/${job.name}`,
      }
      : undefined;
    const process = Deno.run({
      cmd: ["sh", "-c", job.command],
      stdout: logFile.rid,
      stderr: logFile.rid,
      env,
    });
    job.process = process;
    const onAbort = () => {
      process.kill("SIGTERM");
    };
    job.abortSignal.addEventListener("abort", onAbort);
    const status = await process.status();
    job.abortSignal.removeEventListener("abort", onAbort);
    job.process = undefined;

    // Update the run status with the command's status code
    await this.#statusDb.updateOne({ id }, { statusCode: status.code });

    if (!status.success) {
      // Post failures to the @errors mailbox
      this.#mailbox.addMessage(
        "@errors",
        `${job.name} failed with status code ${status.code}`,
      );
    }

    // Write the log file footer and close the log file
    await writeAllString(logFile, `${divider}\nStatus: ${status.code}\n\n`);
    Deno.close(logFile.rid);
  }

  // Throw an exception if the provided name is a valid job name
  // It must be in kebab case
  #validateName(name: string): void {
    if (name.length === 0 || !/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(name)) {
      throw new Error("Invalid job name");
    }

    if (this.#jobs.has(name)) {
      throw new Error("A job with this name already exists");
    }
  }

  // Return the most recent runs of a particular job
  async #getLastRuns(job: string): Promise<RunStatusEntry[]> {
    const runs = (await this.#statusDb.findMany({ name: job }));
    runs
      .sort((
        r1,
        r2,
      ) => r2.timestamp - r1.timestamp);
    return runs;
  }

  // Handle HTTP requests
  async #httpHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json(
        Array.from(this.#jobs.values()).map((job) => ({
          name: job.name,
          running: Boolean(job.process),
        })),
      );
    }

    const pattern = new URLPattern({ pathname: "/:job/:command" });
    const matches = pattern.exec(req.url);
    if (!matches) {
      return new Response("Bad Request", { status: 400 });
    }

    const jobName = matches.pathname.groups.job;
    const job = typeof jobName !== "undefined" && this.#jobs.get(jobName);
    if (!job) {
      return new Response("Not Found", { status: 404 });
    }

    const { command } = matches.pathname.groups;
    if (command === "status") {
      if (req.method === "GET") {
        // Find the job's most recent three runs
        const recentRuns = (await this.#getLastRuns(job.name)).slice(0, 3).map((
          { timestamp, statusCode },
        ) => ({
          timestamp: new Date(timestamp).toISOString(),
          statusCode,
        }));
        return Response.json({
          name: job.name,
          type: job.type,
          runs: recentRuns,
          nextRun: job.type === "scheduled"
            ? job.schedule.getNextDate().toISOString()
            : undefined,
          pid: job.process?.pid,
        });
      }

      return new Response("Invalid Method", { status: 405 });
    } else if (command === "logs") {
      if (req.method === "GET") {
        return serveFile(req, job.logFile).catch(handleFsError);
      } else if (req.method === "DELETE") {
        return Deno.remove(job.logFile)
          .then(() => new Response("Deleted log file"))
          .catch(handleFsError);
      }

      return new Response("Invalid Method", { status: 405 });
    } else if (command === "mailbox") {
      if (req.method === "GET") {
        return Response.json(await this.#mailbox.getMessages(job.name));
      } else if (req.method === "POST") {
        return Response.json(
          await this.#mailbox.addMessage(job.name, await req.text()),
        );
      } else if (req.method === "DELETE") {
        return Response.json(await this.#mailbox.clearMessages(job.name));
      }

      return new Response("Invalid Method", { status: 405 });
    } else if (command === "terminate") {
      if (req.method === "POST") {
        if (job.process) {
          job.process.kill("SIGTERM");
          return new Response("Terminated job");
        } else {
          return new Response("Job not running");
        }
      }

      return new Response("Invalid Method", { status: 405 });
    }

    return new Response("Bad Request", { status: 400 });
  }
}
