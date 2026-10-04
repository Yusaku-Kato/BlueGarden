import type { EnvironmentState, PlantSeed } from "../domain/models";

/**
 * What the application pipeline needs from the terrarium (docs/DESIGN.md §5.5, §35.2).
 * Implemented by TerrariumEngine; implementations must never throw.
 */
export interface GardenSink {
  addPlant(seed: PlantSeed): void;
  /** Raises the target scale of a living or pending plant (after-growth). Unknown id is a no-op. */
  growPlant(id: string, targetScale: number): void;
  setEnvironment(environment: EnvironmentState): void;
}
