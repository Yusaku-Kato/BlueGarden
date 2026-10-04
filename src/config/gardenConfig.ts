/**
 * All tunable constants (docs/DESIGN.md §25).
 * Values marked "SPEC" come from docs/SPEC.md; "design" values are defined in docs/DESIGN.md §30.
 */

export const POLLING = {
  INTERVAL_MS: 15_000, // SPEC §11
  MAX_BACKOFF_MS: 60_000, // SPEC §11.1 (also caps rate-limit waits)
  FETCH_TIMEOUT_MS: 20_000, // design
  TIMELINE_FETCH_LIMIT: 50, // design (lexicon default)
} as const;

export const BLUESKY = {
  SERVICE_URL: "https://bsky.social",
  /** Must match `connect-src` in src-tauri/tauri.conf.json. */
  ALLOWED_PDS_HOST_PATTERNS: ["bsky.social", "*.bsky.network"],
  MAX_TEXT_LENGTH_FOR_ANALYSIS: 3_000, // design
  MAX_IDENTIFIER_LENGTH: 253,
  /** Unauthenticated AppView. Must match `connect-src` in src-tauri/tauri.conf.json (DESIGN §37). */
  PUBLIC_APPVIEW_URL: "https://public.api.bsky.app", // design
} as const;

export const DEDUP = {
  SEEN_POST_LIMIT: 5_000, // SPEC §12
} as const;

export const PLANT = {
  MAX_PLANTS: 300, // SPEC §20
  LIFETIME_MS: 180_000, // SPEC §19.1
  LIFETIME_JITTER_RATIO: 0.1, // design
  FADE_MS: 20_000, // SPEC §19.1
  EVICTION_FADE_MS: 1_000, // design
  FADE_IN_MS: 400, // design
  INITIAL_SCALE: 0.01, // SPEC §23
  SCALE_MIN: 0.75, // SPEC §17.2
  SCALE_MAX: 2.4, // SPEC §17.2
  SCALE_LOG_FACTOR: 0.16, // SPEC §17.2
  GROWTH_BASE_MS: 2_500, // SPEC §18
  GROWTH_MIN_MS: 1_000, // design
  GROWTH_LOG_FACTOR_MS: 250, // design
  SPAWN_PER_SECOND: 4, // design
  SPAWN_QUEUE_LIMIT: 100, // design
  WIND_AMPLITUDE: 0.018, // SPEC §23
  WIND_SPEED: 0.0015, // design (rad/ms)
} as const;

export const FLOW = {
  WINDOW_MS: 60_000, // SPEC §25
  ENTRY_LIMIT: 64, // design
  SMOOTHING_MS: 5_000, // design
} as const;

export const PARTICLES = {
  THRESHOLD_PPM: 25, // SPEC §26
  FULL_INTENSITY_PPM: 100, // SPEC §25 "Very Active"
  MAX_SPAWN_PER_SEC: 6, // design
  MAX_PARTICLES: 150, // design
  LIFETIME_MIN_MS: 4_000, // design
  LIFETIME_MAX_MS: 8_000, // design
  FADE_IN_MS: 500, // design
  FADE_OUT_MS: 1_500, // design
} as const;

export const RENDER = {
  BACKGROUND_COLOR: 0x0b1418,
  MAX_RESOLUTION: 2,
  MAX_FPS: 60, // design (power use on high-refresh displays)
  ERROR_LOG_INTERVAL_MS: 10_000, // design
  MAX_CONTEXT_RECOVERIES: 3, // design
} as const;

/** User-adjustable settings (DESIGN §35.1, §36.1). */
export const SETTINGS = {
  MAX_PLANTS: { DEFAULT: 300, MIN: 50, MAX: 300 }, // SPEC §20 cap, range: design (D-23)
  PLANT_LIFETIME_MS: { DEFAULT: PLANT.LIFETIME_MS, MIN: 60_000, MAX: 600_000 }, // default SPEC §19.1, range design (D-28)
  ANIMATION_SPEED: { DEFAULT: 1, MIN: 0.5, MAX: 2 }, // design (D-24)
  PARTICLE_INTENSITY: { DEFAULT: 1, MIN: 0, MAX: 2 }, // design
  WIND_INTENSITY: { DEFAULT: 1, MIN: 0, MAX: 2 }, // design
  SAVE_DEBOUNCE_MS: 500, // design
  MAX_FILE_BYTES: 16_384, // design (matches the Rust command limit)
} as const;

