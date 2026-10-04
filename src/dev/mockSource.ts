/**
 * Development-only mock data source: feeds random PlantSeeds, an EnvironmentState and occasional
 * growPlant calls into a sink. Loaded through a dynamic import() in dev builds only
 * (docs/DESIGN.md §4). Query presets: `?mock&weather=rain|fog|night|calm|busy`.
 */
import { PLANT, WEATHER } from "../config/gardenConfig";
import type { EnvironmentState, GardenClimate, Mood, PlantSeed } from "../domain/models";

export interface MockSink {
  addPlant(seed: PlantSeed): void;
  growPlant(id: string, targetScale: number): void;
  setEnvironment(environment: EnvironmentState): void;
}

export type MockWeatherPreset = "rain" | "fog" | "night" | "calm" | "busy";

export interface MockSourceOptions {
  /** Seeds per second. Default 1. */
  readonly plantsPerSecond?: number;
  /** Fixed activity to report. Default: a slow wave between about 5 and 125 posts/min. */
  readonly postsPerMinute?: number;
  /** Fixed environment preset. Default: read from the page query (`weather=`), else a slow wave. */
  readonly weather?: MockWeatherPreset;
  readonly random?: () => number;
}

const DEFAULT_PLANTS_PER_SECOND = 1;
const ACTIVITY_INTERVAL_MS = 2_000;
const ACTIVITY_WAVE_PERIOD_MS = 120_000;
const ACTIVITY_BASE = 65;
const ACTIVITY_AMPLITUDE = 60;
const ACTIVITY_NOISE = 10;
const POSITIVE_SHARE = 0.35;
const NEGATIVE_SHARE = 0.2;
const SCALE_SKEW_EXPONENT = 2.2;
const MOCK_SCALE_MAX = 2.0;
const GROW_INTERVAL_MS = 3_000;
const GROW_STEP = 0.35;
/** Only the most recent seeds can grow, so the id list stays small. */
const RECENT_ID_LIMIT = 40;

const PALETTES: Readonly<Record<Mood, readonly number[]>> = {
  positive: [0xf48fb1, 0xffb74d, 0xff8a80],
  neutral: [0x81c784, 0x66bb6a, 0x9ccc65],
  negative: [0x5c7fb8, 0x2e5e4e, 0x5b3f78],
};

interface PresetValues {
  readonly postsPerMinute: number;
  readonly rain: number;
  readonly wind: number;
  readonly light: number;
  readonly fog: number;
  readonly fireflies: number;
  readonly dayPhase: number;
  readonly climate: GardenClimate;
}

const PRESETS: Readonly<Record<MockWeatherPreset, PresetValues>> = {
  rain: { postsPerMinute: 150, rain: 0.85, wind: 0.6, light: 0.1, fog: 0.2, fireflies: 0, dayPhase: 0.5, climate: "rainyGarden" },
  fog: { postsPerMinute: 15, rain: 0, wind: 0.1, light: 0.05, fog: 0.9, fireflies: 0.2, dayPhase: 0.3, climate: "darkForest" },
  night: { postsPerMinute: 45, rain: 0, wind: 0.25, light: 0.3, fog: 0.1, fireflies: 1, dayPhase: 0.95, climate: "temperate" },
  calm: { postsPerMinute: 8, rain: 0, wind: 0.1, light: 0.5, fog: 0, fireflies: 0, dayPhase: 0.5, climate: "temperate" },
  busy: { postsPerMinute: 130, rain: 0.3, wind: 0.9, light: 0.7, fog: 0, fireflies: 0.3, dayPhase: 0.45, climate: "bloomingGarden" },
};

const PRESET_NAMES: readonly MockWeatherPreset[] = ["rain", "fog", "night", "calm", "busy"];

export function parseWeatherPreset(search: string): MockWeatherPreset | undefined {
  const value = new URLSearchParams(search).get("weather");
  return PRESET_NAMES.find((name) => name === value);
}

function ramp(value: number, start: number, full: number): number {
  return Math.min(1, Math.max(0, (value - start) / (full - start)));
}

function localDayPhase(): number {
  const now = new Date();
  return (now.getHours() * 60 + now.getMinutes()) / 1440;
}

function pickMood(random: () => number): Mood {
  const roll = random();
  if (roll < POSITIVE_SHARE) return "positive";
  if (roll < POSITIVE_SHARE + NEGATIVE_SHARE) return "negative";
  return "neutral";
}

function pickColor(mood: Mood, random: () => number): number {
  const palette = PALETTES[mood];
  const color = palette[Math.floor(random() * palette.length) % palette.length];
  return color ?? 0x81c784;
}

