import { useEffect, useState } from "react";
import type { RendererKind } from "../domain/models";
import type { TerrariumRenderer } from "../rendering/TerrariumRenderer";
import type { GardenAccess } from "../services/bluesky/blueskySession";

interface DevStatsProps {
  engine: TerrariumRenderer | null;
  access: GardenAccess | null;
  renderer: RendererKind;
}

const REFRESH_MS = 2_000;

function readStats(engine: TerrariumRenderer | null, access: GardenAccess | null, renderer: RendererKind): string {
  const stats = engine?.getStats();
  const seen = access?.seenPosts.size ?? 0;
  if (stats === undefined) return `renderer: ${renderer}  engine: -  seen: ${String(seen)}`;
  return `${renderer}  plants: ${String(stats.plants)}  queued: ${String(stats.queued)}  particles: ${String(stats.particles)}  effects: ${String(stats.effectObjects)}  seen: ${String(seen)}`;
}

/** Development readout enabled with ?stats. Holds only a formatted string. */
export default function DevStats({ engine, access, renderer }: DevStatsProps) {
  const [text, setText] = useState(() => readStats(engine, access, renderer));

  useEffect(() => {
    const refresh = (): void => {
      setText(readStats(engine, access, renderer));
    };
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [engine, access, renderer]);

  return <div className="dev-stats">{text}</div>;
}
