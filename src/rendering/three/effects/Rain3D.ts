/**
 * Rain streaks driven by weather.rain (docs/DESIGN.md §36.5): one LineSegments object with at most
 * EFFECTS.RAIN_MAX_DROPS streaks. Drops are recycled to the top when they land; they are removed
 * only when the wanted count shrinks or the effect is switched off.
 */
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, LineBasicMaterial, LineSegments } from "three";
import type { Object3D } from "three";
import { EFFECTS } from "../../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../../domain/models";
import { EFFECT_FADE_MS, EFFECT_RELEASE_LEVEL, approach, clamp01 } from "../../effects/EnvironmentEffect";
import { groundHeight } from "../terrain";
import { DEFAULT_AREA } from "./types";
import type { GardenArea, ThreeEffect } from "./types";

const DEFAULT_TINT = 0xaed0e8;
const PEAK_OPACITY = 0.4;
const SPEED_MIN = 11; // world units / s
const SPEED_MAX = 17;
const LENGTH_MIN = 0.45;
const LENGTH_MAX = 0.9;
const TOP_Y = 9;
const MAX_ANGLE = 0.42; // rad from vertical at full wind
const CALM_ANGLE = 0.06;
const ANGLE_SMOOTHING_MS = 1_500;
/** At most this many drops are created per frame so a downpour builds up instead of popping in. */
const MAX_CREATES_PER_FRAME = 10;

interface Drop {
  x: number;
  y: number;
  z: number;
  speed: number;
  length: number;
}

export class Rain3D implements ThreeEffect {
  private readonly geometry: BufferGeometry;
  private readonly material: LineBasicMaterial;
  private readonly lines: LineSegments;
  private readonly positions: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private drops: Drop[] = [];
  private area: GardenArea = DEFAULT_AREA;
  private level = 1;
  private angle = CALM_ANGLE;
  private disposed = false;

  constructor(
    private readonly parent: Object3D,
    private readonly random: () => number,
  ) {
    this.positions = new Float32Array(EFFECTS.RAIN_MAX_DROPS * 2 * 3);
    this.positionAttribute = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", this.positionAttribute);
    this.geometry.setDrawRange(0, 0);
    this.material = new LineBasicMaterial({
      color: DEFAULT_TINT,
      transparent: true,
      opacity: PEAK_OPACITY,
      depthWrite: false,
      fog: false,
    });
    this.lines = new LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.parent.add(this.lines);
  }

  get count(): number {
    return this.drops.length;
  }

  setArea(area: GardenArea): void {
    this.area = area;
  }

  setTint(hex: number): void {
    this.material.color.setHex(hex);
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    const enabled = settings.effects.rain;
    this.level = approach(this.level, enabled ? 1 : 0, dtMs, EFFECT_FADE_MS);
    if (!enabled && this.level < EFFECT_RELEASE_LEVEL) {
      this.clear();
      return;
    }

    const windAmount = settings.effects.wind ? clamp01(env.weather.wind * settings.windIntensity) : 0;
    const targetAngle = CALM_ANGLE + (MAX_ANGLE - CALM_ANGLE) * windAmount;
    this.angle = approach(this.angle, targetAngle, dtMs, ANGLE_SMOOTHING_MS);

    const density = enabled ? clamp01(env.weather.rain * settings.particleIntensity) : 0;
    const wanted = Math.min(EFFECTS.RAIN_MAX_DROPS, Math.round(EFFECTS.RAIN_MAX_DROPS * density));
    const missing = Math.min(wanted - this.drops.length, MAX_CREATES_PER_FRAME);
    for (let created = 0; created < missing; created += 1) this.createDrop();
    this.advance((dtMs * settings.animationSpeed) / 1000, wanted);
    this.material.opacity = PEAK_OPACITY * this.level;
    this.write();
  }

  clear(): void {
    this.drops = [];
    this.geometry.setDrawRange(0, 0);
    this.lines.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.drops = [];
    this.parent.remove(this.lines);
    this.geometry.dispose();
    this.material.dispose();
  }

  private createDrop(): void {
    this.drops.push({
      x: this.randomX(),
      y: TOP_Y * (0.4 + this.random() * 0.6),
      z: this.randomZ(),
      speed: SPEED_MIN + this.random() * (SPEED_MAX - SPEED_MIN),
      length: LENGTH_MIN + this.random() * (LENGTH_MAX - LENGTH_MIN),
    });
  }

  /** Spread past the edges so slanted drops still cover the whole width. */
  private randomX(): number {
    return (this.random() * 2.6 - 1.3) * this.area.halfWidth;
  }

  private randomZ(): number {
    return this.area.zFar + this.random() * (this.area.zNear + 2 - this.area.zFar);
  }

  private advance(dtSeconds: number, wanted: number): void {
    const dx = Math.sin(this.angle);
    const dy = -Math.cos(this.angle);
    for (let index = this.drops.length - 1; index >= 0; index -= 1) {
      const drop = this.drops[index];
      if (drop === undefined) continue;
      drop.x += dx * drop.speed * dtSeconds;
      drop.y += dy * drop.speed * dtSeconds;
      if (drop.y > groundHeight(drop.x, drop.z)) continue;
      if (this.drops.length > wanted) {
        const last = this.drops.pop();
        if (last !== undefined && last !== drop) this.drops[index] = last;
        continue;
      }
      drop.y = TOP_Y * (0.9 + this.random() * 0.1);
      drop.x = this.randomX();
      drop.z = this.randomZ();
    }
  }

  private write(): void {
    const dx = Math.sin(this.angle);
    const dy = -Math.cos(this.angle);
    let offset = 0;
    for (const drop of this.drops) {
      this.positions[offset] = drop.x;
      this.positions[offset + 1] = drop.y;
      this.positions[offset + 2] = drop.z;
      this.positions[offset + 3] = drop.x - dx * drop.length;
      this.positions[offset + 4] = drop.y - dy * drop.length;
      this.positions[offset + 5] = drop.z;
      offset += 6;
    }
    this.geometry.setDrawRange(0, this.drops.length * 2);
    this.lines.visible = this.drops.length > 0;
    if (this.drops.length > 0) this.positionAttribute.needsUpdate = true;
  }
}
