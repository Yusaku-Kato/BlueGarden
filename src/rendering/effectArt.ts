/**
 * Shared GraphicsContexts of the environment effects (docs/DESIGN.md §38).
 * Created once per engine; destroyed once at engine teardown after every Graphics using them.
 * Shapes are white and tinted per instance.
 */
import { GraphicsContext } from "pixi.js";
import { errorName, logger } from "../infra/logger";

const WHITE = 0xffffff;
const RAIN_STREAK_WIDTH = 1.3;
const FOG_LAYERS = 9;
const GLOW_CORE_RADIUS = 2.2;
const GLOW_SOFT_RADIUS = 6;
const HALO_LAYERS = 4;
export const RAIN_STREAK_LENGTH = 16;
export const FOG_BLOB_RADIUS_X = 260;
export const FOG_BLOB_RADIUS_Y = 90;
export const HALO_RADIUS = 20;

export interface EffectArt {
  /** Vertical line from (0, 0) down to (0, RAIN_STREAK_LENGTH). */
  readonly rainStreak: GraphicsContext;
  /** Soft blob of stacked translucent ellipses centred on the origin. */
  readonly fogBlob: GraphicsContext;
  /** Small bright core with a faint glow (firefly body). */
  readonly glowDot: GraphicsContext;
  /** Large faint halo (bloom-lite) centred on the origin; drawn with additive blending. */
  readonly halo: GraphicsContext;
  /** Destroys every shared context once. Call only after all Graphics using them are destroyed. */
  destroy(): void;
}

function buildRainStreak(): GraphicsContext {
  return new GraphicsContext()
    .moveTo(0, 0)
    .lineTo(0, RAIN_STREAK_LENGTH)
    .stroke({ width: RAIN_STREAK_WIDTH, color: WHITE, cap: "round" });
}

function buildFogBlob(): GraphicsContext {
  const context = new GraphicsContext();
  for (let layer = 0; layer < FOG_LAYERS; layer += 1) {
    const ratio = 1 - layer / FOG_LAYERS;
    context
      .ellipse(0, 0, FOG_BLOB_RADIUS_X * ratio, FOG_BLOB_RADIUS_Y * ratio)
      .fill({ color: WHITE, alpha: 0.1 });
  }
  return context;
}

function buildGlowDot(): GraphicsContext {
  return new GraphicsContext()
    .circle(0, 0, GLOW_SOFT_RADIUS)
    .fill({ color: WHITE, alpha: 0.22 })
    .circle(0, 0, GLOW_CORE_RADIUS)
    .fill({ color: WHITE });
}

function buildHalo(): GraphicsContext {
  const context = new GraphicsContext();
  for (let layer = 0; layer < HALO_LAYERS; layer += 1) {
    const ratio = 1 - layer / HALO_LAYERS;
    context.circle(0, 0, HALO_RADIUS * ratio).fill({ color: WHITE, alpha: 0.12 });
  }
  return context;
}

export function createEffectArt(): EffectArt {
  const contexts = {
    rainStreak: buildRainStreak(),
    fogBlob: buildFogBlob(),
    glowDot: buildGlowDot(),
    halo: buildHalo(),
  };
  let destroyed = false;
  return {
    ...contexts,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const [label, context] of Object.entries(contexts)) {
        try {
          context.destroy();
        } catch (error) {
          logger.warn("render.contextDestroyFailed", { context: label, name: errorName(error) });
        }
      }
    },
  };
}
