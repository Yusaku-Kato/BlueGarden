import { BufferGeometry, InstancedMesh, Material, Object3D, ShaderLib } from "three";
import { describe, expect, it, vi } from "vitest";
import { PLANT_VARIANT_COUNTS } from "./proceduralPlant";
import { PlantMeshes, patchPlantShaders } from "./plantMeshes";
import type { PlantInstance, PlantPlacement, PlantStyle } from "./plantMeshes";

const PLACEMENT: PlantPlacement = { x: 1, y: 0, z: -2, yaw: 0.5, lean: 0.05 };

function style(color: number): PlantStyle {
  return { color, swayPhase: 1.5, swayStrength: 1 };
}

function instancedMeshes(parent: Object3D): InstancedMesh[] {
  return parent.children.filter((child): child is InstancedMesh => child instanceof InstancedMesh);
}

function mustAdd(meshes: PlantMeshes, color: number, variant = 0): PlantInstance {
  const instance = meshes.add("positive", variant, PLACEMENT, style(color));
  if (instance === null) throw new Error("expected an instance");
  return instance;
}

describe("patchPlantShaders", () => {
  it("splices sway, fade and part tint into every MeshLambertMaterial hook it targets", () => {
    const patched = patchPlantShaders({
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
    });
    expect(patched.vertexShader).toContain("attribute vec4 aParams");
    expect(patched.vertexShader).toContain("transformed *= aParams.x");
    expect(patched.vertexShader).toContain("swayAmount");
    expect(patched.fragmentShader).toContain("uPartTarget");
    expect(patched.fragmentShader).toContain("vFade");
    expect(patched.fragmentShader).toContain("totalEmissiveRadiance +=");
    // The hooks must still be present exactly once, otherwise the splice silently did nothing.
    expect(patched.vertexShader.split("#include <begin_vertex>").length).toBe(2);
    expect(patched.fragmentShader.split("#include <color_fragment>").length).toBe(2);
    expect(patched.fragmentShader.split("#include <emissivemap_fragment>").length).toBe(2);
  });
});

describe("PlantMeshes", () => {
  it("creates one InstancedMesh per variant with fixed capacity, no frustum culling", () => {
    const parent = new Object3D();
    const meshes = new PlantMeshes(parent, 300);
    const expected =
      PLANT_VARIANT_COUNTS.positive + PLANT_VARIANT_COUNTS.neutral + PLANT_VARIANT_COUNTS.negative;
    expect(meshes.variantCount).toBe(expected);
    const instanced = instancedMeshes(parent);
    expect(instanced).toHaveLength(expected);
    for (const mesh of instanced) {
      expect(mesh.instanceMatrix.count).toBe(300);
      expect(mesh.instanceColor?.count).toBe(300);
      expect(mesh.frustumCulled).toBe(false);
      expect(mesh.count).toBe(0);
    }
    meshes.dispose();
  });

  it("refuses an instance when the variant batch is full", () => {
    const meshes = new PlantMeshes(new Object3D(), 2);
    expect(meshes.add("positive", 0, PLACEMENT, style(0xff0000))).not.toBeNull();
    expect(meshes.add("positive", 0, PLACEMENT, style(0x00ff00))).not.toBeNull();
    expect(meshes.add("positive", 0, PLACEMENT, style(0x0000ff))).toBeNull();
    expect(meshes.count).toBe(2);
    meshes.dispose();
  });

  it("swap-removes: the last instance takes over the freed slot with its color and params", () => {
    const parent = new Object3D();
    const meshes = new PlantMeshes(parent, 10);
    const first = mustAdd(meshes, 0xff0000);
    const second = mustAdd(meshes, 0x00ff00);
    const third = mustAdd(meshes, 0x0000ff);
    meshes.setAppearance(third, 2, 0.5);
    meshes.flush();
    const batch = first.batch;
    expect(batch.mesh.count).toBe(3);

    meshes.remove(first);
    meshes.flush();
    expect(first.slot).toBe(-1);
    expect(third.slot).toBe(0);
    expect(second.slot).toBe(1);
    expect(batch.mesh.count).toBe(2);
    expect(batch.params.array[0]).toBe(2);
    expect(batch.params.array[1]).toBe(0.5);
    const colors = batch.mesh.instanceColor?.array;
    expect(colors?.[2]).toBeGreaterThan(colors?.[0] ?? 1); // slot 0 is now the blue plant
    expect(colors?.[0]).toBe(0);
    expect(meshes.count).toBe(2);

    meshes.remove(first); // a stale handle is ignored
    expect(meshes.count).toBe(2);
    meshes.dispose();
  });

  it("hides empty batches and reuses freed slots without growing", () => {
    const parent = new Object3D();
    const meshes = new PlantMeshes(parent, 3);
    for (let round = 0; round < 20; round += 1) {
      const instances = [mustAdd(meshes, 0xffffff), mustAdd(meshes, 0xffffff), mustAdd(meshes, 0xffffff)];
      meshes.flush();
      for (const instance of instances) meshes.remove(instance);
      meshes.flush();
      expect(meshes.count).toBe(0);
    }
    for (const mesh of instancedMeshes(parent)) expect(mesh.visible).toBe(false);
    meshes.dispose();
  });

  it("disposes every geometry, material and mesh exactly once and removes the meshes", () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    const meshDispose = vi.spyOn(InstancedMesh.prototype, "dispose");
    const parent = new Object3D();
    const meshes = new PlantMeshes(parent, 4);
    const variants = meshes.variantCount;
    const shared = instancedMeshes(parent).map((mesh) => mesh.geometry);
    mustAdd(meshes, 0xffffff);

    meshes.dispose();
    meshes.dispose(); // idempotent

    expect(shared).toHaveLength(variants);
    for (const geometry of shared) {
      expect(geometryDispose.mock.instances.filter((instance) => instance === geometry)).toHaveLength(1);
    }
    expect(materialDispose).toHaveBeenCalledTimes(3);
    expect(new Set(materialDispose.mock.instances).size).toBe(3);
    expect(meshDispose).toHaveBeenCalledTimes(variants);
    expect(parent.children).toHaveLength(0);
    expect(meshes.count).toBe(0);
    expect(meshes.add("neutral", 0, PLACEMENT, style(0xffffff))).toBeNull();
  });
});
