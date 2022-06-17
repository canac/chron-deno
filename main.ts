import { debounce } from "https://deno.land/std@0.142.0/async/debounce.ts";
import { ChronService } from "./src/chron-service.ts";
import { load } from "./src/chronfile.ts";
import { logStderr } from "./src/util.ts";

const rawPort = Deno.env.get("PORT") ?? "";
const port = parseInt(rawPort, 10);
if (Number.isNaN(port)) {
  await logStderr(`Invalid port "${rawPort}"`);
  Deno.exit(1);
}

const chron = new ChronService({
  port,
  chronDir: `${Deno.env.get("HOME")}/.local/share/chron`,
});

const chronfilePath = Deno.args[0];
if (!chronfilePath) {
  console.error("No chronfile provided\n\nUsage:\n  chron <chronfile.toml>");
  Deno.exit(1);
}

await load(chron, chronfilePath);

// Watch the chronfile and reload on changes
const watcher = Deno.watchFs(chronfilePath);
const debouncedLoad = debounce(async () => {
  await logStderr("Chronfile changed. Reloading...\n");
  try {
    await load(chron, chronfilePath);
  } catch (err) {
    console.log(err);
  }
}, 1000);
for await (const event of watcher) {
  if (event.kind === "modify" || event.kind === "remove") {
    debouncedLoad();
  }
}
