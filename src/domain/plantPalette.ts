import type { Mood } from "./models";

/** Per-mood color palettes (docs/SPEC.md §16, docs/DESIGN.md §12.1). Values are 0xRRGGBB. */
export const PALETTES: Readonly<Record<Mood, readonly number[]>> = {
  positive: [0xf48fb1, 0xffb74d, 0xff8a80],
  neutral: [0x81c784, 0x66bb6a, 0x9ccc65],
  negative: [0x5c7fb8, 0x2e5e4e, 0x5b3f78],
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash of the UTF-16 code units of `value`. */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Deterministically picks a color for the mood from the post URI. The hash is not retained. */
export function pickColor(mood: Mood, uri: string): number {
  const palette = PALETTES[mood];
  const color = palette[fnv1a32(uri) % palette.length];
  // palette is never empty; fall back to the first entry to satisfy noUncheckedIndexedAccess.
  return color ?? palette[0] ?? 0xffffff;
}
