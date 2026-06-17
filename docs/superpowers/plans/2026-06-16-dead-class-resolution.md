# Dead-Class Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the LLM from silently emitting CSS class names (e.g. `footer-v2-grid`) that are neither Tailwind utilities nor present in the captured theme CSS — classes that Tailwind JIT never compiles and that therefore do nothing on every JAB-cloned site. Two halves: **PREVENT** (give the chat-edit and block-component prompts the same theme-class inventory + token hex hints the shell already gets) and **DETECT** (a deterministic, report-only dead-class oracle that uses the exact Tailwind config `buildDraftCss` uses).

**Architecture:** A new pure module [dead-class-detect.ts](../../../apps/web/lib/jab/dead-class-detect.ts) holds the oracle: `extractClassNameTokens` (a `ts.createSourceFile` parse that pulls whole tokens **only** from static `className="..."` string literals — the same parser `validateTsx` uses) and `classifyClasses` (a per-token Tailwind-JIT emptiness probe reusing `tailwindExtendFromTokens` + `corePlugins:{preflight:false}`, plus a theme-CSS membership check). The live chat-edit primitive `patchUnitSource` ([patch-component.ts](../../../apps/web/lib/ai/patch-component.ts)) is the PRIMARY prevention site — it gets a soft prefer-inventory + token-hex section and is fed `themeClassNames` by the [draft-edit.ts](../../../apps/web/lib/inngest/functions/draft-edit.ts) worker from the base build's `design_tokens`. The Phase B block-component prompts ([component-generator.ts](../../../apps/web/lib/ai/component-generator.ts)) get the same soft inventory (frequency/DOM-aware, explicit cap arg) plus the shell's color hex-match directive, fed by [generate-components.ts](../../../apps/web/lib/inngest/functions/generate-components.ts). Detection is wired into the draft-edit commit/bundle path: it logs the dead-class count for the patched unit and only rewrites the TSX when `JAB_STRIP_DEAD_CLASSES==='1'`.

**Tech Stack:** TypeScript, Next.js 15 App Router, Supabase JS (admin client + Storage), Vitest, Tailwind 3 JIT via `postcss` + `tailwindcss`, the TypeScript compiler's parser (`ts.createSourceFile`). Server-only modules.

## Global Constraints

- **Fleet-agnostic.** Every change must work across arbitrary WordPress sites/themes — no hardcoded slugs, hosts, colors, or per-site class names. Two Roads is a test target, not the spec. `footer-v2-grid` appears in fixtures only as a synthetic example of a class that resolves nowhere.
- **No DB migration in v1.** A migration would have to be applied to BOTH Supabase projects (local "JAB WP" + prod "jab-prod"). The dead-class count is reported via `console` + the worker's return value only — no new column.
- **Detector reuses the EXACT `buildDraftCss` Tailwind config** — `tailwindExtendFromTokens(tokens)`, `important` left at the probe default, `corePlugins:{preflight:false}`. A token is RESOLVABLE if the minimal per-token JIT probe emits ≥1 rule for it OR it appears as a class token in the captured theme CSS; otherwise DEAD. Substring matching of `buildDraftCss` output is explicitly forbidden — it false-marks escaped arbitrary-value classes (`bg-[#fff]`) and unloaded brand tokens.
- **Detector cost is bounded** by deduping the token list before probing (unique tokens per component are ~dozens).
- **Token extraction is conservative.** Whole tokens come ONLY from STATIC string-literal `className="..."` attribute values — never from template literals, `clsx`, ternaries, `data-*`, `aria-*`, or `key`. The dead-class count is therefore a **lower bound / quality signal**, never a "no dead classes remain" certification. Runtime-composed fragments are never stripped.
- **Report-only default.** Stripping is *mostly* safe (a class producing zero CSS is visually inert inside this closed `#jab-app`/`.jab-theme` system) but is gated behind `JAB_STRIP_DEAD_CLASSES` (default off). **Exception — variant-marker classes:** `group` / `peer` (and named `group/<name>` / `peer/<name>`) emit no CSS alone yet are *required* by `group-hover:*` / `peer-checked:*` utilities on descendants/siblings, so the detector treats them as resolvable and never strips them (Task 1, `isVariantMarkerClass`). Errors are loud; no swallowed failures (CLAUDE.md) — the probe's own failures fail OPEN (treat the token as resolvable) so a transient JIT/parse error never strips a real class.
- **Prompt inventory is a SOFT hint, not a hard rule.** Block components legitimately need layout utilities that never appear in theme CSS, so the directive is "PREFER these verbatim when the source DOM uses them; you MAY also use standard Tailwind utilities." The deterministic detector is the real guardrail.
- Tests run with `pnpm --filter @jab/web test`; typecheck with `pnpm --filter @jab/web exec tsc --noEmit`. Run from repo root `c:\Projects\wp-headless`.

---

## ⚠ Shared-surface coordination with the draft↔deployed CSS parity plan

**This plan and [`2026-06-16-draft-deployed-css-parity.md`](2026-06-16-draft-deployed-css-parity.md) BOTH edit the same symbols** in [patch-component.ts](../../../apps/web/lib/ai/patch-component.ts) (`PatchPromptInput`, `PatchUnitOptions`, `buildPatchPrompt`, `patchUnitSource`) and the same patch step in [draft-edit.ts](../../../apps/web/lib/inngest/functions/draft-edit.ts). Each plan's task snippets show only ITS own additions. **Implement additively — never paste one plan's wholesale function/interface over the other's, or the second erases the first** (this plan adds `themeClassNames`/`tokens` + the two prompt sections + dead-class detection; the parity plan adds `sourceHosts` + `routePathMap` + the origin rewrite).

**Recommended order:** this plan first (larger surface), then the parity plan adds its fields/lines. Either order is fine as long as you MERGE into the existing code. The canonical merged shapes — what these files look like once BOTH plans land — are below; converge here.

**Merged `PatchPromptInput` / `PatchUnitOptions`:**
```ts
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
  themeClassNames?: string[];        // dead-class plan (this)
  tokens?: ThemeJsonTokens | null;   // dead-class plan (this)
  sourceHosts?: string[];            // parity plan (belt-and-suspenders prompt line)
}

export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  maxBytes: number;
  client: ModelClient;
  themeClassNames?: string[];                 // dead-class plan (this)
  tokens?: ThemeJsonTokens | null;            // dead-class plan (this)
  sourceHosts?: string[];                     // parity plan
  routePathMap?: Record<string, string>;      // parity plan (#6)
}
```

`buildPatchPrompt` assembles the base system prompt + ALL sections: `${themeClassSection}${tokenSection}${internalHostsLine}` (this plan's two + the parity plan's hosts line). `patchUnitSource` applies the parity rewrite inside the attempt loop after `postprocessGeneratedTsx`: `if (opts.sourceHosts?.length) candidate = rewriteWpOriginUrls(candidate, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap });`.

**Merged draft-edit patch step** — the authoritative worker shape **once both plans land**. This is complete, pasteable code (no undefined symbols); it replaces this plan's Task 2 `loadBaseThemeClassNames` + patch step AND the parity plan's `derive-rewrite-inputs` + patch step. Imports required (union of both plans): `resolveDeadClasses`/`rankThemeClassesForUnit` from `@/lib/jab/dead-class-detect` (`detectAndMaybeStripDeadClasses` is **not** imported — it is a same-file helper defined in `draft-edit.ts` just below `maxBytesFor`, and it is what calls `resolveDeadClasses`); `resolveThemeTokens`/`ScrapedBrandTokens`/`ThemeJsonTokens` from `@/lib/jab/global-styles`; `emitThemeCss` from `@/lib/jab/compose-site-emit`; `extractThemeClassNames` from `@/lib/ai/shell-prompts`; `hostVariants`/`buildRoutePathMap` from `@/lib/jab/rewrite-origin-links`.

