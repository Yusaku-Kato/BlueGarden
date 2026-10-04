import { FEED, SETTINGS } from "../config/gardenConfig";
import { isFeedGeneratorUri } from "./feedUri";
import type {
  EffectToggles,
  FeedTarget,
  GardenTheme,
  RenderSettings,
  RendererKind,
  RuntimeSettings,
} from "./models";

const THEMES: readonly GardenTheme[] = ["twilight", "dawn", "moss", "nocturne"];
const RENDERERS: readonly RendererKind[] = ["pixi2d", "three3d"];

const DEFAULT_FEED: FeedTarget = { kind: "timeline" };

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

export const DEFAULT_SETTINGS: RuntimeSettings = {
  version: 1,
  feed: DEFAULT_FEED,
  renderer: "pixi2d",
  render: {
    maxPlants: SETTINGS.MAX_PLANTS.DEFAULT,
    plantLifetimeMs: SETTINGS.PLANT_LIFETIME_MS.DEFAULT,
    animationSpeed: SETTINGS.ANIMATION_SPEED.DEFAULT,
    particleIntensity: SETTINGS.PARTICLE_INTENSITY.DEFAULT,
    windIntensity: SETTINGS.WIND_INTENSITY.DEFAULT,
    theme: "twilight",
    effects: DEFAULT_EFFECTS,
  },
  window: { closeToTray: false },
};

interface Range {
  readonly DEFAULT: number;
  readonly MIN: number;
  readonly MAX: number;
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const result: unknown = Reflect.get(value, key);
  return result;
}

function clampNumber(value: unknown, range: Range): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return range.DEFAULT;
  return Math.min(range.MAX, Math.max(range.MIN, value));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

/** Trims and bounds a keyword query. Returns null when empty or too long. */
export function normalizeQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= FEED.MAX_QUERY_LENGTH ? trimmed : null;
}

/** Any invalid target falls back to the timeline. */
export function parseFeedTarget(raw: unknown): FeedTarget {
  switch (readField(raw, "kind")) {
    case "timeline":
      return DEFAULT_FEED;
    case "global":
      return { kind: "global" };
    case "custom": {
      const feedUri = readField(raw, "feedUri");
      return typeof feedUri === "string" && isFeedGeneratorUri(feedUri) ? { kind: "custom", feedUri } : DEFAULT_FEED;
    }
    case "keyword": {
      const query = normalizeQuery(readField(raw, "query"));
      return query === null ? DEFAULT_FEED : { kind: "keyword", query };
    }
    default:
      return DEFAULT_FEED;
  }
}

function parseEffects(raw: unknown): EffectToggles {
  const read = (key: keyof EffectToggles): boolean => readBoolean(readField(raw, key), DEFAULT_EFFECTS[key]);
  return {
    lightParticles: read("lightParticles"),
    rain: read("rain"),
    wind: read("wind"),
    fog: read("fog"),
    fireflies: read("fireflies"),
    bloom: read("bloom"),
    dayNightCycle: read("dayNightCycle"),
    climate: read("climate"),
  };
}

function parseRenderSettings(raw: unknown): RenderSettings {
  return {
    maxPlants: Math.round(clampNumber(readField(raw, "maxPlants"), SETTINGS.MAX_PLANTS)),
    plantLifetimeMs: Math.round(clampNumber(readField(raw, "plantLifetimeMs"), SETTINGS.PLANT_LIFETIME_MS)),
    animationSpeed: clampNumber(readField(raw, "animationSpeed"), SETTINGS.ANIMATION_SPEED),
    particleIntensity: clampNumber(readField(raw, "particleIntensity"), SETTINGS.PARTICLE_INTENSITY),
    windIntensity: clampNumber(readField(raw, "windIntensity"), SETTINGS.WIND_INTENSITY),
    theme: readOneOf(readField(raw, "theme"), THEMES, DEFAULT_SETTINGS.render.theme),
    effects: parseEffects(readField(raw, "effects")),
  };
}

/**
 * Validates untrusted settings JSON field by field (docs/DESIGN.md §35.7).
 * Unknown version or non-object input yields the defaults. Never throws.
 */
export function parseRuntimeSettings(raw: unknown): RuntimeSettings {
  if (readField(raw, "version") !== 1) return DEFAULT_SETTINGS;
  return {
    version: 1,
    feed: parseFeedTarget(readField(raw, "feed")),
    renderer: readOneOf(readField(raw, "renderer"), RENDERERS, DEFAULT_SETTINGS.renderer),
    render: parseRenderSettings(readField(raw, "render")),
    window: { closeToTray: readBoolean(readField(readField(raw, "window"), "closeToTray"), false) },
  };
}

export interface RuntimeSettingsPatch {
  readonly feed?: FeedTarget;
  readonly renderer?: RendererKind;
  readonly render?: Partial<Omit<RenderSettings, "effects">> & { readonly effects?: Partial<EffectToggles> };
  readonly window?: Partial<RuntimeSettings["window"]>;
}

/** Applies a patch and re-validates, so the result is always in range. */
export function mergeSettings(current: RuntimeSettings, patch: RuntimeSettingsPatch): RuntimeSettings {
  return parseRuntimeSettings({
    ...current,
    ...patch,
    render: { ...current.render, ...patch.render, effects: { ...current.render.effects, ...patch.render?.effects } },
    window: { ...current.window, ...patch.window },
  });
}
