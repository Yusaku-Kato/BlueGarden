/**
 * Contract of the 3D environment effects (docs/DESIGN.md §36.5). Like the 2D effects they own no
 * loop: the engine's single render loop calls update() once per frame.
 */
import type { EnvironmentState, RenderSettings } from "../../../domain/models";

/** Where plants and weather live: x in [-halfWidth, halfWidth] (visible width at zFar), z in [zFar, zNear]. */
export interface GardenArea {
  readonly halfWidth: number;
  readonly zNear: number;
  readonly zFar: number;
}

export interface ThreeEffect {
  /** `dtMs` is real frame time (clamped by the engine); motion is scaled by settings.animationSpeed. */
  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void;
  setArea(area: GardenArea): void;
  setTint?(hex: number): void;
  /** Remove every object immediately (idempotent). */
  clear(): void;
  /** clear() plus release of every GPU resource (idempotent). */
  dispose(): void;
  /** Number of live objects (drops, fireflies, particles). */
  readonly count: number;
}

export const DEFAULT_AREA: GardenArea = { halfWidth: 12, zNear: 3, zFar: -9 };
