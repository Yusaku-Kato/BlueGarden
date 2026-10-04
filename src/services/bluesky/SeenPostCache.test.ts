import { describe, expect, it } from "vitest";
import { SeenPostCache } from "./SeenPostCache";

describe("SeenPostCache", () => {
  it("reports new then seen", () => {
    const cache = new SeenPostCache();
    expect(cache.markIfNew("at://a/1")).toBe(true);
    expect(cache.markIfNew("at://a/1")).toBe(false);
    expect(cache.has("at://a/1")).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("evicts the oldest entry beyond the limit", () => {
    const cache = new SeenPostCache(3);
    for (const uri of ["at://a/1", "at://a/2", "at://a/3", "at://a/4"]) cache.markIfNew(uri);
    expect(cache.size).toBe(3);
    expect(cache.has("at://a/1")).toBe(false);
    expect(cache.has("at://a/4")).toBe(true);
  });

  it("uses the default limit of 5000", () => {
    const cache = new SeenPostCache();
    for (let index = 0; index <= 5000; index += 1) cache.markIfNew(`at://a/${index}`);
    expect(cache.size).toBe(5000);
    expect(cache.has("at://a/0")).toBe(false);
    expect(cache.has("at://a/1")).toBe(true);
  });

  it("clears", () => {
    const cache = new SeenPostCache();
    cache.markIfNew("at://a/1");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.markIfNew("at://a/1")).toBe(true);
  });
});
