/**
 * Light particles rising from the ground when Bluesky is busy (docs/DESIGN.md §17.1, §36.5).
 * One THREE.Points object, at most PARTICLES.MAX_PARTICLES points; a particle is removed by
 * swap-remove when its lifetime ends.
 */
import { PARTICLES } from "../../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../../domain/models";
import { EFFECT_FADE_MS, EFFECT_RELEASE_LEVEL, approach } from "../../effects/EnvironmentEffect";
import { clamp } from "../../plantLifecycle";
import { groundHeight } from "../terrain";
import { PointCloud } from "./pointCloud";
import { DEFAULT_AREA } from "./types";
import type { GardenArea, ThreeEffect } from "./types";
import type { Object3D } from "three";

const DEFAULT_TINT = 0xfff1a8;
const PEAK_ALPHA = 0.8;
const RISE_SPEED_MIN = 0.3; // world units / s
const RISE_SPEED_MAX = 0.6;
const SWAY_AMPLITUDE_MIN = 0.15;
const SWAY_AMPLITUDE_MAX = 0.35;
const SWAY_FREQUENCY = 0.0015; // rad/ms
const SPAWN_HEIGHT_SPREAD = 0.8;
const SIZE_MIN = 0.07;
const SIZE_MAX = 0.18;
const INTENSITY = 1.4;

interface Particle {
  baseX: number;
  baseY: number;
  z: number;
  riseSpeed: number;
  swayAmplitude: number;
  swayPhase: number;
  lifeMs: number;
  size: number;
  ageMs: number;
}

export class LightParticles3D implements ThreeEffect {
  private readonly cloud: PointCloud;
  private particles: Particle[] = [];
  private spawnAccumulator = 0;
  private area: GardenArea = DEFAULT_AREA;
  private level = 1;

  constructor(
    parent: Object3D,
    private readonly random: () => number,
  ) {
    this.cloud = new PointCloud(parent, PARTICLES.MAX_PARTICLES, DEFAULT_TINT, INTENSITY);
  }

  get count(): number {
    return this.particles.length;
  }

  setPixelScale(value: number): void {
    this.cloud.setPixelScale(value);
  }

  setArea(area: GardenArea): void {
    this.area = area;
  }

  setTint(hex: number): void {
    this.cloud.setColor(hex);
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    const enabled = settings.effects.lightParticles;
    this.level = approach(this.level, enabled ? 1 : 0, dtMs, EFFECT_FADE_MS);
    if (!enabled && this.level < EFFECT_RELEASE_LEVEL) {
      this.clear();
      return;
    }
    this.advance(dtMs * settings.animationSpeed);
    this.spawn(dtMs, enabled ? env.weather.postsPerMinute : 0, settings.particleIntensity);
    this.write();
  }

  clear(): void {
    this.particles = [];
    this.spawnAccumulator = 0;
    this.cloud.commit(0);
  }

  dispose(): void {
    this.particles = [];
    this.cloud.dispose();
  }

  private advance(motionMs: number): void {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      if (particle === undefined) continue;
      particle.ageMs += motionMs;
      if (particle.ageMs < particle.lifeMs) continue;
      const last = this.particles.pop();
      if (last !== undefined && last !== particle) this.particles[index] = last;
    }
  }

  private write(): void {
    let written = 0;
    for (const particle of this.particles) {
      const fadeIn = clamp(particle.ageMs / PARTICLES.FADE_IN_MS, 0, 1);
      const fadeOut = clamp((particle.lifeMs - particle.ageMs) / PARTICLES.FADE_OUT_MS, 0, 1);
      this.cloud.set(
        written,
        particle.baseX + Math.sin(particle.ageMs * SWAY_FREQUENCY + particle.swayPhase) * particle.swayAmplitude,
        particle.baseY + (particle.riseSpeed * particle.ageMs) / 1000,
        particle.z,
        particle.size,
        PEAK_ALPHA * fadeIn * fadeOut * this.level,
      );
      written += 1;
    }
    this.cloud.commit(written);
  }

  private spawn(dtMs: number, activity: number, intensitySetting: number): void {
    const intensity = clamp(
      (activity - PARTICLES.THRESHOLD_PPM) / (PARTICLES.FULL_INTENSITY_PPM - PARTICLES.THRESHOLD_PPM),
      0,
      1,
    );
    const rate = PARTICLES.MAX_SPAWN_PER_SEC * intensity * clamp(intensitySetting, 0, 2);
    if (rate <= 0 || this.particles.length >= PARTICLES.MAX_PARTICLES) {
      this.spawnAccumulator = 0;
      return;
    }
    // At most one particle per frame, so a spike never bursts onto the screen.
    this.spawnAccumulator = Math.min(this.spawnAccumulator + (rate * dtMs) / 1000, 1);
    if (this.spawnAccumulator < 1) return;
    this.spawnAccumulator -= 1;
    const { halfWidth, zNear, zFar } = this.area;
    const x = (this.random() * 2 - 1) * halfWidth * 0.9;
    const z = zFar + this.random() * (zNear - zFar);
    this.particles.push({
      baseX: x,
      baseY: groundHeight(x, z) + this.random() * SPAWN_HEIGHT_SPREAD,
      z,
      riseSpeed: RISE_SPEED_MIN + this.random() * (RISE_SPEED_MAX - RISE_SPEED_MIN),
      swayAmplitude: SWAY_AMPLITUDE_MIN + this.random() * (SWAY_AMPLITUDE_MAX - SWAY_AMPLITUDE_MIN),
      swayPhase: this.random() * Math.PI * 2,
      lifeMs: PARTICLES.LIFETIME_MIN_MS + this.random() * (PARTICLES.LIFETIME_MAX_MS - PARTICLES.LIFETIME_MIN_MS),
      size: SIZE_MIN + this.random() * (SIZE_MAX - SIZE_MIN),
      ageMs: 0,
    });
  }
}
