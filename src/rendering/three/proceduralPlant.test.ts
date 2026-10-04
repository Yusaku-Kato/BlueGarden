import { describe, expect, it } from "vitest";
import type { Mood } from "../../domain/models";
import {
  MAX_VARIANT_TRIANGLES,
  PLANT_PART,
  PLANT_VARIANT_COUNTS,
  buildPlantGeometry,
  createSeededRandom,
  triangleCount,
  variantSeed,
} from "./proceduralPlant";

const MOODS: readonly Mood[] = ["positive", "neutral", "negative"];

function partsOf(mood: Mood, variant: number): Set<number> {
  const geometry = buildPlantGeometry(mood, variant);
  const attribute = geometry.getAttribute("aPart");
  const found = new Set<number>();
  for (let index = 0; index < attribute.count; index += 1) found.add(attribute.getX(index));
  geometry.dispose();
  return found;
}

describe("plant variants", () => {
  it("defines 3 to 5 variants per mood", () => {
    for (const mood of MOODS) {
      expect(PLANT_VARIANT_COUNTS[mood]).toBeGreaterThanOrEqual(3);
      expect(PLANT_VARIANT_COUNTS[mood]).toBeLessThanOrEqual(5);
    }
  });

  it("stays within the triangle budget and has the attributes the material needs", () => {
    for (const mood of MOODS) {
      for (let variant = 0; variant < PLANT_VARIANT_COUNTS[mood]; variant += 1) {
        const geometry = buildPlantGeometry(mood, variant);
        const triangles = triangleCount(geometry);
        expect(triangles).toBeGreaterThan(0);
        expect(triangles).toBeLessThanOrEqual(MAX_VARIANT_TRIANGLES);
        const position = geometry.getAttribute("position");
        expect(geometry.getAttribute("normal").count).toBe(position.count);
        expect(geometry.getAttribute("aPart").count).toBe(position.count);
        for (let index = 0; index < position.count; index += 1) {
          expect(Number.isFinite(position.getX(index))).toBe(true);
          expect(Number.isFinite(position.getY(index))).toBe(true);
          expect(Number.isFinite(position.getZ(index))).toBe(true);
        }
        geometry.dispose();
      }
    }
  });

  it("is deterministic: the same (mood, variant) gives identical vertices", () => {
    for (const mood of MOODS) {
      const first = buildPlantGeometry(mood, 1);
      const second = buildPlantGeometry(mood, 1);
      expect(Array.from(first.getAttribute("position").array)).toEqual(
        Array.from(second.getAttribute("position").array),
      );
      first.dispose();
      second.dispose();
    }
  });

  it("gives different shapes for different variants", () => {
    const a = buildPlantGeometry("positive", 0);
    const b = buildPlantGeometry("positive", 1);
    expect(Array.from(a.getAttribute("position").array)).not.toEqual(
      Array.from(b.getAttribute("position").array),
    );
    a.dispose();
    b.dispose();
  });

  it("wraps out-of-range variant indices instead of failing", () => {
    const geometry = buildPlantGeometry("neutral", PLANT_VARIANT_COUNTS.neutral + 1);
    expect(triangleCount(geometry)).toBeGreaterThan(0);
    geometry.dispose();
  });

  it("positive plants carry flowers, negative plants carry thorns, neutral plants carry neither", () => {
    for (let variant = 0; variant < PLANT_VARIANT_COUNTS.positive; variant += 1) {
      const parts = partsOf("positive", variant);
      expect(parts.has(PLANT_PART.stem)).toBe(true);
      expect(parts.has(PLANT_PART.leaf)).toBe(true);
      expect(parts.has(PLANT_PART.flower)).toBe(true);
    }
    for (let variant = 0; variant < PLANT_VARIANT_COUNTS.negative; variant += 1) {
      const parts = partsOf("negative", variant);
      expect(parts.has(PLANT_PART.flower)).toBe(false);
      expect(parts.has(PLANT_PART.thorn) || parts.has(PLANT_PART.leaf)).toBe(true);
    }
    const thornVariants = Array.from({ length: PLANT_VARIANT_COUNTS.negative }, (_, variant) =>
      partsOf("negative", variant).has(PLANT_PART.thorn),
    );
    expect(thornVariants.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    for (let variant = 0; variant < PLANT_VARIANT_COUNTS.neutral; variant += 1) {
      const parts = partsOf("neutral", variant);
      expect(parts.has(PLANT_PART.flower)).toBe(false);
      expect(parts.has(PLANT_PART.thorn)).toBe(false);
    }
  });

  it("keeps plants about one unit tall and rooted at the origin", () => {
    for (const mood of MOODS) {
      for (let variant = 0; variant < PLANT_VARIANT_COUNTS[mood]; variant += 1) {
        const geometry = buildPlantGeometry(mood, variant);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        expect(box).not.toBeNull();
        expect(box?.min.y).toBeGreaterThan(-0.2);
        expect(box?.max.y).toBeLessThan(2);
        geometry.dispose();
      }
    }
  });
});

describe("seeded random", () => {
  it("repeats for the same seed and stays in [0, 1)", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    for (let index = 0; index < 100; index += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("derives different seeds per variant and mood", () => {
    expect(variantSeed("positive", 0)).not.toBe(variantSeed("positive", 1));
    expect(variantSeed("positive", 0)).not.toBe(variantSeed("negative", 0));
  });
});
