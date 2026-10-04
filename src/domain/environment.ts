import { CLIMATE, TREND, WEATHER } from "../config/gardenConfig";
import type { FlowSnapshot } from "./FlowRateMeter";
import type { GardenClimate, WeatherState } from "./models";
import type { TrendValue } from "./TrendMeter";

const MINUTES_PER_DAY = 1_440;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Linear 0..1 ramp between `start` (0) and `full` (1). */
function ramp(value: number, start: number, full: number): number {
  if (full <= start) return value >= full ? 1 : 0;
  return clamp01((value - start) / (full - start));
}

/** Local minutes since midnight to 0..1 (0 = midnight). Wraps; invalid input yields 0. */
export function dayPhaseFromMinutes(localMinutesOfDay: number): number {
  if (!Number.isFinite(localMinutesOfDay)) return 0;
  const wrapped = ((localMinutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return wrapped / MINUTES_PER_DAY;
}

/**
 * 0 (day) .. 1 (night). Rises from FIREFLY_DUSK_PHASE over FIREFLY_TWILIGHT_WIDTH, stays 1
 * through midnight, and falls to 0 at FIREFLY_DAWN_PHASE.
 */
export function nightness(dayPhase: number): number {
  const phase = clamp01(dayPhase);
  const width = WEATHER.FIREFLY_TWILIGHT_WIDTH;
  if (phase >= WEATHER.FIREFLY_DUSK_PHASE) return clamp01((phase - WEATHER.FIREFLY_DUSK_PHASE) / width);
  if (phase < WEATHER.FIREFLY_DAWN_PHASE) return clamp01((WEATHER.FIREFLY_DAWN_PHASE - phase) / width);
  return 0;
}

export function deriveWeather(
  snapshot: Pick<FlowSnapshot, "postsPerMinute" | "positiveShare" | "negativeShare">,
  dayPhase: number,
): WeatherState {
  const ppm = Number.isFinite(snapshot.postsPerMinute) ? Math.max(0, snapshot.postsPerMinute) : 0;
  return {
    postsPerMinute: ppm,
    rain: ramp(ppm, WEATHER.RAIN_START_PPM, WEATHER.RAIN_FULL_PPM),
    wind: ramp(ppm, WEATHER.WIND_START_PPM, WEATHER.WIND_FULL_PPM),
    light: ramp(snapshot.positiveShare, WEATHER.LIGHT_SHARE_START, WEATHER.LIGHT_SHARE_FULL),
    fog: ramp(snapshot.negativeShare, WEATHER.FOG_SHARE_START, WEATHER.FOG_SHARE_FULL),
    fireflies: ramp(ppm, WEATHER.FIREFLY_START_PPM, WEATHER.FIREFLY_FULL_PPM) * nightness(dayPhase),
  };
}

/** Entered at `threshold`; an already-active climate is kept until `threshold * (1 - HYSTERESIS)`. */
function isActive(value: number, threshold: number, wasActive: boolean): boolean {
  const limit = wasActive ? threshold * (1 - CLIMATE.HYSTERESIS) : threshold;
  return value >= limit;
}

/**
 * Macro climate from the long-term trend.
 * Priority when several apply (deterministic): darkForest > rainyGarden > bloomingGarden > temperate.
 * Negative mood outranks everything, then sustained heavy flow, then positivity.
 * Stays "temperate" until the trend has been observed for TREND.MIN_OBSERVED_MS.
 */
export function deriveClimate(trend: TrendValue, previous: GardenClimate): GardenClimate {
  if (trend.observedMs < TREND.MIN_OBSERVED_MS) return "temperate";
  if (isActive(trend.negativeShare, CLIMATE.DARK_NEGATIVE_SHARE, previous === "darkForest")) return "darkForest";
  if (isActive(trend.ppm, CLIMATE.RAINY_PPM, previous === "rainyGarden")) return "rainyGarden";
  if (isActive(trend.positiveShare, CLIMATE.BLOOMING_POSITIVE_SHARE, previous === "bloomingGarden")) {
    return "bloomingGarden";
  }
  return "temperate";
}
