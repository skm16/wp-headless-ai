# Patch Data-Shape Context Implementation Plan (Defect 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Live-Draft patch LLM the block's real data-shape (ACF field inventory) so requests like "show the beer description on hover" bind a real field instead of hallucinating an empty container — while staying efficient (cosmetic edits pay nothing).

**Architecture:** A pure `(guidance, category)` relevance gate runs BEFORE any I/O; on a miss the patch prompt is byte-identical to today. On a hit, the worker reads the already-persisted `projects.manifest`, a pure resolver classifies the block's data source, and a pure builder produces a compact field-inventory section (reusing `summarizeAcfFields`, capped at 30 fields) attached to the patch prompt's USER half. Phase 3a covers direct-ACF blocks; Phase 3b adds the novel relation-target resolution (resolve a related-post field's target CPT and surface ITS fields).

**Tech Stack:** TypeScript, Vitest. New pure modules + two thin wiring edits. No DB migration, no new LLM call, no live WP round-trip (manifest is persisted).

## Global Constraints

- **Efficiency first.** The relevance gate takes ONLY `(guidance, category)` — both known BEFORE any I/O. It MUST NOT depend on the resolved schema (that would make "skip the manifest read on a miss" circular). On a gate miss: no manifest read, no schema extraction, no prompt tokens, byte-identical patch prompt.
- **Compact inventory, not raw JSON Schema.** Reuse `summarizeAcfFields` (`lib/ai/component-generator.ts:692`) — already caps at 30 fields, one terse line each.
- **Fail-soft, honest.** Manifest missing / CPT unresolvable / `extractCptAcfSchema` returns null / a ref lacks `post_type` → attach NO section, proceed with the edit. Never fabricate a field. Mirror the existing `loadBaseThemeClassNames` fail-soft posture.
- **Gate bias:** prefer a few false-positives (attach when not strictly needed) over false-negatives (miss a real data edit). A false-positive costs a few hundred tokens; a false-negative reproduces the bug.
- **Prompt placement:** the data-shape section goes in the patch prompt's USER half (alongside current-source/guidance), NOT the system prefix — the system half is the stable output-contract text.
- **Reuse, don't reinvent:** relation-target by-slug ability derivation MUST mirror `related-posts-runtime.ts:109-111` (`jab/get-<postType>-by-slug`, wrapper = `<postType>` snake) so the prompt describes the SAME record the render path actually merges.

---

## Phase 3a — Direct-ACF data shape (efficient scaffold + direct blocks)

### Task 1: Pure relevance gate

**Files:**
- Create: `apps/web/lib/ai/patch-data-relevance.ts`
- Test: `apps/web/lib/ai/patch-data-relevance.test.ts`

**Interfaces:**
- Produces: `type BlockDataCategory = "direct-cpt" | "relation" | "direct-acf" | "none"` and
  `isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean`. Later tasks consume both by these exact names.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/patch-data-relevance.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isDataRelevantEdit } from "./patch-data-relevance";

