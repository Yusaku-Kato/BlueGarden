/**
 * Renderer contract shared by the 2D (PixiJS) and 3D (Three.js) engines (docs/DESIGN.md §35.2).
 * Receives only PlantSeed and plain domain values; never post text or raw API data.
 */
import type { EnvironmentState, PlantSeed, RenderSettings } from "../domain/models";

/** Fade duration callers should pass to fadeOutAll when the feed is switched. */
export const FEED_SWITCH_FADE_MS = 2_000;
export const FADE_OUT_ALL_MIN_MS = 300;
export const FADE_OUT_ALL_MAX_MS = 5_000;

/** Clamp a requested fadeOutAll duration; non-finite input falls back to FEED_SWITCH_FADE_MS. */
export function clampFadeOutAllMs(fadeMs: number): number {
  if (!Number.isFinite(fadeMs)) return FEED_SWITCH_FADE_MS;
  return Math.min(FADE_OUT_ALL_MAX_MS, Math.max(FADE_OUT_ALL_MIN_MS, fadeMs));
}

export class RenderInitError extends Error {
  constructor(message = "Failed to initialize the renderer") {
    super(message);
    this.name = "RenderInitError";
  }
}

export interface RendererOptions {
  /** Render resolution. Defaults to min(devicePixelRatio, RENDER.MAX_RESOLUTION), read lazily in init(). */
  readonly resolution?: number;
  /** Called once if the WebGL context is lost; the owner is expected to recreate the renderer. */
  readonly onContextLost?: () => void;
  /** Random source in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
}

export interface EngineStats {
  readonly plants: number;
  readonly queued: number;
  readonly particles: number;
  /** Rain drops, fog sprites, fireflies and other environment effect objects. */
  readonly effectObjects: number;
}

export interface TerrariumRenderer {
  /** Resolves true when running; rejects only with RenderInitError. */
  init(host: HTMLElement): Promise<boolean>;
  destroy(): void;
  addPlant(seed: PlantSeed): void;
  /** Raises the target scale of a living or pending plant (never shrinks). Unknown id is a no-op. */
  growPlant(id: string, targetScale: number): void;
  setEnvironment(environment: EnvironmentState): void;
  applySettings(settings: RenderSettings): void;
  setDimmed(dimmed: boolean): void;
  setPaused(paused: boolean): void;
  clearPending(): void;
  /**
   * Clears the spawn queue and fades every living plant out over `fadeMs` (clamped to
   * FADE_OUT_ALL_MIN_MS..FADE_OUT_ALL_MAX_MS), e.g. after a feed switch. Plants added afterwards are
   * unaffected. Environment is not reset. No-op after destroy.
   */
  fadeOutAll(fadeMs: number): void;
  getStats(): EngineStats;
}

export type RendererFactory = (options?: RendererOptions) => TerrariumRenderer;
