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
 * Rewrites all BlockNode import paths that reference the SaaS-internal
 * `@/lib/jab/ability-client` module to the generated-project canonical path
 * `@/lib/sdk/types`.
 *
 * Handles two patterns:
 *  1. An explicit import statement (single or double quotes, optional trailing
 *     semi-colon, optional trailing whitespace):
 *       import type { BlockNode } from "@/lib/jab/ability-client";
 *  2. The comment-delimited minimal inline definition emitted by older Phase B
 *     prompts (when the model embedded the shape rather than importing it):
 *       // Minimal BlockNode shape
 *       ...
 *       export interface BlockNode { ... }
 *
 * Already-correct imports (`@/lib/sdk/types`) are left unchanged.
 */
export function rewriteBlockNodeImports(src: string): string {
  return src
    .replace(
      /import\s+type\s*\{\s*BlockNode\s*\}\s+from\s+["']@\/lib\/jab\/ability-client["']\s*;?\s*\n/g,
      `import type { BlockNode } from "@/lib/sdk/types";\n`,
    )
    .replace(
      /\/\/ Minimal BlockNode shape[\s\S]*?export interface BlockNode\s*\{[\s\S]*?\}\s*\n/,
      `import type { BlockNode } from "@/lib/sdk/types";\n\n`,
    );
}
