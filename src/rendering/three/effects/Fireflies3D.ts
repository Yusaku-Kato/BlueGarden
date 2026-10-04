/**
 * Fireflies: glowing points that wander and pulse, driven by weather.fireflies (docs/DESIGN.md
 * §36.5). At most EFFECTS.FIREFLIES_MAX; each firefly is a bright body point plus a larger dim halo
 * point in one THREE.Points object (the bloom pass amplifies them).
 */
import type { Object3D } from "three";
import { EFFECTS } from "../../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../../domain/models";
import { approach, clamp01 } from "../../effects/EnvironmentEffect";
import { groundHeight } from "../terrain";
import { PointCloud } from "./pointCloud";
import { DEFAULT_AREA } from "./types";
import type { GardenArea, ThreeEffect } from "./types";

const FIREFLY_TINT = 0xd9ff7a;
const SPEED_MIN = 0.25; // world units / s
const SPEED_MAX = 0.6;
const TURN_RATE = 6; // rad/s random-walk strength
const PULSE_SPEED_MIN = 0.0012; // rad/ms
const PULSE_SPEED_MAX = 0.0028;
const BODY_ALPHA = 0.95;
const HALO_ALPHA = 0.5;
const BODY_SIZE = 0.07;
const HALO_SIZE = 0.45;
const FIREFLY_FADE_MS = 1_200;
const RETIRED_FADE = 0.01;
const MIN_HEIGHT = 0.4;
const MAX_HEIGHT = 3.2;
const BLOOM_FADE_MS = 500;
const INTENSITY = 2.2;

interface Firefly {
  x: number;
  y: number;
  z: number;
  heading: number;
  climb: number;
  readonly speed: number;
  readonly pulseSpeed: number;
  pulsePhase: number;
  fade: number;
  retiring: boolean;
}

export class Fireflies3D implements ThreeEffect {
  private readonly cloud: PointCloud;
  private flies: Firefly[] = [];
  private area: GardenArea = DEFAULT_AREA;
  private bloomLevel = 0;

  constructor(
    parent: Object3D,
    private readonly random: () => number,
  ) {
    this.cloud = new PointCloud(parent, EFFECTS.FIREFLIES_MAX * 2, FIREFLY_TINT, INTENSITY);
  }

  get count(): number {
    return this.flies.length;
  }

  setPixelScale(value: number): void {
    this.cloud.setPixelScale(value);
  }

  setArea(area: GardenArea): void {
    this.area = area;
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    const enabled = settings.effects.fireflies;
    const density = enabled ? clamp01(env.weather.fireflies * settings.particleIntensity) : 0;
    const wanted = Math.min(EFFECTS.FIREFLIES_MAX, Math.round(EFFECTS.FIREFLIES_MAX * density));
    this.bloomLevel = approach(this.bloomLevel, settings.effects.bloom ? 1 : 0, dtMs, BLOOM_FADE_MS);
    this.reconcile(wanted);
    this.advance(dtMs, settings.animationSpeed);
  }

  clear(): void {
    this.flies = [];
    this.cloud.commit(0);
  }

  dispose(): void {
    this.flies = [];
    this.cloud.dispose();
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
    const { halfWidth, zNear, zFar } = this.area;
    const z = zFar * 0.7 + this.random() * (zNear - zFar * 0.7);
    const x = (this.random() * 2 - 1) * halfWidth * 0.8;
    this.flies.push({
      x,
      y: groundHeight(x, z) + MIN_HEIGHT + this.random() * (MAX_HEIGHT - MIN_HEIGHT),
      z,
      heading: this.random() * Math.PI * 2,
      climb: this.random() * Math.PI * 2,
      speed: SPEED_MIN + this.random() * (SPEED_MAX - SPEED_MIN),
      pulseSpeed: PULSE_SPEED_MIN + this.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN),
      pulsePhase: this.random() * Math.PI * 2,
      fade: 0,
      retiring: false,
    });
  }

  private advance(dtMs: number, animationSpeed: number): void {
    const motionMs = dtMs * animationSpeed;
    const dtSeconds = motionMs / 1000;
    const { halfWidth, zNear, zFar } = this.area;
    const haloAlpha = HALO_ALPHA * this.bloomLevel;
    for (let index = this.flies.length - 1; index >= 0; index -= 1) {
      const fly = this.flies[index];
      if (fly === undefined) continue;
      fly.fade = approach(fly.fade, fly.retiring ? 0 : 1, dtMs, FIREFLY_FADE_MS);
      if (fly.retiring && fly.fade < RETIRED_FADE) {
        const last = this.flies.pop();
        if (last !== undefined && last !== fly) this.flies[index] = last;
        continue;
      }
      fly.heading += (this.random() * 2 - 1) * TURN_RATE * dtSeconds;
      fly.climb += (this.random() * 2 - 1) * TURN_RATE * 0.5 * dtSeconds;
      fly.x += Math.cos(fly.heading) * fly.speed * dtSeconds;
      fly.z += Math.sin(fly.heading) * fly.speed * dtSeconds;
      fly.y += Math.sin(fly.climb) * fly.speed * 0.5 * dtSeconds;
      // Turn back towards the area instead of leaving it.
      const limitX = halfWidth * 0.9;
      if (fly.x < -limitX || fly.x > limitX) {
        fly.heading = Math.PI - fly.heading;
        fly.x = Math.min(limitX, Math.max(-limitX, fly.x));
      }
      if (fly.z < zFar * 0.7 || fly.z > zNear) {
        fly.heading = -fly.heading;
        fly.z = Math.min(zNear, Math.max(zFar * 0.7, fly.z));
      }
      const floor = groundHeight(fly.x, fly.z) + MIN_HEIGHT;
      if (fly.y < floor || fly.y > MAX_HEIGHT + floor) {
        fly.climb = -fly.climb;
        fly.y = Math.min(MAX_HEIGHT + floor, Math.max(floor, fly.y));
      }
      fly.pulsePhase += fly.pulseSpeed * motionMs;
    }
    this.write(haloAlpha);
  }

  private write(haloAlpha: number): void {
    let written = 0;
    for (const fly of this.flies) {
      const pulse = Math.max(0, Math.sin(fly.pulsePhase));
      const brightness = BODY_ALPHA * fly.fade * (0.2 + 0.8 * pulse * pulse);
      this.cloud.set(written, fly.x, fly.y, fly.z, HALO_SIZE, haloAlpha * brightness);
      this.cloud.set(written + 1, fly.x, fly.y, fly.z, BODY_SIZE, brightness);
      written += 2;
    }
    this.cloud.commit(written);
  }
}
