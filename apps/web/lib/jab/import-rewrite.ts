/**
 * import-rewrite.ts — pure string utilities for rewriting import paths in
 * generated / downloaded component source files.
 *
 * These helpers run inside Phase C (compose-site Inngest worker) to sanitise
 * Phase B component output before it is uploaded to the generated project.
 * Keeping them in a separate module (no `server-only`) allows unit testing
 * without the Next.js RSC bundler stub.
 */

/**
 * Replaces the first occurrence of the comment-delimited minimal inline
 * BlockNode definition (emitted by older Phase B prompts) with a canonical
 * import statement.
 *
 * Uses a line-by-line scan instead of a multiline regex to avoid catastrophic
 * backtracking (ReDoS) on large files.  The block appears exactly once in
 * compose-block-tree-runtime.ts, so replacing only the first occurrence is
 * correct and intentional.
 */
function rewriteInlineBlockNodeDef(src: string): string {
  const lines = src.split("\n");
  const startIdx = lines.findIndex((l) =>
    l.startsWith("// Minimal BlockNode shape"),
  );
  if (startIdx === -1) return src;

  // Scan forward from startIdx to find the closing brace of the interface.
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\}\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === startIdx) return src; // malformed — leave unchanged

  const result = [
    ...lines.slice(0, startIdx),
    `import type { BlockNode } from "@/lib/sdk/types";`,
    "",
    ...lines.slice(endIdx + 1),
  ];
  return result.join("\n");
}

/**
 * Rewrites all BlockNode import paths that reference the SaaS-internal
 * `@/lib/jab/ability-client` module to the generated-project canonical path
 * `@/lib/sdk/types`.
 *
 * Handles two patterns:
 *  1. An explicit import statement (single or double quotes, optional trailing
 *     semi-colon, optional trailing whitespace). The `type` keyword is
 *     optional in BOTH positions, since the LLM emits all of these forms:
 *       import type { BlockNode } from "@/lib/jab/ability-client";
 *       import { BlockNode } from "@/lib/jab/ability-client";        // value import
 *       import { type BlockNode } from "@/lib/jab/ability-client";   // inline modifier
 *     All normalise to the canonical type-only import.
 *  2. The comment-delimited minimal inline definition emitted by older Phase B
 *     prompts (when the model embedded the shape rather than importing it):
 *       // Minimal BlockNode shape
 *       ...
 *       export interface BlockNode { ... }
 *
 * Already-correct imports (`@/lib/sdk/types`) are left unchanged. Only the
 * single-named `{ BlockNode }` form is rewritten — a multi-named import that
 * also pulls non-BlockNode symbols from ability-client is left untouched
 * (it never occurs in practice; the prompt only ever imports BlockNode).
 */
export function rewriteBlockNodeImports(src: string): string {
  let out = src.replace(
    /import\s+(?:type\s+)?\{\s*(?:type\s+)?BlockNode\s*\}\s+from\s+["']@\/lib\/jab\/ability-client["']\s*;?\s*(\r?\n|$)/g,
    `import type { BlockNode } from "@/lib/sdk/types";\n`,
  );
  out = rewriteInlineBlockNodeDef(out);
  return out;
}
