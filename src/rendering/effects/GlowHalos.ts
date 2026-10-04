/**
 * "Bloom-lite": additive halos on flowers (docs/DESIGN.md D-26, §36.5, §38).
 * A halo is a child of its plant view, so destroying the plant destroys the halo; the engine calls
 * detach() to drop the reference held here. Halos fade in/out with the bloom toggle and are
 * released entirely once faded out.
 */
import { Graphics } from "pixi.js";
import type { Container, GraphicsContext } from "pixi.js";
import type { EnvironmentState, RenderSettings } from "../../domain/models";
import { EFFECT_FADE_MS, EFFECT_RELEASE_LEVEL, approach, destroyDisplay } from "./EnvironmentEffect";
import type { EnvironmentEffect } from "./EnvironmentEffect";

const HALO_ALPHA = 0.6;
const HALO_SCALE = 1.5;

export class GlowHalos implements EnvironmentEffect {
  private readonly haloContext: GraphicsContext;
  private halos = new Set<Graphics>();
  private level = 0;
  private enabled = false;

  /** `haloContext` is the shared context owned by EffectArt; it is never destroyed here. */
  constructor(haloContext: GraphicsContext) {
    this.haloContext = haloContext;
  }

  get count(): number {
    return this.halos.size;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Add a halo to `view` at (x, y). Returns null while bloom is off. */
  attach(view: Container, x: number, y: number, tint: number): Graphics | null {
    if (!this.enabled) return null;
    const halo = new Graphics(this.haloContext);
    halo.tint = tint;
    halo.blendMode = "add";
    halo.position.set(x, y);
    halo.scale.set(HALO_SCALE);
    halo.alpha = HALO_ALPHA * this.level;
    view.addChild(halo);
    this.halos.add(halo);
    return halo;
  }

  /** Forget a halo whose plant is being destroyed (the plant destroys the Graphics itself). */
  detach(halo: Graphics | null): void {
    if (halo !== null) this.halos.delete(halo);
  }

  update(dtMs: number, _env: EnvironmentState, settings: RenderSettings): void {
    this.enabled = settings.effects.bloom;
    this.level = approach(this.level, this.enabled ? 1 : 0, dtMs, EFFECT_FADE_MS);
    if (!this.enabled && this.level < EFFECT_RELEASE_LEVEL) {
      this.clear();
      return;
    }
    const alpha = HALO_ALPHA * this.level;
    for (const halo of this.halos) halo.alpha = alpha;
  }

  clear(): void {
    for (const halo of this.halos) destroyDisplay(halo, "halo.destroyFailed");
    this.halos.clear();
  }

  destroy(): void {
    this.clear();
  }
}
