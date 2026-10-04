/**
 * Pure sky / ground palette for a theme, time of day and climate (docs/DESIGN.md §36.5).
 * No PixiJS import: shared by the 2D engine and (later) the 3D engine, unit-testable in node.
 */
import type { GardenClimate, GardenTheme } from "../domain/models";

export interface SkyPalette {
  readonly skyTop: number;
  readonly skyHorizon: number;
  readonly ground: number;
  readonly groundEdge: number;
  readonly groundGlow: number;
  /** Multiplied onto the plants (0xffffff = unchanged). */
  readonly ambientTint: number;
  readonly particleTint: number;
}

export interface SkyPaletteOptions {
  /** false: the theme's resting palette, independent of dayPhase. */
  readonly dayNight: boolean;
  /** false: ignore the climate tint. */
  readonly climate: boolean;
}

type DayStage = "night" | "dawn" | "day" | "dusk";

interface Keyframe {
  readonly at: number;
  readonly stage: DayStage;
}

/** Hold night at both ends so the wrap from 1 to 0 is seamless. */
const KEYFRAMES: readonly Keyframe[] = [
  { at: 0, stage: "night" },
  { at: 0.2, stage: "night" },
  { at: 0.27, stage: "dawn" },
  { at: 0.4, stage: "day" },
  { at: 0.6, stage: "day" },
  { at: 0.73, stage: "dusk" },
  { at: 0.8, stage: "night" },
  { at: 1, stage: "night" },
];

/** dayPhase used when the day/night cycle is off. twilight rests at its night keyframe = the MVP colors. */
const REST_PHASE: Readonly<Record<GardenTheme, number>> = {
  twilight: 0,
  dawn: 0.27,
  moss: 0.5,
  nocturne: 0,
};

function palette(
  skyTop: number,
  skyHorizon: number,
  ground: number,
  groundEdge: number,
  groundGlow: number,
  ambientTint: number,
  particleTint: number,
): SkyPalette {
  return { skyTop, skyHorizon, ground, groundEdge, groundGlow, ambientTint, particleTint };
}

const THEMES: Readonly<Record<GardenTheme, Readonly<Record<DayStage, SkyPalette>>>> = {
  // night = the MVP colors (RENDER.BACKGROUND_COLOR and the previous horizon / ground constants).
  twilight: {
    night: palette(0x0b1418, 0x123a40, 0x0a1a16, 0x1f4d45, 0x2c7a6c, 0xffffff, 0xfff1a8),
    dawn: palette(0x1d2c4a, 0x6a5a6e, 0x10201c, 0x3a5a50, 0x8a7a6a, 0xffeedd, 0xffd9a0),
    day: palette(0x1d4a5e, 0x4a8f8f, 0x153228, 0x2f6a58, 0x5fb09a, 0xffffff, 0xffffd0),
    dusk: palette(0x1a1c40, 0x7a4a68, 0x101a1c, 0x3a4a5a, 0x9a5a7a, 0xffe6e6, 0xffc2a0),
  },
  dawn: {
    night: palette(0x1a1830, 0x3a3560, 0x14141e, 0x3a3558, 0x5a4a88, 0xd8d8ff, 0xffe0f0),
    dawn: palette(0x5b6fa8, 0xf4b6a0, 0x2a2a38, 0x7a6a7a, 0xf4b6a0, 0xfff0e8, 0xfff0d0),
    day: palette(0x7fb4d8, 0xdff0f0, 0x3a5a4a, 0x7ab090, 0xcfe8d0, 0xffffff, 0xffffe0),
    dusk: palette(0x5a4a8a, 0xf09a8e, 0x2a2434, 0x6a4a6a, 0xf09a8e, 0xffe8e8, 0xffd0c0),
  },
  moss: {
    night: palette(0x0a140f, 0x14301f, 0x08140c, 0x1f4a30, 0x2c7a4a, 0xe8ffe8, 0xe8ffa0),
    dawn: palette(0x1f3a2c, 0x8aa66a, 0x10241a, 0x3a6a48, 0x9ac07a, 0xfffae0, 0xf0ffb0),
    day: palette(0x2f6a4a, 0xa8d19a, 0x1a3a24, 0x4a8a58, 0xb8e0a0, 0xffffff, 0xffffc0),
    dusk: palette(0x1c3a30, 0x9a8a52, 0x10201a, 0x3a5a3a, 0xc0a860, 0xfff0d0, 0xffe090),
  },
  nocturne: {
    night: palette(0x05060f, 0x10143a, 0x07070f, 0x1c1c48, 0x3a3a9a, 0xc8c8ff, 0xc8d0ff),
    dawn: palette(0x080a1c, 0x1a2050, 0x08081a, 0x24245a, 0x4a4aaa, 0xd0d0ff, 0xd0d8ff),
    day: palette(0x0b1030, 0x1f2a6a, 0x0a0a1c, 0x2a2a6a, 0x5a5ac0, 0xdadaff, 0xd8e0ff),
    dusk: palette(0x080a24, 0x2a1a5a, 0x08081a, 0x2a2058, 0x6a4ab0, 0xd8c8ff, 0xe0d0ff),
  },
};

