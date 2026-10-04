/**
 * Procedural low-poly plant geometry (docs/DESIGN.md §36.6, Q-10). Pure and seeded: the same
 * (mood, variant) always yields the same geometry. No WebGL is needed, so it runs in node tests.
 *
 * Every variant is one merged BufferGeometry with position, normal and a per-vertex `aPart`
 * attribute (see PLANT_PART) that the plant material uses to tint stem / leaf / flower / thorn
 * differently from the single per-instance color. The plant stands at the origin, about 1 unit tall.
 */
import {
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Mood } from "../../domain/models";

export const PLANT_PART = { stem: 0, leaf: 1, flower: 2, thorn: 3, core: 4 } as const;
export type PlantPart = (typeof PLANT_PART)[keyof typeof PLANT_PART];
export const PLANT_PART_COUNT = 5;

/** Hard budget per variant (DESIGN §36.6). */
export const MAX_VARIANT_TRIANGLES = 2_000;

interface LeafSpec {
  readonly count: number;
  /** Position range along the stem, 0 (base) .. 1 (tip). */
  readonly from: number;
  readonly to: number;
  readonly length: number;
  readonly width: number;
  /** Circle segments: 4 = a sharp diamond, 8+ = a round leaf. */
  readonly segments: number;
  /** Angle from vertical in radians (0 = upright, PI/2 = horizontal, more = drooping). */
  readonly pitch: number;
}

interface FlowerSpec {
  readonly t: number;
  readonly petals: number;
  readonly petalLength: number;
  readonly petalWidth: number;
  readonly petalSegments: number;
  /** 0 = flat open flower, ~1.2 = upright cup. */
  readonly cup: number;
  readonly coreRadius: number;
  /** Tilts the flower away from the stem tangent. */
  readonly tilt: number;
  readonly part: PlantPart;
}

interface ThornSpec {
  readonly count: number;
  readonly from: number;
  readonly to: number;
  readonly length: number;
  readonly radius: number;
}

interface VariantSpec {
  readonly height: number;
  readonly bend: number;
  readonly stemRadius: number;
  readonly leaves: readonly LeafSpec[];
  readonly flowers: readonly FlowerSpec[];
  readonly thorns: readonly ThornSpec[];
}

const NO_THORNS: readonly ThornSpec[] = [];
const NO_FLOWERS: readonly FlowerSpec[] = [];

const RADIAL_SEGMENTS = 6;
const TUBULAR_SEGMENTS = 8;
const TIP_TAPER = 0.3;

function flower(
  t: number,
  petals: number,
  petalLength: number,
  petalWidth: number,
  cup: number,
  coreRadius: number,
  tilt = 0,
  petalSegments = 6,
  part: PlantPart = PLANT_PART.flower,
): FlowerSpec {
  return { t, petals, petalLength, petalWidth, petalSegments, cup, coreRadius, tilt, part };
}

