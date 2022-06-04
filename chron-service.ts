import { ensureDir } from "https://deno.land/std@0.142.0/fs/mod.ts";
import { serveFile } from "https://deno.land/std@0.142.0/http/file_server.ts";
import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { join } from "https://deno.land/std@0.142.0/path/mod.ts";
import { writeAll } from "https://deno.land/std@0.142.0/streams/conversion.ts";
import { Database } from "https://denopkg.com/canac/AloeDB@0.9.1/mod.ts";
import { Cron } from "https://deno.land/x/croner@4.2.0/src/croner.js";
import { sleep } from "https://deno.land/x/sleep@v1.2.1/mod.ts";
import { Mailbox } from "./mailbox.ts";

type RunStatusEntry = {
  id: string;
  name: string;
  timestamp: number;
  statusCode?: number; // undefined while the command is running
};

// Helper for returning a response for filesystem errors
function handleFsError(err: unknown): Response {
  if (err instanceof Deno.errors.NotFound) {
    return new Response("Not Found", {
      status: 404,
    });
  } else {
    return new Response(
      err instanceof Error ? err.toString() : "Unknown error",
      { status: 500 },
    );
  }
}

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
  }
  & ({
    type: "startup";
  } | {
    type: "scheduled";

    // The job scheduler
    schedule: Cron;
  });

export class ChronService {
  #chronDir: string;
  #logDir: string;
  #port: number | undefined;

  #statusDb: Database<RunStatusEntry>;
  #jobs = new Map<string, Job>();
  #mailbox: Mailbox;

  // `port` is the port that the HTTP server will listen on, or null to not start the server
  // `chronDir` is the directory to store data and logs, defaulting to the current directory
  constructor(options: { port?: number; chronDir?: string } = {}) {
    this.#chronDir = options.chronDir ?? ".";
    this.#logDir = join(this.#chronDir, "logs"),
      this.#statusDb = new Database<RunStatusEntry>(
        join(this.#chronDir, "jobStatus.json"),
      );
    this.#mailbox = new Mailbox(this.#chronDir);

    this.#port = options.port;
    if (typeof this.#port !== "undefined") {
      serve((req) => this.#httpHandler(req), { port: this.#port });
    }
  }

  // Register a job to run on startup
  async startup(
    name: string,
    command: string,
  ) {
    this.#validateName(name);

    const job: Job = {
      type: "startup",
      name,
      command,
      logFile: join(this.#logDir, `${name}.log`),
      process: undefined,
    };
    this.#jobs.set(name, job);

    // Re-run the job if it ever fails
    while (true) {
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
  ) {
    this.#validateName(name);

    const cronSchedule = new Cron(
      schedule,
      () => this.#executeJob(job),
    );
    const job: Job = {
      type: "scheduled",
      name,
      command,
      schedule: cronSchedule,
      logFile: join(this.#logDir, `${name}.log`),
      process: undefined,
    };
    this.#jobs.set(name, job);
  }

  // Helper function to execute a command with the environment and logging configured
  async #executeJob(job: Job) {
    const startTime = new Date();

    console.log(
      `${startTime.toISOString()} Running ${job.name}: ${job.command}`,
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
    const headerBytes = new TextEncoder().encode(
      `${startTime.toString()}\n${"-".repeat(80)}\n`,
    );
    await writeAll(logFile, headerBytes);

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
    const status = await process.status();
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
    const statusBytes = new TextEncoder().encode(`Status: ${status.code}\n`);
    await writeAll(logFile, statusBytes);
    Deno.close(logFile.rid);
  }

  // Throw an exception if the provided name is a valid job name
  // It must be in kebab case
  #validateName(name: string): void {
    if (!/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(name)) {
      throw new Error("Invalid job name");
    }

    if (this.#jobs.has(name)) {
      throw new Error("A job with this name already exists");
    }
  }

  // Handle HTTP requests
  async #httpHandler(req: Request): Promise<Response> {
    const logPattern = new URLPattern({ pathname: "/log/:name" });
    const mailboxPattern = new URLPattern({ pathname: "/mailbox/:name" });
    const rebootPattern = new URLPattern({ pathname: "/reboot/:name" });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json(
        await Promise.all(
          Array.from(this.#jobs.values()).map(async (job) => {
            // Show the most recent three runs
            const recentRuns =
              (await this.#statusDb.findMany({ name: job.name })).sort((
                r1,
                r2,
              ) => r1.timestamp - r2.timestamp).slice(-3).map((
                { timestamp, statusCode },
              ) => ({
                timestamp: new Date(timestamp).toISOString(),
                statusCode,
              }));
            return {
              name: job.name,
              runs: recentRuns,
              nextRun: job.type === "scheduled"
                ? job.schedule.next()?.toISOString()
                : undefined,
              pid: job.process?.pid,
            };
          }),
        ),
      );
    }

    let matches;

    matches = logPattern.exec(req.url);
    if (matches) {
      const { name } = matches.pathname.groups;
      const logFile = `${this.#logDir}/${name}.log`;
      if (req.method === "GET") {
        return serveFile(req, logFile).catch(handleFsError);
      } else if (req.method === "DELETE") {
        return Deno.remove(logFile)
          .then(() => new Response("Deleted log file"))
          .catch(handleFsError);
      }
    }

    matches = mailboxPattern.exec(req.url);
    if (matches) {
      const { name } = matches.pathname.groups;
      if (req.method === "GET") {
        return Response.json(await this.#mailbox.getMessages(name));
      } else if (req.method === "POST") {
        return Response.json(
          await this.#mailbox.addMessage(name, await req.text()),
        );
      } else if (req.method === "DELETE") {
        return Response.json(await this.#mailbox.clearMessages(name));
      } else {
        return new Response("Invalid Method", { status: 405 });
      }
    }

    matches = rebootPattern.exec(req.url);
    if (req.method === "POST" && matches) {
      const { name } = matches.pathname.groups;
      if (!this.#jobs.has(name)) {
        return new Response("Job Not Found", { status: 404 });
      }

      const process = this.#jobs.get(name)?.process;
      if (process) {
        process.kill("SIGTERM");
        return new Response("Job Rebooted");
      } else {
        return new Response("Job Not Running");
      }
    }

    return new Response("Not Found", { status: 404 });
  }
}
