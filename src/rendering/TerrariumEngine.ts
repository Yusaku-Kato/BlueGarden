/**
 * PixiJS terrarium (docs/DESIGN.md §13-§15, §17, §35-§38).
 * Receives only PlantSeed, EnvironmentState and RenderSettings. Never throws from public methods.
 */
import "pixi.js/unsafe-eval"; // lets Pixi v8 compile shaders without CSP 'unsafe-eval' (DESIGN §22.3)
import { Application, Container, Graphics } from "pixi.js";
import type { Ticker } from "pixi.js";
import { FLOW, PLANT, RENDER } from "../config/gardenConfig";
import type { EnvironmentState, PlantSeed, RenderSettings } from "../domain/models";
import { errorName, logger } from "../infra/logger";
import { createEffectArt } from "./effectArt";
import type { EffectArt } from "./effectArt";
import { approach } from "./effects/EnvironmentEffect";
import type { SceneEffect } from "./effects/EnvironmentEffect";
import { FireflyEffect } from "./effects/FireflyEffect";
import { FogEffect } from "./effects/FogEffect";
import { GlowHalos } from "./effects/GlowHalos";
import { LightOverlay } from "./effects/LightOverlay";
import { LightParticles } from "./effects/LightParticles";
import { RainEffect } from "./effects/RainEffect";
import { FLOWER_OFFSET_Y, buildPlantView, createPlantArt } from "./plantArt";
import type { PlantArt } from "./plantArt";
import { clamp, evaluatePlant, lifeMsFor, windSway } from "./plantLifecycle";
import {
  DEFAULT_RENDER_SETTINGS,
  createCalmEnvironment,
  sanitizeRenderSettings,
  wrapDayPhase,
  writeEnvironment,
} from "./renderInputs";
import type { MutableEnvironment } from "./renderInputs";
import { lerpColor, paletteDistance, skyPalette } from "./skyPalette";
import type { SkyPalette } from "./skyPalette";
import { RenderInitError, clampFadeOutAllMs } from "./TerrariumRenderer";
import type { EngineStats, RendererOptions, TerrariumRenderer } from "./TerrariumRenderer";

export { RenderInitError };
export type { EngineStats };

export type TerrariumEngineOptions = RendererOptions;

type EngineState = "idle" | "initializing" | "running" | "destroyed";

interface PlantObject {
  readonly id: string;
  readonly view: Container;
  readonly mood: PlantSeed["mood"];
  readonly color: number;
  readonly lifeMs: number;
  readonly growthDurationMs: number;
  /** The scale the growth tween is heading to right now (follows goalScale smoothly). */
  targetScale: number;
  /** Requested final scale. growPlant only ever raises it. */
  goalScale: number;
  readonly swayPhase: number;
  readonly lean: number;
  readonly xRatio: number;
  /** 0 (back) .. 1 (front) position within the ground band. */
  readonly depth: number;
  ageMs: number;
  /** Age for the growth tween only; advances with animationSpeed (lifetime does not). */
  growthAgeMs: number;
  evictAtAgeMs: number | null;
  /** Per-plant eviction fade; undefined means PLANT.EVICTION_FADE_MS. */
  evictFadeMs?: number;
  halo: Graphics | null;
}

type IndexEntry =
  | { readonly kind: "queued"; readonly seed: PlantSeed }
  | { readonly kind: "plant"; readonly plant: PlantObject };

// Purely visual layout / drawing constants.
const MAX_FRAME_DELTA_MS = 250;
const GROUND_RATIO = 0.8;
const GROUND_BAND_RATIO = 0.13;
const BACKGROUND_BANDS = 32;
const DIM_ALPHA = 0.6;
const DIM_SMOOTHING_MS = 300;
const PLANT_LEAN_RANGE = 0.12;
const PLANT_X_MARGIN = 0.03;
const DEFAULT_PLANT_COLOR = 0x81c784;
const WHITE = 0xffffff;
/** Smoothing of the environment values other than the flow rate (which uses FLOW.SMOOTHING_MS). */
const ENVIRONMENT_SMOOTHING_MS = 2_500;
const DAY_PHASE_SMOOTHING_MS = 2_000;
const GROW_TARGET_SMOOTHING_MS = 700;
const WIND_SMOOTHING_MS = 500;
const WIND_GUST_RATIO = 0.8;
/** Background / palette are re-evaluated at this interval and redrawn only past the epsilon. */
const PALETTE_INTERVAL_MS = 250;
const PALETTE_EPSILON = 3;
const WEATHER_TINT_MIX = 0.55;

