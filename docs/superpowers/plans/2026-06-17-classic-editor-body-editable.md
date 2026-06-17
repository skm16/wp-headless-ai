# Classic-Editor Body Editability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WordPress Classic-editor (non-Gutenberg) body content an **editable unit** in the Live-Draft system — today it renders via a bare passthrough but is excluded from editing at every layer.

**Architecture:** Promote the `__null__` passthrough into a real, registered, compiled **`ClassicContent`** component that *wraps* the existing `<Passthrough>` (which still injects the live WP HTML). `ClassicContent` is a pure, content-agnostic styling wrapper, so editing it changes presentation (container, typography, spacing, descendant styles via Tailwind arbitrary variants) while the text stays live from WordPress (source of truth). Because it becomes a normal compiled component (`compile_status='ok'`, a real tier, registered in the dispatcher), it flows through the inventory → site-map → planner → draft-edit pipeline like any other block — satisfying the planner-inventory-correctness principle (only offer patchable units) rather than violating it.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind 3, Vitest. Package: `apps/web` (`@jab/web`).

## Global Constraints

- **Errors are loud** — no swallowed failures (CLAUDE.md).
- **Fleet-agnostic** — works for any WP site, not just Two Roads. No site/theme/slug hard-codes.
- **WP stays source of truth** — the Classic HTML is fetched live at render time; the editable artifact is the *wrapper*, never the content. (Confirmed approach: editable wrapper, not per-page LLM conversion.)
- **No new LLM call** — `ClassicContent` is a deterministic template; it's editable afterward via the existing patch flow.
- **No DB migration** — `__null__` already exists in `block_inventory`; only its tier/compile_status values and the editable-unit filters change.
- **No WP plugin change.**
- **Naming is centralized** — `__null__` → component name `ClassicContent` is defined ONCE (constants module) and referenced by each of the codebase's deliberately-mirrored pascal copies. Do NOT deduplicate the pascal algorithm (the repo keeps 5 intentional copies — see `compose-site.ts:976`); only share the two string constants.
- **Verification gates** — every task ends green on `pnpm --filter @jab/web typecheck` AND `pnpm --filter @jab/web test`. Use the package `typecheck` script (NOT `exec tsc`).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Key facts (verified against current master)

