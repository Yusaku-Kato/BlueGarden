/**
 * Core domain models (docs/SPEC.md §8, docs/DESIGN.md §5).
 * This module must stay free of SDK, React, PixiJS, and Tauri imports.
 */

/**
 * A Bluesky post normalized to the minimum BlueGarden needs.
 * Lives only inside a single synchronous processing pass; never stored.
 */
export interface GardenPost {
  /** at:// URI. Deduplication key. */
  readonly uri: string;
  /** Used only for mood classification. May be empty. Truncated before use. */
  readonly text: string;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
  readonly likeCount: number;
  readonly repostCount: number;
}

export type Mood = "positive" | "negative" | "neutral";

/**
 * The only plant input the rendering layer receives.
 * Contains nothing that identifies or reproduces the original post.
 */
export interface PlantSeed {
  /** Opaque sequential id ("plant-123"). Never the post URI. */
  readonly id: string;
  readonly mood: Mood;
  /** 0xRRGGBB */
  readonly color: number;
  /** Clamped to PLANT.SCALE_MIN … PLANT.SCALE_MAX. */
  readonly scale: number;
  /** Clamped to PLANT.GROWTH_MIN_MS … PLANT.GROWTH_BASE_MS. */
  readonly growthDurationMs: number;
  readonly thorny: boolean;
}

/** Feed to draw (docs/DESIGN.md §35.1). */
export type FeedTarget =
  | { readonly kind: "timeline" }
  /** at://did/app.bsky.feed.generator/rkey */
  | { readonly kind: "custom"; readonly feedUri: string }
  /** Trimmed, 1..FEED.MAX_QUERY_LENGTH characters. */
  | { readonly kind: "keyword"; readonly query: string }
  /** Jetstream Global Garden (D-18). */
  | { readonly kind: "global" };

/** Meso-scale environment derived in the domain layer (SPEC §39). */
export interface WeatherState {
  /** Normalized flow rate. Light particles keep the SPEC §26 threshold (> 25). */
  readonly postsPerMinute: number;
  /** 0..1, grows with flow rate. */
  readonly rain: number;
  /** 0..1, grows with flow rate. */
  readonly wind: number;
  /** 0..1, positive-mood share. */
  readonly light: number;
  /** 0..1, negative-mood share. */
  readonly fog: number;
  /** 0..1, flow rate times night-ness. */
  readonly fireflies: number;
}

/** Macro-scale environment from the long-term trend. */
export type GardenClimate = "temperate" | "rainyGarden" | "bloomingGarden" | "darkForest";

export interface EnvironmentState {
  readonly weather: WeatherState;
  /** 0..1 local time of day (0 = midnight). Morning / Evening derive from this (D-22). */
  readonly dayPhase: number;
  readonly climate: GardenClimate;
}

/** "twilight" is the MVP palette. */
export type GardenTheme = "twilight" | "dawn" | "moss" | "nocturne";
export type RendererKind = "pixi2d" | "three3d";

export interface EffectToggles {
  readonly lightParticles: boolean;
  readonly rain: boolean;
  readonly wind: boolean;
  readonly fog: boolean;
  readonly fireflies: boolean;
  readonly bloom: boolean;
  readonly dayNightCycle: boolean;
  readonly climate: boolean;
}

/** Everything a renderer sees of the settings. */
export interface RenderSettings {
  /** 50..300, default 300 (D-23). */
  readonly maxPlants: number;
  /** 60_000..600_000, default 180_000 (D-28). */
  readonly plantLifetimeMs: number;
  /** 0.5..2, default 1 (D-24). */
  readonly animationSpeed: number;
  /** 0..2, default 1. Spawn rate only; caps are unchanged. */
  readonly particleIntensity: number;
  /** 0..2, default 1. */
  readonly windIntensity: number;
  readonly theme: GardenTheme;
  /** All true by default. */
  readonly effects: EffectToggles;
}

export interface WindowSettings {
  /** Default false. */
  readonly closeToTray: boolean;
}

export interface RuntimeSettings {
  readonly version: 1;
  /** Default timeline. Guests are pinned to global. */
  readonly feed: FeedTarget;
  /** Default pixi2d. */
  readonly renderer: RendererKind;
  readonly render: RenderSettings;
  readonly window: WindowSettings;
}

/** Swappable mood classifier (docs/DESIGN.md §11.3). */
export type MoodClassifier = (text: string) => Mood;
