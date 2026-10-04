import { describe, expect, it } from "vitest";
import { SETTINGS } from "../config/gardenConfig";
import type { RenderSettings } from "../domain/models";
import {
  DEFAULT_RENDER_SETTINGS,
  createCalmEnvironment,
  sanitizeRenderSettings,
  wrapDayPhase,
  writeEnvironment,
} from "./renderInputs";

describe("sanitizeRenderSettings", () => {
  it("keeps valid values", () => {
    const input: RenderSettings = {
      maxPlants: 120,
      plantLifetimeMs: 90_000,
      animationSpeed: 1.5,
      particleIntensity: 0.5,
      windIntensity: 2,
      theme: "moss",
      effects: { ...DEFAULT_RENDER_SETTINGS.effects, rain: false },
    };
    expect(sanitizeRenderSettings(input, DEFAULT_RENDER_SETTINGS)).toEqual(input);
  });

  it("clamps out-of-range numbers and floors maxPlants", () => {
    const result = sanitizeRenderSettings(
      {
        ...DEFAULT_RENDER_SETTINGS,
        maxPlants: 9_999,
        plantLifetimeMs: 1,
        animationSpeed: 99,
        particleIntensity: -5,
        windIntensity: 99,
      },
      DEFAULT_RENDER_SETTINGS,
    );
    expect(result.maxPlants).toBe(SETTINGS.MAX_PLANTS.MAX);
    expect(result.plantLifetimeMs).toBe(SETTINGS.PLANT_LIFETIME_MS.MIN);
    expect(result.animationSpeed).toBe(SETTINGS.ANIMATION_SPEED.MAX);
    expect(result.particleIntensity).toBe(SETTINGS.PARTICLE_INTENSITY.MIN);
    expect(result.windIntensity).toBe(SETTINGS.WIND_INTENSITY.MAX);
    expect(sanitizeRenderSettings({ ...DEFAULT_RENDER_SETTINGS, maxPlants: 77.9 }, DEFAULT_RENDER_SETTINGS).maxPlants).toBe(77);
    expect(sanitizeRenderSettings({ ...DEFAULT_RENDER_SETTINGS, maxPlants: 1 }, DEFAULT_RENDER_SETTINGS).maxPlants).toBe(
      SETTINGS.MAX_PLANTS.MIN,
    );
  });

  it("falls back for NaN, wrong types, unknown themes and missing effects", () => {
    const previous: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, maxPlants: 100, theme: "dawn" };
    const result = sanitizeRenderSettings(
      { maxPlants: Number.NaN, animationSpeed: "fast", theme: "neon", effects: null },
      previous,
    );
    expect(result.maxPlants).toBe(100);
    expect(result.animationSpeed).toBe(previous.animationSpeed);
    expect(result.theme).toBe("dawn");
    expect(result.effects).toEqual(previous.effects);
    expect(sanitizeRenderSettings(null, previous)).toBe(previous);
  });

  it("reads each effect toggle independently", () => {
    const result = sanitizeRenderSettings(
      { ...DEFAULT_RENDER_SETTINGS, effects: { rain: false, fog: "no", bloom: false } },
      DEFAULT_RENDER_SETTINGS,
    );
    expect(result.effects.rain).toBe(false);
    expect(result.effects.fog).toBe(true);
    expect(result.effects.bloom).toBe(false);
    expect(result.effects.fireflies).toBe(true);
  });
});

describe("writeEnvironment", () => {
  it("copies valid values and clamps the weather to 0..1", () => {
    const target = createCalmEnvironment();
    writeEnvironment(target, {
      weather: { postsPerMinute: 80, rain: 2, wind: -1, light: 0.4, fog: 0.5, fireflies: 1 },
      dayPhase: 1.25,
      climate: "darkForest",
    });
    expect(target.weather).toEqual({ postsPerMinute: 80, rain: 1, wind: 0, light: 0.4, fog: 0.5, fireflies: 1 });
    expect(target.dayPhase).toBeCloseTo(0.25);
    expect(target.climate).toBe("darkForest");
  });

  it("keeps the previous values for invalid input", () => {
    const target = createCalmEnvironment();
    target.weather.rain = 0.3;
    target.dayPhase = 0.6;
    writeEnvironment(target, {
      weather: { postsPerMinute: Number.NaN, rain: Number.NaN, wind: 0, light: 0, fog: 0, fireflies: 0 },
      dayPhase: Number.NaN,
      climate: "storm" as unknown as "temperate",
    });
    expect(target.weather.rain).toBe(0.3);
    expect(target.weather.postsPerMinute).toBe(0);
    expect(target.dayPhase).toBe(0.6);
    expect(target.climate).toBe("temperate");
    expect(() => {
      writeEnvironment(target, null as unknown as Parameters<typeof writeEnvironment>[1]);
    }).not.toThrow();
  });
});

describe("wrapDayPhase", () => {
  it("wraps into [0, 1)", () => {
    expect(wrapDayPhase(1)).toBe(0);
    expect(wrapDayPhase(-0.25)).toBeCloseTo(0.75);
    expect(wrapDayPhase(2.5)).toBeCloseTo(0.5);
    expect(wrapDayPhase(Number.NaN)).toBe(0);
  });
});
