import "server-only";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";

export interface PostprocessOptions {
  expectedExportName: string;
}

/**
 * Thrown when the postprocessor cannot reconcile the LLM output with the
 * dispatcher's named-import contract — e.g. no exported component at all,
 * or an anonymous `export default function()` from which no name can be
 * extracted. Callers should treat this exactly like a `validateTsx` error:
 * log it, abandon the attempt, and either retry or fall back to passthrough.
 *
 * Why throw instead of returning a marker: `validateTsx` is parse-only and
 * happily accepts a syntactically valid file with no named export, which
 * would then dispatch broken code with `compileStatus='ok'`. Throwing turns
 * silent corruption into a loud failure that the retry loop catches.
 */
export class PostprocessError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PostprocessError";
  }
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
 * Ensures the source contains a named export matching `expectedName`.
 *
 * Resolution order:
 *   1. Expected named export already present → no-op.
 *   2. Different PascalCase `export function|const` present → append alias.
 *   3. `export default function NAME() {}` present → rewrite to a named
 *      export (`export function NAME`) and, if NAME !== expectedName,
 *      append an alias.
 *   4. Anonymous `export default function() {}` → throw PostprocessError
 *      (no identifier to alias from).
 *   5. No exported component of any recognized form → throw PostprocessError.
 *
 * Throws instead of silently returning the source because `validateTsx` is
 * parse-only and won't catch a missing named export — the dispatcher's
 * import would resolve to `undefined` at compile time.
 */
function ensureExportName(src: string, expectedName: string): string {
  // 1. Expected named export already exists (function, const, or class).
  const hasExport = new RegExp(
    `export\\s+(function|const|class)\\s+${expectedName}[\\s<({]`
  ).test(src);
  if (hasExport) return src;

  // 1b. Expected name is already provided by a re-export list — either an alias
  // (`export { Internal as ${expectedName} }`) or a bare re-export
  // (`export { ${expectedName} }`). Components are emitted with an internal
  // name plus a dispatcher-name alias, and the patch LLM returns that whole
  // source on every edit; without this check step 2 would match the internal
  // `export function Internal` and append a SECOND identical alias → esbuild
  // "Multiple exports with the same name". The `[^}]*` stays within one
  // export-list's braces so an unrelated later export can't false-match.
  const hasReexport = new RegExp(
    `export\\s*\\{[^}]*\\b${expectedName}\\b[^}]*\\}`
  ).test(src);
  if (hasReexport) return src;

  // 2. Another PascalCase `export function|const` — alias it.
  const namedMatch = src.match(
    /export\s+(?:function|const)\s+([A-Z][a-zA-Z0-9_]*)/
  );
  if (namedMatch) {
    const actualName = namedMatch[1];
    if (actualName === expectedName) return src;
    return src + `\nexport { ${actualName} as ${expectedName} };\n`;
  }

  // 3. `export default function NAME` — rewrite to named export, alias if needed.
  const defaultNamedMatch = src.match(
    /export\s+default\s+function\s+([A-Z][a-zA-Z0-9_]*)/
  );
  if (defaultNamedMatch) {
    const actualName = defaultNamedMatch[1];
    // Drop the `default` keyword so the function becomes a plain named export.
    // The original `export default` is replaced with `export` — once.
    const rewritten = src.replace(
      /export\s+default\s+function\s+([A-Z][a-zA-Z0-9_]*)/,
      `export function ${actualName}`,
    );
    if (actualName === expectedName) return rewritten;
    return rewritten + `\nexport { ${actualName} as ${expectedName} };\n`;
  }

  // 4. Anonymous default — no identifier available to alias from.
  if (/export\s+default\s+function\s*\(/.test(src)) {
    throw new PostprocessError(
      `expected named export '${expectedName}' but found anonymous \`export default function()\``,
    );
  }

  // 5. No recognized export form at all.
  throw new PostprocessError(
    `expected named export '${expectedName}' but no exported component was found`,
  );
}

/**
 * Matches JSX event-handler prop attributes: onClick={, onChange={, onSubmit={,
 * onMouseEnter={, etc.  The `\b` word-boundary before `on` ensures we don't
 * match prop names that merely end in "on" (e.g. `salmonColor`, `iconName`
 * — in those, "on" is preceded by a word character so no boundary fires).
 */
const JSX_EVENT_HANDLER_RE = /\bon[A-Z][A-Za-z]*\s*=\s*\{/;

/**
 * Adds `"use client";` at the top of the file when the source uses React
 * client hooks OR JSX event-handler attributes but lacks the directive.
 *
 * Matches both single-quote and double-quote variants of the existing
 * directive to avoid adding a duplicate.
 *
 * Event-handler detection covers the live /beers 500 bug class: an LLM
 * component emitting onChange={...} / onClick={...} with no hooks — tsc
 * cannot catch the RSC violation, so it 500s at request time.
 */
function ensureUseClient(src: string): string {
  // Already has the directive (single- or double-quote, with or without semi).
  if (/^["']use client["'];?\s*$/m.test(src)) return src;

  const hooksPattern = new RegExp(`\\b(${CLIENT_HOOKS.join("|")})\\b`);
  if (!hooksPattern.test(src) && !JSX_EVENT_HANDLER_RE.test(src)) return src;

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