```ts
// One step loads every base-build input the patch needs.
const base = await step.run("load-base-patch-inputs", async () => {
  const [{ data: proj }, { data: pages }] = await Promise.all([
    admin
      .from("projects")
      .select("design_tokens, wp_url")
      .eq("id", projectId)
      .eq("tenant_id", tenantId)
      .single<{ design_tokens: unknown; wp_url: string | null }>(),
    admin.from("page_inventory").select("link, route_path").eq("site_build_id", draft.base_build_id),
  ]);
  const dt = (proj?.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    themeStylesheets?: Array<{ css: string }> | null;
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  const sheets = dt.themeStylesheets ?? [];
  const tokens = resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
  const themeCss = sheets.length > 0 ? emitThemeCss(sheets as never) : null;
  // UNCAPPED (finding #5) — rankThemeClassesForUnit caps AFTER DOM-aware ranking.
  const classNames = sheets.length > 0 ? extractThemeClassNames(sheets, Number.MAX_SAFE_INTEGER) : [];
  let sourceHosts: string[] = [];
  if (proj?.wp_url) {
    try { sourceHosts = hostVariants(proj.wp_url); } catch { sourceHosts = []; }
  }
  const routePathMap = buildRoutePathMap(
    (pages ?? []).map((p) => ({
      link: (p as { link: string | null }).link ?? null,
      route_path: (p as { route_path: string }).route_path,
    })),
  );
  return { classNames, tokens, themeCss, sourceHosts, routePathMap };
});

const patched = await step.run("patch-unit", async () => {
  // Rank the UNCAPPED inventory against the CURRENT source so the prompt gets a
  // small, relevant subset (not the length-capped global top-80) — finding #5.
  const themeClassNames = rankThemeClassesForUnit({ themeClassNames: base.classNames, sourceDom: current.tsx });
  const result = await patchUnitSource({
    currentTsx: current.tsx,
    guidance,
    exportName: exportNameFor(scope, target),
    maxBytes: maxBytesFor(scope),
    client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
    themeClassNames,                       // dead-class plan (this)
    tokens: base.tokens,                   // dead-class plan (this)
    sourceHosts: base.sourceHosts,         // parity plan
    routePathMap: base.routePathMap,       // parity plan (#6)
  });
  if (!result.ok) throw new Error(`patch failed after ${result.attempts} attempts: ${result.error}`);
  // dead-class detection — report-only by default, strip behind JAB_STRIP_DEAD_CLASSES
  const { tsx, deadCount, dead } = await detectAndMaybeStripDeadClasses({
    tsx: result.tsx, tokens: base.tokens, themeCss: base.themeCss,
  });
  if (deadCount > 0) console.warn(`[draft-edit] edit ${editId} (${scope}:${target}) produced ${deadCount} dead class(es): ${dead.join(", ")}`);
  return tsx;
}).catch(async (err: unknown) => { await failEdit(err instanceof Error ? err.message : String(err)); return null; });
if (!patched) return { failed: true };
```
`rankThemeClassesForUnit` lives in `dead-class-detect.ts` (Task 1, so the patch wiring has no forward dependency on the Task 4 block prompts); `buildRoutePathMap`/`hostVariants` come from `@/lib/jab/rewrite-origin-links`. Each plan's individual tasks remain standalone-correct; this block is what they converge to when both have landed.

---

## Background — the gap

Confirmed by code map + a 35/57 adversarial review (workflow `wo17mzyzw`, 2026-06-16). Fleet-wide (every JAB-cloned WP site):