const MOUNDS: readonly { readonly x: number; readonly radiusX: number; readonly radiusY: number }[] = [
  { x: 0.12, radiusX: 0.22, radiusY: 14 },
  { x: 0.5, radiusX: 0.3, radiusY: 10 },
  { x: 0.86, radiusX: 0.24, radiusY: 16 },
];

export class TerrariumEngine implements TerrariumRenderer {
  private state: EngineState = "idle";
  private readonly resolutionOverride: number | undefined;
  private readonly onContextLost: (() => void) | undefined;
  private readonly random: () => number;

  private app: Application | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private art: PlantArt | null = null;
  private effectArt: EffectArt | null = null;
  private plantLayer: Container | null = null;
  private background: Graphics | null = null;
  private dimOverlay: Graphics | null = null;
  private lightParticles: LightParticles | null = null;
  private rain: RainEffect | null = null;
  private fog: FogEffect | null = null;
  private fireflies: FireflyEffect | null = null;
  private lightOverlay: LightOverlay | null = null;
  private halos: GlowHalos | null = null;
  /** Effects with a position in the scene, updated in this order from the single ticker. */
  private sceneEffects: SceneEffect[] = [];

  private plants: PlantObject[] = [];
  private spawnQueue: PlantSeed[] = [];
  /** id -> live plant or queued seed. Bounded by maxPlants + SPAWN_QUEUE_LIMIT; see removal paths. */
  private plantIndex = new Map<string, IndexEntry>();
  private spawnAccumulator = 0;

  private settings: RenderSettings = DEFAULT_RENDER_SETTINGS;
  private readonly environment: MutableEnvironment = createCalmEnvironment();
  private readonly targetEnvironment: MutableEnvironment = createCalmEnvironment();
  private dayPhaseInitialized = false;
  private motionTimeMs = 0;
  private windFactor = 1;
  private palette: SkyPalette | null = null;
  private paletteDirty = true;
  private paletteTimerMs = 0;
  private haloPlantsAttached = false;
  private bloomWasEnabled = false;
  private dimmed = false;
  private paused = false;
  private width = 0;
  private height = 0;
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;
  private contextLostReported = false;
  private frameDeltaMs = 0;

  constructor(options: TerrariumEngineOptions = {}) {
    this.resolutionOverride = options.resolution;
    this.onContextLost = options.onContextLost;
    this.random = options.random ?? Math.random;
  }

  /** True once init() resolved with true and until destroy(). */
  private get isRunning(): boolean {
    return this.state === "running";
  }

  private get isDestroyed(): boolean {
    return this.state === "destroyed";
  }

  /**
   * One call per instance. Resolves true when running, false when destroyed before/while
   * initializing or when already used. Rejects only with RenderInitError.
   */
  async init(host: HTMLElement): Promise<boolean> {
    if (this.state !== "idle") return false;
    this.state = "initializing";
    const app = new Application();
    this.app = app;

    try {
      await app.init({
        resizeTo: host,
        background: RENDER.BACKGROUND_COLOR,
        antialias: true,
        autoDensity: true,
        resolution: this.resolutionOverride ?? defaultResolution(),
        preference: "webgl",
      });
    } catch (error) {
      const wasDestroyed = this.isDestroyed;
      this.state = "destroyed";
      this.app = null;
      this.attempt("app.destroyAfterFailedInit", () => {
        app.destroy({ removeView: true }, { children: true });
      });
      if (wasDestroyed) return false;
      logger.error("render.initFailed", { name: errorName(error) });
      throw new RenderInitError();
    }

    if (this.isDestroyed) {
      this.app = null;
      this.attempt("app.destroyDeferred", () => {
        app.destroy({ removeView: true }, { children: true });
      });
      return false;
    }

    try {
      this.setUpScene(app, host);
    } catch (error) {
      logger.error("render.initFailed", { name: errorName(error) });
      this.teardown();
      throw new RenderInitError();
    }
    return true;
  }

  destroy(): void {
    if (this.state === "initializing") {
      this.state = "destroyed"; // init() destroys the app when its await settles
      this.spawnQueue = [];
      this.plantIndex.clear();
      return;
    }
    if (this.state === "running") this.teardown();
  }