const VARIANTS: Readonly<Record<Mood, readonly VariantSpec[]>> = {
  // Pink / orange blossoms and round leaves.
  positive: [
    {
      height: 1.0,
      bend: 0.12,
      stemRadius: 0.028,
      leaves: [{ count: 4, from: 0.12, to: 0.55, length: 0.3, width: 0.22, segments: 9, pitch: 1.05 }],
      flowers: [flower(1, 8, 0.3, 0.17, 0.25, 0.07)],
      thorns: NO_THORNS,
    },
    {
      height: 1.15,
      bend: 0.08,
      stemRadius: 0.03,
      leaves: [{ count: 3, from: 0.05, to: 0.4, length: 0.48, width: 0.24, segments: 8, pitch: 0.5 }],
      flowers: [flower(1, 5, 0.27, 0.22, 1.25, 0.06)],
      thorns: NO_THORNS,
    },
    {
      height: 0.85,
      bend: 0.3,
      stemRadius: 0.026,
      leaves: [{ count: 6, from: 0.1, to: 0.7, length: 0.24, width: 0.2, segments: 9, pitch: 1.1 }],
      flowers: [
        flower(1, 6, 0.2, 0.13, 0.5, 0.05),
        flower(0.78, 5, 0.16, 0.11, 0.7, 0.04, 0.9),
        flower(0.6, 5, 0.14, 0.1, 0.8, 0.035, -0.9),
      ],
      thorns: NO_THORNS,
    },
    {
      height: 1.35,
      bend: 0.5,
      stemRadius: 0.024,
      leaves: [{ count: 8, from: 0.1, to: 0.85, length: 0.26, width: 0.2, segments: 8, pitch: 1.2 }],
      flowers: [flower(1, 7, 0.22, 0.14, 0.4, 0.05), flower(0.7, 5, 0.15, 0.1, 0.6, 0.035, 1.0)],
      thorns: NO_THORNS,
    },
  ],
  // Ordinary green leaves.
  neutral: [
    {
      height: 0.8,
      bend: 0.1,
      stemRadius: 0.025,
      leaves: [{ count: 4, from: 0.3, to: 0.95, length: 0.42, width: 0.22, segments: 8, pitch: 0.9 }],
      flowers: NO_FLOWERS,
      thorns: NO_THORNS,
    },
    {
      height: 0.18,
      bend: 0.02,
      stemRadius: 0.02,
      leaves: [{ count: 8, from: 0, to: 0.2, length: 0.85, width: 0.1, segments: 6, pitch: 0.35 }],
      flowers: NO_FLOWERS,
      thorns: NO_THORNS,
    },
    {
      height: 1.2,
      bend: 0.22,
      stemRadius: 0.03,
      leaves: [{ count: 8, from: 0.25, to: 0.95, length: 0.36, width: 0.2, segments: 8, pitch: 1.0 }],
      flowers: NO_FLOWERS,
      thorns: NO_THORNS,
    },
  ],
  // Thorns and sharp leaves.
  negative: [
    {
      height: 1.1,
      bend: 0.45,
      stemRadius: 0.032,
      leaves: [{ count: 4, from: 0.2, to: 0.8, length: 0.38, width: 0.13, segments: 4, pitch: 1.1 }],
      flowers: NO_FLOWERS,
      thorns: [{ count: 10, from: 0.1, to: 0.9, length: 0.11, radius: 0.026 }],
    },
    {
      height: 0.2,
      bend: 0.02,
      stemRadius: 0.03,
      leaves: [{ count: 9, from: 0, to: 0.05, length: 0.85, width: 0.2, segments: 4, pitch: 0.7 }],
      flowers: NO_FLOWERS,
      thorns: NO_THORNS,
    },
    {
      height: 1.0,
      bend: 0.12,
      stemRadius: 0.03,
      leaves: [{ count: 2, from: 0.15, to: 0.4, length: 0.34, width: 0.12, segments: 4, pitch: 0.9 }],
      flowers: [flower(1, 10, 0.2, 0.06, 1.1, 0.09, 0, 4, PLANT_PART.thorn)],
      thorns: [{ count: 6, from: 0.15, to: 0.8, length: 0.09, radius: 0.022 }],
    },
    {
      height: 1.4,
      bend: 0.7,
      stemRadius: 0.024,
      leaves: [{ count: 6, from: 0.15, to: 0.9, length: 0.34, width: 0.12, segments: 4, pitch: 1.75 }],
      flowers: NO_FLOWERS,
      thorns: [{ count: 8, from: 0.1, to: 0.95, length: 0.1, radius: 0.022 }],
    },
  ],
};

export const PLANT_VARIANT_COUNTS: Readonly<Record<Mood, number>> = {
  positive: VARIANTS.positive.length,
  neutral: VARIANTS.neutral.length,
  negative: VARIANTS.negative.length,
};

