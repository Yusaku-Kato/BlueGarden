/**
 * Shared GraphicsContexts and plant view construction (docs/DESIGN.md §13.5).
 * All shapes are drawn in white and coloured per instance through `tint`.
 * Origin (0, 0) is the base of the plant; plants grow towards negative y.
 */
import { Container, Graphics, GraphicsContext } from "pixi.js";
import type { Mood } from "../domain/models";
import { errorName, logger } from "../infra/logger";

const WHITE = 0xffffff;
const FLOWER_CENTER_SHADE = 0xcfcfcf;
const STEM_HEIGHT = 64;
const STEM_WIDTH = 3;
/** Where the flower of a positive plant sits, in plant space (the halo anchor). */
export const FLOWER_OFFSET_Y = -STEM_HEIGHT;
const STEM_BEND = 6;
const LEAF_LENGTH = 30;
const LEAF_HALF_WIDTH = 7;
const PETAL_COUNT = 5;
const PETAL_RADIUS = 7;
const PETAL_DISTANCE = 8;
const FLOWER_CENTER_RADIUS = 5;
const THORN_LENGTH = 8;
const THORN_HALF_WIDTH = 2.5;
const THORN_ROWS = 4;
const THORN_SPACING = 13;
const PARTICLE_RADIUS = 3;
const LEAF_TILT = 0.6;
const POSITIVE_STEM_COLOR = 0x5f9f6a;
const POSITIVE_LEAF_COLOR = 0x74bd80;
const NEGATIVE_STEM_DARKEN = 0.55;
const NEUTRAL_STEM_DARKEN = 0.7;

export interface PlantArt {
  readonly stem: GraphicsContext;
  readonly leafRound: GraphicsContext;
  readonly leafSharp: GraphicsContext;
  readonly flower: GraphicsContext;
  readonly thorns: GraphicsContext;
  readonly particleDot: GraphicsContext;
  /** Destroys every shared context once. Call only after all Graphics using them are destroyed. */
  destroy(): void;
}

export interface PlantAppearance {
  readonly mood: Mood;
  readonly color: number;
}

export function darkenColor(color: number, factor: number): number {
  const red = Math.round(((color >> 16) & 0xff) * factor);
  const green = Math.round(((color >> 8) & 0xff) * factor);
  const blue = Math.round((color & 0xff) * factor);
  return (red << 16) | (green << 8) | blue;
}

