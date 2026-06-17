import "server-only";
import * as ts from "typescript";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { tailwindExtendFromTokens } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * dead-class-detect — a deterministic oracle for CSS class names the LLM
 * invents that resolve to nothing. The clone runs a closed two-system CSS
 * stack: Tailwind 3 JIT over the raw TSX (buildDraftCss, css.ts) + the
 * captured source theme CSS appended under `.jab-theme`. A class that is
 * neither a Tailwind utility (incl. token-derived / arbitrary-value) nor a
 * class token in the captured theme CSS compiles to nothing in either
 * system and silently does nothing fleet-wide.
 *
 * Conservative by design: tokens are extracted ONLY from STATIC
 * `className="..."` string literals (never template literals / clsx /
 * ternaries / data-* / aria-* / key), so the dead count is a LOWER BOUND
 * quality signal — never a "no dead classes remain" certification. Runtime-
 * composed fragments are never inspected and never stripped.
 */

/**
 * Extract whole class tokens from STATIC className string-literal attribute
 * values, deduped in first-seen source order. Uses ts.createSourceFile —
 * the same parser validateTsx (component-generator.ts) uses — so it sees the
 * real JSX AST rather than guessing with a regex. A className whose value is
 * a JsxExpression (template literal, clsx, ternary, variable) is skipped
 * entirely: those fragments are runtime-composed and MUST NOT be classified.
 */
export function extractClassNameTokens(tsx: string): string[] {
  const sourceFile = ts.createSourceFile(
    "dead-class-detect.tsx",
    tsx,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  const seen = new Set<string>();
  const ordered: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === "className" && node.initializer && ts.isStringLiteral(node.initializer)) {
        for (const tok of node.initializer.text.split(/\s+/)) {
          if (!tok) continue;
          if (seen.has(tok)) continue;
          seen.add(tok);
          ordered.push(tok);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return ordered;
}

/**
 * Class tokens present in captured theme CSS, as a membership Set (uncapped,
 * unranked — this is a correctness check, not a prompt budget). Mirrors the
 * shell's extractThemeClassNames regex family but keeps every match.
 */
export function extractThemeCssClassNames(themeCss: string | null): Set<string> {
  const set = new Set<string>();
  if (!themeCss) return set;
  const pattern = /\.([a-zA-Z_-][a-zA-Z0-9_-]{1,})/g;
  for (const match of themeCss.matchAll(pattern)) {
    const name = match[1];
    if (/^\d/.test(name)) continue;
    set.add(name);
  }
  return set;
}

/**
 * Tailwind variant-MARKER classes: emit zero CSS alone, but are required by
 * companion variant utilities (group-hover:*, peer-checked:*) on descendants/
 * siblings. The JIT probe would mark them dead — never let the detector strip
 * them. Covers bare `group`/`peer` and named `group/<name>` / `peer/<name>`.
 */
const VARIANT_MARKER_RE = /^(group|peer)(\/[A-Za-z0-9_-]+)?$/;
export function isVariantMarkerClass(token: string): boolean {
  return VARIANT_MARKER_RE.test(token);
}

/**
 * Minimal per-token Tailwind-JIT emptiness probe. Reuses the EXACT config
 * buildDraftCss uses — tailwindExtendFromTokens(tokens) + preflight:false —
 * so "resolvable" here means "buildDraftCss would emit a rule for this".
 * A single class in a single-element content source is the cheapest possible
 * JIT input. Returns true when the JIT emits ≥1 rule whose selector contains
 * the (escaped) class. Fails OPEN (returns true) on any probe error: a
 * transient JIT failure must never strip a real class.
 */
async function tailwindEmitsRule(token: string, extend: ReturnType<typeof tailwindExtendFromTokens>): Promise<boolean> {
  try {
    const result = await postcss([
      tailwindcss({
        content: [{ raw: `<div class="${token}"></div>`, extension: "html" }],
        theme: { extend },
        corePlugins: { preflight: false },
      } as never),
    ]).process("@tailwind components;\n@tailwind utilities;\n", { from: undefined });
    // Tailwind escapes special chars in selectors (bg-[#fff] → .bg-\[\#fff\]),
    // so substring-match the class core rather than the raw token: any emitted
    // rule at all means the JIT recognized the class (an empty utilities layer
    // emits nothing for an unknown class).
    return result.css.trim().length > 0;
  } catch {
    return true;
  }
}

export interface ClassifyClassesInput {
  /** Tokens to classify (raw — deduped internally). */
  tokens: string[];
  /** Theme tokens, same value buildDraftCss receives (resolveThemeTokens output). */
  tokens_tw: ThemeJsonTokens | null;
  /** Captured source theme CSS (emitThemeCss output) or null. */
  themeCss: string | null;
}

/**
 * Classify each unique token as `dead` (no Tailwind rule AND not in theme CSS)
 * or `resolvable`. Dedups first to bound cost (unique tokens per component are
 * ~dozens). Order within each bucket is first-seen source order.
 */
export async function classifyClasses(
  input: ClassifyClassesInput,
): Promise<{ dead: string[]; resolvable: string[] }> {
  const extend = tailwindExtendFromTokens(input.tokens_tw);
  const themeSet = extractThemeCssClassNames(input.themeCss);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const tok of input.tokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    unique.push(tok);
  }

  const dead: string[] = [];
  const resolvable: string[] = [];
  for (const tok of unique) {
    // Variant-marker classes (group/peer + named) emit no CSS alone but are
    // REQUIRED by companion utilities on descendants/siblings — never dead.
    if (isVariantMarkerClass(tok) || themeSet.has(tok)) {
      resolvable.push(tok);
      continue;
    }
    const emitted = await tailwindEmitsRule(tok, extend);
    if (emitted) resolvable.push(tok);
    else dead.push(tok);
  }
  return { dead, resolvable };
}

/**
 * Rank a theme-class inventory for ONE unit. Unlike the shell's length-DESC
 * extractThemeClassNames, callers want the classes THIS unit's source DOM
 * actually uses surfaced first (so high-frequency structural classes survive
 * the cap), with everything else kept as a fallback pool. `cap` is explicit
 * (default 40 — block prompts run many times, tighter than the shell's 80).
 * Pure: a regex over the DOM string, no React/prompt deps.
 */
export function rankThemeClassesForUnit(opts: {
  themeClassNames: string[];
  sourceDom: string | null;
  cap?: number;
}): string[] {
  const cap = opts.cap ?? 40;
  const dom = opts.sourceDom ?? "";
  const hits = new Map<string, number>();
  for (const name of opts.themeClassNames) {
    // Count whole-token occurrences in the DOM (no \w- on either side).
    const re = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
    hits.set(name, (dom.match(re) ?? []).length);
  }
  return [...opts.themeClassNames]
    .map((name, idx) => ({ name, idx, hits: hits.get(name) ?? 0 }))
    .sort((a, b) => (b.hits !== a.hits ? b.hits - a.hits : a.idx - b.idx)) // DOM-frequency desc, stable on input order
    .map((e) => e.name)
    .slice(0, cap);
}
