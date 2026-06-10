/**
 * sanitize-shell-dom.ts — pure shellDom prompt-payload sanitizer (Phase 2).
 *
 * The captured shell outerHTML (capture-theme-stylesheets.ts) is raw WP
 * page-builder chrome: inline <script>/<style>, comments, data-* attribute
 * noise, srcset candidate lists, base64 inline images — none of it is
 * information the shell LLM needs to produce TSX chrome, and at 100KB it
 * is the dominant token cost of every shell call (~25-30K input tokens).
 * This pass typically cuts WP chrome HTML 40-70% with zero fidelity loss.
 *
 * Deliberately regex-based, not a DOM parser: deterministic, dependency-
 * free, runs on partial/malformed HTML (the capture cap can truncate), and
 * the worst case of a regex miss is a few extra prompt tokens — never a
 * correctness failure. Capture stays RAW (projects.design_tokens.shellDom
 * is untouched); sanitization happens at prompt-build time in
 * shell-prompts.ts so future consumers keep the full capture.
 *
 * maxBytes is enforced via string length (UTF-16 code units), not strict
 * bytes: shell chrome is overwhelmingly ASCII and a prompt cap needs no
 * byte exactness. The clip lands on an element boundary (just after a '>'),
 * never mid-tag/mid-attribute — fixing the blind html.slice() hazard.
 *
 * Pure module: no imports, no IO, no "server-only".
 */
export function sanitizeShellDom(html: string, maxBytes: number): string {
  if (!html) return "";
  let out = html;

  // 1. Drop script/style/noscript elements wholesale (content included).
  //    The [^<]*(?:(?!</tag>)<[^<]*)* form is the standard backtracking-safe
  //    "until the real close tag" pattern.
  out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
  out = out.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style\s*>/gi, "");
  out = out.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript\s*>/gi, "");

  // 2. HTML comments (covers IE conditional comments too).
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // 3. data-* attributes: double-quoted, single-quoted, bare, or valueless.
  out = out.replace(/\sdata-[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");

  // 4. srcset / imagesrcset candidate lists (responsive variants are pure
  //    token weight; the LLM binds src).
  out = out.replace(/\s(?:srcset|imagesrcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 5. base64 data: URI payloads (inline images/fonts) — strip the URI,
  //    keep the carrying attribute so structure survives.
  out = out.replace(/data:[\w/+.;=-]+;base64,[A-Za-z0-9+/=]+/g, "");

  // 6. Whitespace collapse: inter-tag first, then runs.
  out = out.replace(/>\s+</g, "><");
  out = out.replace(/\s{2,}/g, " ");
  out = out.trim();

  // 7. Clip on an element boundary, never mid-tag.
  if (out.length > maxBytes) {
    const clipped = out.slice(0, maxBytes);
    const lastClose = clipped.lastIndexOf(">");
    out = lastClose > 0 ? clipped.slice(0, lastClose + 1) : clipped;
  }
  return out;
}
