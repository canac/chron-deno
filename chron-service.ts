import { ensureDir } from "https://deno.land/std@0.142.0/fs/mod.ts";
import { serveFile } from "https://deno.land/std@0.142.0/http/file_server.ts";
import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
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

export class ChronService {
  #chronDir: string;
  #logDir: string;
  #port: number | undefined;

  #statusDb: Database<RunStatusEntry>;
  #scheduledJobs = new Map<string, Cron>();
  #startupJobs = new Set<string>();
  #runningProcesses = new Map<string, Deno.Process | undefined>();
  #mailbox: Mailbox;

  // `port` is the port that the HTTP server will listen on, or null to not start the server
  // `chronDir` is the directory to store data and logs, defaulting to the current directory
  constructor(options: { port?: number; chronDir?: string } = {}) {
    this.#chronDir = options.chronDir ?? ".";
    this.#logDir = `${this.#chronDir}/logs`;
    this.#statusDb = new Database<RunStatusEntry>(
      `${this.#chronDir}/jobStatus.json`,
    );
    this.#mailbox = new Mailbox(this.#chronDir);

    this.#port = options.port;
    if (typeof this.#port !== "undefined") {
      serve((req) => this.#httpHandler(req), { port: this.#port });
    }
  }

  // Register a command to run on startup
  async startup(
    name: string,
    command: string,
  ) {
    this.#validateName(name);
    if (this.#startupJobs.has(name)) {
      throw new Error("Startup command with this name already exists");
    }
    this.#startupJobs.add(name);

    // Rerun the command if it ever fails
    while (true) {
      await this.#runCommand(name, command);

      // Wait a few seconds before running again
      await sleep(5);
    }
  }

  // Register a command to run on a certain schedule
  async schedule(
    name: string,
    schedule: string,
    command: string,
  ) {
    this.#validateName(name);
    if (this.#scheduledJobs.has(name)) {
      throw new Error("Scheduled job with this name already exists");
    }

    const job = new Cron(schedule, () => this.#runCommand(name, command));
    this.#scheduledJobs.set(name, job);
  }

  // Helper function to run a command and configure logging
  async #runCommand(name: string, command: string) {
    const startTime = new Date();

    console.log(`${startTime.toISOString()} Running ${name}: ${command}`);

    // Save the run invocation to the database
    const id = crypto.randomUUID();
    await this.#statusDb.insertOne({
      id,
      name,
      timestamp: startTime.getTime(),
    });

    // Open the log file
    await ensureDir(this.#logDir);
    const logFile = await Deno.open(
      `${this.#logDir}/${name}.log`,
      { append: true, create: true },
    );
    const headerBytes = new TextEncoder().encode(
      `${startTime.toString()}\n${"-".repeat(80)}\n`,
    );
    await writeAll(logFile, headerBytes);

    // Run the command and clone the log file after the command completes
    const env = this.#port
      ? { CHRON_MAILBOX_URL: `http://0.0.0.0:${this.#port}/mailbox/${name}` }
      : undefined;
    const process = Deno.run({
      cmd: ["sh", "-c", command],
      stdout: logFile.rid,
      stderr: logFile.rid,
      env,
    });
    this.#runningProcesses.set(name, process);
    const status = await process.status();
    if (!status.success) {
      this.#mailbox.addMessage(
        "@errors",
        `${name} failed with status code ${status.code}`,
      );
    }
    this.#runningProcesses.set(name, undefined);
    const statusBytes = new TextEncoder().encode(`Status: ${status.code}\n`);
    await writeAll(logFile, statusBytes);
    Deno.close(logFile.rid);

    // Update the run status with the status code
    await this.#statusDb.updateOne({ id }, { statusCode: status.code });
  }

  // Throw an exception if the provided name is a valid command name
  // It must be in kebab case
  #validateName(name: string): void {
    if (!/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(name)) {
      throw new Error("Invalid command name");
    }
  }

  // Handle HTTP requests
  async #httpHandler(req: Request): Promise<Response> {
    const logPattern = new URLPattern({ pathname: "/log/:name" });
    const mailboxPattern = new URLPattern({ pathname: "/mailbox/:name" });
    const rebootPattern = new URLPattern({ pathname: "/reboot/:name" });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") {
      const names = Array.from(
        new Set([
          ...this.#scheduledJobs.keys(),
          ...this.#runningProcesses.keys(),
        ]),
      );
      return Response.json(
        await Promise.all(names.map(async (name) => {
          // Show the most recent three runs
          const recentRuns = (await this.#statusDb.findMany({ name })).sort((
            r1,
            r2,
          ) => r1.timestamp - r2.timestamp).slice(-3).map((
            { timestamp, statusCode },
          ) => ({
            timestamp: new Date(timestamp).toISOString(),
            statusCode,
          }));
          return {
            name,
            runs: recentRuns,
            nextRun: this.#scheduledJobs.get(name)?.next()?.toISOString(),
            pid: this.#runningProcesses.get(name)?.pid,
          };
        })),
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
      if (!this.#runningProcesses.has(name)) {
        return new Response("Job Not Found", { status: 404 });
      }

      const process = this.#runningProcesses.get(name);
      if (typeof process !== "undefined") {
        process.kill("SIGTERM");
        return new Response("Job Rebooted");
      }
    }

    return new Response("Not Found", { status: 404 });
  }
}
