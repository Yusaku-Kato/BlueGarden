/**
 * Pure plant lifecycle math (docs/DESIGN.md §14.1). No PixiJS import so it is unit-testable in node.
 */
import { PLANT } from "../config/gardenConfig";

export type PlantPhase = "growing" | "mature" | "fading" | "evicting" | "dead";

export interface PlantLifecycleState {
  readonly ageMs: number;
  readonly lifeMs: number;
  readonly growthDurationMs: number;
  readonly targetScale: number;
  /** Age at which the plant was chosen for early removal, or null. */
  readonly evictAtAgeMs: number | null;
  /** Per-plant eviction fade duration; defaults to constants.EVICTION_FADE_MS. */
  readonly evictFadeMs?: number;
  /** Age used for the growth tween only (animationSpeed scales it). Defaults to ageMs. */
  readonly growthAgeMs?: number;
}

export interface PlantLifecycleConstants {
  readonly FADE_MS: number;
  readonly FADE_IN_MS: number;
  readonly EVICTION_FADE_MS: number;
  readonly INITIAL_SCALE: number;
}

export interface PlantLifecycleResult {
  readonly phase: PlantPhase;
  readonly scale: number;
  readonly alpha: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(t: number): number {
  const inverse = 1 - t;
  return 1 - inverse * inverse * inverse;
}

function scaleAt(state: PlantLifecycleState, constants: PlantLifecycleConstants): number {
  const growthAge = state.growthAgeMs ?? state.ageMs;
  const progress = state.growthDurationMs > 0 ? clamp(growthAge / state.growthDurationMs, 0, 1) : 1;
  return (
    constants.INITIAL_SCALE +
    (state.targetScale - constants.INITIAL_SCALE) * easeOutCubic(progress)
  );
}

/** Alpha ignoring eviction: fade-in at the start, linear fade over the last FADE_MS. */
function naturalAlphaAt(
  ageMs: number,
  lifeMs: number,
  constants: PlantLifecycleConstants,
): number {
  const fadeIn = constants.FADE_IN_MS > 0 ? clamp(ageMs / constants.FADE_IN_MS, 0, 1) : 1;
  const fadeOut =
    constants.FADE_MS > 0 ? clamp((lifeMs - ageMs) / constants.FADE_MS, 0, 1) : 1;
  return fadeIn * fadeOut;
}

export function evaluatePlant(
  state: PlantLifecycleState,
  constants: PlantLifecycleConstants = PLANT,
): PlantLifecycleResult {
  const { ageMs, lifeMs, evictAtAgeMs } = state;
  const scale = scaleAt(state, constants);

  if (ageMs >= lifeMs) return { phase: "dead", scale, alpha: 0 };

  if (evictAtAgeMs !== null) {
    const elapsed = ageMs - evictAtAgeMs;
    const fadeMs = state.evictFadeMs ?? constants.EVICTION_FADE_MS;
    if (elapsed >= fadeMs) return { phase: "dead", scale, alpha: 0 };
    const startAlpha = naturalAlphaAt(evictAtAgeMs, lifeMs, constants);
    const remaining = 1 - clamp(elapsed / fadeMs, 0, 1);
    return { phase: "evicting", scale, alpha: startAlpha * remaining };
  }

  const alpha = naturalAlphaAt(ageMs, lifeMs, constants);
  if (ageMs >= lifeMs - constants.FADE_MS) return { phase: "fading", scale, alpha };
  if ((state.growthAgeMs ?? ageMs) >= state.growthDurationMs) return { phase: "mature", scale, alpha };
  return { phase: "growing", scale, alpha };
}

/** Lifetime with +/- LIFETIME_JITTER_RATIO variation so plants do not vanish together. */
export function lifeMsFor(random: () => number, baseLifetimeMs: number = PLANT.LIFETIME_MS): number {
  const unit = clamp(random(), 0, 1);
  return baseLifetimeMs * (1 + (unit * 2 - 1) * PLANT.LIFETIME_JITTER_RATIO);
}

export function swayRotation(timeMs: number, phase: number): number {
  return Math.sin(timeMs * PLANT.WIND_SPEED + phase) * PLANT.WIND_AMPLITUDE;
}

/** Sway with a wind multiplier (1 = the MVP amplitude). Non-finite input yields 0. */
export function windSway(motionTimeMs: number, phase: number, windFactor: number): number {
  const value = Math.sin(motionTimeMs * PLANT.WIND_SPEED + phase) * PLANT.WIND_AMPLITUDE * windFactor;
  return Number.isFinite(value) ? value : 0;
}