describe("isDataRelevantEdit", () => {
  it("returns true when the guidance names a data verb/noun", () => {
    expect(isDataRelevantEdit("show the beer description on hover", "relation")).toBe(true);
    expect(isDataRelevantEdit("add the ABV field", "direct-acf")).toBe(true);
    expect(isDataRelevantEdit("pull the event date", "direct-cpt")).toBe(true);
  });

  it("returns false for a pure cosmetic edit even on a data-bearing block", () => {
    expect(isDataRelevantEdit("make the heading bigger", "relation")).toBe(false);
    expect(isDataRelevantEdit("change the background to teal", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("bolder", "direct-cpt")).toBe(false);
  });

  it("returns false for any edit on a category='none' block", () => {
    expect(isDataRelevantEdit("show the description", "none")).toBe(false);
  });

  it("returns true for a non-trivial edit on a data-bearing block even without a data keyword", () => {
    // A data-bearing block + a non-style instruction → attach (bias to false-positive).
    expect(isDataRelevantEdit("make each card show more info", "relation")).toBe(true);
  });

  it("is case-insensitive on keywords", () => {
    expect(isDataRelevantEdit("Show The Description", "direct-acf")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-relevance.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the gate**

Create `apps/web/lib/ai/patch-data-relevance.ts`:

```typescript
/**
 * patch-data-relevance — pure relevance gate deciding whether a patch edit
 * needs the block's data-shape context. Takes ONLY (guidance, category) — both
 * known before any I/O — so a cosmetic edit skips the manifest read entirely.
 * Biased toward false-positives (attach when unsure) over false-negatives
 * (miss a real data edit): a wasted section costs a few hundred tokens; a miss
 * reproduces the silent-wrong-output bug.
 */
export type BlockDataCategory = "direct-cpt" | "relation" | "direct-acf" | "none";

/** Data-intent keywords/phrases — matched case-insensitively as substrings. */
const DATA_KEYWORDS = [
  "description", "field", "show the", "add the", "pull", "display", "bind",
  "text", "content", "title", "date", "price",
];

/** Pure style verbs — a data-bearing block edit that is ONLY one of these is cosmetic. */
const STYLE_ONLY = [
  "bigger", "smaller", "bolder", "lighter", "color", "colour", "background",
  "padding", "margin", "spacing", "font", "size", "rounded", "shadow", "align",
  "center", "centre", "wider", "narrower", "taller", "shorter",
];

export function isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean {
  if (category === "none") return false;
  const g = guidance.toLowerCase();
  if (DATA_KEYWORDS.some((k) => g.includes(k))) return true;
  // No explicit data keyword. On a data-bearing block, attach UNLESS the edit
  // is purely stylistic (every content word is a style verb).
  const isPureStyle = STYLE_ONLY.some((s) => g.includes(s)) &&
    !DATA_KEYWORDS.some((k) => g.includes(k));
  return !isPureStyle;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-relevance.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/ai/patch-data-relevance.ts lib/ai/patch-data-relevance.test.ts
git commit -m "feat(patch): pure relevance gate for data-shape context"
```

---

### Task 2: Pure block → data-source resolver (3a categories)

**Files:**
- Create: `apps/web/lib/jab/resolve-block-data-source.ts`
- Test: `apps/web/lib/jab/resolve-block-data-source.test.ts`

**Interfaces:**
- Consumes: `findPostRelationFieldsInSample` (`lib/ai/component-generator.ts:844`).
- Produces:
  ```typescript
  export type BlockDataSource =
    | { kind: "direct-cpt"; cptSlug: string }
    | { kind: "relation"; fieldName: string; postType: string }
    | { kind: "direct-acf"; sample: Record<string, unknown> }
    | { kind: "none" };
  export interface BlockInventoryLike {
    blockName: string | null;
    attrSamples: Array<Record<string, unknown>>;
  }
  export function resolveBlockDataSource(entry: BlockInventoryLike): BlockDataSource;
  export function categoryOf(src: BlockDataSource): BlockDataCategory; // maps to the gate's category
  ```
  **IMPORTANT — the CPT slug comes from the `block_name`, NOT a column.** `block_inventory`
  has NO `cpt_slug` column (verified against `lib/db/schema.ts:251-299`; the columns are
  `block_name`, `attr_samples` jsonb, `kind`, `spec`). The CPT slug is encoded in the block
  name: a CPT-template block is named `cpt_template/{cptSlug}` and a flex layout
  `acf_flex/{cptSlug}/{fieldPath}/{layoutName}` (see `content-detection.ts:112,129`). So
  `resolveBlockDataSource` PARSES `blockName` for the `cpt_template/` prefix to get `cptSlug`.
  This is why `BlockInventoryLike` carries only `blockName` + `attrSamples` — no `cptSlug` field.

  Phase 3b extends the `relation` branch; this task ships `direct-cpt`, `direct-acf`, `none` and a `relation` STUB that Task 6 fills. (Define the `relation` shape now so the type is stable; Task 3's builder only handles direct kinds until 3b.)

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/resolve-block-data-source.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveBlockDataSource, categoryOf, type BlockInventoryLike } from "./resolve-block-data-source";

function entry(over: Partial<BlockInventoryLike> = {}): BlockInventoryLike {
  return { blockName: "acf/hero", attrSamples: [{}], ...over };
}

describe("resolveBlockDataSource", () => {
  it("classifies a cpt_template block (cptSlug parsed from block_name) as direct-cpt", () => {
    const src = resolveBlockDataSource(entry({ blockName: "cpt_template/beer", attrSamples: [{}] }));
    expect(src).toEqual({ kind: "direct-cpt", cptSlug: "beer" });
    expect(categoryOf(src)).toBe("direct-cpt");
  });

  it("classifies an acf/* block with its own attrs as direct-acf", () => {
    const sample = { heading: "Our Beers", subtitle: "On tap" };
    const src = resolveBlockDataSource(entry({ blockName: "acf/section", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "direct-acf", sample });
    expect(categoryOf(src)).toBe("direct-acf");
  });

  it("classifies a block carrying a post-relation array as relation", () => {
    const sample = { beers: [{ ID: 1, post_title: "Lil Heaven", post_name: "lil-heaven", post_type: "beer" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf/featured-beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "relation", fieldName: "beers", postType: "beer" });
    expect(categoryOf(src)).toBe("relation");
  });

  it("prefers a relation over direct-acf when a flex layout has both config attrs AND a post-relation array", () => {
    const sample = { headline: "On Tap", beers: [{ ID: 1, post_title: "X", post_name: "x", post_type: "beer" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf_flex/page/page_builder/featured_beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "relation", fieldName: "beers", postType: "beer" });
  });

  it("fail-softs to none when a relation ref lacks post_type", () => {
    // findPostRelationFieldsInSample flags the field, but no post_type on the ref → cannot resolve target.
    const sample = { beers: [{ ID: 1, post_title: "X", post_name: "x" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf/featured-beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "none" });
  });

  it("returns none for a block with no attrs and no cpt", () => {
    expect(resolveBlockDataSource(entry({ blockName: "core/heading", attrSamples: [] }))).toEqual({ kind: "none" });
  });

  it("returns none when blockName is null", () => {
    expect(resolveBlockDataSource(entry({ blockName: null, attrSamples: [] }))).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/resolve-block-data-source.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the resolver**

Create `apps/web/lib/jab/resolve-block-data-source.ts`:

```typescript
import { findPostRelationFieldsInSample } from "@/lib/ai/component-generator";
import type { BlockDataCategory } from "@/lib/ai/patch-data-relevance";

/**
 * resolve-block-data-source — pure classification of a block's data source so
 * the patch prompt can describe the RIGHT field inventory. Order matters:
 * relation (a post-relation array whose refs carry post_type) beats direct-acf,
 * because a Featured-Beer-style block has its own config attrs AND a relation.
 */
export type BlockDataSource =
  | { kind: "direct-cpt"; cptSlug: string }
  | { kind: "relation"; fieldName: string; postType: string }
  | { kind: "direct-acf"; sample: Record<string, unknown> }
  | { kind: "none" };

export interface BlockInventoryLike {
  blockName: string | null;
  attrSamples: Array<Record<string, unknown>>;
}

export function resolveBlockDataSource(entry: BlockInventoryLike): BlockDataSource {
  const blockName = entry.blockName ?? "";

  // 1. cpt_template block → its own CPT schema. The CPT slug is encoded in the
  //    block_name (`cpt_template/{cptSlug}`, content-detection.ts:129) — there
  //    is NO cpt_slug column on block_inventory.
  if (blockName.startsWith("cpt_template/")) {
    const cptSlug = blockName.slice("cpt_template/".length).split("/")[0];
    if (cptSlug) return { kind: "direct-cpt", cptSlug };
  }

  const sample = entry.attrSamples[0];
  if (!sample || typeof sample !== "object") return { kind: "none" };

  // 2. relation — a post-relation array whose refs carry post_type.
  const relationFields = findPostRelationFieldsInSample(sample);
  for (const fieldName of relationFields) {
    const arr = (sample as Record<string, unknown>)[fieldName];
    const first = Array.isArray(arr) ? arr[0] : undefined;
    const postType =
      first && typeof first === "object" && typeof (first as Record<string, unknown>).post_type === "string"
        ? ((first as Record<string, unknown>).post_type as string)
        : null;
    if (postType) return { kind: "relation", fieldName, postType };
    // Field is a relation but the ref has no post_type — cannot resolve target.
    // Fall through to none rather than surface a wrong CPT.
  }
  if (relationFields.length > 0) return { kind: "none" };

  // 3. direct-acf — the block's own attribute fields.
  if (Object.keys(sample).length > 0) return { kind: "direct-acf", sample: sample as Record<string, unknown> };

  return { kind: "none" };
}

export function categoryOf(src: BlockDataSource): BlockDataCategory {
  return src.kind;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/resolve-block-data-source.test.ts`
Expected: All PASS.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors (confirms `findPostRelationFieldsInSample` import + `BlockDataCategory` reuse are correct).

- [ ] **Step 6: Commit**

```bash
cd apps/web
git add lib/jab/resolve-block-data-source.ts lib/jab/resolve-block-data-source.test.ts
git commit -m "feat(patch): pure block data-source resolver (direct-cpt/direct-acf/none + relation shape)"
```

---

### Task 3: Pure data-shape section builder (3a direct kinds)

**Files:**
- Create: `apps/web/lib/ai/patch-data-shape.ts`
- Test: `apps/web/lib/ai/patch-data-shape.test.ts`

**Interfaces:**
- Consumes: `summarizeAcfFields` (`lib/ai/component-generator.ts:692`), `extractCptAcfSchema` (`lib/jab/paradigm-detection.ts:90`), `resolveCptAbilityMeta` (`lib/jab/ability-client.ts:738`), `BlockDataSource` (Task 2), `Manifest` type.
- Produces: `buildDataShapeSection(src: BlockDataSource, manifest: Manifest | null): string` — returns the prompt section, or `""` when nothing can be surfaced (fail-soft). Task 6 (3b) extends it for `relation`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/patch-data-shape.test.ts`. Build a minimal manifest fixture whose `jab/get-beer-by-slug` ability's `outputSchema` exposes an `acf` group with a `description` field (mirror the real shape `extractCptAcfSchema` walks: `properties.<wrapper>.oneOf[].properties.acf`):

```typescript
import { describe, it, expect } from "vitest";
import { buildDataShapeSection } from "./patch-data-shape";
import type { BlockDataSource } from "@/lib/jab/resolve-block-data-source";

const manifest = {
  abilities: [
    {
      name: "jab/get-beer-by-slug",
      outputSchema: {
        properties: {
          beer: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  acf: {
                    properties: {
                      description: { type: "string" },
                      abv: { type: "number" },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  ],
} as unknown as import("@jab/core").Manifest;

describe("buildDataShapeSection — direct kinds", () => {
  it("lists a direct-cpt block's ACF fields", () => {
    const src: BlockDataSource = { kind: "direct-cpt", cptSlug: "beer" };
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("description");
    expect(out).toContain("abv");
    expect(out.toLowerCase()).toContain("data shape");
  });

  it("lists a direct-acf block's own attr fields", () => {
    const src: BlockDataSource = { kind: "direct-acf", sample: { heading: "Our Beers", subtitle: "On tap" } };
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("heading");
    expect(out).toContain("subtitle");
  });

  it("returns empty string for kind=none", () => {
    expect(buildDataShapeSection({ kind: "none" }, manifest)).toBe("");
  });

  it("fail-softs to empty string when the CPT schema is not in the manifest", () => {
    const src: BlockDataSource = { kind: "direct-cpt", cptSlug: "nonexistent" };
    expect(buildDataShapeSection(src, manifest)).toBe("");
  });

  it("fail-softs to empty string when manifest is null", () => {
    expect(buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, null)).toBe("");
  });
});
```

Confirm the real `Manifest` import path before finalizing (grep `export type Manifest` / `export interface Manifest`); adjust the `import(...)` path if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the builder (direct kinds)**

Create `apps/web/lib/ai/patch-data-shape.ts`:

```typescript
import type { Manifest } from "@jab/core";
import type { BlockDataSource } from "@/lib/jab/resolve-block-data-source";
import { summarizeAcfFields } from "./component-generator";
import { extractCptAcfSchema } from "@/lib/jab/paradigm-detection";
import { resolveCptAbilityMeta } from "@/lib/jab/ability-client";

/**
 * patch-data-shape — pure builder turning a resolved BlockDataSource + the
 * persisted manifest into a compact "## Runtime data shape" prompt section.
 * Fail-soft: returns "" whenever the fields can't be surfaced (no manifest,
 * unknown CPT, empty schema) — the patch proceeds without the section rather
 * than fabricating fields. Reuses summarizeAcfFields (capped at 30 fields).
 */
export function buildDataShapeSection(src: BlockDataSource, manifest: Manifest | null): string {
  if (src.kind === "none") return "";

  if (src.kind === "direct-acf") {
    const lines = Object.keys(src.sample)
      .filter((k) => k !== "acf_fc_layout")
      .slice(0, 30)
      .map((k) => `- ${k}`);
    if (lines.length === 0) return "";
    return `\n\n## Runtime data shape\nThis block's own fields (bind these directly):\n${lines.join("\n")}`;
  }

  if (src.kind === "direct-cpt") {
    const meta = resolveCptAbilityMeta(manifest, { slug: src.cptSlug, rest_base: src.cptSlug });
    const schema = extractCptAcfSchema(manifest, {
      bySlugAbilityName: meta.bySlugAbilityName,
      bySlugWrapperKey: meta.bySlugWrapperKey,
    });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Runtime data shape\nThis component renders a "${src.cptSlug}" record. Bind these ACF fields (nested under \`.acf\`):\n${summary}`;
  }

  // relation — filled in Phase 3b (Task 6). Until then, no section.
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/ai/patch-data-shape.ts lib/ai/patch-data-shape.test.ts
git commit -m "feat(patch): data-shape section builder for direct-cpt/direct-acf blocks"
```

---

### Task 4: Thread `dataShape` through `patchUnitSource` / `buildPatchPrompt`

**Files:**
- Modify: `apps/web/lib/ai/patch-component.ts` (`PatchPromptInput` :25-40; `buildPatchPrompt` :72-95; `PatchUnitOptions` :101-130; `patchUnitSource` prompt build)
- Test: `apps/web/lib/ai/patch-component.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PatchPromptInput.dataShape?: string` and `PatchUnitOptions.dataShape?: string`. `buildPatchPrompt` renders it in the USER half. Absent → byte-identical to today.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/patch-component.test.ts` (find the existing `buildPatchPrompt` tests to match style):

```typescript
describe("buildPatchPrompt — dataShape", () => {
  const base = { currentTsx: "export function Foo(){return null;}", guidance: "show the description", exportName: "Foo" };

  it("renders the dataShape section in the USER half when present", () => {
    const { user, system } = buildPatchPrompt({ ...base, dataShape: "\n\n## Runtime data shape\n- description: string" });
    expect(user).toContain("## Runtime data shape");
    expect(user).toContain("description: string");
    expect(system).not.toContain("Runtime data shape");
  });

  it("is byte-identical to no-dataShape when dataShape is absent", () => {
    const without = buildPatchPrompt(base);
    const withUndef = buildPatchPrompt({ ...base, dataShape: undefined });
    expect(withUndef.user).toBe(without.user);
    expect(withUndef.system).toBe(without.system);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/patch-component.test.ts -t "dataShape"`
Expected: FAIL — `PatchPromptInput` has no `dataShape`; the section isn't rendered.

- [ ] **Step 3: Add the field + render it**

In `apps/web/lib/ai/patch-component.ts`, add to `PatchPromptInput` (after `sourceHosts`, ~line 39):

```typescript
  /**
   * Compact data-shape section (from buildDataShapeSection). Rendered in the
   * USER half so the LLM can bind real fields. Absent → byte-identical prompt.
   */
  dataShape?: string;
```

In `buildPatchPrompt`, append `dataShape` to the USER half (change the `user` template, ~line 89-93):

```typescript
  const dataShapeSection = input.dataShape ?? "";
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}${dataShapeSection}`;
```

Add to `PatchUnitOptions` (after `routePathMap`, ~line 129):

```typescript
  /** Compact data-shape section threaded to the patch prompt (buildDataShapeSection). */
  dataShape?: string;
```

In `patchUnitSource`, pass it through to `buildPatchPrompt` (in the `buildPatchPrompt({...})` call at line 133):

```typescript
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    themeClassNames: opts.themeClassNames,
    tokens: opts.tokens,
    sourceHosts: opts.sourceHosts,
    dataShape: opts.dataShape,
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/patch-component.test.ts`
Expected: All PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx tsc --noEmit` → no errors.

```bash
cd apps/web
git add lib/ai/patch-component.ts lib/ai/patch-component.test.ts
git commit -m "feat(patch): accept and render an optional dataShape section"
```

---

### Task 5: Wire the gate + builder into the draft-edit worker (3a end-to-end)

**Files:**
- Modify: `apps/web/lib/inngest/functions/draft-edit.ts` (the `patch-unit` step, :281-315)
- Test: this is worker I/O wiring — covered by the pure-unit tests plus a typecheck + full-suite. No new worker unit test unless the file already has a test harness for the step (check `draft-edit.test.ts`; if it mocks `patchUnitSource`, add an assertion that `dataShape` is passed when the gate hits — otherwise the pure units are the coverage and this task is wiring + typecheck).

**Interfaces:**
- Consumes: `isDataRelevantEdit`, `resolveBlockDataSource`, `categoryOf`, `buildDataShapeSection`, and a manifest read.
- Produces: `patchUnitSource(...)` now receives `dataShape` when the gate hits and the block resolves; otherwise `dataShape` is undefined (byte-identical path).

- [ ] **Step 1: Read the current patch-unit step + how the block inventory / manifest are reachable**

Read `apps/web/lib/inngest/functions/draft-edit.ts:255-315` (the `load-current-source` and `patch-unit` steps). Determine: (a) how to load the target block's `block_inventory` row for `draft.base_build_id` — select `block_name` + `attr_samples` WHERE `site_build_id = draft.base_build_id AND block_name = target` (the `block_inventory_build_block_name_idx` unique index on `(site_build_id, block_name)` makes this a single-row lookup; `attr_samples` is a jsonb array — map it to `BlockInventoryLike.attrSamples`). **There is NO `cpt_slug` column** — `resolveBlockDataSource` derives the CPT slug from `block_name`, so the loader only needs `block_name` + `attr_samples`. (b) how to load `projects.manifest` — a single-column select on `projects` WHERE `id = projectId`. Check `loadBaseThemeClassNames` (referenced at :282) for the admin-client query pattern to mirror.

- [ ] **Step 2: Write the failing test (only if draft-edit.test.ts already mocks patchUnitSource)**

If `draft-edit.test.ts` has a harness that invokes the `patch-unit` step with a mocked `patchUnitSource`, add a test asserting that for a data-relevant guidance on a relation/direct-acf block, `patchUnitSource` is called with a non-empty `dataShape`, and for a cosmetic guidance it is called with `dataShape` undefined. If NO such harness exists, SKIP this step (documented: the pure units carry the logic coverage; this task's gate is typecheck + full-suite green) and note it in the commit body.

- [ ] **Step 3: Implement the wiring**

In the `patch-unit` step of `draft-edit.ts`, BEFORE calling `patchUnitSource`, run the gate and (on a hit) build the section. Insert after `const base = await loadBaseThemeClassNames(...)`:

```typescript
      // Data-shape context (Defect 3) — gate FIRST (pure, no I/O); only on a
      // hit do we read the manifest + resolve the block's data source. Cosmetic
      // edits skip all of this and get a byte-identical prompt.
      let dataShape: string | undefined;
      if (scope === "component") {
        const blockEntry = await loadBlockInventoryEntry(admin, draft.base_build_id, target);
        if (blockEntry) {
          const src = resolveBlockDataSource(blockEntry);
          if (isDataRelevantEdit(guidance, categoryOf(src))) {
            const manifest = await loadProjectManifest(admin, projectId);
            const section = buildDataShapeSection(src, manifest);
            if (section) dataShape = section;
          }
        }
      }
```

Pass `dataShape` into the `patchUnitSource({...})` call (add `dataShape,` to the options object).

Add the two small loaders (near `loadBaseThemeClassNames`, or in a helpers module if that's the file's pattern) — `loadBlockInventoryEntry` selects the block's `attr_samples` + `cpt_slug` (adapt column names to what Step 1's grep found; return a `BlockInventoryLike`), and `loadProjectManifest` selects `projects.manifest`. Both fail-soft (return null on error). Import `isDataRelevantEdit`, `resolveBlockDataSource`, `categoryOf`, `buildDataShapeSection`, `BlockInventoryLike` at the top.

**Fail-soft discipline:** every new read here must be wrapped so an error returns null / undefined `dataShape` — a data-shape failure must NEVER fail the edit (the whole feature is additive). If `loadBlockInventoryEntry` or `loadProjectManifest` throws, log a warning and proceed with `dataShape` undefined.

- [ ] **Step 4: Verify**

Run: `cd apps/web && npx tsc --noEmit` → no errors.
Run: `cd apps/web && npx vitest run lib/inngest/functions/draft-edit.test.ts` → all pass.
Run: `cd apps/web && npx vitest run` → full suite green.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/inngest/functions/draft-edit.ts
# plus draft-edit.test.ts if Step 2 added a test, plus any helpers module touched
git add -A
git commit -m "feat(patch): wire data-shape gate + builder into the draft-edit worker (3a)"
```

---

## Phase 3b — Relation-target data shape (the reported bug)

### Task 6: Relation-target resolution + section builder

**Files:**
- Modify: `apps/web/lib/ai/patch-data-shape.ts` (the `relation` branch of `buildDataShapeSection`)
- Test: `apps/web/lib/ai/patch-data-shape.test.ts`

**Interfaces:**
- Consumes: `resolveCptAbilityMeta`, `extractCptAcfSchema`, `summarizeAcfFields`, the `relation` `BlockDataSource` (Task 2).
- Produces: `buildDataShapeSection` now returns a relation section for `{ kind: "relation"; fieldName; postType }` describing the merged-at-render record shape + `item.acf.<field>` nesting.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/patch-data-shape.test.ts` (reuse the `manifest` fixture — its `jab/get-beer-by-slug` already exposes `description`/`abv`):

```typescript
describe("buildDataShapeSection — relation (3b)", () => {
  it("surfaces the TARGET CPT's fields for a relation source with the item.acf nesting", () => {
    const src = { kind: "relation", fieldName: "beers", postType: "beer" } as const;
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("description");         // the target CPT's field, not just featured_image
    expect(out).toContain("abv");
    expect(out).toContain("beers");               // names the relation field
    expect(out).toContain("item.acf");            // states the correct nesting
    expect(out.toLowerCase()).toContain("hydrated at render");
  });

  it("fail-softs to empty when the target CPT is not in the manifest", () => {
    const src = { kind: "relation", fieldName: "widgets", postType: "widget" } as const;
    expect(buildDataShapeSection(src, manifest)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts -t "relation (3b)"`
Expected: FAIL — the `relation` branch returns `""` today.

- [ ] **Step 3: Implement the relation branch**

In `apps/web/lib/ai/patch-data-shape.ts`, replace the `// relation — filled in Phase 3b` return with:

```typescript
  if (src.kind === "relation") {
    // Derive the target CPT's by-slug ability the SAME way the render path does
    // (related-posts-runtime.ts:109-111): post_type === slug === rest_base for a
    // standard CPT. Surface the TARGET record's fields — the render merges the
    // full record onto each ref ({ ...ref, ...record }), so they live at item.acf.*.
    const meta = resolveCptAbilityMeta(manifest, { slug: src.postType, rest_base: src.postType });
    const schema = extractCptAcfSchema(manifest, {
      bySlugAbilityName: meta.bySlugAbilityName,
      bySlugWrapperKey: meta.bySlugWrapperKey,
    });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Related-post fields (hydrated at render)\nThe \`${src.fieldName}\` array holds related "${src.postType}" posts. At render each item is hydrated with the FULL record (\`{ ...ref, ...record }\`), so besides \`post_title\`/\`post_name\`/\`featured_image\` each item exposes these ACF fields under \`item.acf\`:\n${summary}\nBind them as \`item.acf.<field>\` (e.g. \`item.acf.description\`). Guard for missing values. Do NOT invent a placeholder container for data you cannot find here.`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts`
Expected: All PASS (3a + 3b).

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/ai/patch-data-shape.ts lib/ai/patch-data-shape.test.ts
git commit -m "feat(patch): surface a relation field's target-CPT fields (3b — beer.description fix)"
```

---

### Task 7: Full-suite verification + manual-validation note

**Files:** none modified.

- [ ] **Step 1: Full suite**

Run: `cd apps/web && npx vitest run`
Expected: all pass.

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Confirm the efficiency invariant with a targeted grep**

Run: `cd apps/web && grep -n "loadProjectManifest\|loadBlockInventoryEntry" lib/inngest/functions/draft-edit.ts`
Expected: both reads are INSIDE the `isDataRelevantEdit(...)` gate branch — never called on a cosmetic edit. Confirm by reading the surrounding lines: the manifest read must be gated behind the relevance check, not run unconditionally.

- [ ] **Step 4: Record the manual-validation requirement**

This feature's real proof is a live run (no live-LLM unit test exists). Document for the operator (in the PR/commit body or the runbook): against the Two Roads Featured Beer block, a chat edit "show the beer description on hover" must now bind `item.acf.description` (a real field) and NOT emit an empty black-box container; a cosmetic edit ("make the heading bigger") must produce a byte-identical prompt (no data section — confirmable via a `[patch]`-tier log or by diffing token counts). This is the acceptance test the unit suite cannot cover.