  addPlant(seed: PlantSeed): void {
    if (this.isDestroyed) return;
    try {
      if (this.spawnQueue.length >= PLANT.SPAWN_QUEUE_LIMIT) {
        const dropped = this.spawnQueue.shift();
        if (dropped !== undefined) this.forgetQueued(dropped);
      }
      this.spawnQueue.push(seed);
      this.plantIndex.set(seed.id, { kind: "queued", seed });
    } catch (error) {
      this.logRateLimited("render.addPlantFailed", error);
    }
  }

  /**
   * Raise the target scale of a living or queued plant (never shrinks, tweened smoothly).
   * Unknown ids are ignored. Never throws.
   */
  growPlant(id: string, targetScale: number): void {
    if (this.isDestroyed) return;
    try {
      if (typeof targetScale !== "number" || !Number.isFinite(targetScale)) return;
      const goal = clamp(targetScale, PLANT.SCALE_MIN, PLANT.SCALE_MAX);
      const entry = this.plantIndex.get(id);
      if (entry === undefined) return;
      if (entry.kind === "plant") {
        if (goal > entry.plant.goalScale) entry.plant.goalScale = goal;
        return;
      }
      if (goal <= entry.seed.scale) return;
      const position = this.spawnQueue.indexOf(entry.seed);
      if (position < 0) return;
      const raised: PlantSeed = { ...entry.seed, scale: goal };
      this.spawnQueue[position] = raised;
      this.plantIndex.set(id, { kind: "queued", seed: raised });
    } catch (error) {
      this.logRateLimited("render.growPlantFailed", error);
    }
  }

  /** The values are smoothed towards (the first dayPhase is applied at once). */
  setEnvironment(environment: EnvironmentState): void {
    if (this.isDestroyed) return;
    try {
      writeEnvironment(this.targetEnvironment, environment);
      if (!this.dayPhaseInitialized) {
        this.dayPhaseInitialized = true;
        this.environment.dayPhase = this.targetEnvironment.dayPhase;
      }
      this.environment.climate = this.targetEnvironment.climate;
      this.paletteDirty = true;
    } catch (error) {
      this.logRateLimited("render.setEnvironmentFailed", error);
    }
  }

  /**
   * Values set before init are applied when running. Lowering maxPlants fades the oldest plants
   * out gradually (at most PLANT.SPAWN_PER_SECOND per second); plantLifetimeMs affects new plants only.
   */
  applySettings(settings: RenderSettings): void {
    if (this.isDestroyed) return;
    try {
      this.settings = sanitizeRenderSettings(settings, this.settings);
      this.paletteDirty = true;
    } catch (error) {
      this.logRateLimited("render.applySettingsFailed", error);
    }
  }

  setDimmed(dimmed: boolean): void {
    if (this.isDestroyed) return;
    this.dimmed = dimmed;
  }

  /**
   * Stops (or restarts) the ticker, and with it rendering and plant aging, while the window is
   * hidden or minimized (docs/DESIGN.md ADR-07). A value set before init is applied when running.
   */
  setPaused(paused: boolean): void {
    if (this.isDestroyed) return;
    this.paused = paused;
    if (this.isRunning) this.applyPaused();
  }

  private applyPaused(): void {
    const ticker = this.app?.ticker;
    if (ticker === undefined) return;
    try {
      if (this.paused) ticker.stop();
      else ticker.start();
    } catch (error) {
      this.logRateLimited("render.setPausedFailed", error);
    }
  }

  /** Drop queued seeds and calm the weather (used on logout). Existing plants fade normally. */
  clearPending(): void {
    if (this.isDestroyed) return;
    for (const seed of this.spawnQueue) this.forgetQueued(seed);
    this.spawnQueue = [];
    this.spawnAccumulator = 0;
    const weather = this.targetEnvironment.weather;
    weather.postsPerMinute = 0;
    weather.rain = 0;
    weather.wind = 0;
    weather.light = 0;
    weather.fog = 0;
    weather.fireflies = 0;
  }