/** mulberry32: small, fast, deterministic. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MOOD_SEED: Readonly<Record<Mood, number>> = { positive: 0x1a2b3c, neutral: 0x4d5e6f, negative: 0x708192 };

/** Seed of one variant (stable across runs). */
export function variantSeed(mood: Mood, variant: number): number {
  return (MOOD_SEED[mood] ^ Math.imul(variant + 1, 0x9e3779b1)) >>> 0;
}

function jitter(random: () => number, amount: number): number {
  return 1 + (random() * 2 - 1) * amount;
}

function withPart(geometry: BufferGeometry, part: PlantPart): BufferGeometry {
  // mergeGeometries needs identical attribute sets.
  geometry.deleteAttribute("uv");
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("aPart", new Float32BufferAttribute(new Float32Array(count).fill(part), 1));
  return geometry;
}

const UP = new Vector3(0, 1, 0);

/** A leaf / petal lying in the XY plane with its base at the origin and its tip at +Y. */
function bladeGeometry(length: number, width: number, segments: number): BufferGeometry {
  const geometry = new CircleGeometry(0.5, Math.max(3, Math.round(segments)));
  geometry.scale(width, length, 1);
  geometry.translate(0, length / 2, 0);
  return geometry;
}

/** Stem with the radius shrinking towards the tip. */
function taperedStem(curve: CatmullRomCurve3, radius: number): BufferGeometry {
  const geometry = new TubeGeometry(curve, TUBULAR_SEGMENTS, radius, RADIAL_SEGMENTS, false);
  const position = geometry.getAttribute("position");
  const ringSize = RADIAL_SEGMENTS + 1;
  const center = new Vector3();
  const point = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    const t = Math.floor(index / ringSize) / TUBULAR_SEGMENTS;
    curve.getPointAt(Math.min(1, t), center);
    point.fromBufferAttribute(position, index).sub(center).multiplyScalar(1 - (1 - TIP_TAPER) * t).add(center);
    position.setXYZ(index, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return withPart(geometry, PLANT_PART.stem);
}

function buildStemCurve(spec: VariantSpec, random: () => number): CatmullRomCurve3 {
  const heading = random() * Math.PI * 2;
  const bendX = Math.cos(heading) * spec.bend;
  const bendZ = Math.sin(heading) * spec.bend;
  const height = spec.height;
  return new CatmullRomCurve3([
    new Vector3(0, 0, 0),
    new Vector3(bendX * 0.15, height * 0.35, bendZ * 0.15),
    new Vector3(bendX * 0.55, height * 0.7, bendZ * 0.55),
    new Vector3(bendX, height, bendZ),
  ]);
}

function addLeaves(
  parts: BufferGeometry[],
  curve: CatmullRomCurve3,
  leaves: LeafSpec,
  random: () => number,
): void {
  const point = new Vector3();
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const euler = new Euler(0, 0, 0, "YXZ");
  const unit = new Vector3(1, 1, 1);
  const golden = 2.399963;
  const azimuthStart = random() * Math.PI * 2;
  for (let index = 0; index < leaves.count; index += 1) {
    const t = leaves.count === 1 ? leaves.from : leaves.from + ((leaves.to - leaves.from) * index) / (leaves.count - 1);
    curve.getPointAt(Math.min(1, Math.max(0, t)), point);
    const size = jitter(random, 0.12);
    const blade = bladeGeometry(leaves.length * size, leaves.width * size, leaves.segments);
    euler.set(leaves.pitch * jitter(random, 0.12), azimuthStart + index * golden, 0);
    rotation.setFromEuler(euler);
    matrix.compose(point, rotation, unit);
    blade.applyMatrix4(matrix);
    parts.push(withPart(blade, PLANT_PART.leaf));
  }
}

function addFlower(
  parts: BufferGeometry[],
  curve: CatmullRomCurve3,
  spec: FlowerSpec,
  random: () => number,
): void {
  const point = new Vector3();
  const tangent = new Vector3();
  curve.getPointAt(Math.min(1, Math.max(0, spec.t)), point);
  curve.getTangentAt(Math.min(1, Math.max(0, spec.t)), tangent);
  const orientation = new Quaternion().setFromUnitVectors(UP, tangent.normalize());
  if (spec.tilt !== 0) {
    const tiltAxis = new Vector3(Math.cos(random() * Math.PI * 2), 0, Math.sin(random() * Math.PI * 2));
    orientation.premultiply(new Quaternion().setFromAxisAngle(tiltAxis, spec.tilt));
  }
  const euler = new Euler(0, 0, 0, "YXZ");
  const petalRotation = new Quaternion();
  const matrix = new Matrix4();
  const unit = new Vector3(1, 1, 1);
  const spin = random() * Math.PI * 2;
  const petalTilt = Math.PI / 2 - spec.cup;
  for (let index = 0; index < spec.petals; index += 1) {
    const blade = bladeGeometry(spec.petalLength, spec.petalWidth, spec.petalSegments);
    euler.set(petalTilt, spin + (index * Math.PI * 2) / spec.petals, 0);
    petalRotation.setFromEuler(euler).premultiply(orientation);
    matrix.compose(point, petalRotation, unit);
    blade.applyMatrix4(matrix);
    parts.push(withPart(blade, spec.part));
  }
  const core = new SphereGeometry(spec.coreRadius, 6, 4);
  const lift = tangent.clone().multiplyScalar(spec.coreRadius * 0.6).add(point);
  core.translate(lift.x, lift.y, lift.z);
  parts.push(withPart(core, PLANT_PART.core));
}

function addThorns(
  parts: BufferGeometry[],
  curve: CatmullRomCurve3,
  spec: ThornSpec,
  stemRadius: number,
  random: () => number,
): void {
  const point = new Vector3();
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const euler = new Euler(0, 0, 0, "YXZ");
  const unit = new Vector3(1, 1, 1);
  const golden = 2.399963;
  const azimuthStart = random() * Math.PI * 2;
  for (let index = 0; index < spec.count; index += 1) {
    const t = spec.count === 1 ? spec.from : spec.from + ((spec.to - spec.from) * index) / (spec.count - 1);
    curve.getPointAt(Math.min(1, Math.max(0, t)), point);
    const thorn = new ConeGeometry(spec.radius, spec.length, 5, 1, true);
    thorn.translate(0, spec.length / 2 - stemRadius * 0.3, 0);
    euler.set(1.15 + random() * 0.4, azimuthStart + index * golden, 0);
    rotation.setFromEuler(euler);
    matrix.compose(point, rotation, unit);
    thorn.applyMatrix4(matrix);
    parts.push(withPart(thorn, PLANT_PART.thorn));
  }
}

/** Build the merged geometry of one variant. Throws only if merging fails (never for built-in specs). */
export function buildPlantGeometry(mood: Mood, variant: number): BufferGeometry {
  const specs = VARIANTS[mood];
  const spec = specs[((Math.trunc(variant) % specs.length) + specs.length) % specs.length];
  if (spec === undefined) throw new Error("No plant variant defined");
  const random = createSeededRandom(variantSeed(mood, variant));

  const curve = buildStemCurve(spec, random);
  const parts: BufferGeometry[] = [taperedStem(curve, spec.stemRadius)];
  for (const leaves of spec.leaves) addLeaves(parts, curve, leaves, random);
  for (const bloom of spec.flowers) addFlower(parts, curve, bloom, random);
  for (const thorns of spec.thorns) addThorns(parts, curve, thorns, spec.stemRadius, random);

  // The typings omit it, but mergeGeometries returns null when the attribute sets do not match.
  const merged = mergeGeometries(parts, false) as BufferGeometry | null;
  for (const part of parts) part.dispose();
  if (merged === null) throw new Error("Failed to merge plant geometry");
  merged.computeBoundingSphere();
  return merged;
}

/** Triangle count of an indexed or non-indexed geometry. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  if (index !== null) return Math.floor(index.count / 3);
  return Math.floor(geometry.getAttribute("position").count / 3);
}
