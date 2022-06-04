import { parse as parseToml } from "https://deno.land/std@0.142.0/encoding/toml.ts";
import { z } from "https://deno.land/x/zod@v3.17.3/mod.ts";
import { ChronService } from "./chron-service.ts";

const chronfileSchema = z.object({
  startup: z.record(z.object({ command: z.string() })).default({}),
  schedule: z.record(z.object({ schedule: z.string(), command: z.string() }))
    .default({}),
});

const port = parseInt(Deno.env.get("PORT") ?? "", 10);
const chron = new ChronService({
  port: Number.isNaN(port) ? undefined : port,
  chronDir: `${Deno.env.get("HOME")}/.local/share/chron`,
});

const chronfilePath = Deno.args[1];
if (!chronfilePath) {
  console.error("No chronfile provided\n\nUsage:\n  chron [chronfile.toml]");
  Deno.exit(1);
}
const chronfile = chronfileSchema.parse(
  parseToml(await Deno.readTextFile(chronfilePath)),
);
Object.entries(chronfile.startup).forEach(([name, { command }]) => {
  chron.startup(name, command);
});
Object.entries(chronfile.schedule).forEach(([name, { schedule, command }]) => {
  chron.schedule(name, schedule, command);
});
