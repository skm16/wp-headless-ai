import "server-only";

/**
 * Shared text-normalization helpers. Lived as private copies in
 * scrape-extract.ts and validators.ts before being consolidated here —
 * the duplication created a real drift risk: a validator comparing
 * "is the source's hero copy in the output?" was using its own
 * `collapseWhitespace` while scrape-extract's `extract.h1[0]` came from
 * a different `collapseWhitespace`. If either ever diverged (e.g.
 * Unicode whitespace handling), the validator could pass on truly
 * mismatched content. One copy keeps the contract honest.
 *
 * `sanitize.ts` is for prompt-injection defense (strips non-printable,
 * flattens code fences, truncates). These are for normalization
 * (whitespace + tags). Separate concerns, separate file.
 */

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}
