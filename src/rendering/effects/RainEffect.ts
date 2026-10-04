/**
 * Rain streaks driven by weather.rain (docs/DESIGN.md §36.5).
 * Shared-context Graphics (one streak context for all drops, no per-drop geometry). Drops are
 * recycled to the top when they land; they are destroyed only when the wanted count shrinks
 * or the effect is switched off.
 */
import { Graphics } from "pixi.js";
import type { Container, GraphicsContext } from "pixi.js";
import { EFFECTS } from "../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import {
  EFFECT_FADE_MS,
  EFFECT_RELEASE_LEVEL,
  approach,
  clamp01,
  destroyDisplay,
} from "./EnvironmentEffect";
import type { SceneEffect } from "./EnvironmentEffect";

const DEFAULT_TINT = 0xaed0e8;
const PEAK_ALPHA = 0.45;
const SPEED_MIN = 520; // px/s
const SPEED_MAX = 820;
const LENGTH_SCALE_MIN = 0.7;
const LENGTH_SCALE_MAX = 1.4;
const MAX_ANGLE = 0.42; // rad from vertical at full wind
const CALM_ANGLE = 0.06;
const ANGLE_SMOOTHING_MS = 1_500;
/** At most this many drops are created per frame so a downpour builds up instead of popping in. */
const MAX_CREATES_PER_FRAME = 10;
/** Drops land somewhere in this band below the ground line (fraction of height). */
const LANDING_BAND_RATIO = 0.12;

interface Drop {
  readonly graphic: Graphics;
  x: number;
  y: number;
  readonly speed: number;
  readonly endY: number;
}

export interface RainEffectOptions {
  readonly layer: Container;
  /** Shared streak context owned by EffectArt. Never destroyed here. */
  readonly streakContext: GraphicsContext;
  readonly random: () => number;
}

export class RainEffect implements SceneEffect {
  private readonly layer: Container;
  private readonly streakContext: GraphicsContext;
  private readonly random: () => number;
  private drops: Drop[] = [];
  private width = 0;
  private height = 0;
  private groundY = 0;
  private tint = DEFAULT_TINT;
  private level = 1;
  private angle = CALM_ANGLE;

  constructor(options: RainEffectOptions) {
    this.layer = options.layer;
    this.streakContext = options.streakContext;
    this.random = options.random;
  }

  get count(): number {
    return this.drops.length;
  }

  setArea(width: number, height: number, groundY: number): void {
    this.width = width;
    this.height = height;
    this.groundY = groundY;
  }

  setTint(color: number): void {
    this.tint = color;
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    const enabled = settings.effects.rain;
    this.level = approach(this.level, enabled ? 1 : 0, dtMs, EFFECT_FADE_MS);
    if (!enabled && this.level < EFFECT_RELEASE_LEVEL) {
      this.clear();
      return;
    }
    if (this.width <= 0 || this.groundY <= 0) return;

    const windAmount = settings.effects.wind
      ? clamp01(env.weather.wind * settings.windIntensity)
      : 0;
    const targetAngle = CALM_ANGLE + (MAX_ANGLE - CALM_ANGLE) * windAmount;
    this.angle = approach(this.angle, targetAngle, dtMs, ANGLE_SMOOTHING_MS);

    const density = enabled ? clamp01(env.weather.rain * settings.particleIntensity) : 0;
    const wanted = Math.min(EFFECTS.RAIN_MAX_DROPS, Math.round(EFFECTS.RAIN_MAX_DROPS * density));
    this.createMissing(wanted);
    this.advance((dtMs * settings.animationSpeed) / 1000, wanted);
  }

  clear(): void {
    for (const drop of this.drops) destroyDisplay(drop.graphic, "rain.destroyFailed");
    this.drops = [];
  }

  destroy(): void {
    this.clear();
  }

  private createMissing(wanted: number): void {
    const missing = Math.min(wanted - this.drops.length, MAX_CREATES_PER_FRAME);
    for (let created = 0; created < missing; created += 1) this.createDrop();
  }

  private createDrop(): void {
    const graphic = new Graphics(this.streakContext);
    graphic.tint = this.tint;
    graphic.alpha = 0;
    graphic.scale.set(1, LENGTH_SCALE_MIN + this.random() * (LENGTH_SCALE_MAX - LENGTH_SCALE_MIN));
    const drop: Drop = {
      graphic,
      x: this.randomX(),
      y: -this.random() * this.groundY * 0.6,
      speed: SPEED_MIN + this.random() * (SPEED_MAX - SPEED_MIN),
      endY: this.groundY + this.random() * this.height * LANDING_BAND_RATIO,
    };
    graphic.position.set(drop.x, drop.y);
    this.layer.addChild(graphic);
    this.drops.push(drop);
  }

  /** Spread past the left edge so slanted drops still cover the whole width. */
  private randomX(): number {
    return (this.random() * 1.3 - 0.15) * this.width;
  }

  private advance(dtSeconds: number, wanted: number): void {
    const dx = Math.sin(this.angle);
    const dy = Math.cos(this.angle);
    const rotation = -this.angle;
    const alpha = PEAK_ALPHA * this.level;
    for (let index = this.drops.length - 1; index >= 0; index -= 1) {
      const drop = this.drops[index];
      if (drop === undefined) continue;
      drop.x += dx * drop.speed * dtSeconds;
      drop.y += dy * drop.speed * dtSeconds;
      if (drop.y >= drop.endY) {
        if (this.drops.length > wanted) {
          destroyDisplay(drop.graphic, "rain.destroyFailed");
          this.drops.splice(index, 1);
          continue;
        }
        drop.y = -this.random() * this.groundY * 0.2;
        drop.x = this.randomX();
      }
      drop.graphic.position.set(drop.x, drop.y);
      drop.graphic.rotation = rotation;
      drop.graphic.alpha = alpha;
    }
  }
}
