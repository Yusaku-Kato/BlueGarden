/**
 * Owner of the shared plant geometries and materials (docs/DESIGN.md §36.6, §38).
 * One InstancedMesh per (mood, variant), capacity fixed at creation. Per instance:
 *   - instanceMatrix: position, yaw and lean (written on spawn / layout only)
 *   - instanceColor: the seed color
 *   - aParams (vec4): current scale, fade alpha, sway phase, sway strength (written per frame)
 * Sway runs in the vertex shader and the fade is a dither (alpha hash), so there is no per-plant
 * CPU sway and no transparent sorting.
 */
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  Vector4,
} from "three";
import type { BufferGeometry, IUniform, Object3D } from "three";
import { PLANT } from "../../config/gardenConfig";
import type { Mood } from "../../domain/models";
import {
  PLANT_PART_COUNT,
  PLANT_VARIANT_COUNTS,
  buildPlantGeometry,
} from "./proceduralPlant";
import { SlotPool } from "./slotPool";

/** Sway is exaggerated a little in 3D (perspective hides a rotation of 0.018 rad). */
const SWAY_GAIN = 2.2;
const PARAMS_STRIDE = 4;
const MATRIX_STRIDE = 16;
const COLOR_STRIDE = 3;

const MOODS: readonly Mood[] = ["positive", "neutral", "negative"];

/** [target color, mix amount of the target over the instance color, brightness] per PLANT_PART. */
type PartStyle = readonly [target: number, amount: number, light: number];

const PART_STYLES: Readonly<Record<Mood, readonly PartStyle[]>> = {
  positive: [
    [0x3f7d46, 0.75, 0.85], // stem
    [0x4caf50, 0.75, 0.9], // leaf: green, so only the blossom carries the pink / orange
    [0xffffff, 0, 1.05], // flower: the seed color
    [0x000000, 0, 1], // thorn (unused)
    [0xffe082, 0.8, 1], // core
  ],
  neutral: [
    [0x2e5a30, 0.35, 0.7],
    [0xffffff, 0, 1],
    [0xffffff, 0, 1],
    [0x000000, 0, 1],
    [0xe6c35c, 0.5, 1],
  ],
  negative: [
    [0x1b2a22, 0.35, 0.6],
    [0xffffff, 0, 0.95],
    [0xffffff, 0, 1.2],
    [0x0a0a12, 0.45, 0.85],
    [0x7b1fa2, 0.5, 1],
  ],
};

export interface PlantUniforms {
  /** Wind phase in radians (wrapped by the caller). */
  readonly uTime: IUniform<number>;
  /** Sway multiplier (the engine's wind factor). */
  readonly uWind: IUniform<number>;
  /** Emissive strength of flowers (night + bloom). */
  readonly uGlow: IUniform<number>;
}

export function createPlantUniforms(): PlantUniforms {
  return { uTime: { value: 0 }, uWind: { value: 1 }, uGlow: { value: 0 } };
}

function glslFloat(value: number): string {
  return value.toFixed(5);
}

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

/** Splices the instanced sway / fade / part-tint code into MeshLambertMaterial's shaders. Pure. */
export function patchPlantShaders(source: ShaderSource): ShaderSource {
  const amplitude = glslFloat(PLANT.WIND_AMPLITUDE * SWAY_GAIN);
  const vertexShader = source.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
attribute vec4 aParams;
attribute float aPart;
uniform float uTime;
uniform float uWind;
varying float vFade;
varying float vPart;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
vFade = aParams.y;
vPart = aPart;
float bendHeight = transformed.y * aParams.x;
transformed *= aParams.x;
float swayPhase = uTime + aParams.z;
float swayAmount = uWind * aParams.w * ${amplitude} * bendHeight;
transformed.x += sin(swayPhase) * swayAmount;
transformed.z += sin(swayPhase * 0.83 + 1.3) * swayAmount * 0.6;`,
    );
  const fragmentShader = source.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
varying float vFade;
varying float vPart;
uniform vec4 uPartTarget[${String(PLANT_PART_COUNT)}];
uniform float uPartLight[${String(PLANT_PART_COUNT)}];
uniform float uGlow;`,
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
int partIndex = int(vPart + 0.5);
vec4 partTarget = uPartTarget[partIndex];
diffuseColor = vec4(mix(vColor.rgb, partTarget.rgb, partTarget.a) * uPartLight[partIndex], vFade);`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
float glowMask = step(1.5, vPart) * (1.0 - step(2.5, vPart)) + step(3.5, vPart);
totalEmissiveRadiance += diffuseColor.rgb * uGlow * glowMask;`,
    );
  return { vertexShader, fragmentShader };
}

