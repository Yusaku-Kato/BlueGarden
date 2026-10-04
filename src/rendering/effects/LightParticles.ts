/**
 * Light particles rising from the ground when Bluesky is busy (docs/DESIGN.md §17.1).
 * Driven by the engine's single ticker; owns no ticker callback itself.
 */
import { Graphics } from "pixi.js";
import type { Container, GraphicsContext } from "pixi.js";
import { PARTICLES } from "../../config/gardenConfig";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import { clamp } from "../plantLifecycle";
import { EFFECT_FADE_MS, EFFECT_RELEASE_LEVEL, approach, destroyDisplay } from "./EnvironmentEffect";
import type { SceneEffect } from "./EnvironmentEffect";

const DEFAULT_TINT = 0xfff1a8;
const PEAK_ALPHA = 0.8;
const RISE_SPEED_MIN = 20; // px/s
const RISE_SPEED_MAX = 40;
const SWAY_AMPLITUDE_MIN = 8; // px
const SWAY_AMPLITUDE_MAX = 16;
const SWAY_FREQUENCY = 0.0015; // rad/ms
const SPAWN_HEIGHT_SPREAD = 40; // px above the ground line
const SIZE_MIN = 0.6;
const SIZE_MAX = 1.6;

interface Particle {
  readonly graphic: Graphics;
  readonly baseX: number;
  readonly baseY: number;
  readonly riseSpeed: number;
  readonly swayAmplitude: number;
  readonly swayPhase: number;
  readonly lifeMs: number;
  ageMs: number;
}

export interface LightParticlesOptions {
  readonly layer: Container;
  /** Shared dot context owned by PlantArt. Never destroyed here. */
  readonly dotContext: GraphicsContext;
  readonly random: () => number;
}

export class LightParticles implements SceneEffect {
  private readonly layer: Container;
  private readonly dotContext: GraphicsContext;
  private readonly random: () => number;
  private particles: Particle[] = [];
  private spawnAccumulator = 0;
  private width = 0;
  private groundY = 0;
  private tint = DEFAULT_TINT;
  /** 0..1 on/off fade of the toggle. */
  private level = 1;

  constructor(options: LightParticlesOptions) {
    this.layer = options.layer;
    this.dotContext = options.dotContext;
    this.random = options.random;
  }

  get count(): number {
    return this.particles.length;
  }

  /** Spawn area (CSS pixels): along the width, just above groundY. */
  setArea(width: number, _height: number, groundY: number): void {
    this.width = width;
    this.groundY = groundY;
  }

  setTint(color: number): void {
    this.tint = color;
  }

  update(dtMs: number, env: EnvironmentState, settings: RenderSettings): void {
    const enabled = settings.effects.lightParticles;
    this.level = approach(this.level, enabled ? 1 : 0, dtMs, EFFECT_FADE_MS);
    if (!enabled && this.level < EFFECT_RELEASE_LEVEL) {
      this.clear();
      return;
    }
    const motionMs = dtMs * settings.animationSpeed;
    this.advance(motionMs);
    this.spawn(dtMs, enabled ? env.weather.postsPerMinute : 0, settings.particleIntensity);
  }

  clear(): void {
    for (const particle of this.particles) destroyDisplay(particle.graphic, "particle.destroyFailed");
    this.particles = [];
    this.spawnAccumulator = 0;
  }

  destroy(): void {
    this.clear();
  }

  private advance(dtMs: number): void {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      if (particle === undefined) continue;
      particle.ageMs += dtMs;
      if (particle.ageMs >= particle.lifeMs) {
        destroyDisplay(particle.graphic, "particle.destroyFailed");
        this.particles.splice(index, 1);
        continue;
      }
      const fadeIn = clamp(particle.ageMs / PARTICLES.FADE_IN_MS, 0, 1);
      const fadeOut = clamp((particle.lifeMs - particle.ageMs) / PARTICLES.FADE_OUT_MS, 0, 1);
      particle.graphic.alpha = PEAK_ALPHA * fadeIn * fadeOut * this.level;
      particle.graphic.position.set(
        particle.baseX +
          Math.sin(particle.ageMs * SWAY_FREQUENCY + particle.swayPhase) * particle.swayAmplitude,
        particle.baseY - (particle.riseSpeed * particle.ageMs) / 1000,
      );
    }
  }

  private spawn(dtMs: number, activity: number, intensitySetting: number): void {
    const intensity = clamp(
      (activity - PARTICLES.THRESHOLD_PPM) /
        (PARTICLES.FULL_INTENSITY_PPM - PARTICLES.THRESHOLD_PPM),
      0,
      1,
    );
    const rate = PARTICLES.MAX_SPAWN_PER_SEC * intensity * clamp(intensitySetting, 0, 2);
    const atCapacity = this.particles.length >= PARTICLES.MAX_PARTICLES;
    if (rate <= 0 || atCapacity || this.width <= 0) {
      this.spawnAccumulator = 0;
      return;
    }
    // At most one particle per frame, so a spike never bursts onto the screen.
    this.spawnAccumulator = Math.min(this.spawnAccumulator + (rate * dtMs) / 1000, 1);
    if (this.spawnAccumulator < 1) return;
    this.spawnAccumulator -= 1;
    this.createParticle();
  }

  private createParticle(): void {
    const graphic = new Graphics(this.dotContext);
    graphic.tint = this.tint;
    graphic.blendMode = "add";
    graphic.alpha = 0;
    graphic.scale.set(SIZE_MIN + this.random() * (SIZE_MAX - SIZE_MIN));
    const particle: Particle = {
      graphic,
      baseX: this.random() * this.width,
      baseY: this.groundY - this.random() * SPAWN_HEIGHT_SPREAD,
      riseSpeed: RISE_SPEED_MIN + this.random() * (RISE_SPEED_MAX - RISE_SPEED_MIN),
      swayAmplitude:
        SWAY_AMPLITUDE_MIN + this.random() * (SWAY_AMPLITUDE_MAX - SWAY_AMPLITUDE_MIN),
      swayPhase: this.random() * Math.PI * 2,
      lifeMs:
        PARTICLES.LIFETIME_MIN_MS +
        this.random() * (PARTICLES.LIFETIME_MAX_MS - PARTICLES.LIFETIME_MIN_MS),
      ageMs: 0,
    };
    graphic.position.set(particle.baseX, particle.baseY);
    this.layer.addChild(graphic);
    this.particles.push(particle);
  }
}
