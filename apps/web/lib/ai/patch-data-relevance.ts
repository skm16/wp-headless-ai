/**
 * patch-data-relevance — pure relevance gate. On a data-bearing block, ATTACH
 * the data-shape section by default; skip ONLY a clearly-cosmetic edit that
 * names no field-ish token. A style word NEVER suppresses a data edit
 * ("make the ABV bigger" attaches) — the spec's stated bias is toward
 * false-positives (a wasted capped section) over false-negatives (a missing
 * section reproduces the silent-wrong-output bug). Word-boundary matching, not
 * substring, so "color" ∈ "discoloration" and "date" ∈ "update" don't fire.
 */
export type BlockDataCategory = "direct-cpt" | "relation" | "direct-acf" | "none";

/**
 * Clear-cosmetic verbs/nouns. An edit is skipped ONLY when it (a) matches at
 * least one of these AND (b) is SHORT (a pure-styling instruction, not a
 * sentence that also references content). Word-boundary matched.
 */
const COSMETIC_WORDS = [
  "bigger", "smaller", "bold", "bolder", "lighter", "color", "colour",
  "background", "padding", "margin", "spacing", "font", "rounded", "round",
  "corners", "shadow", "wider", "narrower", "taller", "shorter", "opacity",
  "border", "teal", "red", "blue", "green", "heading", "layout", "texture",
];

/** Field-ish tokens that force ATTACH even alongside a cosmetic word. */
const DATA_WORDS = [
  "description", "field", "content", "title", "price", "abv", "ibu", "rating",
  "notes", "blurb", "excerpt", "date", "author", "location", "info", "details",
  "color", "clarity", "varietal", "sku", "brewery", "value", "values",
];

/** Function/filler words ignored when deciding "is every content word cosmetic". */
const STOP_WORDS = new Set([
  "make", "the", "a", "an", "it", "to", "and", "of", "on", "in", "is", "be",
  "this", "that", "please", "change", "set", "give", "more", "less", "little",
  "bit", "up", "down", "its", "update",
]);
/** Cosmetic intensifiers/directions that count as styling, not content. */
const STYLE_QUALIFIERS = new Set([
  "left", "right", "top", "bottom", "middle", "sticky", "fixed", "flat",
  "increase", "decrease", "reduce", "add", "remove",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWholeWord(haystack: string, word: string): boolean {
  // Word-boundary match: the word must be delimited by non-word chars.
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`, "i").test(haystack);
}

export function isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean {
  if (category === "none") return false;
  const g = guidance.toLowerCase();

  // A field-ish token forces attach, even with a cosmetic word present
  // ("make the ABV bigger", "show beer color").
  if (DATA_WORDS.some((w) => hasWholeWord(g, w))) return true;

  // No field token. Skip ONLY when the edit is short AND every meaningful word
  // is cosmetic — a pure-styling instruction like "make the heading bigger" or
  // "round the corners". Otherwise attach (bias to false-positive).
  const words = g.split(/[^a-z0-9]+/).filter(Boolean);
  const contentWords = words.filter((w) => !STOP_WORDS.has(w));
  const anyCosmetic = COSMETIC_WORDS.some((w) => hasWholeWord(g, w));
  const allContentCosmetic =
    contentWords.length > 0 &&
    contentWords.every((w) => COSMETIC_WORDS.includes(w) || STYLE_QUALIFIERS.has(w));
  if (anyCosmetic && allContentCosmetic) return false;

  // Neutral / ambiguous edit on a data-bearing block → attach.
  return true;
}