export function mixColor(from: number, to: number, amount: number): number {
  const mix = (shift: number): number => {
    const start = (from >> shift) & 0xff;
    const end = (to >> shift) & 0xff;
    return Math.round(start + (end - start) * amount);
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

function buildStem(): GraphicsContext {
  return new GraphicsContext()
    .moveTo(0, 0)
    .quadraticCurveTo(STEM_BEND, -STEM_HEIGHT / 2, 0, -STEM_HEIGHT)
    .stroke({ width: STEM_WIDTH, color: WHITE, cap: "round" });
}

function buildLeafRound(): GraphicsContext {
  return new GraphicsContext()
    .ellipse(LEAF_LENGTH / 2, 0, LEAF_LENGTH / 2, LEAF_HALF_WIDTH)
    .fill({ color: WHITE });
}

function buildLeafSharp(): GraphicsContext {
  const halfWidth = LEAF_HALF_WIDTH * 0.8;
  return new GraphicsContext()
    .poly([0, 0, LEAF_LENGTH * 0.45, -halfWidth, LEAF_LENGTH, 0, LEAF_LENGTH * 0.45, halfWidth])
    .fill({ color: WHITE });
}

function buildFlower(): GraphicsContext {
  const context = new GraphicsContext();
  for (let index = 0; index < PETAL_COUNT; index += 1) {
    const angle = (index / PETAL_COUNT) * Math.PI * 2 - Math.PI / 2;
    context
      .circle(Math.cos(angle) * PETAL_DISTANCE, Math.sin(angle) * PETAL_DISTANCE, PETAL_RADIUS)
      .fill({ color: WHITE });
  }
  return context.circle(0, 0, FLOWER_CENTER_RADIUS).fill({ color: FLOWER_CENTER_SHADE });
}

function buildThorns(): GraphicsContext {
  const context = new GraphicsContext();
  for (let row = 0; row < THORN_ROWS; row += 1) {
    const y = -THORN_SPACING * (row + 1);
    const side = row % 2 === 0 ? 1 : -1;
    context
      .poly([
        side * 1.5,
        y,
        side * (1.5 + THORN_LENGTH),
        y - THORN_HALF_WIDTH * 2,
        side * 1.5,
        y - THORN_HALF_WIDTH * 2.4,
      ])
      .fill({ color: WHITE });
  }
  return context;
}

function buildParticleDot(): GraphicsContext {
  return new GraphicsContext().circle(0, 0, PARTICLE_RADIUS).fill({ color: WHITE });
}

/** Create the shared contexts. Call only after the Application initialised successfully. */
export function createPlantArt(): PlantArt {
  const contexts = {
    stem: buildStem(),
    leafRound: buildLeafRound(),
    leafSharp: buildLeafSharp(),
    flower: buildFlower(),
    thorns: buildThorns(),
    particleDot: buildParticleDot(),
  };
  let destroyed = false;
  return {
    ...contexts,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const [label, context] of Object.entries(contexts)) {
        try {
          context.destroy();
        } catch (error) {
          logger.warn("render.contextDestroyFailed", { context: label, name: errorName(error) });
        }
      }
    },
  };
}

function tinted(context: GraphicsContext, tint: number): Graphics {
  const graphic = new Graphics(context);
  graphic.tint = tint;
  return graphic;
}

function addLeaf(
  view: Container,
  context: GraphicsContext,
  tint: number,
  heightRatio: number,
  facingRight: boolean,
  random: () => number,
): void {
  const leaf = tinted(context, tint);
  leaf.position.set(0, -STEM_HEIGHT * heightRatio);
  const size = 0.8 + random() * 0.4;
  leaf.scale.set(facingRight ? size : -size, size);
  leaf.rotation = (facingRight ? -LEAF_TILT : LEAF_TILT) * (0.7 + random() * 0.6);
  view.addChild(leaf);
}

/**
 * Build one plant view (a Container with 3-4 Graphics sharing `art` contexts).
 * Destroy it with `view.destroy({ children: true })`; shared contexts are not affected.
 */
export function buildPlantView(
  appearance: PlantAppearance,
  art: PlantArt,
  random: () => number,
): Container {
  const view = new Container();
  const { color } = appearance;
  const startsRight = random() < 0.5;

  if (appearance.mood === "positive") {
    view.addChild(tinted(art.stem, POSITIVE_STEM_COLOR));
    addLeaf(view, art.leafRound, POSITIVE_LEAF_COLOR, 0.3, startsRight, random);
    addLeaf(view, art.leafRound, POSITIVE_LEAF_COLOR, 0.55, !startsRight, random);
    const flower = tinted(art.flower, color);
    flower.position.set(0, -STEM_HEIGHT);
    view.addChild(flower);
  } else if (appearance.mood === "negative") {
    view.addChild(tinted(art.stem, darkenColor(color, NEGATIVE_STEM_DARKEN)));
    addLeaf(view, art.leafSharp, color, 0.35, startsRight, random);
    addLeaf(view, art.leafSharp, color, 0.65, !startsRight, random);
    view.addChild(tinted(art.thorns, color));
  } else {
    view.addChild(tinted(art.stem, darkenColor(color, NEUTRAL_STEM_DARKEN)));
    addLeaf(view, art.leafRound, color, 0.25, startsRight, random);
    addLeaf(view, art.leafRound, color, 0.5, !startsRight, random);
    addLeaf(view, art.leafRound, color, 0.8, startsRight, random);
  }
  return view;
}
