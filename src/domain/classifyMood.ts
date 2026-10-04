import type { Mood } from "./models";
import {
  NEGATIVE_KEYWORDS,
  NEGATIVE_WHOLE_WORDS,
  POSITIVE_KEYWORDS,
  POSITIVE_WHOLE_WORDS,
} from "./sentimentKeywords";

/** A compiled keyword matcher that counts occurrences in normalized text. */
type Matcher = (normalizedText: string) => number;

const ASCII_ONLY = /^[\x20-\x7e]+$/;
/** Emoji variation selector: NFKC keeps it, so it is removed from both text and keywords. */
const VARIATION_SELECTOR = new RegExp(String.fromCharCode(0xfe0f), "g");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(VARIATION_SELECTOR, "");
}

/**
 * Builds one matcher per polarity: a single ASCII regex (leading boundary for stems, full-word
 * boundary for whole words) and a single substring regex for non-ASCII entries.
 */
function buildMatcher(stems: readonly string[], wholeWords: readonly string[]): Matcher {
  const normalizedStems = stems.map(normalize);
  const asciiStems = normalizedStems.filter((keyword) => ASCII_ONLY.test(keyword));
  const other = normalizedStems.filter((keyword) => !ASCII_ONLY.test(keyword));
  const words = wholeWords.map(normalize).filter((keyword) => ASCII_ONLY.test(keyword));

  // ASCII stems: leading word boundary only, so "hates" matches "hate" but "whatever" does not.
  // Whole words additionally require a trailing boundary ("fun" does not match "fund").
  const alternatives = [
    ...asciiStems.map(escapeRegExp),
    ...(words.length > 0 ? [`(?:${words.map(escapeRegExp).join("|")})\\b`] : []),
  ];
  const asciiPattern =
    alternatives.length > 0 ? new RegExp(`\\b(?:${alternatives.join("|")})`, "g") : null;
  const otherPattern =
    other.length > 0 ? new RegExp(other.map(escapeRegExp).join("|"), "g") : null;

  return (text) =>
    (asciiPattern ? (text.match(asciiPattern)?.length ?? 0) : 0) +
    (otherPattern ? (text.match(otherPattern)?.length ?? 0) : 0);
}

const countPositive = buildMatcher(POSITIVE_KEYWORDS, POSITIVE_WHOLE_WORDS);
const countNegative = buildMatcher(NEGATIVE_KEYWORDS, NEGATIVE_WHOLE_WORDS);

/** Keyword-count mood classification (docs/DESIGN.md §11.2). Ties, including 0-0, are neutral. */
export function classifyMood(text: string): Mood {
  const normalized = normalize(text);
  const positive = countPositive(normalized);
  const negative = countNegative(normalized);
  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
}
