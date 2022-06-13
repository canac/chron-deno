import { parse as parseToml } from "https://deno.land/std@0.142.0/encoding/toml.ts";
import { z } from "https://deno.land/x/zod@v3.17.3/mod.ts";
import { ChronService } from "./chron-service.ts";

const schema = z.object({
  startup: z.record(z.object({ command: z.string() })).default({}),
  schedule: z.record(
    z.object({
      schedule: z.string(),
      command: z.string(),
      makeUpMissedRuns: z.union([z.number().min(0), z.literal("all")])
        .default(0),
    }),
  )
    .default({}),
});

// Load a chronfile into an existing chron service instance, replacing all previous jobs
export async function load(chron: ChronService, path: string): Promise<void> {
  chron.reset();

  const chronfile = schema.parse(
    parseToml(await Deno.readTextFile(path)),
  );

  Object.entries(chronfile.startup).forEach(([name, { command }]) => {
    chron.startup(name, command);
  });
  Object.entries(chronfile.schedule).forEach(
    ([name, { schedule, command, makeUpMissedRuns }]) => {
      chron.schedule(name, schedule, command, { makeUpMissedRuns });
    },
  );
}
