/**
 * Development-only page for looking at the 3D renderer without the app shell:
 * http://localhost:1422/src/dev/threeSmoke.html?weather=night|rain|fog|calm|busy&plants=120&bloom=0
 * Not part of the production bundle (index.html does not reference it).
 */
import { ThreeTerrariumEngine } from "../rendering/three/ThreeTerrariumEngine";
import { DEFAULT_RENDER_SETTINGS } from "../rendering/renderInputs";
import { startMockSource } from "./mockSource";

const params = new URLSearchParams(window.location.search);
const log = document.getElementById("log");
const host = document.getElementById("host");

function show(message: string): void {
  if (log !== null) log.textContent = message;
}

async function main(): Promise<void> {
  if (host === null) return;
  const engine = new ThreeTerrariumEngine({
    onContextLost: () => {
      show("context lost");
    },
  });
  await engine.init(host);
  const bloom = params.get("bloom") !== "0";
  engine.applySettings({ ...DEFAULT_RENDER_SETTINGS, effects: { ...DEFAULT_RENDER_SETTINGS.effects, bloom } });
  const wanted = Number(params.get("plants") ?? "60");
  const stop = startMockSource(engine, { plantsPerSecond: 20 });
  const timer = window.setInterval(() => {
    const stats = engine.getStats();
    show(
      `plants ${String(stats.plants)}/${String(wanted)}  queued ${String(stats.queued)}  particles ${String(
        stats.particles,
      )}  effects ${String(stats.effectObjects)}`,
    );
    if (stats.plants >= wanted) {
      window.clearInterval(timer);
      stop();
      document.title = "ready";
    }
  }, 250);
}

main().catch((error: unknown) => {
  show(`failed: ${error instanceof Error ? error.message : "unknown error"}`);
});
