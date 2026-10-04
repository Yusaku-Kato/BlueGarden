/**
 * Three.js terrarium (docs/DESIGN.md §34-§38, ADR-13, Q-10). Same contract and state machine as the
 * PixiJS TerrariumEngine: receives only PlantSeed, EnvironmentState and RenderSettings and never
 * throws from public methods. Loaded lazily through loadRenderer().
 *
 * Art direction (Q-10): low-poly look carrying over the 2D palette, a slightly raised camera with a
 * slow drift, bloom on flowers and fireflies only, a weak depth of field.
 */
import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FLOW, PLANT, RENDER, SETTINGS } from "../../config/gardenConfig";
import type { EnvironmentState, PlantSeed, RenderSettings } from "../../domain/models";
import { errorName, logger } from "../../infra/logger";
import { approach } from "../effects/EnvironmentEffect";
import { clamp, evaluatePlant, lifeMsFor } from "../plantLifecycle";
import {
  DEFAULT_RENDER_SETTINGS,
  createCalmEnvironment,
  sanitizeRenderSettings,
  wrapDayPhase,
  writeEnvironment,
} from "../renderInputs";
import type { MutableEnvironment } from "../renderInputs";
import { effectiveDayPhase, lerpColor, skyPalette } from "../skyPalette";
import type { SkyPalette } from "../skyPalette";
import { RenderInitError, clampFadeOutAllMs } from "../TerrariumRenderer";
import type { EngineStats, RendererOptions, TerrariumRenderer } from "../TerrariumRenderer";
import {
  computeBloomStrength,
  computeFlowerGlow,
  computeFogDensity,
  computeLighting,
} from "./atmosphere";
import { Fireflies3D } from "./effects/Fireflies3D";
import { LightParticles3D } from "./effects/LightParticles3D";
import { Rain3D } from "./effects/Rain3D";
import type { GardenArea, ThreeEffect } from "./effects/types";
import { PlantMeshes } from "./plantMeshes";
import type { PlantInstance, PlantPlacement } from "./plantMeshes";
import { SkyDome } from "./skyDome";
import { Ground, groundHeight } from "./terrain";

export { RenderInitError };
export type { EngineStats };

export type ThreeTerrariumEngineOptions = RendererOptions;

type EngineState = "idle" | "initializing" | "running" | "destroyed";

interface PlantLayout {
  readonly xRatio: number;
  /** 0 (front) .. 1 (back) position within the garden depth. */
  readonly depth: number;
  readonly yaw: number;
  readonly lean: number;
}

interface PlantObject extends PlantLayout {
  readonly id: string;
  readonly mood: PlantSeed["mood"];
  readonly instance: PlantInstance;
  readonly lifeMs: number;
  readonly growthDurationMs: number;
  /** The scale the growth tween is heading to right now (follows goalScale smoothly). */
  targetScale: number;
  /** Requested final scale. growPlant only ever raises it. */
  goalScale: number;
  ageMs: number;
  /** Age for the growth tween only; advances with animationSpeed (lifetime does not). */
  growthAgeMs: number;
  evictAtAgeMs: number | null;
  /** Per-plant eviction fade; undefined means PLANT.EVICTION_FADE_MS. */
  evictFadeMs?: number;
}

type IndexEntry =
  | { readonly kind: "queued"; readonly seed: PlantSeed }
  | { readonly kind: "plant"; readonly plant: PlantObject };

