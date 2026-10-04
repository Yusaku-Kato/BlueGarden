/**
 * Fireflies: additive glow dots that wander and pulse, driven by weather.fireflies
 * (docs/DESIGN.md §36.5). At most EFFECTS.FIREFLIES_MAX, sharing two contexts. Each firefly is a
 * Container (body + bloom halo) destroyed with its children.
 */
import { Container, Graphics } from "pixi.js";
import type { GraphicsContext } from "pixi.js";
import { EFFECTS } from "../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import { approach, clamp01, destroyDisplay } from "./EnvironmentEffect";
import type { SceneEffect } from "./EnvironmentEffect";

const FIREFLY_TINT = 0xd9ff7a;
const SPEED_MIN = 10; // px/s
const SPEED_MAX = 26;
const TURN_RATE = 6; // rad/s random-walk strength
const PULSE_SPEED_MIN = 0.0012; // rad/ms
const PULSE_SPEED_MAX = 0.0028;
const BODY_ALPHA = 0.95;
const HALO_ALPHA = 0.55;
const HALO_SCALE = 1.1;
const FIREFLY_FADE_MS = 1_200;
const RETIRED_FADE = 0.01;
const MIN_HEIGHT_RATIO = 0.3; // of groundY
const BELOW_GROUND_RATIO = 0.06; // of height
const BLOOM_FADE_MS = 500;

interface Firefly {
  readonly view: Container;
  readonly halo: Graphics;
  x: number;
  y: number;
  heading: number;
  readonly speed: number;
  readonly pulseSpeed: number;
  pulsePhase: number;
  fade: number;
  retiring: boolean;
}

export interface FireflyEffectOptions {
  readonly layer: Container;
  /** Shared contexts owned by EffectArt. Never destroyed here. */
  readonly bodyContext: GraphicsContext;
  readonly haloContext: GraphicsContext;
  readonly random: () => number;
}

export class FireflyEffect implements SceneEffect {
  private readonly layer: Container;
  private readonly bodyContext: GraphicsContext;
  private readonly haloContext: GraphicsContext;
  private readonly random: () => number;
  private flies: Firefly[] = [];
  private width = 0;
  private height = 0;
  private groundY = 0;
  private tint = FIREFLY_TINT;
  private bloomLevel = 0;

  constructor(options: FireflyEffectOptions) {
    this.layer = options.layer;
    this.bodyContext = options.bodyContext;
    this.haloContext = options.haloContext;
    this.random = options.random;
  }

  get count(): number {
    return this.flies.length;
  }

  setArea(width: number, height: number, groundY: number): void {
    this.width = width;
    this.height = height;
    this.groundY = groundY;
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    if (this.width <= 0 || this.groundY <= 0) return;
    const enabled = settings.effects.fireflies;
    const density = enabled ? clamp01(env.weather.fireflies * settings.particleIntensity) : 0;
    const wanted = Math.min(EFFECTS.FIREFLIES_MAX, Math.round(EFFECTS.FIREFLIES_MAX * density));
    this.bloomLevel = approach(this.bloomLevel, settings.effects.bloom ? 1 : 0, dtMs, BLOOM_FADE_MS);
    this.reconcile(wanted);
    this.advance(dtMs, settings.animationSpeed);
  }

  clear(): void {
    for (const fly of this.flies) destroyDisplay(fly.view, "firefly.destroyFailed");
    this.flies = [];
  }

  destroy(): void {
    this.clear();
  }

  /** Create at most one firefly per frame; retire surplus ones (one per frame). */
  private reconcile(wanted: number): void {
    let active = 0;
    for (const fly of this.flies) if (!fly.retiring) active += 1;
    if (active < wanted && this.flies.length < EFFECTS.FIREFLIES_MAX) {
      this.createFirefly();
    } else if (active > wanted) {
      for (let index = this.flies.length - 1; index >= 0; index -= 1) {
        const fly = this.flies[index];
        if (fly !== undefined && !fly.retiring) {
          fly.retiring = true;
          break;
        }
      }
    }
  }

  private createFirefly(): void {
    const view = new Container();
    const halo = new Graphics(this.haloContext);
    halo.tint = this.tint;
    halo.blendMode = "add";
    halo.scale.set(HALO_SCALE);
    halo.alpha = 0;
    const body = new Graphics(this.bodyContext);
    body.tint = this.tint;
    body.blendMode = "add";
    view.addChild(halo);
    view.addChild(body);
    view.alpha = 0;
    const top = this.groundY * MIN_HEIGHT_RATIO;
    const fly: Firefly = {
      view,
      halo,
      x: this.random() * this.width,
      y: top + this.random() * (this.groundY + this.height * BELOW_GROUND_RATIO - top),
      heading: this.random() * Math.PI * 2,
      speed: SPEED_MIN + this.random() * (SPEED_MAX - SPEED_MIN),
      pulseSpeed: PULSE_SPEED_MIN + this.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN),
      pulsePhase: this.random() * Math.PI * 2,
      fade: 0,
      retiring: false,
    };
    view.position.set(fly.x, fly.y);
    this.layer.addChild(view);
    this.flies.push(fly);
  }

  private advance(dtMs: number, animationSpeed: number): void {
    const motionMs = dtMs * animationSpeed;
    const dtSeconds = motionMs / 1000;
    const top = this.groundY * MIN_HEIGHT_RATIO;
    const bottom = this.groundY + this.height * BELOW_GROUND_RATIO;
    const haloAlpha = HALO_ALPHA * this.bloomLevel;
    for (let index = this.flies.length - 1; index >= 0; index -= 1) {
      const fly = this.flies[index];
      if (fly === undefined) continue;
      fly.fade = approach(fly.fade, fly.retiring ? 0 : 1, dtMs, FIREFLY_FADE_MS);
      if (fly.retiring && fly.fade < RETIRED_FADE) {
        destroyDisplay(fly.view, "firefly.destroyFailed");
        this.flies.splice(index, 1);
        continue;
      }
      fly.heading += (this.random() * 2 - 1) * TURN_RATE * dtSeconds;
      fly.x += Math.cos(fly.heading) * fly.speed * dtSeconds;
      fly.y += Math.sin(fly.heading) * fly.speed * dtSeconds;
      // Turn back towards the area instead of leaving it.
      if (fly.x < 0 || fly.x > this.width) {
        fly.heading = Math.PI - fly.heading;
        fly.x = Math.min(this.width, Math.max(0, fly.x));
      }
      if (fly.y < top || fly.y > bottom) {
        fly.heading = -fly.heading;
        fly.y = Math.min(bottom, Math.max(top, fly.y));
      }
      fly.pulsePhase += fly.pulseSpeed * motionMs;
      const pulse = Math.max(0, Math.sin(fly.pulsePhase));
      fly.view.position.set(fly.x, fly.y);
      fly.view.alpha = BODY_ALPHA * fly.fade * (0.2 + 0.8 * pulse * pulse);
      fly.halo.alpha = haloAlpha;
    }
  }
}
