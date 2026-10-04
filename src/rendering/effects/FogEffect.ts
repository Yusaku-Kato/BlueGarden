/**
 * Slow drifting fog banks driven by weather.fog (docs/DESIGN.md §36.5).
 * At most EFFECTS.FOG_MAX_SPRITES large soft shapes sharing one context. A bank that is no longer
 * wanted fades out and is destroyed; there is no per-frame allocation.
 */
import { Graphics } from "pixi.js";
import type { Container, GraphicsContext } from "pixi.js";
import { EFFECTS } from "../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import { FOG_BLOB_RADIUS_X } from "../effectArt";
import { approach, clamp01, destroyDisplay } from "./EnvironmentEffect";
import type { SceneEffect } from "./EnvironmentEffect";

const FOG_TINT = 0x9fb2c0;
const PEAK_ALPHA = 0.42; // per bank at fog = 1 (each bank is already translucent)
const DRIFT_SPEED_MIN = 6; // px/s
const DRIFT_SPEED_MAX = 18;
const SCALE_MIN = 0.9;
const SCALE_MAX = 1.8;
const BANK_FADE_MS = 2_500;
const RETIRED_FADE = 0.01;
/** Banks sit between this fraction of the ground height and just below the ground line. */
const TOP_RATIO = 0.35;

interface Bank {
  readonly graphic: Graphics;
  x: number;
  readonly y: number;
  readonly speed: number;
  /** 0..1 individual fade. */
  fade: number;
  retiring: boolean;
}

export interface FogEffectOptions {
  readonly layer: Container;
  /** Shared blob context owned by EffectArt. Never destroyed here. */
  readonly blobContext: GraphicsContext;
  readonly random: () => number;
}

export class FogEffect implements SceneEffect {
  private readonly layer: Container;
  private readonly blobContext: GraphicsContext;
  private readonly random: () => number;
  private banks: Bank[] = [];
  private width = 0;
  private height = 0;
  private groundY = 0;
  private tint = FOG_TINT;

  constructor(options: FogEffectOptions) {
    this.layer = options.layer;
    this.blobContext = options.blobContext;
    this.random = options.random;
  }

  get count(): number {
    return this.banks.length;
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
    if (this.width <= 0) return;
    const enabled = settings.effects.fog;
    const fog = enabled ? clamp01(env.weather.fog) : 0;
    const wanted = Math.min(EFFECTS.FOG_MAX_SPRITES, Math.ceil(EFFECTS.FOG_MAX_SPRITES * fog));
    this.reconcile(wanted);
    this.advance(dtMs, settings.animationSpeed, fog);
  }

  clear(): void {
    for (const bank of this.banks) destroyDisplay(bank.graphic, "fog.destroyFailed");
    this.banks = [];
  }

  destroy(): void {
    this.clear();
  }

  /** Create at most one bank per frame; retire surplus banks (one per frame). */
  private reconcile(wanted: number): void {
    let active = 0;
    for (const bank of this.banks) if (!bank.retiring) active += 1;
    if (active < wanted && this.banks.length < EFFECTS.FOG_MAX_SPRITES) {
      this.createBank();
    } else if (active > wanted) {
      for (let index = this.banks.length - 1; index >= 0; index -= 1) {
        const bank = this.banks[index];
        if (bank !== undefined && !bank.retiring) {
          bank.retiring = true;
          break;
        }
      }
    }
  }

  private createBank(): void {
    const graphic = new Graphics(this.blobContext);
    graphic.tint = this.tint;
    graphic.alpha = 0;
    const scale = SCALE_MIN + this.random() * (SCALE_MAX - SCALE_MIN);
    graphic.scale.set(scale, scale * 0.8);
    const top = this.groundY * TOP_RATIO;
    const bank: Bank = {
      graphic,
      x: this.random() * this.width,
      y: top + this.random() * (this.groundY + this.height * 0.08 - top),
      speed: DRIFT_SPEED_MIN + this.random() * (DRIFT_SPEED_MAX - DRIFT_SPEED_MIN),
      fade: 0,
      retiring: false,
    };
    graphic.position.set(bank.x, bank.y);
    this.layer.addChild(graphic);
    this.banks.push(bank);
  }

  private advance(dtMs: number, animationSpeed: number, fog: number): void {
    const dtSeconds = (dtMs * animationSpeed) / 1000;
    const wrapMargin = FOG_BLOB_RADIUS_X * SCALE_MAX;
    const peak = PEAK_ALPHA * (0.4 + 0.6 * fog);
    for (let index = this.banks.length - 1; index >= 0; index -= 1) {
      const bank = this.banks[index];
      if (bank === undefined) continue;
      bank.fade = approach(bank.fade, bank.retiring ? 0 : 1, dtMs, BANK_FADE_MS);
      if (bank.retiring && bank.fade < RETIRED_FADE) {
        destroyDisplay(bank.graphic, "fog.destroyFailed");
        this.banks.splice(index, 1);
        continue;
      }
      bank.x += bank.speed * dtSeconds;
      if (bank.x > this.width + wrapMargin) bank.x = -wrapMargin;
      bank.graphic.position.set(bank.x, bank.y);
      bank.graphic.alpha = peak * bank.fade;
    }
  }
}