// Purely visual layout constants.
const MAX_FRAME_DELTA_MS = 250;
const MIN_FRAME_INTERVAL_MS = 1000 / RENDER.MAX_FPS - 1.5;
const DIM_OPACITY = 0.4;
const DIM_SMOOTHING_MS = 300;
const PLANT_LEAN_RANGE = 0.12;
const PLANT_X_MARGIN = 0.03;
const PLANT_WORLD_SCALE = 1.5;
const PLANT_Z_NEAR = 2.2;
const PLANT_Z_FAR = -6.5;
const DEFAULT_PLANT_COLOR = 0x81c784;
const ENVIRONMENT_SMOOTHING_MS = 2_500;
const DAY_PHASE_SMOOTHING_MS = 2_000;
const GROW_TARGET_SMOOTHING_MS = 700;
const WIND_SMOOTHING_MS = 500;
const WIND_GUST_RATIO = 0.8;
const PALETTE_INTERVAL_MS = 250;
const WEATHER_TINT_MIX = 0.55;
const LIGHT_UNIT = Math.PI; // three.js lights are in physical units: Lambert divides the irradiance by PI
const WHITE = 0xffffff;
const SUN_COLOR = 0xfff1d6;
const MOON_COLOR = 0x9fb4ff;
const LIGHT_DISTANCE = 30;

const CAMERA_FOV = 40;
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 220;
const CAMERA_BASE = new Vector3(0, 2.4, 10.5);
const CAMERA_TARGET = new Vector3(0, 1.5, -2);
const CAMERA_DRIFT_X = 1.4;
const CAMERA_DRIFT_Y = 0.35;
const CAMERA_DRIFT_Z = 0.7;
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 360;

const BLOOM_RADIUS = 0.55;
const BLOOM_THRESHOLD = 0.85;
const BOKEH_FOCUS = 11;
const BOKEH_APERTURE = 0.0006;
const BOKEH_MAX_BLUR = 0.005;
/** Depth of field is dropped for good when frames stay this slow for BOKEH_SLOW_WINDOW_MS. */
const BOKEH_SLOW_FRAME_MS = 24;
const BOKEH_SLOW_WINDOW_MS = 4_000;
const FRAME_TIME_SMOOTHING_MS = 1_000;

export class ThreeTerrariumEngine implements TerrariumRenderer {
  private state: EngineState = "idle";
  private readonly resolutionOverride: number | undefined;
  private readonly onContextLost: (() => void) | undefined;
  private readonly random: () => number;

  private host: HTMLElement | null = null;
  private renderer: WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private hemisphere: HemisphereLight | null = null;
  private sun: DirectionalLight | null = null;
  private fog: FogExp2 | null = null;
  private sky: SkyDome | null = null;
  private ground: Ground | null = null;
  private meshes: PlantMeshes | null = null;
  private lightParticles: LightParticles3D | null = null;
  private rain: Rain3D | null = null;
  private fireflies: Fireflies3D | null = null;
  private effects: ThreeEffect[] = [];
  private pixelScaleEffects: { setPixelScale(value: number): void }[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private windowResizeListening = false;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bokehPass: BokehPass | null = null;
  private outputPass: OutputPass | null = null;
  private postFailed = false;
  private bokehDropped = false;
  private slowFrameMs = 0;
  private frameTimeMs = 1000 / 60;

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
  private paletteDirty = true;
  private paletteTimerMs = 0;
  private dimmed = false;
  private dimLevel = 0;
  private paused = false;
  private width = FALLBACK_WIDTH;
  private height = FALLBACK_HEIGHT;
  private pixelRatio = 1;
  private lastFrameTime: number | null = null;
  private frameDeltaMs = 0;
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;
  private contextLostReported = false;

  private readonly scratchColor = new Color();
  private readonly scratchTint = new Color();

  constructor(options: ThreeTerrariumEngineOptions = {}) {
    this.resolutionOverride = options.resolution;
    this.onContextLost = options.onContextLost;
    this.random = options.random ?? Math.random;
  }

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
    // Yield once so a synchronous destroy() (React StrictMode) cancels before a WebGL context is created.
    await Promise.resolve();
    if (this.isDestroyed) return false;

    try {
      this.setUpScene(host);
    } catch (error) {
      logger.error("render.initFailed", { name: errorName(error) });
      this.teardown();
      throw new RenderInitError();
    }
    return true;
  }

