/**
 * Chooses the renderer implementation (docs/DESIGN.md §35.2). The 3D engine is a separate chunk
 * that is only downloaded when the user selects it.
 */
import type { RendererKind } from "../domain/models";
import { TerrariumEngine } from "./TerrariumEngine";
import type { RendererFactory } from "./TerrariumRenderer";

export async function loadRenderer(kind: RendererKind): Promise<RendererFactory> {
  if (kind === "three3d") {
    const module = await import("./three/ThreeTerrariumEngine");
    return (options) => new module.ThreeTerrariumEngine(options);
  }
  return (options) => new TerrariumEngine(options);
}
