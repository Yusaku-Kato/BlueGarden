/**
 * Sky gradient: a large inside-out sphere with a two-color vertical gradient (the skyPalette colors).
 * It is not affected by fog and follows the camera position so the camera drift never shows an edge.
 */
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from "three";
import type { BufferGeometry, IUniform, Object3D } from "three";

export const SKY_RADIUS = 120;

const VERTEX_SHADER = /* glsl */ `
varying float vHeight;
void main() {
  vHeight = normalize(position).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
varying float vHeight;
void main() {
  float t = clamp(vHeight * 1.8 + 0.05, 0.0, 1.0);
  gl_FragColor = vec4(mix(uHorizon, uTop, pow(t, 0.75)), 1.0);
  #include <colorspace_fragment>
}`;

export class SkyDome {
  readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly top: IUniform<Color> = { value: new Color(0x0b1418) };
  private readonly horizon: IUniform<Color> = { value: new Color(0x123a40) };
  private disposed = false;

  constructor(private readonly parent: Object3D) {
    this.geometry = new SphereGeometry(SKY_RADIUS, 24, 12);
    this.material = new ShaderMaterial({
      uniforms: { uTop: this.top, uHorizon: this.horizon },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.parent.add(this.mesh);
  }

  setColors(topHex: number, horizonHex: number): void {
    this.top.value.setHex(topHex);
    this.horizon.value.setHex(horizonHex);
  }

  follow(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