The LLM invents CSS class names that resolve to nothing. The clone runs two CSS systems: (1) Tailwind 3 JIT compiled at draft time over the raw TSX sources — `buildDraftCss` ([css.ts:23-72](../../../apps/web/lib/draft/css.ts#L23-L72)) only emits a rule for a class if it is a recognized Tailwind utility (including token-derived ones from `tailwindExtendFromTokens`, [compose-site-emit.ts:830](../../../apps/web/lib/jab/compose-site-emit.ts#L830)) or an arbitrary-value class; and (2) the captured source theme CSS, appended verbatim under a `.jab-theme` scope. A class name that is neither a Tailwind utility nor present in the captured theme CSS (e.g. a hallucinated `footer-v2-grid`) compiles to nothing in either system and silently does nothing.

Why it happens — three asymmetries:

1. **The chat-edit primitive has no inventory at all.** `patchUnitSource` ([patch-component.ts:52-84](../../../apps/web/lib/ai/patch-component.ts#L52-L84)) calls `buildPatchPrompt` ([patch-component.ts:20-37](../../../apps/web/lib/ai/patch-component.ts#L20-L37)); `PatchPromptInput` ([patch-component.ts:14-18](../../../apps/web/lib/ai/patch-component.ts#L14-L18)) carries only `currentTsx` + `guidance` + `exportName`. No theme-class inventory, no token section. This is the PRIMARY fix site for the live loop — a generator-only fix never touches chat edits.

2. **Block-component prompts get tokens but no class inventory, and actively steer away from reuse.** `sharedSystemPrompt` ([component-generator.ts:50-114](../../../apps/web/lib/ai/component-generator.ts#L50-L114)) emits a token section but no class names; `renderDomSampleSection` ([component-generator.ts:164-173](../../../apps/web/lib/ai/component-generator.ts#L164-L173)) tells the model to "Translate source class names to corresponding Tailwind classes" — steering AWAY from reusing real theme classes. Only the SHELL prompts get the class inventory (`renderThemeClassSection` [shell-prompts.ts:97-108](../../../apps/web/lib/ai/shell-prompts.ts#L97-L108) + the hard rule in `sharedShellSystemPrompt` [shell-prompts.ts:152-155](../../../apps/web/lib/ai/shell-prompts.ts#L152-L155): "Inventing class names that appear in neither list is an error").

3. **Color-fidelity asymmetry.** The shell's `renderTokenSection` ([shell-prompts.ts:75-87](../../../apps/web/lib/ai/shell-prompts.ts#L75-L87)) emits slug+hex pairs plus "Match by hex value, not by semantic name". The block `tokenSection` ([component-generator.ts:51-66](../../../apps/web/lib/ai/component-generator.ts#L51-L66)) emits the same data but only says "Use these tokens as Tailwind class values where possible" — no hex-match rule — while `renderComputedStylesSection` ([component-generator.ts:202-230](../../../apps/web/lib/ai/component-generator.ts#L202-L230)) surfaces real `color`/`backgroundColor` values with only a `fontSize` example.

The shell's `extractThemeClassNames` ([shell-prompts.ts:54-66](../../../apps/web/lib/ai/shell-prompts.ts#L54-L66)) sorts length-DESC, caps at 80, drops names <3 chars. Per the review's HARD CONSTRAINT, block prompts must NOT reuse it verbatim: ranking by length drops high-frequency structural classes, and the hard "inventing is an error" directive is wrong for block components (they need layout utilities never in theme CSS). The block inventory must rank by intersection with THIS unit's source DOM (frequency fallback), take an explicit cap argument, and stay SOFT.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| [apps/web/lib/jab/dead-class-detect.ts](../../../apps/web/lib/jab/dead-class-detect.ts) | The dead-class oracle (NEW) | `extractClassNameTokens`, `classifyClasses`, `stripDeadClasses`, `extractThemeCssClassNames`, `isVariantMarkerClass`, `rankThemeClassesForUnit` (pure ranker — here, not in component-generator, so Task 2 can use it with no forward dep on Task 4) |
| [apps/web/lib/jab/dead-class-detect.test.ts](../../../apps/web/lib/jab/dead-class-detect.test.ts) | Unit tests for the oracle (NEW) | Fixtures: dead/resolvable/arbitrary/theme-CSS/dynamic-className |
| [apps/web/lib/inngest/functions/draft-edit.ts](../../../apps/web/lib/inngest/functions/draft-edit.ts) | Live-draft chat-edit worker | Thread `themeClassNames` into the patch prompt; detect + log + (gated) strip dead classes on the patched unit |
| [apps/web/lib/inngest/functions/draft-edit.test.ts](../../../apps/web/lib/inngest/functions/draft-edit.test.ts) | Worker helper tests (NEW) | Test the pure detection/strip wiring helper |
| [apps/web/lib/ai/patch-component.ts](../../../apps/web/lib/ai/patch-component.ts) | Chat-edit prompt primitive | `PatchPromptInput`/`PatchUnitOptions` gain `themeClassNames?`/`tokens?`; `buildPatchPrompt` renders the SOFT inventory + token-hex section |
| [apps/web/lib/ai/patch-component.test.ts](../../../apps/web/lib/ai/patch-component.test.ts) | Patch-prompt tests | Assert inventory + soft rule present; byte-identical when absent |
| [apps/web/lib/ai/component-generator.ts](../../../apps/web/lib/ai/component-generator.ts) | Phase B block-component prompts | Import `rankThemeClassesForUnit` (from dead-class-detect, Task 1); add a SOFT class section via `renderBlockThemeClassSection`; replace the "translate to Tailwind" steer; add the color hex-match directive; thread `themeClassNames` through `generateComponent` |
| [apps/web/lib/ai/component-generator.test.ts](../../../apps/web/lib/ai/component-generator.test.ts) | Block-prompt tests | Assert the inventory ranking, the softened DOM directive, the hex-match rule |
| [apps/web/lib/inngest/functions/generate-components.ts](../../../apps/web/lib/inngest/functions/generate-components.ts) | Phase B worker | Compute `themeClassNames` from `design_tokens.themeStylesheets`; pass to `generateComponent` |

---

### Task 1: The dead-class oracle — pure module

**Files:**
- Create: `apps/web/lib/jab/dead-class-detect.ts`
- Test: `apps/web/lib/jab/dead-class-detect.test.ts`

**Interfaces:**
- Produces:
  - `extractClassNameTokens(tsx: string): string[]` — whole tokens from STATIC `className="..."` literals only, deduped in source order.
  - `extractThemeCssClassNames(themeCss: string | null): Set<string>` — class tokens parsed from captured theme CSS (same regex family the shell's `extractThemeClassNames` uses, but returns a membership Set, uncapped).
  - `classifyClasses(opts: { tokens: string[]; tokens_tw: ThemeJsonTokens | null; themeCss: string | null }): Promise<{ dead: string[]; resolvable: string[] }>` — per-token JIT probe + theme-CSS membership.
- Consumes: `tailwindExtendFromTokens` from `@/lib/jab/compose-site-emit`; `postcss`, `tailwindcss`; `ts` from `typescript`; `ThemeJsonTokens` from `@/lib/jab/global-styles`.

- [ ] **Step 1: Write the failing test** (`apps/web/lib/jab/dead-class-detect.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  extractClassNameTokens,
  extractThemeCssClassNames,
  classifyClasses,
} from "./dead-class-detect";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

const TOKENS: ThemeJsonTokens = {
  colorPalette: [{ slug: "primary", color: "#0a4f8a" }],
  fontFamilies: [{ slug: "heading", fontFamily: "Syne, sans-serif" }],
  fontSizes: [{ slug: "huge", size: "4rem" }],
};

describe("extractClassNameTokens", () => {
  it("extracts whole tokens from a static className string literal", () => {
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid bg-[#fff]">y</div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual(["text-4xl", "footer-v2-grid", "bg-[#fff]"]);
  });

  it("dedups repeated tokens in source order", () => {
    const tsx = `export function X() { return <div className="p-2"><span className="p-2 mt-1">y</span></div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual(["p-2", "mt-1"]);
  });

  it("ignores template-literal / clsx / ternary classNames (runtime-composed)", () => {
    const tsx = `export function X({ a }: { a: boolean }) {
      return <div className={\`base \${a ? "on" : "off"}\`} data-x="ignored" aria-label="nope">y</div>;
    }`;
    expect(extractClassNameTokens(tsx)).toEqual([]);
  });

  it("ignores non-className static attributes", () => {
    const tsx = `export function X() { return <div id="header" data-role="banner">y</div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual([]);
  });
});

describe("extractThemeCssClassNames", () => {
  it("parses class selectors from captured theme CSS", () => {
    const css = `.jab-theme .footer-v2-grid { display: grid; } .jab-theme .site-header{padding:0}`;
    const set = extractThemeCssClassNames(css);
    expect(set.has("footer-v2-grid")).toBe(true);
    expect(set.has("site-header")).toBe(true);
  });

  it("returns an empty set for null", () => {
    expect(extractThemeCssClassNames(null).size).toBe(0);
  });
});

describe("classifyClasses", () => {
  it("marks a hallucinated class with no Tailwind rule and no theme CSS as DEAD", async () => {
    const r = await classifyClasses({ tokens: ["footer-v2-grid"], tokens_tw: TOKENS, themeCss: null });
    expect(r.dead).toEqual(["footer-v2-grid"]);
    expect(r.resolvable).toEqual([]);
  });

  it("marks a standard Tailwind utility as RESOLVABLE", async () => {
    const r = await classifyClasses({ tokens: ["text-4xl"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["text-4xl"]);
    expect(r.dead).toEqual([]);
  });

  it("marks a token-derived utility (bg-primary) as RESOLVABLE", async () => {
    const r = await classifyClasses({ tokens: ["bg-primary"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["bg-primary"]);
  });

  it("marks an arbitrary-value class (bg-[#fff]) as RESOLVABLE (no substring false-positive)", async () => {
    const r = await classifyClasses({ tokens: ["bg-[#fff]"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["bg-[#fff]"]);
  });

  it("marks a class present only in captured theme CSS as RESOLVABLE", async () => {
    const r = await classifyClasses({
      tokens: ["footer-v2-grid"],
      tokens_tw: TOKENS,
      themeCss: ".jab-theme .footer-v2-grid { display: grid; }",
    });
    expect(r.resolvable).toEqual(["footer-v2-grid"]);
    expect(r.dead).toEqual([]);
  });

  it("dedups before probing (one classification per unique token)", async () => {
    const r = await classifyClasses({
      tokens: ["text-4xl", "text-4xl", "footer-v2-grid"],
      tokens_tw: TOKENS,
      themeCss: null,
    });
    expect(r.resolvable).toEqual(["text-4xl"]);
    expect(r.dead).toEqual(["footer-v2-grid"]);
  });

  it("NEVER marks variant-marker classes dead (group/peer + named) — they emit no CSS alone but drive group-hover/peer-* on descendants", async () => {
    const r = await classifyClasses({
      tokens: ["group", "peer", "group/card", "peer/email"],
      tokens_tw: TOKENS,
      themeCss: null,
    });
    expect(r.dead).toEqual([]);
    expect(r.resolvable).toEqual(["group", "peer", "group/card", "peer/email"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- dead-class-detect`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the oracle** (`apps/web/lib/jab/dead-class-detect.ts`)

```ts
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
```

> **Variant-marker safety (review finding #4):** `group`, `peer`, and the named variants `group/<name>` / `peer/<name>` emit **no CSS on their own** — they are markers that companion utilities reference (`group-hover:bg-x` compiles to `.group:hover .group-hover\:bg-x`; `peer-checked:*` to `.peer:checked ~ .peer-checked\:*`). The per-token JIT probe sees `<div class="group">` emit nothing and would classify `group` as dead; stripping it then silently breaks every `group-hover:`/`peer-*:` interaction on descendants. They MUST be treated as resolvable. Add this helper just above `tailwindEmitsRule`:

```ts
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
```

Also add the per-unit class ranker **here, in the pure oracle module** (NOT in the Task 4 block-prompt module). It is pure — a regex over the unit's source DOM — and BOTH the patch path (Task 2) and the block prompts (Task 4) import it from here. Defining it in Task 1 is what keeps Task 2's worker wiring free of any forward dependency on Task 4 (review finding: a Task 2 import of a Task 4 symbol would fail the per-task typecheck):

```ts
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
```

Add its unit tests to the Task 1 test file (alongside the Step 1 tests):

```ts
import { rankThemeClassesForUnit } from "./dead-class-detect";

describe("rankThemeClassesForUnit", () => {
  it("ranks classes used in THIS unit's source DOM ahead of the rest, by frequency", () => {
    const ranked = rankThemeClassesForUnit({
      themeClassNames: ["unused-a", "card-grid", "unused-b", "hero-banner"],
      sourceDom: `<section class="hero-banner"><div class="card-grid card-grid">x</div></section>`,
      cap: 10,
    });
    expect(ranked.slice(0, 2)).toEqual(["card-grid", "hero-banner"]); // 2 hits before 1 hit, both before unused
    expect(ranked).toContain("unused-a");
  });

  it("respects the explicit cap", () => {
    expect(rankThemeClassesForUnit({ themeClassNames: ["a-aa", "b-bb", "c-cc", "d-dd"], sourceDom: null, cap: 2 }).length).toBe(2);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- dead-class-detect`
Expected: PASS (allow the per-token JIT probes ~a few seconds — bump the suite `testTimeout` only if a probe-heavy case trips the default).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/dead-class-detect.ts apps/web/lib/jab/dead-class-detect.test.ts
git commit -m "feat(draft): add dead-class oracle (JIT-probe + theme-CSS membership) + per-unit class ranker"
```

---

### Task 2: `stripDeadClasses` + wire detection into the draft-edit commit path

**Files:**
- Modify: `apps/web/lib/jab/dead-class-detect.ts`, `apps/web/lib/inngest/functions/draft-edit.ts`
- Test: `apps/web/lib/jab/dead-class-detect.test.ts`, `apps/web/lib/inngest/functions/draft-edit.test.ts`

**Interfaces:**
- Produces:
  - `stripDeadClasses(tsx: string, dead: string[]): string` — removes ONLY whole dead tokens from static `className="..."` literals (pure; never touches template literals/expressions). When a className becomes empty it is left as `className=""` (no structural rewrite).
  - `resolveDeadClasses(args: { tsx; tokens_tw; themeCss }): Promise<{ dead: string[]; cleaned: string }>` — convenience wrapper used by the worker: extract → classify → strip-if-flag. Reads `process.env.JAB_STRIP_DEAD_CLASSES`.
- Consumes: the patched TSX + the base build's `tokens`/`themeCss` already loaded by `loadProjectMeta` ([artifacts.ts:200-219](../../../apps/web/lib/draft/artifacts.ts#L200-L219)).

- [ ] **Step 1: Write the failing strip test** (append to `dead-class-detect.test.ts`)

```ts
import { stripDeadClasses } from "./dead-class-detect";

describe("stripDeadClasses", () => {
  it("removes only the dead token from a static className, keeping the rest", () => {
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid p-2">y</div>; }`;
    expect(stripDeadClasses(tsx, ["footer-v2-grid"])).toBe(
      `export function X() { return <div className="text-4xl p-2">y</div>; }`,
    );
  });

  it("collapses to className=\"\" when every token was dead", () => {
    const tsx = `export function X() { return <div className="footer-v2-grid">y</div>; }`;
    expect(stripDeadClasses(tsx, ["footer-v2-grid"])).toBe(
      `export function X() { return <div className="">y</div>; }`,
    );
  });

  it("never touches template-literal / expression classNames", () => {
    const tsx = `export function X({ a }: { a: boolean }) { return <div className={a ? "footer-v2-grid" : "x"}>y</div>; }`;
    expect(stripDeadClasses(tsx, ["footer-v2-grid"])).toBe(tsx);
  });

  it("is a no-op when there are no dead classes", () => {
    const tsx = `export function X() { return <div className="p-2">y</div>; }`;
    expect(stripDeadClasses(tsx, [])).toBe(tsx);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- dead-class-detect`
Expected: FAIL — `stripDeadClasses` is not exported.

- [ ] **Step 3: Implement `stripDeadClasses` + `resolveDeadClasses`** (append to `dead-class-detect.ts`)

```ts
/**
 * Remove ONLY whole dead tokens from STATIC className string literals, leaving
 * everything else byte-identical. Operates on the same AST as
 * extractClassNameTokens, so an expression className (template literal, clsx,
 * ternary) is never rewritten — only quoted static values are. Stripping is
 * safe because a class producing zero CSS is visually inert in this closed
 * #jab-app / .jab-theme system; an emptied className stays as className="".
 */
export function stripDeadClasses(tsx: string, dead: string[]): string {
  if (dead.length === 0) return tsx;
  const deadSet = new Set(dead);

  const sourceFile = ts.createSourceFile(
    "dead-class-detect.tsx",
    tsx,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  // Collect [start, end, replacement] edits, then apply right-to-left so
  // earlier offsets stay valid.
  const edits: Array<{ start: number; end: number; text: string }> = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === "className" && node.initializer && ts.isStringLiteral(node.initializer)) {
        const lit = node.initializer;
        const kept = lit.text.split(/\s+/).filter((t) => t && !deadSet.has(t));
        const next = kept.join(" ");
        if (next !== lit.text) {
          // Replace the literal's inner text only (preserve the quote chars).
          edits.push({ start: lit.getStart(sourceFile) + 1, end: lit.getEnd() - 1, text: next });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (edits.length === 0) return tsx;
  edits.sort((a, b) => b.start - a.start);
  let out = tsx;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * Worker convenience: extract → classify → (optionally) strip. The dead-class
 * count is REPORT-ONLY by default (logged + returned); set
 * JAB_STRIP_DEAD_CLASSES=1 to also rewrite the TSX. Returns the cleaned TSX
 * (identical to the input when the flag is off) plus the dead list so the
 * caller can log/return the count.
 */
export async function resolveDeadClasses(args: {
  tsx: string;
  tokens_tw: ThemeJsonTokens | null;
  themeCss: string | null;
}): Promise<{ dead: string[]; cleaned: string }> {
  const tokens = extractClassNameTokens(args.tsx);
  if (tokens.length === 0) return { dead: [], cleaned: args.tsx };
  const { dead } = await classifyClasses({ tokens, tokens_tw: args.tokens_tw, themeCss: args.themeCss });
  const strip = process.env.JAB_STRIP_DEAD_CLASSES === "1";
  const cleaned = strip ? stripDeadClasses(args.tsx, dead) : args.tsx;
  return { dead, cleaned };
}
```

- [ ] **Step 4: Run the strip test to verify it passes**

Run: `pnpm --filter @jab/web test -- dead-class-detect`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring test** (`apps/web/lib/inngest/functions/draft-edit.test.ts`)

This test exercises the pure wiring helper added in Step 6 so the worker logic is testable without an Inngest harness.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectAndMaybeStripDeadClasses } from "./draft-edit";

const TOKENS = { colorPalette: [{ slug: "primary", color: "#0a4f8a" }] };

describe("detectAndMaybeStripDeadClasses", () => {
  const prev = process.env.JAB_STRIP_DEAD_CLASSES;
  afterEach(() => {
    if (prev === undefined) delete process.env.JAB_STRIP_DEAD_CLASSES;
    else process.env.JAB_STRIP_DEAD_CLASSES = prev;
  });

  it("reports the dead count and leaves TSX untouched when the flag is off (default)", async () => {
    delete process.env.JAB_STRIP_DEAD_CLASSES;
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(tsx);
  });

  it("strips dead classes when JAB_STRIP_DEAD_CLASSES=1", async () => {
    process.env.JAB_STRIP_DEAD_CLASSES = "1";
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(`export function X() { return <div className="text-4xl">y</div>; }`);
  });
});
```

- [ ] **Step 6: Run the wiring test to verify it fails**

Run: `pnpm --filter @jab/web test -- draft-edit`
Expected: FAIL — `detectAndMaybeStripDeadClasses` is not exported.

- [ ] **Step 7: Implement the worker wiring** (`draft-edit.ts`)

Add the import near the existing `patchUnitSource` import:

```ts
import { resolveDeadClasses } from "@/lib/jab/dead-class-detect";
import { resolveThemeTokens } from "@/lib/jab/global-styles";
import { emitThemeCss } from "@/lib/jab/compose-site-emit";
import { rankThemeClassesForUnit } from "@/lib/jab/dead-class-detect"; // Task 1 (pure ranker — no forward dep on Task 4)
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
```

Add the pure, exported helper just below `maxBytesFor`:

```ts
/**
 * Detect (and, behind JAB_STRIP_DEAD_CLASSES, strip) class names the patch LLM
 * invented that resolve to no CSS in the clone's closed Tailwind + theme-CSS
 * system. REPORT-ONLY by default — the count is a lower-bound quality signal,
 * not a certification. Pure: takes the same tokens/themeCss buildDraftCss uses.
 */
export async function detectAndMaybeStripDeadClasses(args: {
  tsx: string;
  tokens: ThemeJsonTokens | null;
  themeCss: string | null;
}): Promise<{ tsx: string; deadCount: number; dead: string[] }> {
  const { dead, cleaned } = await resolveDeadClasses({
    tsx: args.tsx,
    tokens_tw: args.tokens,
    themeCss: args.themeCss,
  });
  return { tsx: cleaned, deadCount: dead.length, dead };
}
```

Wire it into the `patch-unit` step (Step 4 of the worker). The patch step currently returns `result.tsx`; load the base build's tokens + theme CSS, run detection, log the count, and return the (possibly cleaned) TSX. Replace the body of the `patch-unit` step:

```ts
    // 4. Patch LLM, then run the deterministic dead-class oracle over the
    //    result. Report-only by default; JAB_STRIP_DEAD_CLASSES=1 strips.
    const patched = await step.run("patch-unit", async () => {
      const base = await loadBaseThemeClassNames(admin, draft.base_build_id, projectId);
      const result = await patchUnitSource({
        currentTsx: current.tsx,
        guidance,
        exportName: exportNameFor(scope, target),
        maxBytes: maxBytesFor(scope),
        client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
        // Rank the UNCAPPED inventory against the current source so the prompt
        // gets the relevant subset, not the length-capped global top-80 (#5).
        // rankThemeClassesForUnit lives in dead-class-detect.ts (Task 1), so this
        // wiring has NO forward dependency on Task 4. (When the draft↔deployed-css
        // -parity plan also lands, see the Shared-surface coordination section for
        // the single merged patch step that ALSO threads sourceHosts + routePathMap.)
        themeClassNames: rankThemeClassesForUnit({ themeClassNames: base.classNames, sourceDom: current.tsx }),
        tokens: base.tokens,
      });
      if (!result.ok) throw new Error(`patch failed after ${result.attempts} attempts: ${result.error}`);
      const { tsx, deadCount, dead } = await detectAndMaybeStripDeadClasses({
        tsx: result.tsx,
        tokens: themeClassNames.tokens,
        themeCss: themeClassNames.themeCss,
      });
      if (deadCount > 0) {
        console.warn(
          `[draft-edit] edit ${editId} (${scope}:${target}) produced ${deadCount} dead class(es): ${dead.join(", ")}${
            process.env.JAB_STRIP_DEAD_CLASSES === "1" ? " — stripped" : " — report-only (set JAB_STRIP_DEAD_CLASSES=1 to strip)"
          }`,
        );
      }
      return tsx;
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!patched) return { failed: true };
```

Add the loader helper (mirrors `loadProjectMeta` [artifacts.ts:200-219](../../../apps/web/lib/draft/artifacts.ts#L200-L219), but on the project that owns the base build) below `detectAndMaybeStripDeadClasses`:

```ts
/**
 * Load the base build's project theme inputs once for the patch step: the
 * resolved theme tokens (for the JIT probe + token-hex prompt section), the
 * emitted theme CSS (for the dead-class membership check), and the shell-style
 * class-name inventory (for the SOFT prefer-inventory prompt section). Mirrors
 * artifacts.ts loadProjectMeta + compose-site's extractThemeClassNames. Fails
 * SOFT to empty inputs — a missing token table must not block a chat edit.
 */
async function loadBaseThemeClassNames(
  admin: ReturnType<typeof createAdminClient>,
  baseBuildId: string,
  projectId: string,
): Promise<{ classNames: string[]; tokens: ThemeJsonTokens | null; themeCss: string | null }> {
  void baseBuildId; // tokens live on the project row, not the build row
  const { data } = await admin
    .from("projects")
    .select("design_tokens")
    .eq("id", projectId)
    .single();
  const dt = (data?.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    themeStylesheets?: Array<{ css: string }> | null;
    colors?: import("@/lib/jab/global-styles").ScrapedBrandTokens["colors"];
    typography?: import("@/lib/jab/global-styles").ScrapedBrandTokens["typography"];
  };
  const sheets = dt.themeStylesheets ?? [];
  const tokens = resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
  const themeCss = sheets.length > 0 ? emitThemeCss(sheets as never) : null;
  const { extractThemeClassNames } = await import("@/lib/ai/shell-prompts");
  // UNCAPPED (review finding #5) — the patch step ranks this against current.tsx
  // (rankThemeClassesForUnit, Task 1) and caps THERE, so a class the component
  // already uses must not be dropped by the extractor's length-DESC top-80.
  return { classNames: extractThemeClassNames(sheets, Number.MAX_SAFE_INTEGER), tokens, themeCss };
}
```

> Note: `loadBaseThemeClassNames` depends on `PatchUnitOptions.themeClassNames`/`tokens`, which Task 3 adds. If `tsc` flags the unknown options here, proceed to Task 3 before committing — or commit Tasks 2+3 together. Either ordering is fine; the steps are written so Task 3's interface change makes this compile.

- [ ] **Step 8: Run both tests**

Run: `pnpm --filter @jab/web test -- "dead-class-detect|draft-edit"`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean once Task 3's `PatchUnitOptions` fields land (see the note above).

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/jab/dead-class-detect.ts apps/web/lib/jab/dead-class-detect.test.ts apps/web/lib/inngest/functions/draft-edit.ts apps/web/lib/inngest/functions/draft-edit.test.ts
git commit -m "feat(draft): report dead classes on chat edits, strip behind JAB_STRIP_DEAD_CLASSES"
```

---

### Task 3 (PRIMARY): Patch-prompt theme-class inventory + token-hex hints

**Files:**
- Modify: `apps/web/lib/ai/patch-component.ts`
- Test: `apps/web/lib/ai/patch-component.test.ts`

**Interfaces:**
- Produces: `PatchPromptInput`/`PatchUnitOptions` gain `themeClassNames?: string[]` + `tokens?: ThemeJsonTokens | null`; `buildPatchPrompt` appends a SOFT prefer-inventory section + a token slug+hex section with the "Match by hex value" rule (ported from the shell). Byte-identical when neither is provided.
- Consumes: `ThemeJsonTokens` from `@/lib/jab/global-styles`.

- [ ] **Step 1: Write the failing test** (append to `patch-component.test.ts`)

```ts
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

describe("buildPatchPrompt — theme-class inventory + token hex hints", () => {
  const tokens: ThemeJsonTokens = { colorPalette: [{ slug: "primary", color: "#ffc72c" }] };

  it("renders a SOFT prefer-inventory section when themeClassNames is provided", () => {
    const p = buildPatchPrompt({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      themeClassNames: ["site-header", "footer-v2-grid"],
    });
    expect(p.system).toMatch(/site-header/);
    expect(p.system).toMatch(/footer-v2-grid/);
    expect(p.system).toMatch(/PREFER/);
    // It is a SOFT hint — Tailwind utilities are still allowed, and inventing
    // is NOT declared a hard error (unlike the shell prompt).
    expect(p.system).toMatch(/standard Tailwind utilities/);
    expect(p.system).not.toMatch(/is an error/);
  });

  it("renders token slug+hex pairs with the hex-match rule when tokens are provided", () => {
    const p = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero", tokens });
    expect(p.system).toMatch(/primary \(#ffc72c\)/);
    expect(p.system).toMatch(/Match by hex value, not by semantic name/);
  });

  it("is byte-identical to the no-inventory prompt when neither is provided", () => {
    const a = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero" });
    const b = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero", themeClassNames: [], tokens: null });
    expect(b.system).toBe(a.system);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- patch-component`
Expected: FAIL — `themeClassNames`/`tokens` are not on `PatchPromptInput`; the soft section + hex rule are absent.

- [ ] **Step 3: Implement** (`patch-component.ts`)

Add the import + widen the interfaces, and render the two soft sections. Replace the top of the file (import block + `PatchPromptInput` + `buildPatchPrompt`):

```ts
import "server-only";
import { validateTsx } from "./component-generator";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import type { ModelClient, GenerateUsage } from "./model-client";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * patch-component — the Live Draft edit primitive (spec §6.2.3). Unlike the
 * Phase B generator (which re-derives a component from DOM samples and can
 * silently lose earlier edits), this takes the CURRENT draft TSX as input and
 * asks for a minimal modification — iterative chat edits compound instead of
 * resetting. Same validation discipline as generation: postprocess → parse
 * check → size cap, two attempts.
 *
 * Theme-class inventory + token-hex hints (added 2026-06-16): the patch LLM
 * previously had NO signal about which class names the bundled theme CSS
 * defines or which hex maps to which token, so it invented dead classes
 * (e.g. footer-v2-grid) and approximated brand colors with stock Tailwind
 * utilities. Both sections are SOFT — block-level edits legitimately need
 * Tailwind layout utilities never present in theme CSS — and the deterministic
 * dead-class oracle is the real guardrail. Both are byte-additive: when no
 * inventory/tokens are supplied the prompt is identical to before.
 */
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** Class names defined in the bundled source theme CSS (SOFT prefer hint). */
  themeClassNames?: string[];
  /** Theme tokens, for the slug+hex "match by hex" section (SOFT). */
  tokens?: ThemeJsonTokens | null;
}

function renderPatchThemeClassSection(classNames: string[] | undefined): string {
  if (!classNames || classNames.length === 0) return "";
  return `

## Source theme class names (defined in the bundled theme CSS)
These class names are defined in the site's compiled CSS, which the clone
bundles at runtime. When the current source already uses one of these classes,
PREFER to keep it verbatim (the bundled CSS resolves it) rather than swapping
it for a Tailwind approximation. You MAY also use standard Tailwind utilities
for layout/spacing — inventing a class that is in NEITHER list resolves to no
CSS and does nothing, so avoid it:
${classNames.map((n) => `- ${n}`).join("\n")}`;
}

function renderPatchTokenSection(tokens: ThemeJsonTokens | null | undefined): string {
  if (!tokens) return "";
  const colorPairs = (tokens.colorPalette ?? []).slice(0, 12).map((c) => `${c.slug} (${c.color})`).join(", ");
  const fontPairs = (tokens.fontFamilies ?? []).slice(0, 6).map((f) => `${f.slug} (${f.fontFamily})`).join(", ");
  if (!colorPairs && !fontPairs) return "";
  return `

## Available theme tokens
Colors: ${colorPairs || "(none)"}
Font families: ${fontPairs || "(none)"}
The generated tailwind.config maps each slug to a Tailwind class (e.g. \`bg-primary\`,
\`text-primary\`, \`font-heading\`). When the edit introduces a literal color value
(e.g. \`#ffc72c\` or \`rgb(255,199,44)\`), prefer the matching token class over a
Tailwind utility approximation (\`bg-yellow-400\`). Match by hex value, not by semantic name.`;
}

export function buildPatchPrompt(input: PatchPromptInput): { system: string; user: string } {
  const themeClassSection = renderPatchThemeClassSection(input.themeClassNames);
  const tokenSection = renderPatchTokenSection(input.tokens);
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.${themeClassSection}${tokenSection}`;
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}`;
  return { system, user };
}
```

Widen `PatchUnitOptions` and forward the new fields into `buildPatchPrompt`. Replace the `PatchUnitOptions` interface and the first line of `patchUnitSource`:

```ts
export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** MAX_COMPONENT_BYTES (10_000) for components, MAX_SHELL_BYTES (24_000) for shell. */
  maxBytes: number;
  client: ModelClient;
  /** SOFT prefer-inventory of class names defined in the bundled theme CSS. */
  themeClassNames?: string[];
  /** Theme tokens for the slug+hex "match by hex" prompt section. */
  tokens?: ThemeJsonTokens | null;
}

export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    themeClassNames: opts.themeClassNames,
    tokens: opts.tokens,
  });
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";
```

(The rest of `patchUnitSource` is unchanged — it already consumes `prompt.system`/`prompt.user`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- patch-component`
Expected: PASS (the existing `buildPatchPrompt` test still passes — the no-inventory path is byte-identical).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean — this also satisfies the Task 2 `loadBaseThemeClassNames` call site.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/ai/patch-component.ts apps/web/lib/ai/patch-component.test.ts
git commit -m "feat(draft): feed chat-edit patch prompt the theme-class inventory + token hex hints"
```

---

### Task 4: Block-component prompt inventory (soft, DOM/frequency-aware) + color hex-match port

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts`, `apps/web/lib/inngest/functions/generate-components.ts`
- Test: `apps/web/lib/ai/component-generator.test.ts`

**Interfaces:**
- Produces:
  - `renderBlockThemeClassSection(ranked: string[]): string` — SOFT prefer-inventory section.
  - `sharedSystemPrompt(tokens, sourceHost, themeClassNames?)` gains the inventory + the color hex-match line; `renderDomSampleSection`'s default guidance drops "Translate source class names to corresponding Tailwind classes" in favor of "PREFER reusing a listed theme class when the source DOM uses it; otherwise use Tailwind utilities."
  - `GenerateComponentOptions` gains `themeClassNames?: string[]`; all five tier prompt builders accept + thread it.
- Consumes:
  - `rankThemeClassesForUnit` — **imported from `@/lib/jab/dead-class-detect` (Task 1)**; this task only USES the pure ranker (against `entry.sourceDomSample`), it does not define it. (Defining it in Task 1 is what keeps the Task 2 patch wiring free of a forward dependency on this task.)
  - `entry.sourceDomSample` (already on `EnrichedInventoryEntry`); `design_tokens.themeStylesheets` in the worker.

- [ ] **Step 1: Write the failing tests** (append to `component-generator.test.ts`)

```ts
import { visualPrompt } from "./component-generator";

// rankThemeClassesForUnit is defined + unit-tested in dead-class-detect.ts
// (Task 1). This task only exercises the block prompt's USE of it.

describe("block prompt — theme-class inventory + softened DOM directive + hex rule", () => {
  const entry = {
    blockName: "core/cover",
    kind: "block",
    tier: "visual",
    occurrenceCount: 3,
    pageSlugs: ["home"],
    attrSamples: [{}],
    sourceDomSample: `<div class="wp-block-cover hero-banner">x</div>`,
    computedStyles: null,
    spec: null,
  } as unknown as import("@/lib/jab/inventory").EnrichedInventoryEntry;

  const tokens = { colorPalette: [{ slug: "primary", color: "#ffc72c" }] };

  it("renders the SOFT theme-class inventory in the system half", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner", "wp-block-cover"]);
    expect(p).toMatch(/hero-banner/);
    expect(p).toMatch(/PREFER/);
    expect(p).not.toMatch(/Inventing class names that appear in neither list is an error/);
  });

  it("no longer instructs the model to translate source classes to Tailwind", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner"]);
    expect(p).not.toMatch(/Translate source class names to corresponding Tailwind classes/);
  });

  it("ports the shell's hex-match directive into the block token section", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner"]);
    expect(p).toMatch(/Match by hex value, not by semantic name/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jab/web test -- component-generator`
Expected: FAIL — `visualPrompt` takes no `themeClassNames` arg; the DOM directive + hex rule are unchanged. (`rankThemeClassesForUnit` already exists + is green from Task 1.)

- [ ] **Step 3: Implement the ranking + section helpers + token-hex rule** (`component-generator.ts`)

First add the ranker import to the top of `component-generator.ts` (with the other imports) — do NOT redefine the ranker here; it lives in `dead-class-detect.ts` (Task 1) so Task 2 can use it without depending on this task:

```ts
import { rankThemeClassesForUnit } from "@/lib/jab/dead-class-detect";
```

Then add the section helper below `isPassthroughShapedBlockName` (before `renderDomSampleSection`):

```ts
/**
 * SOFT prefer-inventory section for block components. Deliberately NOT a hard
 * rule (block components legitimately need Tailwind layout utilities absent
 * from theme CSS) — the deterministic dead-class oracle is the real guardrail.
 */
function renderBlockThemeClassSection(ranked: string[]): string {
  if (ranked.length === 0) return "";
  return `
## Source theme class names (defined in the bundled theme CSS)
The clone bundles the source site's compiled CSS at runtime. When the source
DOM below uses one of these class names, PREFER to reuse it verbatim (the
bundled CSS resolves it) over inventing a Tailwind approximation. You MAY also
use standard Tailwind utilities for layout/spacing. A class in NEITHER the
Tailwind set NOR this list resolves to no CSS and does nothing — avoid it:
${ranked.map((n) => `- ${n}`).join("\n")}
`;
}
```

Add the color hex-match line to the token section. Replace the `tokens` branch of `sharedSystemPrompt` ([component-generator.ts:51-66](../../../apps/web/lib/ai/component-generator.ts#L51-L66)) and widen the signature:

```ts
function sharedSystemPrompt(
  tokens: ThemeJsonTokens | null,
  sourceHost?: string | null,
  themeClassNames?: string[],
): string {
  const tokenSection = tokens
    ? `
## Design tokens (from theme.json)

Colors: ${JSON.stringify(tokens.colorPalette?.slice(0, 10) ?? [])}
Font sizes: ${JSON.stringify(tokens.fontSizes?.slice(0, 8) ?? [])}
Font families: ${JSON.stringify(tokens.fontFamilies?.slice(0, 4) ?? [])}
Block gap: ${tokens.blockGap ?? "unset"}

Use these tokens as Tailwind class values where possible. The generated
tailwind.config.ts maps all slugs to Tailwind color/font keys. When the source
DOM or computed styles carry a literal color value (e.g. \`#ffc72c\` or
\`rgb(255,199,44)\`), prefer the matching token class (\`bg-primary\` /
\`text-primary\` for that hex) over a Tailwind utility approximation
(\`bg-yellow-400\`). Match by hex value, not by semantic name.
`
    : `
## Design tokens
No theme.json tokens available. Use Tailwind defaults.
`;

  const themeClassSection = renderBlockThemeClassSection(themeClassNames ?? []);
```

Then append `${themeClassSection}` to the returned system string (it ends `...${tokenSection}`):

```ts
${sourceHost ? `- Links whose host is ${sourceHost} are INTERNAL. Emit them as root-relative paths copied exactly from the source URL's path. NEVER emit ${sourceHost} in any href.\n` : ""}${tokenSection}${themeClassSection}`;
```

Soften `renderDomSampleSection`'s default guidance ([component-generator.ts:171](../../../apps/web/lib/ai/component-generator.ts#L171)). Replace the default `guidance` assignment:

```ts
  const guidance = opts.guidance ?? "This HTML is the literal markup the source theme rendered. Match its semantic structure — element hierarchy, sectioning, content placeholders. When the source uses a class name listed in the theme-class inventory above, PREFER reusing it verbatim; otherwise use Tailwind utilities (with the theme tokens above). The screenshot shows the pixels; this HTML shows the structure those pixels come from.";
```

(Also update the `acf_flex` and `cpt_template` inline `guidance` strings that contain "Translate the source class names to Tailwind classes" / "Translate source class names" — at [component-generator.ts:337](../../../apps/web/lib/ai/component-generator.ts#L337) and [component-generator.ts:566](../../../apps/web/lib/ai/component-generator.ts#L566) — to the same PREFER-reuse phrasing, so the steer is removed consistently across tiers.)

- [ ] **Step 4: Thread `themeClassNames` through the prompt builders + `generateComponent`** (`component-generator.ts`)

Add `themeClassNames?: string[]` as the trailing param to `visualPrompt`, `standardPrompt`, `trivialPrompt`, `cptTemplatePrompt`, and `acfFlexPrompt`, pass it into `sharedSystemPrompt`, and rank it against `entry.sourceDomSample` once per builder. Example for `visualPrompt` (apply the same pattern to the others):

```ts
export function visualPrompt(
  entry: EnrichedInventoryEntry,
  tokens: ThemeJsonTokens | null,
  guidance?: string,
  sourceHost?: string | null,
  themeClassNames?: string[],
): string {
  const ranked = rankThemeClassesForUnit({ themeClassNames: themeClassNames ?? [], sourceDom: entry.sourceDomSample });
  const system = sharedSystemPrompt(tokens, sourceHost, ranked);
  // ...rest unchanged...
```

> For `trivialPrompt`: it uses a bespoke minimal system prompt (not `sharedSystemPrompt`) and deliberately omits the DOM sample. Accept the `themeClassNames` param for signature symmetry but DO NOT render the inventory there — trivial blocks (paragraph/heading) don't carry structural theme classes and the token budget matters across many short blocks. Mark the param `_themeClassNames` to satisfy the no-unused rule, matching the existing `_sourceHost`.

Add the field to `GenerateComponentOptions` (after `sourceHosts`):

```ts
  /**
   * Class names defined in the bundled source theme CSS — a SOFT prefer-reuse
   * inventory, ranked per-unit against the entry's source DOM. Built once in
   * the generate-components worker from design_tokens.themeStylesheets. Absent
   * → no inventory section (safe default for tests + the passthrough path).
   */
  themeClassNames?: string[];
```

Pass `opts.themeClassNames` into each branch of the prompt selection in `generateComponent` ([component-generator.ts:711-721](../../../apps/web/lib/ai/component-generator.ts#L711-L721)):

```ts
  const themeClassNames = opts.themeClassNames ?? [];
  if (entry.kind === "cpt_template") {
    combinedPrompt = cptTemplatePrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  } else if (entry.kind === "acf_flex") {
    combinedPrompt = acfFlexPrompt(entry, tokens, guidance, opts.dynamicList, sourceHost, themeClassNames);
  } else if (entry.tier === "visual") {
    combinedPrompt = visualPrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  } else if (entry.tier === "standard") {
    combinedPrompt = standardPrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  } else {
    combinedPrompt = trivialPrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  }
```

> `acfFlexPrompt` currently has signature `(entry, tokens, guidance?, dynamicList?, sourceHost?)` — add `themeClassNames?` as the 6th param so the `dynamicList`/`sourceHost` order is preserved.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @jab/web test -- component-generator`
Expected: PASS (existing block-prompt tests stay green — the inventory section is absent when `themeClassNames` is empty/omitted).

- [ ] **Step 6: Wire the worker to compute + pass the inventory** (`generate-components.ts`)

The worker already loads `design_tokens` for tokens but discards `themeStylesheets`. Add a step that reads them and derives the inventory once, then pass it into every `generateComponent` call.

Add the import near the top (with the other `@/lib/ai` imports):

```ts
import { extractThemeClassNames } from "@/lib/ai/shell-prompts";
```

Add a `load-theme-classes` step after the `load-tokens` step:

```ts
    // Theme-class inventory derived from the captured source stylesheets —
    // the SOFT prefer-reuse hint for block prompts (mirrors compose-site's
    // shell-prompt wiring). Empty when no stylesheets captured (block prompts
    // then fall back to Tailwind-only, same as before this fix).
    const themeClassNames = await step.run("load-theme-classes", async (): Promise<string[]> => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("projects")
        .select("design_tokens")
        .eq("id", projectId)
        .eq("tenant_id", tenantId)
        .single<{ design_tokens: unknown }>();
      if (error || !data) return [];
      const container = data.design_tokens as { themeStylesheets?: Array<{ css: string }> } | null;
      const sheets = container?.themeStylesheets ?? [];
      // UNCAPPED (review finding #5): extractThemeClassNames defaults to a
      // length-DESC top-80, which drops short high-frequency structural classes
      // (row/col/btn/nav). rankThemeClassesForUnit caps to 40 AFTER DOM-aware
      // ranking, so a DOM class outside the global top-80 must still reach the
      // ranker. Pass the full set here; the per-unit ranker does the capping.
      return sheets.length > 0 ? extractThemeClassNames(sheets, Number.MAX_SAFE_INTEGER) : [];
    });
```

Pass it into the `generateComponent` call inside the batch loop ([generate-components.ts:335](../../../apps/web/lib/inngest/functions/generate-components.ts#L335)):

```ts
            const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts, themeClassNames });
```

- [ ] **Step 7: Typecheck + targeted tests**

Run: `pnpm --filter @jab/web exec tsc --noEmit` then `pnpm --filter @jab/web test -- "component-generator|generate-components"`
Expected: clean tsc; tests green.

- [ ] **Step 8: Full suite**

Run: `pnpm --filter @jab/web test`
Expected: full suite green (allow extra time for the JIT-probe-based dead-class tests).

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts apps/web/lib/inngest/functions/generate-components.ts
git commit -m "feat(draft): give block-component prompts a soft DOM-aware theme-class inventory + hex-match rule"
```

---

## Self-Review

**Confirmed-fact coverage (facts 1–8):**
- Fact 1 (chat edit is `patchUnitSource`/`buildPatchPrompt` with no inventory — PRIMARY fix site) → Task 3 (prompt) + Task 2 (worker thread). ✓
- Fact 2 (block prompts get tokens but no inventory; `renderDomSampleSection` steers away from reuse; only the shell gets the inventory) → Task 4 (add soft inventory, soften the DOM directive). ✓
- Fact 3 (block inventory must NOT reuse `extractThemeClassNames` verbatim — explicit cap arg, DOM/frequency ranking, SOFT directive, detector is the guardrail) → `rankThemeClassesForUnit` (cap arg, DOM-hit ranking — defined in Task 1's pure module, used by Task 4) + Task 4 `renderBlockThemeClassSection` (soft). ✓
- Fact 4 (detector uses a per-token JIT emptiness probe with the SAME `tailwindExtendFromTokens` + `preflight:false` config, OR theme-CSS membership; dedup to bound cost; NOT substring of `buildDraftCss`) → Task 1 `tailwindEmitsRule` + `classifyClasses`. ✓
- Fact 5 (token extraction via `ts.createSourceFile`, STATIC `className` literals only; lower-bound signal; never strip runtime fragments) → Task 1 `extractClassNameTokens` + Task 2 `stripDeadClasses` (AST-scoped). ✓
- Fact 6 (strip safe but report-only default; gate behind `JAB_STRIP_DEAD_CLASSES`; no DB column in v1; report via console + return value) → Task 2 `resolveDeadClasses` + worker logging. ✓
- Fact 7 (captured theme CSS available via `loadProjectMeta`'s `design_tokens.themeStylesheets`; draft-edit derives `themeClassNames` via `extractThemeClassNames`) → Task 2 `loadBaseThemeClassNames`. ✓
- Fact 8 (port shell's slug+hex "Match by hex value" directive into block prompts; computed-styles section surfaces color but only a fontSize example) → Task 4 token-section hex line + the same line ported into Task 3's patch prompt. ✓

**Type consistency:** `PatchPromptInput`/`PatchUnitOptions` gain matching `themeClassNames?: string[]` + `tokens?: ThemeJsonTokens | null`; `GenerateComponentOptions.themeClassNames?: string[]` matches the trailing param threaded through all five prompt builders; `classifyClasses`/`resolveDeadClasses`/`detectAndMaybeStripDeadClasses` all use `ThemeJsonTokens | null` for tokens and `string | null` for `themeCss`; `extractClassNameTokens`/`stripDeadClasses` are both `(string, …) → string[]/string` operating on the same AST. Task 2's `loadBaseThemeClassNames` returns `{ classNames; tokens; themeCss }` consumed positionally by the patch call + the detector call.

**Placeholder scan:** every code step contains complete, real code or an exact command — no `TODO`, no "similar to above", no "add validation". The two cross-task ordering notes (Task 2 → Task 3 interface dependency; trivial-prompt deliberately omitting the inventory) are explicit and conditional, not deferrals.

**Cost / fleet-agnostic check:** the detector dedups before probing and fails OPEN on probe error; the prompt inventory is capped (40 for blocks, default-80 for the shell-derived `extractThemeClassNames` reused in the worker) and SOFT; no slug/host/color is hardcoded — `footer-v2-grid` appears only as a synthetic fixture. No migration; report-only by default.

**Review-driven refinements (2026-06-17, all confirmed against code):**
- **#3 Shared-surface conflict with the parity plan** — both plans edit `PatchPromptInput`/`PatchUnitOptions`/`buildPatchPrompt`/`patchUnitSource` + the draft-edit patch step. Resolved by the **Shared-surface coordination** section: canonical merged interfaces + a single merged worker patch step both plans converge on; tasks are additive, never wholesale-replace. ✓
- **#4 Variant-marker classes** (`group`/`peer`, named) emit no CSS alone but drive `group-hover:*`/`peer-checked:*` on descendants — the JIT probe would mark them dead and `JAB_STRIP_DEAD_CLASSES=1` would break interactions. `isVariantMarkerClass` (Task 1) classifies them resolvable; a test pins it; the Global Constraints strip bullet documents the exception. ✓
- **#5 Inventory cap** — `extractThemeClassNames` defaults to a length-DESC top-80, dropping short structural classes. Both the block worker (Task 4) and the patch loader (Task 2) now extract UNCAPPED (`Number.MAX_SAFE_INTEGER`); `rankThemeClassesForUnit` caps to 40 AFTER DOM-aware ranking (block path against `entry.sourceDomSample`, patch path against `current.tsx`). ✓

**Second-round review (2026-06-17):**
- **Task-order forward dependency** — Task 2's patch wiring used `rankThemeClassesForUnit`, which was originally defined in Task 4, so a task-by-task executor would hit a compile error before the Task 2 commit (Task 2's typecheck only depends on Task 3). Resolved by **moving the pure ranker into Task 1's `dead-class-detect.ts`**; Task 2 and Task 4 both import it from there. Task 4 now imports (not defines) it; its ranker unit tests moved to Task 1. ✓
- **Coordination "single source of truth" had undefined symbols** — the merged worker step was sketch-level (`return { classNames, tokens, ... }` with no bodies). It is now **complete, pasteable code** (full `load-base-patch-inputs` loader + `patch-unit` step) with its required imports listed, satisfying the no-placeholder bar. ✓

**Task-dependency ledger (for a task-by-task executor):** T1 standalone. T2's worker wiring imports T1's ranker (OK, backward dep) and T3's `PatchUnitOptions` fields — commit **T2+T3 together** (already noted in T2). T4 imports T1's ranker. The fully merged worker step (Shared-surface coordination) is what T2+T3+T4 (+ the parity plan) converge to.

## Out of scope (tracked elsewhere)

- Persisting the dead-class count to the DB (`workspace_edits` / `site_builds`) — needs a migration to both Supabase projects; v1 is console + return value only.
- Detecting dead classes in template-literal / `clsx` / ternary classNames — runtime-composed; deliberately excluded so the count stays a safe lower bound.
- A whole-build dead-class gate in compose/verify (Phase D/E) — this plan covers the live chat-edit path (`draft-edit`) + generation prompts only.
- Auto-correcting a dead class to the nearest real theme class — prevention (prompt) + detection (oracle) only; rewriting to a *different* class is a fidelity risk, not in v1.
