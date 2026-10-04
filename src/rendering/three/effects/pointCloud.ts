/**
 * A fixed-capacity cloud of soft additive round points drawn with one THREE.Points object.
 * Per point: position, world size and alpha. Used by the light particles and the fireflies.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial } from "three";
import type { IUniform, Object3D } from "three";

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uPixelScale;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  gl_PointSize = max(1.0, aSize * uPixelScale / max(0.1, -viewPosition.z));
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vAlpha;
void main() {
  float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
  float falloff = smoothstep(1.0, 0.0, distanceFromCenter);
  gl_FragColor = vec4(uColor * uIntensity, falloff * falloff * vAlpha);
  #include <colorspace_fragment>
}`;

export class PointCloud {
  readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly positions: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private readonly sizeAttribute: BufferAttribute;
  private readonly alphaAttribute: BufferAttribute;
  private readonly colorUniform: IUniform<Color>;
  private readonly pixelScaleUniform: IUniform<number>;
  private disposed = false;

  constructor(
    private readonly parent: Object3D,
    readonly capacity: number,
    color: number,
    intensity: number,
  ) {
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.positionAttribute = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.sizeAttribute = new BufferAttribute(this.sizes, 1).setUsage(DynamicDrawUsage);
    this.alphaAttribute = new BufferAttribute(this.alphas, 1).setUsage(DynamicDrawUsage);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", this.positionAttribute);
    this.geometry.setAttribute("aSize", this.sizeAttribute);
    this.geometry.setAttribute("aAlpha", this.alphaAttribute);
    this.geometry.setDrawRange(0, 0);
    this.colorUniform = { value: new Color(color) };
    this.pixelScaleUniform = { value: 600 };
    this.material = new ShaderMaterial({
      uniforms: {
        uColor: this.colorUniform,
        uIntensity: { value: intensity },
        uPixelScale: this.pixelScaleUniform,
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.parent.add(this.points);
  }

  setColor(hex: number): void {
    this.colorUniform.value.setHex(hex);
  }

  /** Pixels per world unit at distance 1 (depends on the render height and fov). */
  setPixelScale(value: number): void {
    if (Number.isFinite(value) && value > 0) this.pixelScaleUniform.value = value;
  }

  set(index: number, x: number, y: number, z: number, size: number, alpha: number): void {
    if (index < 0 || index >= this.capacity) return;
    const offset = index * 3;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    this.sizes[index] = size;
    this.alphas[index] = alpha;
  }

  /** Draw the first `count` points and upload the buffers. */
  commit(count: number): void {
    const visible = Math.max(0, Math.min(this.capacity, Math.floor(count)));
    this.geometry.setDrawRange(0, visible);
    this.points.visible = visible > 0;
    if (visible === 0) return;
    this.positionAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
