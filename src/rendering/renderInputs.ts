/**
 * Defensive normalization of the settings / environment that reach the renderer
 * (docs/DESIGN.md §35.1). Pure, no PixiJS import. Anything invalid falls back or is clamped;
 * nothing here throws.
 */
import { SETTINGS } from "../config/gardenConfig";
import type {
  EffectToggles,
  EnvironmentState,
  GardenClimate,
  GardenTheme,
  RenderSettings,
} from "../domain/models";

export const DEFAULT_EFFECTS: EffectToggles = {
  lightParticles: true,
  rain: true,
  wind: true,
  fog: true,
  fireflies: true,
  bloom: true,
  dayNightCycle: true,
  climate: true,
};

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  maxPlants: SETTINGS.MAX_PLANTS.DEFAULT,
  plantLifetimeMs: SETTINGS.PLANT_LIFETIME_MS.DEFAULT,
  animationSpeed: SETTINGS.ANIMATION_SPEED.DEFAULT,
  particleIntensity: SETTINGS.PARTICLE_INTENSITY.DEFAULT,
  windIntensity: SETTINGS.WIND_INTENSITY.DEFAULT,
  theme: "twilight",
  effects: DEFAULT_EFFECTS,
};

export interface MutableWeather {
  postsPerMinute: number;
  rain: number;
  wind: number;
  light: number;
  fog: number;
  fireflies: number;
}

/** Same shape as EnvironmentState, writable so the engine can smooth it in place without allocating. */
export interface MutableEnvironment {
  readonly weather: MutableWeather;
  dayPhase: number;
  climate: GardenClimate;
}

/** The engine's resting environment: nothing happening, resting at midnight (the MVP palette). */
export function createCalmEnvironment(): MutableEnvironment {
  return {
    weather: { postsPerMinute: 0, rain: 0, wind: 0, light: 0, fog: 0, fireflies: 0 },
    dayPhase: 0,
    climate: "temperate",
  };
}

const THEMES: readonly GardenTheme[] = ["twilight", "dawn", "moss", "nocturne"];
const CLIMATES: readonly GardenClimate[] = [
  "temperate",
  "rainyGarden",
  "bloomingGarden",
  "darkForest",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readTheme(value: unknown, fallback: GardenTheme): GardenTheme {
  return THEMES.find((theme) => theme === value) ?? fallback;
}

function readClimate(value: unknown, fallback: GardenClimate): GardenClimate {
  return CLIMATES.find((climate) => climate === value) ?? fallback;
}

function readEffects(value: unknown, fallback: EffectToggles): EffectToggles {
  if (!isRecord(value)) return fallback;
  return {
    lightParticles: readBoolean(value["lightParticles"], fallback.lightParticles),
    rain: readBoolean(value["rain"], fallback.rain),
    wind: readBoolean(value["wind"], fallback.wind),
    fog: readBoolean(value["fog"], fallback.fog),
    fireflies: readBoolean(value["fireflies"], fallback.fireflies),
    bloom: readBoolean(value["bloom"], fallback.bloom),
    dayNightCycle: readBoolean(value["dayNightCycle"], fallback.dayNightCycle),
    climate: readBoolean(value["climate"], fallback.climate),
  };
}

/** Clamp every field to its SETTINGS range; invalid fields keep the value from `fallback`. */
export function sanitizeRenderSettings(input: unknown, fallback: RenderSettings): RenderSettings {
  if (!isRecord(input)) return fallback;
  return {
    maxPlants: Math.floor(
      readNumber(
        input["maxPlants"],
        fallback.maxPlants,
        SETTINGS.MAX_PLANTS.MIN,
        SETTINGS.MAX_PLANTS.MAX,
      ),
    ),
    plantLifetimeMs: readNumber(
      input["plantLifetimeMs"],
      fallback.plantLifetimeMs,
      SETTINGS.PLANT_LIFETIME_MS.MIN,
      SETTINGS.PLANT_LIFETIME_MS.MAX,
    ),
    animationSpeed: readNumber(
      input["animationSpeed"],
      fallback.animationSpeed,
      SETTINGS.ANIMATION_SPEED.MIN,
      SETTINGS.ANIMATION_SPEED.MAX,
    ),
    particleIntensity: readNumber(
      input["particleIntensity"],
      fallback.particleIntensity,
      SETTINGS.PARTICLE_INTENSITY.MIN,
      SETTINGS.PARTICLE_INTENSITY.MAX,
    ),
    windIntensity: readNumber(
      input["windIntensity"],
      fallback.windIntensity,
      SETTINGS.WIND_INTENSITY.MIN,
      SETTINGS.WIND_INTENSITY.MAX,
    ),
    theme: readTheme(input["theme"], fallback.theme),
    effects: readEffects(input["effects"], fallback.effects),
  };
}

/** Wraps any finite value into [0, 1). Non-finite becomes 0. */
export function wrapDayPhase(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value - Math.floor(value);
}

/**
 * Copy a sanitized environment into `target`. Invalid fields keep the target's current value.
 * Returns nothing; allocation-free so it can be reused for the smoothed state too.
 */
export function writeEnvironment(target: MutableEnvironment, input: EnvironmentState): void {
  const source: unknown = input;
  if (!isRecord(source)) return;
  const weather = source["weather"];
  if (isRecord(weather)) {
    const to = target.weather;
    to.postsPerMinute = readNumber(weather["postsPerMinute"], to.postsPerMinute, 0, 100_000);
    to.rain = readNumber(weather["rain"], to.rain, 0, 1);
    to.wind = readNumber(weather["wind"], to.wind, 0, 1);
    to.light = readNumber(weather["light"], to.light, 0, 1);
    to.fog = readNumber(weather["fog"], to.fog, 0, 1);
    to.fireflies = readNumber(weather["fireflies"], to.fireflies, 0, 1);
  }
  const dayPhase = source["dayPhase"];
  if (typeof dayPhase === "number" && Number.isFinite(dayPhase)) {
    target.dayPhase = wrapDayPhase(dayPhase);
  }
  target.climate = readClimate(source["climate"], target.climate);
}
