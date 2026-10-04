/**
 * Pure lighting / fog math of the 3D garden (docs/DESIGN.md §36.5, §36.6). No three import,
 * so it is unit-testable in node. The engine only applies the numbers.
 */
import type { GardenClimate } from "../../domain/models";

export interface Lighting {
  /** 0 (night) .. 1 (full day). */
  readonly day: number;
  /** 0 (day) .. 1 (night). */
  readonly night: number;
  readonly hemisphereIntensity: number;
  /** Intensity of the single directional light (sun by day, moon by night). */
  readonly directionalIntensity: number;
  /** Position of the directional light on a sphere of radius 1. */
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Sun height: 0 at 06:00 and 18:00, 1 at noon, -1 at midnight. */
export function sunElevation(dayPhase: number): number {
  return Math.sin((dayPhase - 0.25) * Math.PI * 2);
}

export function dayAmount(dayPhase: number): number {
  return smoothstep(-0.08, 0.3, sunElevation(dayPhase));
}

const CLIMATE_BRIGHTNESS: Readonly<Record<GardenClimate, number>> = {
  temperate: 1,
  rainyGarden: 0.85,
  bloomingGarden: 1.1,
  darkForest: 0.75,
};

const CLIMATE_FOG: Readonly<Record<GardenClimate, number>> = {
  temperate: 0,
  rainyGarden: 0.012,
  bloomingGarden: 0,
  darkForest: 0.02,
};

const BASE_FOG_DENSITY = 0.01;
const WEATHER_FOG_DENSITY = 0.045;

/**
 * @param phase phase after the day/night toggle was applied (see effectiveDayPhase)
 * @param weatherLight 0..1 positive share: brightens the garden
 */
export function computeLighting(phase: number, weatherLight: number, climate: GardenClimate | null): Lighting {
  const dayPhase = Number.isFinite(phase) ? phase : 0;
  const day = dayAmount(dayPhase);
  const night = 1 - day;
  const brightness = climate === null ? 1 : CLIMATE_BRIGHTNESS[climate];
  const light = clamp01(weatherLight);
  const elevation = sunElevation(dayPhase);
  const sunAngle = (dayPhase - 0.25) * Math.PI * 2;
  // Sun travels east to west on the x axis and stays in front of the camera (z > 0).
  const sunX = Math.cos(sunAngle);
  const sunY = Math.max(0.2, elevation);
  const sunZ = 0.45;
  // The moon is fixed high and slightly to the left.
  const moonX = -0.35;
  const moonY = 0.9;
  const moonZ = 0.35;
  const dirX = sunX * day + moonX * night;
  const dirY = sunY * day + moonY * night;
  const dirZ = sunZ * day + moonZ * night;
  const length = Math.hypot(dirX, dirY, dirZ) || 1;
  return {
    day,
    night,
    hemisphereIntensity: (0.4 + 0.3 * day + 0.25 * light) * brightness,
    directionalIntensity: (1.1 * day + 0.5 * night) * (0.85 + 0.3 * light) * brightness,
    directionX: dirX / length,
    directionY: dirY / length,
    directionZ: dirZ / length,
  };
}

/** FogExp2 density: a thin base haze, more with weather.fog, a little more in rainy / dark climates. */
export function computeFogDensity(weatherFog: number, climate: GardenClimate | null, fogEnabled: boolean): number {
  const fog = fogEnabled ? clamp01(weatherFog) : 0;
  const climateFog = climate === null ? 0 : CLIMATE_FOG[climate];
  return BASE_FOG_DENSITY + fog * WEATHER_FOG_DENSITY + climateFog;
}

/** Bloom strength: faint by day, strong at night. */
export function computeBloomStrength(night: number): number {
  return 0.25 + 0.65 * clamp01(night);
}

/** Emissive strength of flowers: they glow once it gets dark and bloom is on. */
export function computeFlowerGlow(night: number, bloomEnabled: boolean): number {
  return bloomEnabled ? 0.15 + 0.7 * clamp01(night) : 0;
}