function createPartUniforms(mood: Mood): { target: IUniform<Vector4[]>; light: IUniform<number[]> } {
  const target: Vector4[] = [];
  const light: number[] = [];
  const styles = PART_STYLES[mood];
  for (let part = 0; part < PLANT_PART_COUNT; part += 1) {
    const style = styles[part] ?? [0xffffff, 0, 1];
    const color = new Color(style[0]);
    target.push(new Vector4(color.r, color.g, color.b, style[1]));
    light.push(style[2]);
  }
  return { target: { value: target }, light: { value: light } };
}

function createPlantMaterial(mood: Mood, uniforms: PlantUniforms): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ flatShading: true, side: DoubleSide, alphaHash: true });
  const partUniforms = createPartUniforms(mood);
  material.onBeforeCompile = (shader) => {
    const patched = patchPlantShaders(shader);
    shader.vertexShader = patched.vertexShader;
    shader.fragmentShader = patched.fragmentShader;
    shader.uniforms["uTime"] = uniforms.uTime;
    shader.uniforms["uWind"] = uniforms.uWind;
    shader.uniforms["uGlow"] = uniforms.uGlow;
    shader.uniforms["uPartTarget"] = partUniforms.target;
    shader.uniforms["uPartLight"] = partUniforms.light;
  };
  material.customProgramCacheKey = () => "bluegarden-plant";
  return material;
}

export interface PlantPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Tilt in radians. */
  readonly lean: number;
}

export interface PlantStyle {
  /** 0xRRGGBB seed color. */
  readonly color: number;
  readonly swayPhase: number;
  /** Per-plant sway strength multiplier. */
  readonly swayStrength: number;
}

/** Handle to one live instance. `slot` changes when another instance is removed (swap-remove). */
export interface PlantInstance {
  slot: number;
  readonly batch: PlantBatch;
}

export interface PlantBatch {
  readonly mood: Mood;
  readonly mesh: InstancedMesh;
  readonly pool: SlotPool<PlantInstance>;
  readonly params: InstancedBufferAttribute;
  matrixDirty: boolean;
  colorDirty: boolean;
  paramsDirty: boolean;
}