  destroy(): void {
    if (this.state === "initializing" || this.state === "idle") {
      this.state = "destroyed"; // init() returns false when its yield settles
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
   * Stops (or restarts) the render loop, and with it rendering and plant aging, while the window is
   * hidden or minimized (docs/DESIGN.md ADR-07). A value set before init is applied when running.
   */
  setPaused(paused: boolean): void {
    if (this.isDestroyed) return;
    this.paused = paused;
    if (this.isRunning) this.applyPaused();
  }

  private applyPaused(): void {
    const renderer = this.renderer;
    if (renderer === null) return;
    try {
      this.lastFrameTime = null; // no jump when resuming
      renderer.setAnimationLoop(this.paused ? null : this.onFrame);
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
      effectObjects: (this.rain?.count ?? 0) + (this.fireflies?.count ?? 0),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------------------------

  private setUpScene(host: HTMLElement): void {
    this.host = host;
    this.pixelRatio = this.resolutionOverride ?? defaultResolution();
    const size = measure(host);
    this.width = size.width;
    this.height = size.height;

    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "default" });
    this.renderer = renderer;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(this.width, this.height);
    const canvas = renderer.domElement;
    this.canvas = canvas;
    canvas.style.display = "block";
    canvas.style.opacity = this.dimmed ? String(1 - DIM_OPACITY) : "1";
    host.appendChild(canvas);

    const scene = new Scene();
    this.scene = scene;
    const camera = new PerspectiveCamera(CAMERA_FOV, this.width / this.height, CAMERA_NEAR, CAMERA_FAR);
    camera.position.copy(CAMERA_BASE);
    camera.lookAt(CAMERA_TARGET);
    this.camera = camera;

    const palette = this.computePalette();
    const fog = new FogExp2(palette.skyHorizon, computeFogDensity(0, null, false));
    this.fog = fog;
    scene.fog = fog;

    const hemisphere = new HemisphereLight(palette.skyHorizon, palette.ground, 1);
    const sun = new DirectionalLight(SUN_COLOR, 1);
    scene.add(hemisphere);
    scene.add(sun);
    this.hemisphere = hemisphere;
    this.sun = sun;

    this.sky = new SkyDome(scene);
    this.ground = new Ground(scene);
    this.meshes = new PlantMeshes(scene, SETTINGS.MAX_PLANTS.MAX);

    const lightParticles = new LightParticles3D(scene, this.random);
    const rain = new Rain3D(scene, this.random);
    const fireflies = new Fireflies3D(scene, this.random);
    this.lightParticles = lightParticles;
    this.rain = rain;
    this.fireflies = fireflies;
    this.effects = [lightParticles, rain, fireflies];
    this.pixelScaleEffects = [lightParticles, fireflies];

    this.layout();
    this.applyPalette(palette);

    canvas.addEventListener("webglcontextlost", this.onContextLostEvent);
    canvas.addEventListener("webglcontextrestored", this.onContextRestoredEvent);
    this.observeSize(host);
    this.state = "running";
    renderer.setAnimationLoop(this.paused ? null : this.onFrame);
  }

  private observeSize(host: HTMLElement): void {
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(this.onResize);
      observer.observe(host);
      this.resizeObserver = observer;
      return;
    }
    window.addEventListener("resize", this.onResize);
    this.windowResizeListening = true;
  }

  private readonly onResize = (): void => {
    if (!this.isRunning) return;
    try {
      const host = this.host;
      if (host === null) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!(width > 0) || !(height > 0)) return; // minimized: keep the last size
      if (width === this.width && height === this.height) return;
      this.width = width;
      this.height = height;
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

  /** Apply the current size to the renderer, camera, composer, effects and plant positions. */
  private layout(): void {
    const renderer = this.renderer;
    const camera = this.camera;
    if (renderer === null || camera === null) return;
    renderer.setSize(this.width, this.height);
    camera.aspect = this.width / this.height;
    camera.updateProjectionMatrix();
    this.composer?.setSize(this.width, this.height);

    const area = this.gardenArea();
    const pixelScale = (this.height * this.pixelRatio) / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
    for (const effect of this.effects) effect.setArea(area);
    for (const effect of this.pixelScaleEffects) effect.setPixelScale(pixelScale);
    for (const plant of this.plants) this.meshes?.place(plant.instance, this.placementOf(plant));
  }

  private visibleHalfWidth(z: number): number {
    const distance = Math.max(1, CAMERA_BASE.z - z);
    return Math.tan((CAMERA_FOV * Math.PI) / 360) * (this.width / this.height) * distance;
  }

  private gardenArea(): GardenArea {
    return {
      halfWidth: this.visibleHalfWidth((PLANT_Z_NEAR + PLANT_Z_FAR) / 2),
      zNear: PLANT_Z_NEAR,
      zFar: PLANT_Z_FAR,
    };
  }

  private placementOf(plant: PlantLayout): PlantPlacement {
    const z = PLANT_Z_NEAR - plant.depth * (PLANT_Z_NEAR - PLANT_Z_FAR);
    const x = (plant.xRatio * 2 - 1) * this.visibleHalfWidth(z) * (1 - 2 * PLANT_X_MARGIN);
    return { x, y: groundHeight(x, z), z, yaw: plant.yaw, lean: plant.lean };
  }

  private computePalette(): SkyPalette {
    const { theme, effects } = this.settings;
    return skyPalette(theme, this.environment.dayPhase, this.environment.climate, {
      dayNight: effects.dayNightCycle,
      climate: effects.climate,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Frame update (single render loop callback)
  // ---------------------------------------------------------------------------------------------

  private readonly onFrame = (time: number): void => {
    if (!this.isRunning) return;
    try {
      if (!Number.isFinite(time)) return;
      const previous = this.lastFrameTime;
      if (previous !== null && time - previous < MIN_FRAME_INTERVAL_MS) return; // 60 FPS cap
      const deltaMs = previous === null ? 0 : clamp(time - previous, 0, MAX_FRAME_DELTA_MS);
      this.lastFrameTime = time;
      this.frameDeltaMs = Number.isFinite(deltaMs) ? deltaMs : 0;
      this.motionTimeMs += this.frameDeltaMs * this.settings.animationSpeed;
      this.runStep("render.environmentFailed", this.stepEnvironment);
      this.runStep("render.paletteFailed", this.stepPalette);
      this.runStep("render.atmosphereFailed", this.stepAtmosphere);
      this.runStep("render.spawnFailed", this.stepSpawn);
      this.runStep("render.plantsFailed", this.stepPlants);
      this.runStep("render.effectsFailed", this.stepEffects);
      this.runStep("render.cameraFailed", this.stepCamera);
      this.runStep("render.dimFailed", this.stepDim);
      this.runStep("render.postFailed", this.stepFrameTime);
      this.runStep("render.drawFailed", this.draw);
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

  /** Re-evaluate the palette a few times per second (nothing is redrawn, only colors are set). */
  private readonly stepPalette = (): void => {
    this.paletteTimerMs += this.frameDeltaMs;
    if (!this.paletteDirty && this.paletteTimerMs < PALETTE_INTERVAL_MS) return;
    this.paletteTimerMs = 0;
    this.paletteDirty = false;
    const next = this.computePalette();
    this.applyPalette(next);
  };

  private applyPalette(palette: SkyPalette): void {
    this.sky?.setColors(palette.skyTop, palette.skyHorizon);
    this.fog?.color.setHex(palette.skyHorizon);
    this.renderer?.setClearColor(palette.skyHorizon);
    this.ground?.setColor(lerpColor(palette.ground, palette.groundEdge, 0.6));
    this.hemisphere?.color.setHex(lerpColor(palette.skyHorizon, WHITE, 0.45));
    this.hemisphere?.groundColor.setHex(lerpColor(palette.ground, palette.groundEdge, 0.5));
    const weatherTint = lerpColor(palette.skyHorizon, WHITE, WEATHER_TINT_MIX);
    this.lightParticles?.setTint(palette.particleTint);
    this.rain?.setTint(weatherTint);
    this.applySunColor(palette);
  }

  private applySunColor(palette: SkyPalette): void {
    const sun = this.sun;
    if (sun === null) return;
    const { theme, effects } = this.settings;
    const phase = effectiveDayPhase(theme, this.environment.dayPhase, effects.dayNightCycle);
    const lighting = computeLighting(phase, this.environment.weather.light, null);
    this.scratchColor.setHex(lerpColor(MOON_COLOR, SUN_COLOR, lighting.day));
    this.scratchTint.setHex(palette.ambientTint);
    sun.color.copy(this.scratchColor).multiply(this.scratchTint);
  }

  /** Light intensities, fog density, bloom strength and flower glow follow the environment every frame. */
  private readonly stepAtmosphere = (): void => {
    const hemisphere = this.hemisphere;
    const sun = this.sun;
    const fog = this.fog;
    const meshes = this.meshes;
    if (hemisphere === null || sun === null || fog === null || meshes === null) return;
    const { theme, effects } = this.settings;
    const phase = effectiveDayPhase(theme, this.environment.dayPhase, effects.dayNightCycle);
    const climate = effects.climate ? this.environment.climate : null;
    const weather = this.environment.weather;
    const lighting = computeLighting(phase, weather.light, climate);
    hemisphere.intensity = lighting.hemisphereIntensity * LIGHT_UNIT;
    sun.intensity = lighting.directionalIntensity * LIGHT_UNIT;
    sun.position.set(
      lighting.directionX * LIGHT_DISTANCE,
      lighting.directionY * LIGHT_DISTANCE,
      lighting.directionZ * LIGHT_DISTANCE,
    );
    fog.density = computeFogDensity(weather.fog, climate, effects.fog);
    meshes.uniforms.uGlow.value = computeFlowerGlow(lighting.night, effects.bloom);
    if (this.bloomPass !== null) this.bloomPass.strength = computeBloomStrength(lighting.night);
  };

  private readonly stepSpawn = (): void => {
    this.shrinkToMaxPlants();
    this.drainSpawnQueue(this.frameDeltaMs);
  };

  private readonly stepPlants = (): void => {
    const dt = this.frameDeltaMs;
    const meshes = this.meshes;
    if (meshes === null) return;
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
    meshes.uniforms.uTime.value = (this.motionTimeMs * PLANT.WIND_SPEED) % (Math.PI * 2);
    meshes.uniforms.uWind.value = this.windFactor;
    meshes.flush();
  };

  private readonly stepEffects = (): void => {
    const env: EnvironmentState = this.environment;
    const settings = this.settings;
    const dt = this.frameDeltaMs;
    for (const effect of this.effects) {
      try {
        effect.update(dt, env, settings);
      } catch (error) {
        this.logRateLimited("render.effectUpdateFailed", error);
      }
    }
  };

  /** Slow drift of the camera around its base position. */
  private readonly stepCamera = (): void => {
    const camera = this.camera;
    if (camera === null) return;
    const t = this.motionTimeMs;
    camera.position.set(
      CAMERA_BASE.x + Math.sin(t * 0.00011) * CAMERA_DRIFT_X,
      CAMERA_BASE.y + Math.sin(t * 0.00017 + 1) * CAMERA_DRIFT_Y,
      CAMERA_BASE.z + Math.cos(t * 0.00009) * CAMERA_DRIFT_Z,
    );
    camera.lookAt(CAMERA_TARGET);
    this.sky?.follow(camera.position.x, camera.position.y, camera.position.z);
  };

  private readonly stepDim = (): void => {
    const canvas = this.canvas;
    if (canvas === null) return;
    const target = this.dimmed ? 1 : 0;
    if (this.dimLevel === target) return;
    const next = approach(this.dimLevel, target, this.frameDeltaMs, DIM_SMOOTHING_MS);
    this.dimLevel = Math.abs(target - next) < 0.002 ? target : next;
    canvas.style.opacity = String(1 - DIM_OPACITY * this.dimLevel);
  };

  /** Drops the depth of field for good when frames stay slow (it renders the scene twice). */
  private readonly stepFrameTime = (): void => {
    const bokeh = this.bokehPass;
    if (bokeh === null || !bokeh.enabled || this.bokehDropped) return;
    const dt = this.frameDeltaMs;
    if (dt <= 0) return;
    this.frameTimeMs = approach(this.frameTimeMs, dt, dt, FRAME_TIME_SMOOTHING_MS);
    if (this.frameTimeMs > BOKEH_SLOW_FRAME_MS) this.slowFrameMs += dt;
    else this.slowFrameMs = 0;
    if (this.slowFrameMs > BOKEH_SLOW_WINDOW_MS) {
      this.bokehDropped = true;
      bokeh.enabled = false;
      logger.warn("render.bokehDisabled");
    }
  };

  private readonly draw = (): void => {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (renderer === null || scene === null || camera === null) return;
    if (this.settings.effects.bloom && !this.postFailed) {
      const composer = this.ensureComposer();
      if (composer !== null) {
        composer.render(this.frameDeltaMs / 1000);
        return;
      }
    }
    renderer.render(scene, camera);
  };

  /** Post-processing is created on first use. A failure falls back to plain rendering for good. */
  private ensureComposer(): EffectComposer | null {
    if (this.composer !== null) return this.composer;
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (renderer === null || scene === null || camera === null) return null;
    try {
      const composer = new EffectComposer(renderer);
      this.composer = composer;
      this.renderPass = new RenderPass(scene, camera);
      composer.addPass(this.renderPass);
      this.bloomPass = new UnrealBloomPass(
        new Vector2(this.width, this.height),
        computeBloomStrength(1),
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      );
      composer.addPass(this.bloomPass);
      if (!this.bokehDropped) {
        this.bokehPass = new BokehPass(scene, camera, {
          focus: BOKEH_FOCUS,
          aperture: BOKEH_APERTURE,
          maxblur: BOKEH_MAX_BLUR,
        });
        composer.addPass(this.bokehPass);
      }
      this.outputPass = new OutputPass();
      composer.addPass(this.outputPass);
      composer.setSize(this.width, this.height);
      return composer;
    } catch (error) {
      this.postFailed = true;
      this.logRateLimited("render.composerFailed", error);
      this.disposeComposer();
      return null;
    }
  }

  private disposeComposer(): void {
    this.attempt("renderPass.dispose", () => {
      this.renderPass?.dispose();
    });
    this.attempt("bloomPass.dispose", () => {
      this.bloomPass?.dispose();
    });
    this.attempt("bokehPass.dispose", () => {
      this.bokehPass?.dispose();
    });
    this.attempt("outputPass.dispose", () => {
      this.outputPass?.dispose();
    });
    this.attempt("composer.dispose", () => {
      this.composer?.dispose();
    });
    this.renderPass = null;
    this.bloomPass = null;
    this.bokehPass = null;
    this.outputPass = null;
    this.composer = null;
  }

  private advancePlant(plant: PlantObject, dtMs: number): boolean {
    plant.ageMs += dtMs;
    plant.growthAgeMs += dtMs * this.settings.animationSpeed;
    if (plant.targetScale !== plant.goalScale) {
      plant.targetScale = approach(plant.targetScale, plant.goalScale, dtMs, GROW_TARGET_SMOOTHING_MS);
      if (Math.abs(plant.goalScale - plant.targetScale) < 1e-3) plant.targetScale = plant.goalScale;
    }
    const result = evaluatePlant(plant);
    if (result.phase === "dead") return false;
    this.meshes?.setAppearance(plant.instance, result.scale * PLANT_WORLD_SCALE, result.alpha);
    return true;
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
    const meshes = this.meshes;
    if (meshes === null) return;

    const color = Number.isFinite(seed.color) ? seed.color & 0xffffff : DEFAULT_PLANT_COLOR;
    const goalScale = clamp(seed.scale, PLANT.SCALE_MIN, PLANT.SCALE_MAX);
    const xRatio = PLANT_X_MARGIN + this.random() * (1 - 2 * PLANT_X_MARGIN);
    const depth = this.random();
    const yaw = this.random() * Math.PI * 2;
    const lean = (this.random() * 2 - 1) * PLANT_LEAN_RANGE;
    const variant = Math.floor(this.random() * Math.max(1, meshes.variantsOf(seed.mood)));
    const lifeMs = lifeMsFor(this.random, this.settings.plantLifetimeMs);
    const swayPhase = this.random() * Math.PI * 2;
    const swayStrength = 0.7 + this.random() * 0.6;

    const layout: PlantLayout = { xRatio, depth, yaw, lean };
    const instance = meshes.add(seed.mood, variant, this.placementOf(layout), {
      color,
      swayPhase,
      swayStrength,
    });
    if (instance === null) return; // batch full: drop the seed (cannot happen below the plant cap)
    const plant: PlantObject = {
      ...layout,
      id: seed.id,
      mood: seed.mood,
      instance,
      lifeMs,
      growthDurationMs: clamp(seed.growthDurationMs, PLANT.GROWTH_MIN_MS, PLANT.GROWTH_BASE_MS),
      targetScale: goalScale,
      goalScale,
      ageMs: 0,
      growthAgeMs: 0,
      evictAtAgeMs: null,
    };
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

  /** Free the instance slot and drop every reference to the plant. */
  private releasePlant(plant: PlantObject): void {
    const entry = this.plantIndex.get(plant.id);
    if (entry !== undefined && entry.kind === "plant" && entry.plant === plant) {
      this.plantIndex.delete(plant.id);
    }
    try {
      this.meshes?.remove(plant.instance);
    } catch (error) {
      logger.warn("plant.releaseFailed", { name: errorName(error) });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Teardown (DESIGN §36.6): every step guarded, always reaches renderer.dispose / forceContextLoss.
  // ---------------------------------------------------------------------------------------------

  private teardown(): void {
    this.state = "destroyed";
    const renderer = this.renderer;
    const canvas = this.canvas;

    this.attempt("loop.stop", () => {
      renderer?.setAnimationLoop(null);
    });
    this.attempt("resize.stop", () => {
      this.resizeObserver?.disconnect();
      if (this.windowResizeListening) window.removeEventListener("resize", this.onResize);
    });
    this.resizeObserver = null;
    this.windowResizeListening = false;
    this.attempt("canvasListeners.remove", () => {
      canvas?.removeEventListener("webglcontextlost", this.onContextLostEvent);
      canvas?.removeEventListener("webglcontextrestored", this.onContextRestoredEvent);
    });
    for (const effect of this.effects) {
      this.attempt("effect.dispose", () => {
        effect.dispose();
      });
    }
    this.plants = [];
    this.spawnQueue = [];
    this.plantIndex.clear();
    this.effects = [];
    this.pixelScaleEffects = [];
    this.attempt("plantMeshes.dispose", () => {
      this.meshes?.dispose();
    });
    this.attempt("ground.dispose", () => {
      this.ground?.dispose();
    });
    this.attempt("sky.dispose", () => {
      this.sky?.dispose();
    });
    this.attempt("lights.dispose", () => {
      this.hemisphere?.dispose();
      this.sun?.dispose();
    });
    this.attempt("scene.clear", () => {
      this.scene?.clear();
    });
    this.disposeComposer();
    this.attempt("renderer.dispose", () => {
      renderer?.dispose();
    });
    // The context-loss listener is already removed, so this does not report a loss to the owner.
    this.attempt("renderer.forceContextLoss", () => {
      renderer?.forceContextLoss();
    });
    this.attempt("canvas.remove", () => {
      canvas?.remove();
    });

    this.host = null;
    this.renderer = null;
    this.canvas = null;
    this.scene = null;
    this.camera = null;
    this.hemisphere = null;
    this.sun = null;
    this.fog = null;
    this.sky = null;
    this.ground = null;
    this.meshes = null;
    this.lightParticles = null;
    this.rain = null;
    this.fireflies = null;
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

function measure(host: HTMLElement): { width: number; height: number } {
  const width = host.clientWidth;
  const height = host.clientHeight;
  return {
    width: width > 0 ? width : FALLBACK_WIDTH,
    height: height > 0 ? height : FALLBACK_HEIGHT,
  };
}
