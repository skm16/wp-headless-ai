/**
 * patch-data-relevance — pure relevance gate deciding whether a patch edit
 * needs the block's data-shape context. Takes ONLY (guidance, category) — both
 * known before any I/O — so a cosmetic edit skips the manifest read entirely.
 * Biased toward false-positives (attach when unsure) over false-negatives
 * (miss a real data edit): a wasted section costs a few hundred tokens; a miss
 * reproduces the silent-wrong-output bug.
 */
export type BlockDataCategory = "direct-cpt" | "relation" | "direct-acf" | "none";

/** Data-intent keywords/phrases — matched case-insensitively as substrings. */
const DATA_KEYWORDS = [
  "description", "field", "show the", "add the", "pull", "display", "bind",
  "text", "content", "title", "date", "price",
];

/** Pure style verbs — a data-bearing block edit that is ONLY one of these is cosmetic. */
const STYLE_ONLY = [
  "bigger", "smaller", "bolder", "lighter", "color", "colour", "background",
  "padding", "margin", "spacing", "font", "size", "rounded", "shadow", "align",
  "center", "centre", "wider", "narrower", "taller", "shorter",
];

export function isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean {
  if (category === "none") return false;
  const g = guidance.toLowerCase();
  if (DATA_KEYWORDS.some((k) => g.includes(k))) return true;
  // No explicit data keyword. On a data-bearing block, attach UNLESS the edit
  // is purely stylistic (every content word is a style verb).
  const isPureStyle = STYLE_ONLY.some((s) => g.includes(s)) &&
    !DATA_KEYWORDS.some((k) => g.includes(k));
  return !isPureStyle;
}
