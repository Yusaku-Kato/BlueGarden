/**
 * Whole-scene brightness / warmth overlay driven by weather.light (docs/DESIGN.md §36.5).
 * One additive rectangle that is redrawn only on resize; only its alpha changes per frame.
 */
import { Graphics } from "pixi.js";
import type { Container } from "pixi.js";
import type { EnvironmentState } from "../../domain/models";
import { errorName, logger } from "../../infra/logger";
import { approach, clamp01 } from "./EnvironmentEffect";
import type { SceneEffect } from "./EnvironmentEffect";

const WARM_TINT = 0xffe2b0;
const MAX_ALPHA = 0.09; // subtle: this is a mood, not a flash
const SMOOTHING_MS = 2_500;
const VISIBLE_ALPHA = 0.002;

export class LightOverlay implements SceneEffect {
  private graphic: Graphics | null;
  private level = 0;

  constructor(layer: Container) {
    const graphic = new Graphics();
    graphic.tint = WARM_TINT;
    graphic.blendMode = "add";
    graphic.alpha = 0;
    layer.addChild(graphic);
    this.graphic = graphic;
  }

  /** 1 while the overlay contributes to the picture, else 0. */
  get count(): number {
    return this.graphic !== null && this.graphic.alpha > VISIBLE_ALPHA ? 1 : 0;
  }

  setArea(width: number, height: number): void {
    const graphic = this.graphic;
    if (graphic === null) return;
    graphic.clear();
    graphic.rect(0, 0, width, height).fill({ color: 0xffffff });
  }

  update(dtMs: number, env: EnvironmentState): void {
    const graphic = this.graphic;
    if (graphic === null) return;
    this.level = approach(this.level, clamp01(env.weather.light), dtMs, SMOOTHING_MS);
    graphic.alpha = MAX_ALPHA * this.level;
  }

  clear(): void {
    if (this.graphic !== null) this.graphic.alpha = 0;
    this.level = 0;
  }

  destroy(): void {
    const graphic = this.graphic;
    this.graphic = null;
    if (graphic === null) return;
    // Own (non-shared) context, safe to destroy together with the Graphics.
    try {
      graphic.removeFromParent();
      graphic.destroy({ context: true });
    } catch (error) {
      logger.warn("lightOverlay.destroyFailed", { name: errorName(error) });
    }
  }
}
