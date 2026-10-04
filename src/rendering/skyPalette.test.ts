import { describe, expect, it } from "vitest";
import type { GardenClimate, GardenTheme } from "../domain/models";
import { lerpColor, paletteDistance, skyPalette } from "./skyPalette";
import type { SkyPalette } from "./skyPalette";

const THEMES: readonly GardenTheme[] = ["twilight", "dawn", "moss", "nocturne"];
const CLIMATES: readonly GardenClimate[] = ["temperate", "rainyGarden", "bloomingGarden", "darkForest"];
const ON = { dayNight: true, climate: true } as const;
const OFF = { dayNight: false, climate: false } as const;

function luminance(color: number): number {
  return (((color >> 16) & 0xff) * 0.3 + ((color >> 8) & 0xff) * 0.59 + (color & 0xff) * 0.11) / 255;
}

function isColor(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

function allColors(palette: SkyPalette): number[] {
  return [palette.skyTop, palette.skyHorizon, palette.ground, palette.groundEdge, palette.groundGlow, palette.ambientTint, palette.particleTint];
}

describe("skyPalette", () => {
  it("returns valid colors for every theme, phase and climate, including bad input", () => {
    for (const theme of THEMES) {
      for (const climate of CLIMATES) {
        for (const phase of [-3.2, 0, 0.1, 0.27, 0.5, 0.73, 0.99, 1, 7.5, Number.NaN, Infinity]) {
          for (const options of [ON, OFF]) {
            for (const color of allColors(skyPalette(theme, phase, climate, options))) {
              expect(isColor(color)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("twilight at rest is the MVP palette", () => {
    const palette = skyPalette("twilight", 0.9, "temperate", OFF);
    expect(palette.skyTop).toBe(0x0b1418);
    expect(palette.skyHorizon).toBe(0x123a40);
    expect(palette.ground).toBe(0x0a1a16);
    expect(palette.groundEdge).toBe(0x1f4d45);
    expect(palette.groundGlow).toBe(0x2c7a6c);
    expect(palette.ambientTint).toBe(0xffffff);
  });

  it("is independent of dayPhase when the day/night cycle is off", () => {
    for (const theme of THEMES) {
      const reference = skyPalette(theme, 0, "temperate", OFF);
      for (const phase of [0.2, 0.5, 0.8, 1.7]) {
        expect(skyPalette(theme, phase, "temperate", OFF)).toEqual(reference);
      }
    }
  });

  it("is brighter at noon than at midnight for the twilight, dawn and moss themes", () => {
    for (const theme of ["twilight", "dawn", "moss"] as const) {
      const night = skyPalette(theme, 0, "temperate", ON);
      const day = skyPalette(theme, 0.5, "temperate", ON);
      expect(luminance(day.skyHorizon)).toBeGreaterThan(luminance(night.skyHorizon));
    }
  });

  it("wraps the day: phase 0 equals phase 1 and transitions are continuous", () => {
    for (const theme of THEMES) {
      expect(skyPalette(theme, 0, "temperate", ON)).toEqual(skyPalette(theme, 1, "temperate", ON));
      let previous = skyPalette(theme, 0, "temperate", ON);
      for (let step = 1; step <= 400; step += 1) {
        const next = skyPalette(theme, step / 400, "temperate", ON);
        // 1/400 of a day never moves the sky by more than a small step.
        expect(paletteDistance(previous, next)).toBeLessThan(120);
        previous = next;
      }
    }
  });

  it("lerps between keyframes", () => {
    const dawn = skyPalette("moss", 0.27, "temperate", ON);
    const day = skyPalette("moss", 0.4, "temperate", ON);
    const between = skyPalette("moss", 0.335, "temperate", ON);
    expect(paletteDistance(dawn, between)).toBeGreaterThan(0);
    expect(paletteDistance(between, day)).toBeGreaterThan(0);
    expect(paletteDistance(dawn, between)).toBeLessThan(paletteDistance(dawn, day));
  });

  it("tints by climate: rainy cooler/greyer, blooming warmer/brighter, dark forest darker", () => {
    const base = skyPalette("moss", 0.5, "temperate", ON);
    const rainy = skyPalette("moss", 0.5, "rainyGarden", ON);
    const blooming = skyPalette("moss", 0.5, "bloomingGarden", ON);
    const dark = skyPalette("moss", 0.5, "darkForest", ON);

    expect(luminance(rainy.skyHorizon)).toBeLessThan(luminance(base.skyHorizon));
    const saturation = (color: number): number =>
      Math.max(color >> 16, (color >> 8) & 0xff, color & 0xff) -
      Math.min(color >> 16, (color >> 8) & 0xff, color & 0xff);
    expect(saturation(rainy.skyHorizon)).toBeLessThan(saturation(base.skyHorizon));

    expect(luminance(blooming.skyHorizon)).toBeGreaterThan(luminance(base.skyHorizon));
    const red = (color: number): number => (color >> 16) & 0xff;
    const blue = (color: number): number => color & 0xff;
    expect(red(blooming.skyHorizon) - blue(blooming.skyHorizon)).toBeGreaterThan(
      red(base.skyHorizon) - blue(base.skyHorizon),
    );

    expect(luminance(dark.skyHorizon)).toBeLessThan(luminance(base.skyHorizon));
    expect(luminance(dark.ground)).toBeLessThanOrEqual(luminance(base.ground));
  });

  it("ignores the climate when the climate option is off", () => {
    const base = skyPalette("dawn", 0.5, "temperate", { dayNight: true, climate: false });
    expect(skyPalette("dawn", 0.5, "darkForest", { dayNight: true, climate: false })).toEqual(base);
  });

  it("falls back to twilight / temperate for unknown values", () => {
    const unknownTheme = "nope" as unknown as GardenTheme;
    const unknownClimate = "storm" as unknown as GardenClimate;
    expect(skyPalette(unknownTheme, 0, unknownClimate, ON)).toEqual(
      skyPalette("twilight", 0, "temperate", ON),
    );
  });
});

describe("lerpColor and paletteDistance", () => {
  it("interpolates per channel and clamps the amount", () => {
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(lerpColor(0x102030, 0x102030, 0.7)).toBe(0x102030);
    expect(lerpColor(0x000000, 0xff0000, 2)).toBe(0xff0000);
    expect(lerpColor(0x000000, 0xff0000, -1)).toBe(0x000000);
    expect(lerpColor(0x000000, 0xff0000, Number.NaN)).toBe(0x000000);
  });

  it("is zero for equal palettes and grows with the difference", () => {
    const a = skyPalette("twilight", 0, "temperate", ON);
    const b = skyPalette("twilight", 0.5, "temperate", ON);
    expect(paletteDistance(a, a)).toBe(0);
    expect(paletteDistance(a, b)).toBeGreaterThan(0);
  });
});
