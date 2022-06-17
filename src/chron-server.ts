import { serveFile } from "https://deno.land/std@0.142.0/http/file_server.ts";
import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { ChronService } from "./chron-service.ts";
import { handleFsError } from "./util.ts";

export class ChronServer {
  #chron: ChronService;

  constructor(chron: ChronService) {
    this.#chron = chron;

    serve((req) => this.#httpHandler(req), {
      port: this.#chron.getServerPort(),
      onListen: undefined,
    });
  }

  // Handle HTTP requests
  async #httpHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json(
        Array.from(this.#chron.getJobs().values()).map((job) => ({
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
    const job = typeof jobName !== "undefined" &&
      this.#chron.getJobs().get(jobName);
    if (!job) {
      return new Response("Not Found", { status: 404 });
    }

    const { command } = matches.pathname.groups;
    if (command === "status") {
      if (req.method === "GET") {
        // Find the job's most recent three runs
        const recentRuns = (await this.#chron.getLastRuns(job.name)).slice(0, 3)
          .map((
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
      const mailbox = this.#chron.getMailbox();
      if (req.method === "GET") {
        return Response.json(await mailbox.getMessages(job.name));
      } else if (req.method === "POST") {
        return Response.json(
          await mailbox.addMessage(job.name, await req.text()),
        );
      } else if (req.method === "DELETE") {
        return Response.json(await mailbox.clearMessages(job.name));
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