- **Sentinel:** Classic content is keyed `block_name = "__null__"` in `block_inventory` (`inventory.ts` walks `block.blockName ?? "__null__"`); TS-side `blockName` is `null`. `inventory-entry-from-row.ts` converts `"__null__"` ↔ `null`.
- **Tier:** `assignTier(null)` → `"passthrough"` ([inventory.ts:215](../../../apps/web/lib/jab/inventory.ts#L215)).
- **Generation:** `generateComponent` short-circuits `__null__`/passthrough to a **skipped** passthrough ([component-generator.ts:1021](../../../apps/web/lib/ai/component-generator.ts#L1021)).
- **Runtime synthesis:** `synthClassic` emits `{ blockName: null, innerHTML, _key: "classic-0" }` ([compose-block-tree-runtime.ts:141](../../../apps/web/lib/jab/compose-block-tree-runtime.ts#L141)).
- **Dispatcher:** routes `block.blockName ? REGISTRY[...] : <Passthrough>`; excludes `__null__` + `passthrough` + non-ok from REGISTRY ([compose-site-emit.ts:1196-1270](../../../apps/web/lib/jab/compose-site-emit.ts#L1196)).
- **The raw-HTML render** lives only in the emitted `_passthrough.tsx` (the audited sink, `__html` from the WP DB, sanitized at WP write-time). `ClassicContent` will wrap it and never inject HTML itself.
- **Name derivations (4 mirrored copies that turn a block name into a component identifier):** `compose-site-emit.ts toPascalCase` (dispatcher import/register), `compose-site.ts blockNameToPascal` (Phase-C file copy), `persist-generation.ts` pascal (Phase-B Storage write), `bundle.ts draftComponentName` (draft sources). All currently yield `Null` for `__null__`.
- **Editable-unit filters (exclude `__null__`):** `reduceSiteMap` ([site-map.ts:120](../../../apps/web/lib/jab/site-map.ts#L120)), `artifacts.ts` ×2 ([:63](../../../apps/web/lib/draft/artifacts.ts#L63), [:124](../../../apps/web/lib/draft/artifacts.ts#L124)), `emitDispatcherTsx` ([:1200](../../../apps/web/lib/jab/compose-site-emit.ts#L1200)).
- **Label:** `humanLabelForBlock("__null__")` already returns `"Classic content"` ([site-map.ts:74](../../../apps/web/lib/jab/site-map.ts#L74)) — no change needed.
- **Patch flow:** `exportNameFor("component", target)` = `draftComponentName(target)`; current source path = `builds/{base}/components/{draftComponentName(target)}.tsx`. Both resolve to `ClassicContent` once the bundle guard lands.
- **Edit validation:** `validateEditInput` accepts any non-empty component target ([workspace-edit-validation.ts:64](../../../apps/web/lib/jab/workspace-edit-validation.ts)); `validateEditPlan` accepts a target present in `siteMap.blockTypes` ([edit-plan.ts:87](../../../apps/web/lib/jab/edit-plan.ts)). Both pass for `__null__` once it's in the site-map.

---

## File Structure

| File | Change |
|------|--------|
| `apps/web/lib/jab/classic-content.ts` | **Create** — `CLASSIC_BLOCK_NAME`, `CLASSIC_COMPONENT_NAME`, `isClassicBlock`, `classicComponentName`, `emitClassicContentTsx` |
| `apps/web/lib/jab/classic-content.test.ts` | **Create** |
| `apps/web/lib/jab/inventory.ts` | **Modify** — `Tier` gains `"classic"`; `assignTier(null)` → `"classic"` |
| `apps/web/lib/jab/inventory.test.ts` | **Modify** |
| `apps/web/lib/jab/compose-block-tree-runtime.ts` | **Modify** — `synthClassic` emits `blockName: "__null__"` |
| `apps/web/lib/jab/compose-block-tree-runtime.test.ts` | **Modify** |
| `apps/web/lib/ai/component-generator.ts` | **Modify** — `generateComponent` emits `ClassicContent` (compile ok) for `__null__` |
| `apps/web/lib/ai/component-generator.test.ts` | **Modify** |
| `apps/web/lib/jab/compose-site-emit.ts` | **Modify** — dispatcher includes `__null__`, imports/registers `ClassicContent`; `toPascalCase` guard |
| `apps/web/lib/jab/compose-site-emit.test.ts` | **Modify** |
| `apps/web/lib/inngest/functions/compose-site.ts` | **Modify** — `blockNameToPascal` guard |
| `apps/web/lib/inngest/functions/persist-generation.ts` | **Modify** — pascal guard |
| `apps/web/lib/draft/bundle.ts` | **Modify** — `draftComponentName` guard |
| `apps/web/lib/draft/bundle.test.ts` | **Modify** |
| `apps/web/lib/jab/site-map.ts` | **Modify** — `reduceSiteMap` admits `__null__` |
| `apps/web/lib/jab/site-map.test.ts` | **Modify** |
| `apps/web/lib/draft/artifacts.ts` | **Modify** — both unit filters admit `__null__` |
| `apps/web/lib/draft/artifacts.test.ts` | **Modify** |
| `docs/.../2026-06-17-independent-review-recommendations.md`, `2026-06-16-jab-fleet-gap-register.md`, `CLAUDE.md` | **Modify** — status |

---

## Task 1: `classic-content.ts` — constants + helpers + the wrapper template

**Files:** Create `apps/web/lib/jab/classic-content.ts` + `apps/web/lib/jab/classic-content.test.ts`

**Interfaces — Produces:**
- `export const CLASSIC_BLOCK_NAME = "__null__"`
- `export const CLASSIC_COMPONENT_NAME = "ClassicContent"`
- `export function isClassicBlock(blockName: string | null): boolean`
- `export function classicComponentName(): string` (returns `CLASSIC_COMPONENT_NAME`)
- `export function emitClassicContentTsx(): string` — the deterministic editable wrapper

The wrapper delegates HTML injection to `<Passthrough>` (it carries NO raw-HTML sink of its own — no `__html`), so it's a pure styling wrapper and there's nothing new to re-audit.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/classic-content.test.ts
import { describe, it, expect } from "vitest";
import {
  CLASSIC_BLOCK_NAME,
  CLASSIC_COMPONENT_NAME,
  isClassicBlock,
  classicComponentName,
  emitClassicContentTsx,
} from "@/lib/jab/classic-content";

describe("classic-content constants + helpers", () => {
  it("pins the sentinel + component name", () => {
    expect(CLASSIC_BLOCK_NAME).toBe("__null__");
    expect(CLASSIC_COMPONENT_NAME).toBe("ClassicContent");
    expect(classicComponentName()).toBe("ClassicContent");
  });

  it("isClassicBlock matches the sentinel and TS null, nothing else", () => {
    expect(isClassicBlock("__null__")).toBe(true);
    expect(isClassicBlock(null)).toBe(true);
    expect(isClassicBlock("core/paragraph")).toBe(false);
    expect(isClassicBlock("acf/hero")).toBe(false);
  });
});

describe("emitClassicContentTsx", () => {
  const src = emitClassicContentTsx();
  it("exports ClassicContent and wraps Passthrough with no raw-HTML sink of its own", () => {
    expect(src).toContain("export function ClassicContent");
    expect(src).toContain('import { Passthrough } from "./_passthrough"');
    expect(src).toContain("<Passthrough block={block} />");
    expect(src).not.toContain("__html"); // the raw-HTML sink stays in _passthrough.tsx only
  });
  it("has an editable wrapper class", () => {
    expect(src).toContain('className="jab-classic-content"');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @jab/web test -- classic-content`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/jab/classic-content.ts
/**
 * Classic-editor content is keyed in block_inventory under the "__null__"
 * sentinel (WP Classic pages are a single blockName:null body). We promote it
 * into a real, editable wrapper component named ClassicContent. These two
 * strings are the single source of truth shared by every name-derivation site
 * (the repo keeps the pascal ALGORITHM duplicated on purpose — see
 * compose-site.ts:976 — but the __null__->ClassicContent mapping is centralized
 * here so it can't drift across those copies).
 */
export const CLASSIC_BLOCK_NAME = "__null__";
export const CLASSIC_COMPONENT_NAME = "ClassicContent";

/** True for the Classic sentinel ("__null__") or its TS-side null form. */
export function isClassicBlock(blockName: string | null): boolean {
  return blockName === null || blockName === CLASSIC_BLOCK_NAME;
}

/** The component name the Classic block resolves to (vs. the ugly auto "Null"). */
export function classicComponentName(): string {
  return CLASSIC_COMPONENT_NAME;
}

/**
 * Deterministic editable wrapper for Classic-editor body content. The live WP
 * HTML is injected by <Passthrough> (the audited raw-HTML sink); THIS component
 * only wraps + styles it, so it carries no raw-HTML sink of its own. Edit it to
 * restyle the body — container width, typography, spacing, or descendant
 * elements via Tailwind arbitrary variants (e.g. [&_h2]:text-3xl). The TEXT
 * lives in WordPress (source of truth, fetched live at render time); it cannot
 * be edited here.
 */
export function emitClassicContentTsx(): string {
  return `import type { BlockNode } from "@/lib/jab/ability-client";
import { Passthrough } from "./_passthrough";

/**
 * ClassicContent — editable wrapper for WordPress Classic-editor body HTML.
 * The HTML comes LIVE from WordPress via <Passthrough> (source of truth). Edit
 * THIS wrapper to restyle the body: container, typography, spacing, or
 * descendant elements via Tailwind arbitrary variants like [&_h2]:text-3xl.
 * To change the TEXT, edit it in WordPress.
 */
export function ClassicContent({ block }: { block: BlockNode }) {
  return (
    <div className="jab-classic-content">
      <Passthrough block={block} />
    </div>
  );
}
`;
}
```

- [ ] **Step 4: Run — verify pass.** `pnpm --filter @jab/web test -- classic-content` → PASS.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/classic-content.ts apps/web/lib/jab/classic-content.test.ts
git commit -m "feat(saas): classic-content module — ClassicContent wrapper + sentinel constants"
```

---

## Task 2: `Tier` gains `"classic"`; `assignTier(null)` → `"classic"`

**Files:** Modify `apps/web/lib/jab/inventory.ts` + `apps/web/lib/jab/inventory.test.ts`

Giving the Classic block a non-`passthrough` tier is what lets it survive the editable-unit filters (which all gate on `tier !== "passthrough"`). The generator special-cases `__null__` BEFORE any tier-based model routing (Task 4), so `"classic"` never reaches `modelClientForTier`/`MAX_TOKENS_BY_TIER`.

- [ ] **Step 1: Write the failing test** (add to `inventory.test.ts`)

```typescript
import { assignTierForTest } from "@/lib/jab/inventory"; // if assignTier isn't exported, see Step 3

describe("assignTier — classic", () => {
  it("assigns the classic tier to null-named (Classic-editor) blocks", () => {
    expect(assignTierForTest(null, 1)).toBe("classic");
  });
  it("still passthroughs rare/unknown blocks", () => {
    expect(assignTierForTest("core/paragraph", 1)).toBe("passthrough"); // occurrence <= 2
    expect(assignTierForTest("third/unknown", 99)).toBe("passthrough");
  });
});
```

- [ ] **Step 2: Run — verify fail** (`assignTier` not exported / returns "passthrough" for null).

Run: `pnpm --filter @jab/web test -- inventory`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `inventory.ts`:

(a) Add `"classic"` to the `Tier` union (find the `Tier` type declaration near the tier sets and add `"classic"`).

(b) Change `assignTier`:

```typescript
function assignTier(blockName: string | null, occurrence: number): Tier {
  // Null blockName = classic-editor body -> editable ClassicContent wrapper.
  if (blockName === null) return "classic";
  if (occurrence <= 2) return "passthrough";
  if (blockName.startsWith("acf/")) return "visual";
  if (TIER_VISUAL.has(blockName)) return "visual";
  if (TIER_STANDARD.has(blockName)) return "standard";
  if (TIER_TRIVIAL.has(blockName)) return "trivial";
  return "passthrough";
}
```

(c) Export a test seam if `assignTier` is private: add `export function assignTierForTest(blockName: string | null, occurrence: number): Tier { return assignTier(blockName, occurrence); }`.

(d) Update the tier docblock (lines 18-33) so it states `null blockName -> "classic"` (not passthrough).

- [ ] **Step 4: Run — verify pass.** Then run the FULL suite + typecheck to catch any exhaustive `Tier` switch that now needs a `"classic"` arm:

Run: `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`
Expected: typecheck clean. If `pricing.ts` (the only other `Tier` user) switches exhaustively, add a `"classic"` arm mirroring `"passthrough"` (Classic generation is deterministic/$0 — treat it like passthrough for cost). Quote any such change in the commit.

- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/inventory.ts apps/web/lib/jab/inventory.test.ts apps/web/lib/pricing.ts
git commit -m "feat(saas): classic tier for null-named blocks (editable, non-passthrough)"
```

---

## Task 3: `synthClassic` emits the `__null__` blockName

**Files:** Modify `apps/web/lib/jab/compose-block-tree-runtime.ts` + its test

The runtime dispatcher routes by `block.blockName` — a `null` name falls to `<Passthrough>`. Emitting the `"__null__"` sentinel lets the dispatcher route the Classic body to the registered `ClassicContent` instead, while freeform `null` chunks inside Gutenberg pages (which never go through `synthClassic`) stay on the passthrough path.

- [ ] **Step 1: Write the failing test** (add to `compose-block-tree-runtime.test.ts`)

```typescript
// synthClassic is invoked via composeBlockTree when paradigm includes "classic".
// Assert the synthesized body block carries the "__null__" sentinel name.
it("synthesizes the Classic body under the __null__ sentinel", () => {
  const record = { content: { rendered: "<p>hi</p>" }, blocks: [] } as never;
  const out = composeBlockTree(record, "page", ["classic"], { acfFlexFields: [] });
  expect(out).toHaveLength(1);
  expect(out[0].blockName).toBe("__null__");
  expect(out[0].innerHTML).toContain("<p>hi</p>");
});
```

> Note: verify the exact `composeBlockTree` signature + how it triggers `synthClassic` in this file before finalizing the test inputs (the `record`/paradigm shape). Adapt the call to match.

- [ ] **Step 2: Run — verify fail** (currently `blockName` is `null`).
- [ ] **Step 3: Implement** — in `synthClassic`, set `blockName: "__null__"` (was `null`):

```typescript
  return [
    {
      blockName: "__null__",
      attrs: {},
      innerBlocks: [],
      innerHTML: content,
      _key: "classic-0",
    },
  ];
```

> ⚠️ This runtime file is ALSO emitted into generated projects (`compose-site.ts` reads it via `readFileSync` + `rewriteBlockNodeImports`) and must stay self-contained. Use the LITERAL `"__null__"` here (with a comment: `// CLASSIC_BLOCK_NAME — keep literal; this module is emitted standalone`), NOT an import from `@/lib/jab/classic-content`. **Confirm the emitted-runtime / `rewriteBlockNodeImports` constraint before choosing.**

- [ ] **Step 4: Run — verify pass** + full suite (the runtime is widely used). Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/compose-block-tree-runtime.ts apps/web/lib/jab/compose-block-tree-runtime.test.ts
git commit -m "feat(saas): synthClassic emits the __null__ sentinel so the Classic body routes to ClassicContent"
```

---

## Task 4: `generateComponent` emits `ClassicContent` (compiled) for `__null__`

**Files:** Modify `apps/web/lib/ai/component-generator.ts` + its test

Special-case the Classic block BEFORE the generic passthrough short-circuit: return the deterministic `ClassicContent` wrapper with `compileStatus: "ok"` (so it survives the `compile_status === "ok"` filters) and zero token usage (no LLM).

- [ ] **Step 1: Write the failing test** (add to `component-generator.test.ts`)

```typescript
import { generateComponent } from "@/lib/ai/component-generator";

it("emits an editable ClassicContent component for the __null__ block", async () => {
  const result = await generateComponent({
    entry: { blockName: null, tier: "classic", occurrenceCount: 3, pageSlugs: ["about"], attrShapes: [] } as never,
    tokens: null,
  });
  expect(result.blockName).toBe("__null__");
  expect(result.compileStatus).toBe("ok");
  expect(result.tsx).toContain("export function ClassicContent");
  expect(result.tsx).toContain("<Passthrough");
  expect(result.inputTokens).toBe(0);
  expect(result.outputTokens).toBe(0);
});
```

> Adapt the `entry` shape to the real `EnrichedInventoryEntry` (only the fields `generateComponent` reads matter — `blockName`, `tier`).

- [ ] **Step 2: Run — verify fail** (currently returns the skipped passthrough, `compileStatus: "skipped"`, export name `Null`).
- [ ] **Step 3: Implement** — at the top of `generateComponent`, before the existing passthrough short-circuit:

```typescript
import { isClassicBlock, emitClassicContentTsx } from "@/lib/jab/classic-content";
// ...
export async function generateComponent(opts: GenerateComponentOptions): Promise<GeneratedComponent> {
  const { entry } = opts;
  const blockName = entry.blockName ?? "__null__";

  // Classic-editor body -> deterministic editable ClassicContent wrapper.
  // compile_status 'ok' (a known-good template) so it surfaces as an editable
  // unit; no LLM, zero tokens. MUST precede the passthrough branch
  // (entry.blockName === null would otherwise fall through to the skipped stub).
  if (isClassicBlock(entry.blockName)) {
    return {
      blockName,
      tsx: emitClassicContentTsx(),
      compileStatus: "ok",
      compileAttemptCount: 0,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failureKind: null,
    };
  }

  if (entry.tier === "passthrough" || entry.blockName === null) {
    // ...existing skipped-passthrough return unchanged...
  }
```

- [ ] **Step 4: Run — verify pass** + full suite. Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts
git commit -m "feat(saas): generateComponent emits a compiled ClassicContent wrapper for __null__"
```

---

## Task 5: Route `__null__` → `ClassicContent` across all name derivations

**Files:** Modify `apps/web/lib/jab/compose-site-emit.ts` (`toPascalCase`), `apps/web/lib/inngest/functions/compose-site.ts` (`blockNameToPascal`), `apps/web/lib/inngest/functions/persist-generation.ts` (its pascal), `apps/web/lib/draft/bundle.ts` (`draftComponentName`) + `bundle.test.ts`

Each mirrored pascal copy must map the Classic sentinel to `ClassicContent` so the emitted file name, dispatcher import/export, Phase-C copy, and draft source all agree (export name == import name == file name).

- [ ] **Step 1: Write the failing test** (add to `bundle.test.ts`)

```typescript
import { CLASSIC_COMPONENT_NAME } from "@/lib/jab/classic-content";

it("maps the __null__ sentinel to the ClassicContent component name", () => {
  expect(draftComponentName("__null__")).toBe(CLASSIC_COMPONENT_NAME);
});
it("still pascal-cases real block names", () => {
  expect(draftComponentName("acf/hero")).toBe("AcfHero");
});
```

- [ ] **Step 2: Run — verify fail** (`draftComponentName("__null__")` returns `"Null"`).
- [ ] **Step 3: Implement** — add the SAME guard as the first line of each of the 4 pascal functions, importing the constants from `@/lib/jab/classic-content`:

```typescript
import { CLASSIC_BLOCK_NAME, CLASSIC_COMPONENT_NAME } from "@/lib/jab/classic-content";
// inside each pascal fn, first line:
  if (s === CLASSIC_BLOCK_NAME) return CLASSIC_COMPONENT_NAME;
```

Apply to: `compose-site-emit.ts` `toPascalCase` (param `s`), `compose-site.ts` `blockNameToPascal` (param `s`), `persist-generation.ts` pascal (match its param name), `bundle.ts` `draftComponentName` (param `blockName`). Keep the existing "mirrored copy, do not dedupe the algorithm" comments; the guard references shared constants so only the algorithm stays duplicated.

> Verify `persist-generation.ts`'s pascal function name + that it's the Phase-B Storage writer for `builds/{id}/components/{Name}.tsx` before editing. If the draft bundle / emitted runtime can't import `@/lib/jab/classic-content`, inline the literals with a pointer comment (see Task 3's constraint note) — `bundle.ts` is a server module so the import is fine there; confirm per file.

- [ ] **Step 4: Run — verify pass** + `pnpm --filter @jab/web typecheck`. Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/inngest/functions/persist-generation.ts apps/web/lib/draft/bundle.ts apps/web/lib/draft/bundle.test.ts
git commit -m "feat(saas): map __null__ -> ClassicContent across all component-name derivations"
```

---

## Task 6: Dispatcher includes `__null__` and registers `ClassicContent`

**Files:** Modify `apps/web/lib/jab/compose-site-emit.ts` (`emitDispatcherTsx`) + `compose-site-emit.test.ts`

Drop the `__null__` exclusion (it's now a compiled, non-passthrough component). The `toPascalCase` guard (Task 5) makes the import/register resolve to `ClassicContent`.

- [ ] **Step 1: Write the failing test** (add to `compose-site-emit.test.ts`)

```typescript
it("registers ClassicContent for the __null__ block in the dispatcher", () => {
  const src = emitDispatcherTsx([
    { blockName: "__null__", tier: "classic", compileStatus: "ok" },
    { blockName: "acf/hero", tier: "visual", compileStatus: "ok" },
  ]);
  expect(src).toContain('import { ClassicContent } from "./ClassicContent";');
  expect(src).toContain('"__null__": ClassicContent as unknown as ComponentType<BlockProps>,');
  expect(src).toContain("AcfHero");
});
```

- [ ] **Step 2: Run — verify fail** (`__null__` filtered out at line 1200).
- [ ] **Step 3: Implement** — in `emitDispatcherTsx`, remove the `r.blockName !== "__null__"` line from the `usable` filter (keep `r.blockName !== null`, `r.tier !== "passthrough"`, `r.compileStatus === "ok"`). The loop's `toPascalCase(row.blockName)` now yields `ClassicContent` (Task 5 guard) and registers `REGISTRY["__null__"] = ClassicContent`.

> The runtime dispatcher line `const C = block.blockName ? REGISTRY[block.blockName] : undefined` already resolves `"__null__"` (truthy) -> `REGISTRY["__null__"]`. No change needed there — `synthClassic` (Task 3) now produces `"__null__"`.

- [ ] **Step 4: Run — verify pass** + full suite. Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): dispatcher registers ClassicContent for the __null__ block"
```

---

## Task 7: `reduceSiteMap` admits `__null__` (planner sees "Classic content")

**Files:** Modify `apps/web/lib/jab/site-map.ts` + `site-map.test.ts`

- [ ] **Step 1: Write the failing test** (add to `site-map.test.ts`)

```typescript
it("includes the Classic block as an editable unit", () => {
  const map = reduceSiteMap({
    blockRows: [{ block_name: "__null__", tier: "classic", occurrence_count: 4, compile_status: "ok", page_slugs: ["about", "team"] }],
    pageRows: [{ slug: "about", route_path: "/about", post_type: "page" }],
    hasHeader: false,
    hasFooter: false,
  });
  const classic = map.blockTypes.find((b) => b.blockName === "__null__");
  expect(classic).toBeDefined();
  expect(classic!.label).toBe("Classic content");
});
```

- [ ] **Step 2: Run — verify fail** (`block_name !== "__null__"` filter at line 120).
- [ ] **Step 3: Implement** — remove the `r.block_name !== "__null__" &&` line from `reduceSiteMap`'s filter. Keep `core/image`, `tier !== "passthrough"`, `compile_status === "ok"`. Update the explanatory comment (the `__null__` exclusion rationale no longer applies — it's now a real patchable unit).
- [ ] **Step 4: Run — verify pass** + full suite. Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts
git commit -m "feat(saas): planner site-map admits the Classic-content unit"
```

---

## Task 8: Draft artifacts admit `__null__` (editable in the draft)

**Files:** Modify `apps/web/lib/draft/artifacts.ts` + `artifacts.test.ts`

Both unit filters (Phase-1 `usableNames` ~line 62; Phase-2 `usable` ~line 124) currently drop falsy/`__null__` block names. Admit `__null__` so the Classic component is bundled, loadable, and patchable.

- [ ] **Step 1: Write the failing test** (add to `artifacts.test.ts`) — assert the Classic row is included in the usable/override set the builder produces (model on the existing artifacts tests; assert the usable names / `componentSources` include `ClassicContent` when a `__null__` / `compile_status:"ok"` / `tier:"classic"` row is present).
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** — in both filters, ensure the `__null__` row passes. The rows here carry `blockName` from `dispatcherRowsFromInventory` (the DB value `"__null__"`, a truthy string — confirm), so the load-bearing exclusions are `r.blockName !== "core/image" && r.tier !== "passthrough" && r.compileStatus === "ok"`. Remove/adjust any clause that drops `"__null__"` (e.g. a `r.blockName !== "__null__"` or a falsy-guard that the string defeats but the comment implies is meant to exclude it). `draftComponentName("__null__")` -> `ClassicContent` (Task 5) so the Storage path resolves to `components/ClassicContent.tsx`.

> Verify whether `dispatcherRowsFromInventory` yields `blockName: "__null__"` (string) or `null` for the Classic row — that determines whether the `r.blockName &&` truthiness check already passes and exactly which clause to change. Adjust precisely based on the real value.

- [ ] **Step 4: Run — verify pass** + full suite. Expected green.
- [ ] **Step 5: Commit**
```bash
git add apps/web/lib/draft/artifacts.ts apps/web/lib/draft/artifacts.test.ts
git commit -m "feat(saas): draft artifacts admit the Classic-content editable unit"
```

---

## Task 9: End-to-end edit path — `__null__` target validates + patches

**Files:** Modify `apps/web/lib/jab/edit-plan.test.ts` (and a naming cross-check)

The patch flow needs no code change: `validateEditInput` accepts the non-empty target `"__null__"`; `validateEditPlan` accepts it once it's in `siteMap.blockTypes` (Task 7); `exportNameFor("component", "__null__")` = `draftComponentName("__null__")` = `ClassicContent` (Task 5), matching the component's export; the source path resolves to `.../components/ClassicContent.tsx`. This task pins those with tests.

- [ ] **Step 1: Write the test**

```typescript
import { validateEditPlan } from "@/lib/jab/edit-plan";

it("accepts a component edit targeting the Classic block", () => {
  const siteMap = {
    blockTypes: [{ blockName: "__null__", label: "Classic content", tier: "classic", occurrenceCount: 4, pageCount: 2, pageCountIsFloor: false }],
    pageSlugs: ["about"],
    shell: { header: false, footer: false },
  };
  const res = validateEditPlan(
    { needsClarification: false, scope: "component", target: "__null__", action: "Restyle the Classic body", regenerationPrompt: "Constrain to a max-width container", clarifyingQuestion: null } as never,
    siteMap as never,
  );
  expect(res.ok).toBe(true);
});
```

Also add a cross-check (in `draft-edit` or `bundle` test) that `exportNameFor("component", "__null__")` / `draftComponentName("__null__")` === `"ClassicContent"` (the export the wrapper actually declares).

- [ ] **Step 2: Run — verify pass** (no code change expected; if it fails, the gap is real — fix the minimal validation path).
- [ ] **Step 3: Full verification.** `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test` → green.
- [ ] **Step 4: Commit**
```bash
git add apps/web/lib/jab/edit-plan.test.ts
git commit -m "test(saas): pin the Classic-content edit target through plan validation + naming"
```

---

## Task 10: Status docs + residuals

**Files:** Modify the recommendations doc, fleet-gap register (A1), `CLAUDE.md`

- [ ] **Step 1** — Recommendations doc: mark finding #3 ✅ FIXED (link this plan); update the headline tally and recommended-sequence (drop #3, promote #4 multi-viewport to lead).
- [ ] **Step 2** — Fleet-gap register A1: mark resolved (Classic body editable via the `ClassicContent` wrapper); record residuals:
  - **Presentation-only:** Classic *text* stays in WP (source of truth); only the wrapper is editable.
  - Freeform `null` chunks inside Gutenberg pages still render via bare `<Passthrough>` (only the Classic-paradigm body routes to `ClassicContent`).
  - Per-element editing is via Tailwind descendant variants on the wrapper, not a structured editor.
- [ ] **Step 3** — `CLAUDE.md`: status line under the fleet-gap section.
- [ ] **Step 4: Final full verification.** `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test` → green.
- [ ] **Step 5: Commit**
```bash
git add docs/ CLAUDE.md
git commit -m "docs(saas): Classic-editor body editable via ClassicContent wrapper — status + residuals"
```

---

## Self-Review

**1. Spec coverage (recommendation #3 / fleet-gap A1):**
- "segment Classic HTML into addressable units OR expose the passthrough block as an editable unit" → the latter, via `ClassicContent` (Tasks 1, 4, 6). ✓
- Editable end-to-end: inventory tier (2) → synth name (3) → compiled component (4) → naming (5) → dispatcher (6) → planner site-map (7) → draft artifacts (8) → patch path (9). ✓
- Renders correctly deployed AND in draft (dispatcher + artifacts both updated). ✓

**2. Placeholder scan:** every code step has concrete code or an explicit "verify X then adapt" with the exact uncertainty named (emitted-runtime import constraint in T3/T5; `dispatcherRowsFromInventory` value in T8; `persist-generation` fn name in T5; `composeBlockTree` trigger shape in T3). No TBD/TODO — the "verify before finalizing" notes are deliberate de-risking, each naming the precise check.

**3. Type consistency:** `CLASSIC_BLOCK_NAME`/`CLASSIC_COMPONENT_NAME` are the single source for `"__null__"`/`"ClassicContent"` across Tasks 3, 5, 6, 7, 8 — no string drift. `isClassicBlock`/`emitClassicContentTsx` signatures match call sites (T4). `"classic"` added to `Tier` (T2) and handled in `pricing.ts` if exhaustive. `generateComponent`'s returned `GeneratedComponent` shape unchanged (T4 fills all fields). Dispatcher REGISTRY key `"__null__"` matches `synthClassic`'s emitted blockName (T3) and the site-map/artifacts inclusion (T7/T8).

**4. Risk controls:** No migration, no plugin change, no new LLM call, no per-page identity (one shared `ClassicContent`). The 5th-copy naming risk is contained by centralized constants. Freeform `null` chunks are intentionally untouched (only `synthClassic` emits the sentinel). Each filter change removes a now-incorrect `__null__` exclusion, consistent with the planner-inventory-correctness principle (the unit is now genuinely patchable).