  /** Drop queued seeds and fade every living plant out over fadeMs (feed switch). Environment is kept. */
  fadeOutAll(fadeMs: number): void {
    if (this.isDestroyed) return;
    try {
      for (const seed of this.spawnQueue) this.forgetQueued(seed);
      this.spawnQueue = [];
      this.spawnAccumulator = 0;
      const duration = clampFadeOutAllMs(fadeMs);
      for (const plant of this.plants) {
        if (plant.evictAtAgeMs !== null) {
          // Already fading out: never lengthen the fade.
          plant.evictFadeMs = Math.min(plant.evictFadeMs ?? PLANT.EVICTION_FADE_MS, duration);
          continue;
        }
        plant.evictAtAgeMs = plant.ageMs;
        plant.evictFadeMs = duration;
      }
    } catch (error) {
      this.logRateLimited("render.fadeOutAllFailed", error);
    }
  }

  getStats(): EngineStats {
    return {
      plants: this.plants.length,
      queued: this.spawnQueue.length,
      particles: this.lightParticles?.count ?? 0,
      effectObjects:
        (this.rain?.count ?? 0) +
        (this.fog?.count ?? 0) +
        (this.fireflies?.count ?? 0) +
        (this.lightOverlay?.count ?? 0) +
        (this.halos?.count ?? 0),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------------------------

  private setUpScene(app: Application, host: HTMLElement): void {
    const canvas = app.canvas;
    this.canvas = canvas;
    host.appendChild(canvas);

    app.stage.eventMode = "none";
    app.stage.interactiveChildren = false;

    const art = createPlantArt();
    this.art = art;
    const effectArt = createEffectArt();
    this.effectArt = effectArt;

    // Layer order: background, fog, plants, particles / rain / fireflies, light, dim.
    const backgroundLayer = new Container();
    const fogLayer = new Container();
    const plantLayer = new Container();
    plantLayer.sortableChildren = true;
    const effectLayer = new Container();
    const lightLayer = new Container();
    const background = new Graphics();
    const dimOverlay = new Graphics();
    dimOverlay.alpha = this.dimmed ? DIM_ALPHA : 0;
    backgroundLayer.addChild(background);
    app.stage.addChild(backgroundLayer);
    app.stage.addChild(fogLayer);
    app.stage.addChild(plantLayer);
    app.stage.addChild(effectLayer);
    app.stage.addChild(lightLayer);
    app.stage.addChild(dimOverlay);
    this.plantLayer = plantLayer;
    this.background = background;
    this.dimOverlay = dimOverlay;

    this.lightParticles = new LightParticles({
      layer: effectLayer,
      dotContext: art.particleDot,
      random: this.random,
    });
    this.rain = new RainEffect({
      layer: effectLayer,
      streakContext: effectArt.rainStreak,
      random: this.random,
    });
    this.fog = new FogEffect({
      layer: fogLayer,
      blobContext: effectArt.fogBlob,
      random: this.random,
    });
    this.fireflies = new FireflyEffect({
      layer: effectLayer,
      bodyContext: effectArt.glowDot,
      haloContext: effectArt.halo,
      random: this.random,
    });
    this.lightOverlay = new LightOverlay(lightLayer);
    this.halos = new GlowHalos(effectArt.halo);
    this.sceneEffects = [this.fog, this.lightParticles, this.rain, this.fireflies, this.lightOverlay];

    const palette = this.computePalette();
    this.palette = palette;
    this.applyPalette(palette);
    this.layout();

    app.renderer.on("resize", this.onResize);
    canvas.addEventListener("webglcontextlost", this.onContextLostEvent);
    canvas.addEventListener("webglcontextrestored", this.onContextRestoredEvent);
    // Uncapped requestAnimationFrame runs at the display rate (360 Hz was observed); 60 FPS is enough.
    app.ticker.maxFPS = RENDER.MAX_FPS;
    app.ticker.add(this.update);
    this.state = "running";
    if (this.paused) this.applyPaused();
  }

  private readonly onResize = (): void => {
    if (!this.isRunning) return;
    try {
      this.layout();
    } catch (error) {
      this.logRateLimited("render.resizeFailed", error);
    }
  };

  private readonly onContextLostEvent = (event: Event): void => {
    // Allow the browser to restore the context if it can.
    event.preventDefault();
    logger.error("render.contextLost");
    if (this.contextLostReported) return;
    this.contextLostReported = true;
    try {
      this.onContextLost?.();
    } catch (error) {
      logger.warn("render.contextLostCallbackFailed", { name: errorName(error) });
    }
  };

  private readonly onContextRestoredEvent = (): void => {
    logger.info("render.contextRestored");
  };

  private groundY(): number {
    return this.height * GROUND_RATIO;
  }

  /** Redraw the static background and reposition plants. No-op while the size is 0 (minimized). */
  private layout(): void {
    const app = this.app;
    if (app === null) return;
    const width = app.screen.width;
    const height = app.screen.height;
    if (!(width > 0) || !(height > 0)) return;
    this.width = width;
    this.height = height;
    this.drawBackground(width, height);
    for (const effect of this.sceneEffects) effect.setArea(width, height, this.groundY());
    for (const plant of this.plants) this.placePlant(plant);
  }

  private computePalette(): SkyPalette {
    const { theme, effects } = this.settings;
    return skyPalette(theme, this.environment.dayPhase, this.environment.climate, {
      dayNight: effects.dayNightCycle,
      climate: effects.climate,
    });
  }

  private drawBackground(width: number, height: number): void {
    const background = this.background;
    const dimOverlay = this.dimOverlay;
    const palette = this.palette;
    if (background === null || dimOverlay === null || palette === null) return;
    const groundY = this.groundY();

    background.clear();
    for (let band = 0; band < BACKGROUND_BANDS; band += 1) {
      const top = Math.floor((groundY * band) / BACKGROUND_BANDS);
      const bottom = Math.ceil((groundY * (band + 1)) / BACKGROUND_BANDS);
      const color = lerpColor(palette.skyTop, palette.skyHorizon, band / (BACKGROUND_BANDS - 1));
      background.rect(0, top, width, bottom - top).fill({ color });
    }
    background.ellipse(width / 2, groundY, width * 0.6, height * 0.12).fill({
      color: palette.groundGlow,
      alpha: 0.1,
    });
    background.rect(0, groundY, width, height - groundY).fill({ color: palette.ground });
    for (const mound of MOUNDS) {
      background
        .ellipse(width * mound.x, groundY, width * mound.radiusX, mound.radiusY)
        .fill({ color: palette.ground });
    }
    background.rect(0, groundY, width, 2).fill({ color: palette.groundEdge, alpha: 0.5 });

    dimOverlay.clear();
    dimOverlay.rect(0, 0, width, height).fill({ color: 0x000000 });
  }

  private placePlant(plant: PlantObject): void {
    const y = this.groundY() + plant.depth * this.height * GROUND_BAND_RATIO;
    plant.view.position.set(plant.xRatio * this.width, y);
    plant.view.zIndex = y;
  }

  // ---------------------------------------------------------------------------------------------
  // Frame update (single ticker callback)
  // ---------------------------------------------------------------------------------------------

  private readonly update = (ticker: Pick<Ticker, "deltaMS">): void => {
    if (!this.isRunning) return;
    try {
      const deltaMs = clamp(ticker.deltaMS, 0, MAX_FRAME_DELTA_MS);
      this.frameDeltaMs = Number.isFinite(deltaMs) ? deltaMs : 0;
      this.motionTimeMs += this.frameDeltaMs * this.settings.animationSpeed;
      this.runStep("render.environmentFailed", this.stepEnvironment);
      this.runStep("render.paletteFailed", this.stepPalette);
      this.runStep("render.spawnFailed", this.stepSpawn);
      this.runStep("render.plantsFailed", this.stepPlants);
      this.runStep("render.effectsFailed", this.stepEffects);
      this.runStep("render.dimFailed", this.stepDim);
    } catch (error) {
      this.logRateLimited("render.updateFailed", error);
    }
  };

  private runStep(label: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.logRateLimited(label, error);
    }
  }

  /** Smooth the environment towards its target (flow rate keeps its 5 s constant, DESIGN §16). */
  private readonly stepEnvironment = (): void => {
    const dt = this.frameDeltaMs;
    const current = this.environment.weather;
    const target = this.targetEnvironment.weather;
    current.postsPerMinute = approach(current.postsPerMinute, target.postsPerMinute, dt, FLOW.SMOOTHING_MS);
    current.rain = approach(current.rain, target.rain, dt, ENVIRONMENT_SMOOTHING_MS);
    current.wind = approach(current.wind, target.wind, dt, ENVIRONMENT_SMOOTHING_MS);
    current.light = approach(current.light, target.light, dt, ENVIRONMENT_SMOOTHING_MS);
    current.fog = approach(current.fog, target.fog, dt, ENVIRONMENT_SMOOTHING_MS);
    current.fireflies = approach(current.fireflies, target.fireflies, dt, ENVIRONMENT_SMOOTHING_MS);

    // Shortest way round the clock so 23:59 -> 00:01 does not sweep through the whole day.
    let delta = this.targetEnvironment.dayPhase - this.environment.dayPhase;
    if (delta > 0.5) delta -= 1;
    else if (delta < -0.5) delta += 1;
    if (delta !== 0) {
      const next = this.environment.dayPhase + delta * (1 - Math.exp(-dt / DAY_PHASE_SMOOTHING_MS));
      this.environment.dayPhase = Math.abs(delta) < 1e-6 ? this.targetEnvironment.dayPhase : wrapDayPhase(next);
    }

    this.windFactor = approach(this.windFactor, this.computeWindFactor(), dt, WIND_SMOOTHING_MS);
  };

  /** Sway multiplier: (1 + weather.wind) * windIntensity plus a slow gust; 1 (MVP) when wind is off. */
  private computeWindFactor(): number {
    if (!this.settings.effects.wind) return 1;
    const { wind } = this.environment.weather;
    const intensity = this.settings.windIntensity;
    const gust = Math.max(
      0,
      Math.sin(this.motionTimeMs * 0.00031) * Math.sin(this.motionTimeMs * 0.00077 + 1),
    );
    return (1 + wind) * intensity + wind * intensity * WIND_GUST_RATIO * gust;
  }

  /** Re-evaluate the palette a few times per second; redraw the background only past the epsilon. */
  private readonly stepPalette = (): void => {
    this.paletteTimerMs += this.frameDeltaMs;
    if (!this.paletteDirty && this.paletteTimerMs < PALETTE_INTERVAL_MS) return;
    this.paletteTimerMs = 0;
    const next = this.computePalette();
    const previous = this.palette;
    this.paletteDirty = false;
    if (previous !== null && paletteDistance(next, previous) < PALETTE_EPSILON) return;
    this.palette = next;
    this.applyPalette(next);
  };

  private applyPalette(palette: SkyPalette): void {
    if (this.plantLayer !== null) this.plantLayer.tint = palette.ambientTint;
    const weatherTint = lerpColor(palette.skyHorizon, WHITE, WEATHER_TINT_MIX);
    this.lightParticles?.setTint(palette.particleTint);
    this.fog?.setTint(weatherTint);
    this.rain?.setTint(weatherTint);
    if (this.width > 0 && this.height > 0) this.drawBackground(this.width, this.height);
  }

  private readonly stepSpawn = (): void => {
    this.shrinkToMaxPlants();
    this.drainSpawnQueue(this.frameDeltaMs);
  };

  private readonly stepPlants = (): void => {
    const dt = this.frameDeltaMs;
    for (let index = this.plants.length - 1; index >= 0; index -= 1) {
      const plant = this.plants[index];
      if (plant === undefined) continue;
      let alive = false;
      try {
        alive = this.advancePlant(plant, dt);
      } catch (error) {
        this.logRateLimited("render.plantUpdateFailed", error);
      }
      if (!alive) this.removePlantAt(index);
    }
  };

  private readonly stepEffects = (): void => {
    const env: EnvironmentState = this.environment;
    const settings = this.settings;
    const dt = this.frameDeltaMs;
    for (const effect of this.sceneEffects) {
      try {
        effect.update(dt, env, settings);
      } catch (error) {
        this.logRateLimited("render.effectUpdateFailed", error);
      }
    }
    try {
      this.halos?.update(dt, env, settings);
      this.syncHalos();
    } catch (error) {
      this.logRateLimited("render.haloUpdateFailed", error);
    }
  };

  private readonly stepDim = (): void => {
    const overlay = this.dimOverlay;
    if (overlay === null) return;
    const target = this.dimmed ? DIM_ALPHA : 0;
    overlay.alpha += (target - overlay.alpha) * (1 - Math.exp(-this.frameDeltaMs / DIM_SMOOTHING_MS));
  };

  private advancePlant(plant: PlantObject, dtMs: number): boolean {
    plant.ageMs += dtMs;
    plant.growthAgeMs += dtMs * this.settings.animationSpeed;
    if (plant.targetScale !== plant.goalScale) {
      plant.targetScale = approach(plant.targetScale, plant.goalScale, dtMs, GROW_TARGET_SMOOTHING_MS);
      if (Math.abs(plant.goalScale - plant.targetScale) < 1e-3) plant.targetScale = plant.goalScale;
    }
    const result = evaluatePlant(plant);
    if (result.phase === "dead") return false;
    plant.view.scale.set(result.scale);
    plant.view.alpha = result.alpha;
    plant.view.rotation = plant.lean + windSway(this.motionTimeMs, plant.swayPhase, this.windFactor);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Bloom-lite halos on flowers
  // ---------------------------------------------------------------------------------------------

  /** Attach halos when bloom turns on; forget the references once the faded-out halos were released. */
  private syncHalos(): void {
    const halos = this.halos;
    if (halos === null) return;
    const enabled = halos.isEnabled;
    if (enabled && !this.bloomWasEnabled) {
      for (const plant of this.plants) this.attachHalo(plant);
    }
    this.bloomWasEnabled = enabled;
    if (!enabled && halos.count === 0 && this.haloPlantsAttached) {
      for (const plant of this.plants) plant.halo = null;
      this.haloPlantsAttached = false;
    }
  }

  private attachHalo(plant: PlantObject): void {
    if (plant.mood !== "positive" || plant.halo !== null || this.halos === null) return;
    plant.halo = this.halos.attach(plant.view, 0, FLOWER_OFFSET_Y, plant.color);
    if (plant.halo !== null) this.haloPlantsAttached = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Spawn queue and plant cap
  // ---------------------------------------------------------------------------------------------

  /** After maxPlants was lowered: fade the oldest out gradually, never more than SPAWN_PER_SECOND at once. */
  private shrinkToMaxPlants(): void {
    const excess = this.plants.length - this.settings.maxPlants;
    if (excess > 0) this.evictOldest(Math.min(excess, PLANT.SPAWN_PER_SECOND));
  }

  private drainSpawnQueue(dtMs: number): void {
    if (this.spawnQueue.length === 0) {
      this.spawnAccumulator = 0;
      return;
    }
    // Capped at one plant per frame so a large backlog never bursts onto the screen.
    this.spawnAccumulator = Math.min(this.spawnAccumulator + (dtMs * PLANT.SPAWN_PER_SECOND) / 1000, 1);

    if (this.plants.length >= this.settings.maxPlants) {
      this.evictOldest(Math.min(this.spawnQueue.length, PLANT.SPAWN_PER_SECOND));
      this.spawnAccumulator = 0;
      return;
    }
    if (this.spawnAccumulator < 1) return;
    this.spawnAccumulator -= 1;
    const seed = this.spawnQueue.shift();
    if (seed !== undefined) this.spawnPlant(seed);
  }

  /** Ensure up to `wanted` of the oldest plants are fading out early. */
  private evictOldest(wanted: number): void {
    let evicting = 0;
    for (const plant of this.plants) if (plant.evictAtAgeMs !== null) evicting += 1;
    for (const plant of this.plants) {
      if (evicting >= wanted) return;
      if (plant.evictAtAgeMs !== null) continue;
      plant.evictAtAgeMs = plant.ageMs;
      evicting += 1;
    }
  }

  private spawnPlant(seed: PlantSeed): void {
    const art = this.art;
    const layer = this.plantLayer;
    if (art === null || layer === null) return;

    const color = Number.isFinite(seed.color) ? seed.color & 0xffffff : DEFAULT_PLANT_COLOR;
    const view = buildPlantView({ mood: seed.mood, color }, art, this.random);
    const goalScale = clamp(seed.scale, PLANT.SCALE_MIN, PLANT.SCALE_MAX);
    const plant: PlantObject = {
      id: seed.id,
      view,
      mood: seed.mood,
      color,
      lifeMs: lifeMsFor(this.random, this.settings.plantLifetimeMs),
      growthDurationMs: clamp(seed.growthDurationMs, PLANT.GROWTH_MIN_MS, PLANT.GROWTH_BASE_MS),
      targetScale: goalScale,
      goalScale,
      swayPhase: this.random() * Math.PI * 2,
      lean: (this.random() * 2 - 1) * PLANT_LEAN_RANGE,
      xRatio: PLANT_X_MARGIN + this.random() * (1 - 2 * PLANT_X_MARGIN),
      depth: this.random(),
      ageMs: 0,
      growthAgeMs: 0,
      evictAtAgeMs: null,
      halo: null,
    };
    view.scale.set(PLANT.INITIAL_SCALE);
    view.alpha = 0;
    this.placePlant(plant);
    layer.addChild(view);
    this.attachHalo(plant);
    this.plants.push(plant);
    this.indexSpawned(seed, plant);
  }

  /** The seed left the queue and became a plant. A newer queued seed with the same id keeps its entry. */
  private indexSpawned(seed: PlantSeed, plant: PlantObject): void {
    const existing = this.plantIndex.get(seed.id);
    if (existing === undefined || existing.kind === "plant" || existing.seed === seed) {
      this.plantIndex.set(seed.id, { kind: "plant", plant });
    }
  }

  private forgetQueued(seed: PlantSeed): void {
    const entry = this.plantIndex.get(seed.id);
    if (entry !== undefined && entry.kind === "queued" && entry.seed === seed) {
      this.plantIndex.delete(seed.id);
    }
  }

  private removePlantAt(index: number): void {
    const plant = this.plants[index];
    if (plant === undefined) return;
    this.releasePlant(plant);
    this.plants.splice(index, 1);
  }

  /** Drop every reference to the plant, then destroy its view (which owns the halo). */
  private releasePlant(plant: PlantObject): void {
    const entry = this.plantIndex.get(plant.id);
    if (entry !== undefined && entry.kind === "plant" && entry.plant === plant) {
      this.plantIndex.delete(plant.id);
    }
    this.halos?.detach(plant.halo);
    plant.halo = null;
    this.destroyView(plant.view);
  }

  private destroyView(view: Container): void {
    try {
      view.removeFromParent();
      view.destroy({ children: true });
    } catch (error) {
      logger.warn("plant.destroyFailed", { name: errorName(error) });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Teardown (DESIGN §13.7): every step guarded, always reaches app.destroy.
  // ---------------------------------------------------------------------------------------------

  private teardown(): void {
    this.state = "destroyed";
    const app = this.app;
    const canvas = this.canvas;

    this.attempt("ticker.remove", () => {
      app?.ticker.remove(this.update);
    });
    this.attempt("listeners.remove", () => {
      app?.renderer.off("resize", this.onResize);
    });
    this.attempt("canvasListeners.remove", () => {
      canvas?.removeEventListener("webglcontextlost", this.onContextLostEvent);
      canvas?.removeEventListener("webglcontextrestored", this.onContextRestoredEvent);
    });
    this.attempt("halos.destroy", () => {
      this.halos?.destroy();
    });
    this.attempt("particles.destroy", () => {
      this.lightParticles?.destroy();
    });
    this.attempt("rain.destroy", () => {
      this.rain?.destroy();
    });
    this.attempt("fog.destroy", () => {
      this.fog?.destroy();
    });
    this.attempt("fireflies.destroy", () => {
      this.fireflies?.destroy();
    });
    this.attempt("lightOverlay.destroy", () => {
      this.lightOverlay?.destroy();
    });
    this.attempt("plants.destroy", () => {
      for (const plant of this.plants) this.destroyView(plant.view);
    });
    this.plants = [];
    this.spawnQueue = [];
    this.plantIndex.clear();
    this.sceneEffects = [];
    this.attempt("background.destroy", () => {
      this.destroyOwnedGraphics(this.background);
    });
    this.attempt("dimOverlay.destroy", () => {
      this.destroyOwnedGraphics(this.dimOverlay);
    });
    this.attempt("plantArt.destroy", () => {
      this.art?.destroy();
    });
    this.attempt("effectArt.destroy", () => {
      this.effectArt?.destroy();
    });
    this.attempt("app.destroy", () => {
      app?.destroy({ removeView: true }, { children: true });
    });
    this.attempt("canvas.remove", () => {
      if (canvas?.parentNode) canvas.remove();
    });

    this.app = null;
    this.canvas = null;
    this.art = null;
    this.effectArt = null;
    this.plantLayer = null;
    this.background = null;
    this.dimOverlay = null;
    this.lightParticles = null;
    this.rain = null;
    this.fog = null;
    this.fireflies = null;
    this.lightOverlay = null;
    this.halos = null;
  }

  /** Graphics with their own (non-shared) context: safe to destroy the context too. */
  private destroyOwnedGraphics(graphics: Graphics | null): void {
    if (graphics === null) return;
    graphics.removeFromParent();
    graphics.destroy({ context: true });
  }

  private attempt(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      logger.warn("render.teardownStepFailed", { step: label, name: errorName(error) });
    }
  }

  private logRateLimited(event: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < RENDER.ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    logger.error(event, { name: errorName(error) });
  }
}

function defaultResolution(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, RENDER.MAX_RESOLUTION) : 1;
}
