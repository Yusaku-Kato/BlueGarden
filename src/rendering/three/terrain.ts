/**
 * Ground of the 3D garden: a faceted plane with low rolling mounds that rise behind the garden to
 * hide the horizon. `groundHeight` is pure so plants and effects sit exactly on the surface.
 */
import { BufferGeometry, Mesh, MeshLambertMaterial, PlaneGeometry } from "three";
import type { Object3D } from "three";

export const GROUND_WIDTH = 100;
export const GROUND_DEPTH = 70;
export const GROUND_CENTER_Z = -14;
const GROUND_SEGMENTS_X = 64;
const GROUND_SEGMENTS_Z = 44;

export function groundHeight(x: number, z: number): number {
  const rolling =
    Math.sin(x * 0.31 + 1.2) * Math.cos(z * 0.27) * 0.2 + Math.sin(x * 0.83 + z * 0.5) * 0.05;
  const backHills = Math.min(1.6, Math.max(0, -z - 9) * 0.2) + Math.min(1.6, Math.max(0, Math.abs(x) - 24) * 0.12);
  return rolling + backHills;
}

export class Ground {
  readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  readonly material: MeshLambertMaterial;
  private disposed = false;

  constructor(private readonly parent: Object3D) {
    const plane = new PlaneGeometry(GROUND_WIDTH, GROUND_DEPTH, GROUND_SEGMENTS_X, GROUND_SEGMENTS_Z);
    plane.rotateX(-Math.PI / 2);
    const position = plane.getAttribute("position");
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getZ(index) + GROUND_CENTER_Z;
      position.setY(index, groundHeight(x, z));
    }
    plane.translate(0, 0, GROUND_CENTER_Z);
    plane.deleteAttribute("uv");
    plane.computeVertexNormals();
    this.geometry = plane;
    this.material = new MeshLambertMaterial({ flatShading: true });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.parent.add(this.mesh);
  }

  setColor(hex: number): void {
    this.material.color.setHex(hex);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
