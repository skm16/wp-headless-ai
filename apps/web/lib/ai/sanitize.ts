import "server-only";

/**
 * Strip non-printable ASCII and (optionally) truncate. Used on any string
 * sourced from an external surface — scraped alt text, LLM-authored
 * reasoning strings, content brief markdown — before it ends up in an
 * LLM prompt. Defense against an adversarial source or a quirky earlier
 * model emitting characters that would corrupt the markdown structure
 * (code fences, ATX headings, RLO/LRO control bytes, etc.).
 *
 * `maxLen` default = 80 (suitable for alt text). Reasoning strings and
 * content excerpts should pass an explicit larger cap.
 */
export function sanitizeForPrompt(input: string, maxLen = 80): string {
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[^\x20-\x7E]/g, "").trim();
  // Also flatten code-fence markers — three backticks in a row would
  // break out of the markdown block the prompt assembles them into.
  const safe = stripped.replace(/```/g, "''''");
  return safe.slice(0, maxLen);
}