export class PlantMeshes {
  readonly uniforms: PlantUniforms = createPlantUniforms();
  private batches: PlantBatch[] = [];
  private batchesByMood: Record<Mood, PlantBatch[]> = { positive: [], neutral: [], negative: [] };
  private geometries: BufferGeometry[] = [];
  private materials: MeshLambertMaterial[] = [];
  private disposed = false;

  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, "YXZ");
  private readonly unit = new Vector3(1, 1, 1);
  private readonly color = new Color();

  constructor(
    private readonly parent: Object3D,
    capacity: number,
  ) {
    for (const mood of MOODS) {
      const material = createPlantMaterial(mood, this.uniforms);
      this.materials.push(material);
      for (let variant = 0; variant < PLANT_VARIANT_COUNTS[mood]; variant += 1) {
        const geometry = buildPlantGeometry(mood, variant);
        this.geometries.push(geometry);
        const batch = this.createBatch(mood, geometry, material, capacity);
        this.batches.push(batch);
        this.batchesByMood[mood].push(batch);
      }
    }
  }

  /** Number of live instances over all variants. */
  get count(): number {
    let total = 0;
    for (const batch of this.batches) total += batch.pool.count;
    return total;
  }

  get variantCount(): number {
    return this.batches.length;
  }

  variantsOf(mood: Mood): number {
    return this.batchesByMood[mood].length;
  }

  /** Returns null when the variant's batch is full. The new instance starts invisible (scale 0, alpha 0). */
  add(mood: Mood, variant: number, placement: PlantPlacement, style: PlantStyle): PlantInstance | null {
    if (this.disposed) return null;
    const candidates = this.batchesByMood[mood];
    const batch = candidates[Math.max(0, Math.floor(variant)) % Math.max(1, candidates.length)];
    if (batch === undefined) return null;
    const instance: PlantInstance = { slot: -1, batch };
    const slot = batch.pool.acquire(instance);
    if (slot < 0) return null;
    instance.slot = slot;
    this.writeMatrix(batch, slot, placement);
    this.writeColor(batch, slot, style.color);
    const params = batch.params.array;
    const offset = slot * PARAMS_STRIDE;
    params[offset] = 0;
    params[offset + 1] = 0;
    params[offset + 2] = style.swayPhase;
    params[offset + 3] = style.swayStrength;
    batch.paramsDirty = true;
    return instance;
  }

  /** Rewrite the matrix (layout change). */
  place(instance: PlantInstance, placement: PlantPlacement): void {
    this.writeMatrix(instance.batch, instance.slot, placement);
  }

  setAppearance(instance: PlantInstance, scale: number, alpha: number): void {
    const params = instance.batch.params.array;
    const offset = instance.slot * PARAMS_STRIDE;
    params[offset] = scale;
    params[offset + 1] = alpha;
    instance.batch.paramsDirty = true;
  }

  /** Swap-remove: the last instance of the batch moves into the freed slot. */
  remove(instance: PlantInstance): void {
    const batch = instance.batch;
    const slot = instance.slot;
    if (slot < 0 || batch.pool.ownerAt(slot) !== instance) return;
    const move = batch.pool.release(slot);
    instance.slot = -1;
    if (move !== null) {
      const moved = batch.pool.ownerAt(move.to);
      if (moved !== undefined) moved.slot = move.to;
      copySlot(batch.mesh.instanceMatrix.array, move.from, move.to, MATRIX_STRIDE);
      copySlot(batch.params.array, move.from, move.to, PARAMS_STRIDE);
      const colorArray = batch.mesh.instanceColor?.array;
      if (colorArray !== undefined) copySlot(colorArray, move.from, move.to, COLOR_STRIDE);
      batch.colorDirty = true;
    }
    batch.matrixDirty = true;
    batch.paramsDirty = true;
  }

  /** Upload what changed and set the draw counts. Call once per frame after updating instances. */
  flush(): void {
    for (const batch of this.batches) {
      const count = batch.pool.count;
      batch.mesh.count = count;
      batch.mesh.visible = count > 0;
      if (batch.matrixDirty) {
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.matrixDirty = false;
      }
      if (batch.colorDirty && batch.mesh.instanceColor !== null) {
        batch.mesh.instanceColor.needsUpdate = true;
        batch.colorDirty = false;
      }
      if (batch.paramsDirty) {
        batch.params.needsUpdate = true;
        batch.paramsDirty = false;
      }
    }
  }

  /** Remove every instance (keeps geometries and materials). */
  clear(): void {
    for (const batch of this.batches) {
      batch.pool.clear();
      batch.mesh.count = 0;
      batch.mesh.visible = false;
    }
  }

  /** Release every GPU resource. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const batch of this.batches) {
      batch.pool.clear();
      this.parent.remove(batch.mesh);
      batch.mesh.dispose();
    }
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.batches = [];
    this.batchesByMood = { positive: [], neutral: [], negative: [] };
    this.geometries = [];
    this.materials = [];
  }

  private createBatch(
    mood: Mood,
    geometry: BufferGeometry,
    material: MeshLambertMaterial,
    capacity: number,
  ): PlantBatch {
    const params = new InstancedBufferAttribute(new Float32Array(capacity * PARAMS_STRIDE), PARAMS_STRIDE);
    params.setUsage(DynamicDrawUsage);
    geometry.setAttribute("aParams", params);
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Allocated up front so the program is compiled with USE_INSTANCING_COLOR.
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * COLOR_STRIDE), COLOR_STRIDE);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false; // the shader moves vertices; instances span the whole scene anyway
    mesh.count = 0;
    mesh.visible = false;
    this.parent.add(mesh);
    return {
      mood,
      mesh,
      pool: new SlotPool<PlantInstance>(capacity),
      params,
      matrixDirty: false,
      colorDirty: false,
      paramsDirty: false,
    };
  }

  private writeMatrix(batch: PlantBatch, slot: number, placement: PlantPlacement): void {
    this.position.set(placement.x, placement.y, placement.z);
    this.euler.set(placement.lean * 0.5, placement.yaw, placement.lean);
    this.rotation.setFromEuler(this.euler);
    this.matrix.compose(this.position, this.rotation, this.unit);
    this.matrix.toArray(batch.mesh.instanceMatrix.array, slot * MATRIX_STRIDE);
    batch.matrixDirty = true;
  }

  private writeColor(batch: PlantBatch, slot: number, hex: number): void {
    const colors = batch.mesh.instanceColor;
    if (colors === null) return;
    this.color.setHex(hex);
    colors.setXYZ(slot, this.color.r, this.color.g, this.color.b);
    batch.colorDirty = true;
  }
}

function copySlot(
  array: { [index: number]: number },
  from: number,
  to: number,
  stride: number,
): void {
  for (let component = 0; component < stride; component += 1) {
    array[to * stride + component] = array[from * stride + component] ?? 0;
  }
}
