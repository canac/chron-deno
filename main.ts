import { debounce } from "https://deno.land/std@0.142.0/async/debounce.ts";
import { ChronService } from "./src/chron-service.ts";
import { load } from "./src/chronfile.ts";

const port = parseInt(Deno.env.get("PORT") ?? "", 10);
const chron = new ChronService({
  port: Number.isNaN(port) ? undefined : port,
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
  console.log("Chronfile changed. Reloading...");
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
