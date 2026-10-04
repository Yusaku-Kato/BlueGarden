import { describe, expect, it } from "vitest";
import { FEED, SETTINGS } from "../config/gardenConfig";
import { isFeedGeneratorUri, isValidDid, isValidHandle, isValidRkey } from "./feedUri";
import { DEFAULT_SETTINGS, mergeSettings, parseRuntimeSettings } from "./settings";

const FEED_URI = "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.generator/my-feed";

describe("DEFAULT_SETTINGS", () => {
  it("matches the documented defaults", () => {
    expect(DEFAULT_SETTINGS.feed).toEqual({ kind: "timeline" });
    expect(DEFAULT_SETTINGS.renderer).toBe("pixi2d");
    expect(DEFAULT_SETTINGS.render.theme).toBe("twilight");
    expect(DEFAULT_SETTINGS.render.maxPlants).toBe(300);
    expect(DEFAULT_SETTINGS.render.plantLifetimeMs).toBe(180_000);
    expect(Object.values(DEFAULT_SETTINGS.render.effects).every(Boolean)).toBe(true);
    expect(DEFAULT_SETTINGS.window.closeToTray).toBe(false);
  });
});

describe("parseRuntimeSettings", () => {
  it("returns defaults for non-objects and unknown versions", () => {
    for (const raw of [undefined, null, 5, "x", [], {}, { version: 2 }, { version: "1" }]) {
      expect(parseRuntimeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("round-trips valid settings", () => {
    const valid = {
      ...DEFAULT_SETTINGS,
      feed: { kind: "custom", feedUri: FEED_URI },
      renderer: "three3d",
      render: { ...DEFAULT_SETTINGS.render, theme: "moss", maxPlants: 120 },
      window: { closeToTray: true },
    };
    expect(parseRuntimeSettings(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it("clamps numbers and falls back on junk per field", () => {
    const parsed = parseRuntimeSettings({
      version: 1,
      renderer: "vulkan",
      render: {
        maxPlants: 10_000,
        plantLifetimeMs: 1,
        animationSpeed: Number.NaN,
        particleIntensity: -3,
        windIntensity: "high",
        theme: "neon",
        effects: { rain: false, fog: "no" },
      },
      window: { closeToTray: "yes" },
    });
    expect(parsed.renderer).toBe("pixi2d");
    expect(parsed.render.maxPlants).toBe(SETTINGS.MAX_PLANTS.MAX);
    expect(parsed.render.plantLifetimeMs).toBe(SETTINGS.PLANT_LIFETIME_MS.MIN);
    expect(parsed.render.animationSpeed).toBe(SETTINGS.ANIMATION_SPEED.DEFAULT);
    expect(parsed.render.particleIntensity).toBe(0);
    expect(parsed.render.windIntensity).toBe(SETTINGS.WIND_INTENSITY.DEFAULT);
    expect(parsed.render.theme).toBe("twilight");
    expect(parsed.render.effects.rain).toBe(false);
    expect(parsed.render.effects.fog).toBe(true);
    expect(parsed.window.closeToTray).toBe(false);
  });

  it("validates feed targets", () => {
    const feed = (value: unknown) => parseRuntimeSettings({ version: 1, feed: value }).feed;
    expect(feed({ kind: "global" })).toEqual({ kind: "global" });
    expect(feed({ kind: "custom", feedUri: FEED_URI })).toEqual({ kind: "custom", feedUri: FEED_URI });
    expect(feed({ kind: "custom", feedUri: "at://did:plc:x/app.bsky.feed.post/1" })).toEqual({ kind: "timeline" });
    expect(feed({ kind: "custom", feedUri: "https://example.com" })).toEqual({ kind: "timeline" });
    expect(feed({ kind: "custom" })).toEqual({ kind: "timeline" });
    expect(feed({ kind: "keyword", query: "  moss  " })).toEqual({ kind: "keyword", query: "moss" });
    expect(feed({ kind: "keyword", query: "   " })).toEqual({ kind: "timeline" });
    expect(feed({ kind: "keyword", query: "a".repeat(FEED.MAX_QUERY_LENGTH + 1) })).toEqual({ kind: "timeline" });
    expect(feed({ kind: "keyword", query: "a".repeat(FEED.MAX_QUERY_LENGTH) })).toMatchObject({ kind: "keyword" });
    expect(feed("timeline")).toEqual({ kind: "timeline" });
    expect(feed({ kind: "nope" })).toEqual({ kind: "timeline" });
  });

  it("does not throw on hostile objects", () => {
    const hostile = {
      version: 1,
      get render(): unknown {
        return { maxPlants: { valueOf: () => 5 } };
      },
    };
    expect(parseRuntimeSettings(hostile).render.maxPlants).toBe(SETTINGS.MAX_PLANTS.DEFAULT);
  });
});

describe("mergeSettings", () => {
  it("applies and re-validates a patch", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      render: { maxPlants: 9_999, effects: { rain: false } },
      feed: { kind: "keyword", query: " tea " },
    });
    expect(merged.render.maxPlants).toBe(300);
    expect(merged.render.effects.rain).toBe(false);
    expect(merged.render.effects.fog).toBe(true);
    expect(merged.feed).toEqual({ kind: "keyword", query: "tea" });
  });
});

describe("feedUri validators", () => {
  it("validates DIDs, handles, rkeys and generator URIs", () => {
    expect(isValidDid("did:plc:abc123")).toBe(true);
    expect(isValidDid("did:web:example.com")).toBe(true);
    expect(isValidDid("did:plc:")).toBe(false);
    expect(isValidDid("DID:plc:abc")).toBe(false);
    expect(isValidDid("did:plc:a b")).toBe(false);
    expect(isValidHandle("alice.example.com")).toBe(true);
    expect(isValidHandle("alice")).toBe(false);
    expect(isValidHandle("-a.example.com")).toBe(false);
    expect(isValidHandle("a.b.1")).toBe(false);
    expect(isValidHandle("a/b.example.com")).toBe(false);
    expect(isValidRkey("my-feed_1.x")).toBe(true);
    expect(isValidRkey("..")).toBe(false);
    expect(isValidRkey("a/b")).toBe(false);
    expect(isValidRkey("")).toBe(false);
    expect(isFeedGeneratorUri(FEED_URI)).toBe(true);
    expect(isFeedGeneratorUri(`${FEED_URI}/extra`)).toBe(false);
    expect(isFeedGeneratorUri("at://did:plc:abc/app.bsky.feed.generator")).toBe(false);
  });
});