/** Feed selection and retrieval (DESIGN §36.2). */
export const FEED = {
  MAX_QUERY_LENGTH: 100, // design
  CUSTOM_FETCH_LIMIT: 50, // design
  SEARCH_FETCH_LIMIT: 50, // design
  DISCOVER_FEED_URI: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot", // design
} as const;

/** Global Garden over Jetstream (DESIGN §36.3, D-20, D-21). */
export const JETSTREAM = {
  /** Tried in order on failover. Must match `connect-src` (DESIGN §37). */
  HOSTS: [
    "jetstream2.us-east.bsky.network",
    "jetstream1.us-east.bsky.network",
    "jetstream1.us-west.bsky.network",
    "jetstream2.us-west.bsky.network",
  ], // design
  MAX_PLANTS_PER_SEC: 2, // design (Q-12)
  FLUSH_INTERVAL_MS: 2_000, // design
  BATCH_LIMIT: 10, // design
  ACTIVITY_SCALE: 0.02, // design (D-21): ~30 posts/s * 60 * 0.02 = ~36 ppm
  CURSOR_MAX_REWIND_MS: 30_000, // design (D-20)
  RECONNECT_MIN_MS: 2_000, // design
  RECONNECT_MAX_MS: 60_000, // design
  STABLE_RESET_MS: 60_000, // design
} as const;

/** Like / repost re-fetch after growth (SPEC §13.3, DESIGN §35.6, D-29). */
export const AFTER_GROWTH = {
  DELAY_MS: 30_000, // design
  TRACK_LIMIT: 200, // design
  URIS_PER_CALL: 25, // design (getPosts lexicon limit)
} as const;

/**
 * Meso weather ramps (DESIGN §35.8). Each value maps linearly 0..1 between START and FULL.
 * PPM values are relative to PARTICLES.THRESHOLD_PPM (25) and FULL_INTENSITY_PPM (100).
 */
export const WEATHER = {
  WIND_START_PPM: 10, // design: breeze below the light-particle threshold
  WIND_FULL_PPM: 100, // design: full wind at "Very Active"
  RAIN_START_PPM: 40, // design: rain only after light particles have begun
  RAIN_FULL_PPM: 160, // design: full rain well above "Very Active"
  LIGHT_SHARE_START: 0.12, // retuned for the expanded keyword set: typical global positive share is ~0.18 (ja ~0.29), giving a subtle glow
  LIGHT_SHARE_FULL: 0.5, // full light only at ~2.5x the typical positive share
  FOG_SHARE_START: 0.07, // retuned: typical negative share is ~0.035-0.05, so ordinary traffic has no fog
  FOG_SHARE_FULL: 0.25, // noticeable (~0.4) from about 3x the typical negative share
  FIREFLY_START_PPM: 5, // design: fireflies appear even in a calm garden
  FIREFLY_FULL_PPM: 60, // design
  FIREFLY_DUSK_PHASE: 0.75, // design: 18:00, night-ness starts rising
  FIREFLY_DAWN_PHASE: 0.25, // design: 06:00, night-ness is back to 0
  FIREFLY_TWILIGHT_WIDTH: 0.04, // design: ramp width (about one hour) at each edge
} as const;

/** Long-term trend (exponential moving average, DESIGN §35.8, Q-11). */
export const TREND = {
  TAU_MS: 7_200_000, // design: 2 h
  MIN_OBSERVED_MS: 1_800_000, // design: 30 min before climate leaves "temperate"
} as const;

/**
 * Macro climate thresholds on the trend values (DESIGN §35.8, D-22).
 * HYSTERESIS is a relative margin: a climate is entered at the threshold and left
 * only after the value falls below threshold * (1 - HYSTERESIS).
 */
export const CLIMATE = {
  RAINY_PPM: 60, // design: sustained flow well above the 25 ppm threshold
  BLOOMING_POSITIVE_SHARE: 0.35, // retuned (unchanged value): ~1.9x typical global (0.18), ~1.2x ja (0.29)
  DARK_NEGATIVE_SHARE: 0.1, // retuned from 0.3: ~2-3x the typical negative share (0.035-0.05)
  HYSTERESIS: 0.15, // design
} as const;

/** Upper bounds of environment effect objects (DESIGN §36.5, §38). */
export const EFFECTS = {
  RAIN_MAX_DROPS: 300, // design
  FOG_MAX_SPRITES: 6, // design
  FIREFLIES_MAX: 40, // design
} as const;

/** OAuth loopback flow (DESIGN §36.4). */
export const OAUTH = {
  SCOPE: "atproto transition:generic", // design (§34)
  CALLBACK_PATH: "/callback", // design
  TIMEOUT_MS: 300_000, // design: 5 min
} as const;
