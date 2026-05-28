import "server-only";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";

export interface PostprocessOptions {
  expectedExportName: string;
}

/**
 * React hooks that require a client-side rendering context ("use client").
 * If any of these are referenced in the generated source, the directive is
 * added at the top of the file.
 */
const CLIENT_HOOKS = [
  "useState",
  "useEffect",
  "useRef",
  "useCallback",
  "useMemo",
  "useReducer",
  "useContext",
  "useLayoutEffect",
  "useTransition",
  "useDeferredValue",
  "useId",
  "useSyncExternalStore",
  "useImperativeHandle",
  "useOptimistic",
];

/**
 * Strips markdown code fence lines that the LLM accidentally includes in its
 * output (e.g. ```tsx, ```typescript, ```).
 *
 * Only lines that consist ENTIRELY of a fence marker (with optional leading
 * whitespace and an optional language tag) are removed.  Inline backtick
 * sequences inside JSX comments or string literals are left untouched.
 */
function stripCodeFences(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*```\w*\s*$/.test(line))
    .join("\n");
}

/**
 * Ensures the source contains an export with `expectedName`.
 *
 * If the expected export already exists → no-op.
 * If a different PascalCase export is found → append a re-export alias.
 * If no export at all is found → return unchanged (let validateTsx catch it).
 */
function ensureExportName(src: string, expectedName: string): string {
  // Check if expected export already exists (function, const, or class).
  const hasExport = new RegExp(
    `export\\s+(function|const|class)\\s+${expectedName}[\\s<({]`
  ).test(src);
  if (hasExport) return src;

  // Find the first exported PascalCase function or const.
  const match = src.match(
    /export\s+(?:function|const)\s+([A-Z][a-zA-Z0-9_]*)/
  );
  if (!match) return src; // No export found — let validation fail with a clear error.

  const actualName = match[1];
  if (actualName === expectedName) return src;

  // Append a re-export alias so the dispatcher can import expectedName.
  return src + `\nexport { ${actualName} as ${expectedName} };\n`;
}

/**
 * Adds `"use client";` at the top of the file when the source uses React
 * client hooks but lacks the directive.
 *
 * Matches both single-quote and double-quote variants of the existing
 * directive to avoid adding a duplicate.
 */
function ensureUseClient(src: string): string {
  // Already has the directive (single- or double-quote, with or without semi).
  if (/^["']use client["'];?\s*$/m.test(src)) return src;

  const hooksPattern = new RegExp(`\\b(${CLIENT_HOOKS.join("|")})\\b`);
  if (!hooksPattern.test(src)) return src;

  return `"use client";\n` + src;
}

/**
 * Deterministic post-processing pass applied to every LLM-generated TSX
 * before it reaches `validateTsx`.
 *
 * Fixes the four most common mechanical contract violations:
 *   1. Markdown code fences left in the output.
 *   2. BlockNode imported from `@/lib/jab/ability-client` instead of `@/lib/sdk/types`.
 *   3. Exported component name doesn't match what the dispatcher imports.
 *   4. Client hooks used without `"use client"` directive.
 */
export function postprocessGeneratedTsx(source: string, opts: PostprocessOptions): string {
  let out = source;

  // 1. Strip code fences
  out = stripCodeFences(out);

  // 2. Rewrite BlockNode import paths
  out = rewriteBlockNodeImports(out);

  // 3. Ensure expected export name exists
  out = ensureExportName(out, opts.expectedExportName);

  // 4. Add "use client" if hooks are used and directive is absent
  out = ensureUseClient(out);

  return out;
}