function createSeed(index: number, random: () => number): PlantSeed {
  const mood = pickMood(random);
  const skewed = Math.pow(random(), SCALE_SKEW_EXPONENT); // most plants small, a few large
  const scale = PLANT.SCALE_MIN + skewed * (MOCK_SCALE_MAX - PLANT.SCALE_MIN);
  const growthDurationMs =
    PLANT.GROWTH_MIN_MS + (1 - skewed) * (PLANT.GROWTH_BASE_MS - PLANT.GROWTH_MIN_MS);
  return {
    id: `mock-${String(index)}`,
    mood,
    color: pickColor(mood, random),
    scale,
    growthDurationMs,
    thorny: mood === "negative",
  };
}

function fromPreset(values: PresetValues): EnvironmentState {
  return {
    weather: {
      postsPerMinute: values.postsPerMinute,
      rain: values.rain,
      wind: values.wind,
      light: values.light,
      fog: values.fog,
      fireflies: values.fireflies,
    },
    dayPhase: values.dayPhase,
    climate: values.climate,
  };
}

/** Wave-driven environment that mirrors how the domain derives weather from the flow rate. */
function fromFlowRate(postsPerMinute: number, elapsedMs: number): EnvironmentState {
  const shareWave = (Math.sin((elapsedMs / (ACTIVITY_WAVE_PERIOD_MS * 1.7)) * Math.PI * 2) + 1) / 2;
  return {
    weather: {
      postsPerMinute,
      rain: ramp(postsPerMinute, WEATHER.RAIN_START_PPM, WEATHER.RAIN_FULL_PPM),
      wind: ramp(postsPerMinute, WEATHER.WIND_START_PPM, WEATHER.WIND_FULL_PPM),
      light: shareWave,
      fog: 1 - shareWave,
      fireflies: ramp(postsPerMinute, WEATHER.FIREFLY_START_PPM, WEATHER.FIREFLY_FULL_PPM) * 0.6,
    },
    dayPhase: localDayPhase(),
    climate: "temperate",
  };
}

/** Start generating seeds. Returns a function that stops all timers (idempotent). */
export function startMockSource(sink: MockSink, options: MockSourceOptions = {}): () => void {
  const random = options.random ?? Math.random;
  const plantsPerSecond = Math.max(0.1, options.plantsPerSecond ?? DEFAULT_PLANTS_PER_SECOND);
  const preset =
    options.weather ??
    (typeof window === "undefined" ? undefined : parseWeatherPreset(window.location.search));
  let index = 0;
  let elapsedMs = 0;
  const recent: { id: string; scale: number }[] = [];

  const plantTimer = setInterval(() => {
    index += 1;
    const seed = createSeed(index, random);
    sink.addPlant(seed);
    recent.push({ id: seed.id, scale: seed.scale });
    if (recent.length > RECENT_ID_LIMIT) recent.shift();
  }, 1000 / plantsPerSecond);

  const reportEnvironment = (): void => {
    if (preset !== undefined) {
      const values = PRESETS[preset];
      sink.setEnvironment(
        fromPreset(
          options.postsPerMinute === undefined
            ? values
            : { ...values, postsPerMinute: options.postsPerMinute },
        ),
      );
      return;
    }
    if (options.postsPerMinute !== undefined) {
      sink.setEnvironment(fromFlowRate(options.postsPerMinute, elapsedMs));
      return;
    }
    const wave = Math.sin((elapsedMs / ACTIVITY_WAVE_PERIOD_MS) * Math.PI * 2);
    const noise = (random() * 2 - 1) * ACTIVITY_NOISE;
    sink.setEnvironment(
      fromFlowRate(Math.max(0, ACTIVITY_BASE + wave * ACTIVITY_AMPLITUDE + noise), elapsedMs),
    );
  };
  reportEnvironment();
  const environmentTimer = setInterval(() => {
    elapsedMs += ACTIVITY_INTERVAL_MS;
    reportEnvironment();
  }, ACTIVITY_INTERVAL_MS);

  // Simulates after-growth (SPEC §13.3): a recent plant gets more likes and grows.
  const growTimer = setInterval(() => {
    const entry = recent[Math.floor(random() * recent.length)];
    if (entry === undefined) return;
    entry.scale = Math.min(PLANT.SCALE_MAX, entry.scale + GROW_STEP);
    sink.growPlant(entry.id, entry.scale);
  }, GROW_INTERVAL_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(plantTimer);
    clearInterval(environmentTimer);
    clearInterval(growTimer);
  };
}
