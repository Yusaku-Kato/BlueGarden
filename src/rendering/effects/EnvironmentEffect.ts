/**
 * Contract of the 2D environment effects (docs/DESIGN.md §36.5, §38).
 * Effects own no ticker callback: the engine's single ticker calls update() once per frame.
 */
import type { Container } from "pixi.js";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import { errorName, logger } from "../../infra/logger";

export interface EnvironmentEffect {
  /** `dtMs` is real frame time (clamped by the engine); motion should be scaled by settings.animationSpeed. */
  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void;
  /** Destroy every display object immediately (idempotent). */
  clear(): void;
  /** clear() plus release of anything else. Shared textures / contexts are NOT destroyed here. */
  destroy(): void;
  /** Number of live display objects. */
  readonly count: number;
}

/** Effects that live in the scene and need its size / palette. */
export interface SceneEffect extends EnvironmentEffect {
  /** Size in CSS pixels and the y of the ground line. Called on layout. */
  setArea(width: number, height: number, groundY: number): void;
  /** Optional tint from the sky palette. */
  setTint?(color: number): void;
}

/** Time constant of the on/off fade of a toggled effect. */
export const EFFECT_FADE_MS = 700;
/** Below this level a disabled effect is released completely. */
export const EFFECT_RELEASE_LEVEL = 0.01;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Frame-rate independent exponential approach of `value` to `target`. */
export function approach(value: number, target: number, dtMs: number, tauMs: number): number {
  return value + (target - value) * (1 - Math.exp(-dtMs / tauMs));
}

/** removeFromParent + destroy({children}). Never throws. Never touches shared contexts. */
export function destroyDisplay(display: Container, label: string): void {
  try {
    display.removeFromParent();
    display.destroy({ children: true });
  } catch (error) {
    logger.warn(label, { name: errorName(error) });
  }
}