interface ClimateTint {
  readonly color: number;
  readonly amount: number;
  readonly brightness: number;
}

const CLIMATE_TINTS: Readonly<Record<GardenClimate, ClimateTint>> = {
  temperate: { color: 0xffffff, amount: 0, brightness: 1 },
  rainyGarden: { color: 0x5a6670, amount: 0.35, brightness: 0.9 },
  bloomingGarden: { color: 0xffc7a8, amount: 0.15, brightness: 1.12 },
  darkForest: { color: 0x0a2a1a, amount: 0.35, brightness: 0.8 },
};

function channel(color: number, shift: number): number {
  return (color >> shift) & 0xff;
}

function pack(red: number, green: number, blue: number): number {
  const limit = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  return (limit(red) << 16) | (limit(green) << 8) | limit(blue);
}

export function lerpColor(from: number, to: number, amount: number): number {
  const t = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  return pack(
    channel(from, 16) + (channel(to, 16) - channel(from, 16)) * t,
    channel(from, 8) + (channel(to, 8) - channel(from, 8)) * t,
    channel(from, 0) + (channel(to, 0) - channel(from, 0)) * t,
  );
}

function lerpPalette(from: SkyPalette, to: SkyPalette, amount: number): SkyPalette {
  return {
    skyTop: lerpColor(from.skyTop, to.skyTop, amount),
    skyHorizon: lerpColor(from.skyHorizon, to.skyHorizon, amount),
    ground: lerpColor(from.ground, to.ground, amount),
    groundEdge: lerpColor(from.groundEdge, to.groundEdge, amount),
    groundGlow: lerpColor(from.groundGlow, to.groundGlow, amount),
    ambientTint: lerpColor(from.ambientTint, to.ambientTint, amount),
    particleTint: lerpColor(from.particleTint, to.particleTint, amount),
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrapPhase(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value - Math.floor(value);
  return wrapped;
}

function paletteAtPhase(theme: GardenTheme, phase: number): SkyPalette {
  const stages = THEMES[theme];
  for (let index = 1; index < KEYFRAMES.length; index += 1) {
    const next = KEYFRAMES[index];
    const previous = KEYFRAMES[index - 1];
    if (next === undefined || previous === undefined) continue;
    if (phase > next.at) continue;
    const span = next.at - previous.at;
    const t = span > 0 ? smoothstep((phase - previous.at) / span) : 1;
    return lerpPalette(stages[previous.stage], stages[next.stage], t);
  }
  return stages.night;
}

function applyClimate(base: SkyPalette, climate: GardenClimate): SkyPalette {
  const tint = CLIMATE_TINTS[climate];
  if (tint.amount === 0 && tint.brightness === 1) return base;
  const adjust = (color: number): number => {
    const mixed = lerpColor(color, tint.color, tint.amount);
    return pack(
      channel(mixed, 16) * tint.brightness,
      channel(mixed, 8) * tint.brightness,
      channel(mixed, 0) * tint.brightness,
    );
  };
  return {
    skyTop: adjust(base.skyTop),
    skyHorizon: adjust(base.skyHorizon),
    ground: adjust(base.ground),
    groundEdge: adjust(base.groundEdge),
    groundGlow: adjust(base.groundGlow),
    ambientTint: lerpColor(base.ambientTint, tint.color, tint.amount * 0.5),
    particleTint: base.particleTint,
  };
}

/** The phase the palette is evaluated at: the clock phase, or the theme's resting phase when dayNight is off. */
export function effectiveDayPhase(theme: GardenTheme, dayPhase: number, dayNight: boolean): number {
  const safeTheme: GardenTheme = theme in THEMES ? theme : "twilight";
  return dayNight ? wrapPhase(dayPhase) : REST_PHASE[safeTheme];
}

export function skyPalette(
  theme: GardenTheme,
  dayPhase: number,
  climate: GardenClimate,
  options: SkyPaletteOptions,
): SkyPalette {
  const safeTheme: GardenTheme = theme in THEMES ? theme : "twilight";
  const phase = effectiveDayPhase(safeTheme, dayPhase, options.dayNight);
  const base = paletteAtPhase(safeTheme, phase);
  const safeClimate: GardenClimate = climate in CLIMATE_TINTS ? climate : "temperate";
  return options.climate ? applyClimate(base, safeClimate) : base;
}

/** Sum of absolute per-channel differences over the colors that are drawn into the background. */
export function paletteDistance(a: SkyPalette, b: SkyPalette): number {
  const colorDistance = (x: number, y: number): number =>
    Math.abs(channel(x, 16) - channel(y, 16)) +
    Math.abs(channel(x, 8) - channel(y, 8)) +
    Math.abs(channel(x, 0) - channel(y, 0));
  return (
    colorDistance(a.skyTop, b.skyTop) +
    colorDistance(a.skyHorizon, b.skyHorizon) +
    colorDistance(a.ground, b.ground) +
    colorDistance(a.groundEdge, b.groundEdge) +
    colorDistance(a.groundGlow, b.groundGlow) +
    colorDistance(a.ambientTint, b.ambientTint)
  );
}
