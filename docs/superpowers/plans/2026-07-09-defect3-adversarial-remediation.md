# Defect 3 Adversarial Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. TDD, checkbox steps.

**Goal:** Fix the confirmed adversarial findings against the Defect 3 data-shape feature — the miscalibrated relevance gate (reproduces the original bug on real data edits), the fail-soft hole on malformed manifests, the array-sample leak, and the wrapper-key mismatch between the prompt and the render path.

**Context:** The feature landed (commits e66dd26…relation 3b). Three adversaries ALL broke it (`holdsUp:false`). This plan fixes the real defects. Every fix is TDD with a test that reproduces the adversary's exact repro, then the fix.

## Global Constraints

- Gate redesign decision (2026-07-09): on a data-bearing category, ATTACH by default; skip ONLY clearly-cosmetic edits. A style word must NEVER suppress a data edit. Use WORD-BOUNDARY matching, not substring (kill "color" ∈ "discoloration", "date" ∈ "update").
- Fail-soft is a hard contract: `buildDataShapeSection` must return `""` (never throw) for ANY manifest shape, including `{}`, `{abilities: null}`, `{abilities: 42}`.
- The 3b relation section must describe the SAME record the render path actually merges — derive the wrapper the way `related-posts-runtime.ts` does (pure `snake(post_type)`), NOT via the manifest's custom key, so the prompt never claims fields the render can't bind.
- Every fix keeps the full suite + `tsc --noEmit` green.

---

### Task 1: Redesign the relevance gate (attach-by-default, word-boundary, no style-suppression)

**Files:**
- Modify: `apps/web/lib/ai/patch-data-relevance.ts` (whole `isDataRelevantEdit` + the keyword lists)
- Test: `apps/web/lib/ai/patch-data-relevance.test.ts`

**Interfaces:**
- Produces: `isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean` — SAME signature. New semantics: `none` → false; any data-bearing category → true UNLESS the guidance is unambiguously pure-cosmetic (matches a clear-cosmetic phrase AND names no field-ish token).

- [ ] **Step 1: Write the failing tests (the adversaries' exact repros)**

REPLACE the existing `describe("isDataRelevantEdit", ...)` block in `apps/web/lib/ai/patch-data-relevance.test.ts` with this expanded suite (it encodes the false-negative repros that MUST now pass, plus the clear-cosmetic cases that must still skip):

```typescript
import { describe, it, expect } from "vitest";
import { isDataRelevantEdit } from "./patch-data-relevance";

describe("isDataRelevantEdit", () => {
  it("returns false for category=none regardless of guidance", () => {
    expect(isDataRelevantEdit("show the description", "none")).toBe(false);
    expect(isDataRelevantEdit("make it bigger", "none")).toBe(false);
  });

  // ── FALSE-NEGATIVE repros from the adversarial review — these MUST attach now ──
  it("attaches for a data edit that also contains a style verb", () => {
    // 'bigger'/'center'/'align' must NOT suppress a genuine data edit.
    expect(isDataRelevantEdit("make the ABV bigger", "relation")).toBe(true);
    expect(isDataRelevantEdit("center the tasting notes", "relation")).toBe(true);
    expect(isDataRelevantEdit("align the ABV to the right", "relation")).toBe(true);
    expect(isDataRelevantEdit("put the IBU in a rounded badge", "relation")).toBe(true);
  });

  it("attaches for a data edit whose field name collides with a style-word substring", () => {
    // 'color' is a real field on many CPTs; word-boundary must not treat it as cosmetic-only.
    expect(isDataRelevantEdit("show beer color", "relation")).toBe(true);
    expect(isDataRelevantEdit("render the beer's color and clarity", "relation")).toBe(true);
    expect(isDataRelevantEdit("surface the discoloration warning", "direct-cpt")).toBe(true);
  });

  it("attaches for neutral non-cosmetic edits on a data-bearing block", () => {
    expect(isDataRelevantEdit("make each card show more info", "relation")).toBe(true);
    expect(isDataRelevantEdit("add a bigger hover box with the rating", "relation")).toBe(true);
  });

  // ── Clear-cosmetic edits that should STILL skip (no field-ish token, pure styling) ──
  it("skips a clearly-cosmetic edit that names no field", () => {
    expect(isDataRelevantEdit("make the heading bigger", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("change the background to teal", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("bolder", "direct-cpt")).toBe(false);
    expect(isDataRelevantEdit("increase the padding", "relation")).toBe(false);
    expect(isDataRelevantEdit("round the corners", "relation")).toBe(false);
  });

  // ── Substring false-positives from the review — must NOT trip on these ──
  it("does not trip on style words that merely contain a data-keyword substring", () => {
    expect(isDataRelevantEdit("update the layout spacing", "direct-cpt")).toBe(false); // 'date' ∈ 'update'
    expect(isDataRelevantEdit("make the texture lighter", "direct-acf")).toBe(false);  // 'text' ∈ 'texture'
  });

  it("is case-insensitive", () => {
    expect(isDataRelevantEdit("Show The Description", "direct-acf")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-relevance.test.ts`
Expected: FAIL — the false-negative repros currently return false ("make the ABV bigger" → false today), and the substring cases currently return true.

- [ ] **Step 3: Reimplement the gate**

REPLACE the body of `apps/web/lib/ai/patch-data-relevance.ts` (keep the `BlockDataCategory` export) with an attach-by-default, word-boundary design:

```typescript
/**
 * patch-data-relevance — pure relevance gate. On a data-bearing block, ATTACH
 * the data-shape section by default; skip ONLY a clearly-cosmetic edit that
 * names no field-ish token. A style word NEVER suppresses a data edit
 * ("make the ABV bigger" attaches) — the spec's stated bias is toward
 * false-positives (a wasted capped section) over false-negatives (a missing
 * section reproduces the silent-wrong-output bug). Word-boundary matching, not
 * substring, so "color" ∈ "discoloration" and "date" ∈ "update" don't fire.
 */
export type BlockDataCategory = "direct-cpt" | "relation" | "direct-acf" | "none";

/**
 * Clear-cosmetic verbs/nouns. An edit is skipped ONLY when it (a) matches at
 * least one of these AND (b) is SHORT (a pure-styling instruction, not a
 * sentence that also references content). Word-boundary matched.
 */
const COSMETIC_WORDS = [
  "bigger", "smaller", "bold", "bolder", "lighter", "color", "colour",
  "background", "padding", "margin", "spacing", "font", "rounded", "round",
  "corners", "shadow", "wider", "narrower", "taller", "shorter", "opacity",
  "border", "teal", "red", "blue", "green",
];

/** Field-ish tokens that force ATTACH even alongside a cosmetic word. */
const DATA_WORDS = [
  "description", "field", "content", "title", "price", "abv", "ibu", "rating",
  "notes", "blurb", "excerpt", "date", "author", "location", "info", "details",
  "color", "clarity", "varietal", "sku", "brewery", "value", "values",
];

function hasWholeWord(haystack: string, word: string): boolean {
  // Word-boundary match: the word must be delimited by non-word chars.
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`, "i").test(haystack);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isDataRelevantEdit(guidance: string, category: BlockDataCategory): boolean {
  if (category === "none") return false;
  const g = guidance.toLowerCase();

  // A field-ish token forces attach, even with a cosmetic word present
  // ("make the ABV bigger", "show beer color").
  if (DATA_WORDS.some((w) => hasWholeWord(g, w))) return true;

  // No field token. Skip ONLY when the edit is short AND every meaningful word
  // is cosmetic — a pure-styling instruction like "make the heading bigger" or
  // "round the corners". Otherwise attach (bias to false-positive).
  const words = g.split(/[^a-z0-9]+/).filter(Boolean);
  const contentWords = words.filter((w) => !STOP_WORDS.has(w));
  const anyCosmetic = COSMETIC_WORDS.some((w) => hasWholeWord(g, w));
  const allContentCosmetic =
    contentWords.length > 0 &&
    contentWords.every((w) => COSMETIC_WORDS.includes(w) || STYLE_QUALIFIERS.has(w));
  if (anyCosmetic && allContentCosmetic) return false;

  // Neutral / ambiguous edit on a data-bearing block → attach.
  return true;
}

/** Function/filler words ignored when deciding "is every content word cosmetic". */
const STOP_WORDS = new Set([
  "make", "the", "a", "an", "it", "to", "and", "of", "on", "in", "is", "be",
  "this", "that", "please", "change", "set", "give", "more", "less", "little",
  "bit", "up", "down", "its",
]);
/** Cosmetic intensifiers/directions that count as styling, not content. */
const STYLE_QUALIFIERS = new Set([
  "left", "right", "top", "bottom", "middle", "sticky", "fixed", "flat",
  "increase", "decrease", "reduce", "add", "remove",
]);
```

Notes for the implementer: the two `Set`s referenced before their `const` declaration are hoisted (they're `const` in module scope, evaluated before `isDataRelevantEdit` is ever called — module-eval order makes them defined at call time). If your linter objects to use-before-declaration, move the two `Set` declarations and `hasWholeWord`/`escapeRe` ABOVE `isDataRelevantEdit`. Tune `COSMETIC_WORDS`/`DATA_WORDS` only as needed to make ALL Step-1 tests pass — do not remove any test case.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-relevance.test.ts`
Expected: All PASS. If a case fails, adjust the word lists (NOT the tests) until green — the tests encode the required behavior from the adversarial review.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx tsc --noEmit` → clean.

```bash
cd apps/web
git add lib/ai/patch-data-relevance.ts lib/ai/patch-data-relevance.test.ts
git commit -m "fix(patch): recalibrate data-relevance gate — attach-by-default, word-boundary, no style-suppression"
```

---

### Task 2: Fail-soft `buildDataShapeSection` against malformed manifests

**Files:**
- Modify: `apps/web/lib/ai/patch-data-shape.ts` (`buildDataShapeSection`)
- Test: `apps/web/lib/ai/patch-data-shape.test.ts`

**Interfaces:**
- Produces: `buildDataShapeSection` returns `""` (never throws) for any manifest shape.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/patch-data-shape.test.ts`:

```typescript
describe("buildDataShapeSection — fail-soft on malformed manifest", () => {
  const cases = [
    ["empty object", {}],
    ["abilities null", { abilities: null }],
    ["abilities non-array", { abilities: 42 }],
    ["abilities string", { abilities: "nope" }],
  ] as const;
  for (const [label, m] of cases) {
    it(`returns "" (no throw) for a ${label} manifest — direct-cpt`, () => {
      expect(() => buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, m as never)).not.toThrow();
      expect(buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, m as never)).toBe("");
    });
    it(`returns "" (no throw) for a ${label} manifest — relation`, () => {
      expect(() => buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, m as never)).not.toThrow();
      expect(buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, m as never)).toBe("");
    });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts -t "fail-soft on malformed"`
Expected: FAIL — throws `TypeError: manifest.abilities.find is not a function` (the adversary's repro).

- [ ] **Step 3: Add a manifest-shape guard**

In `apps/web/lib/ai/patch-data-shape.ts`, add a guard at the TOP of `buildDataShapeSection` (after the `none` check) that normalizes a structurally-invalid manifest to `null` before it reaches `resolveCptAbilityMeta`/`extractCptAcfSchema`:

```typescript
export function buildDataShapeSection(src: BlockDataSource, manifest: Manifest | null): string {
  if (src.kind === "none") return "";

  // Fail-soft: a truthy-but-malformed persisted manifest (legacy/partial write:
  // {}, { abilities: null }, non-array abilities) would make resolveCptAbilityMeta
  // / extractCptAcfSchema throw on `.abilities.find`. Normalize to null so those
  // helpers take their documented `if (!manifest)` fail-soft path.
  const safeManifest =
    manifest && Array.isArray((manifest as { abilities?: unknown }).abilities) ? manifest : null;

  if (src.kind === "direct-acf") {
    // (unchanged — direct-acf never touches the manifest)
    const lines = Object.keys(src.sample)
      .filter((k) => k !== "acf_fc_layout")
      .slice(0, 30)
      .map((k) => `- ${k}`);
    if (lines.length === 0) return "";
    return `\n\n## Runtime data shape\nThis block's own fields (bind these directly):\n${lines.join("\n")}`;
  }
```

Then replace BOTH remaining uses of `manifest` (in the `direct-cpt` and `relation` branches) with `safeManifest`. (Both `resolveCptAbilityMeta(safeManifest, ...)` and `extractCptAcfSchema(safeManifest, ...)`.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts`
Expected: All PASS (new fail-soft cases + the pre-existing direct/relation tests).

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/ai/patch-data-shape.ts lib/ai/patch-data-shape.test.ts
git commit -m "fix(patch): fail-soft buildDataShapeSection on a malformed persisted manifest"
```

---

### Task 3: Reject array samples in the resolver

**Files:**
- Modify: `apps/web/lib/jab/resolve-block-data-source.ts` (`resolveBlockDataSource`)
- Test: `apps/web/lib/jab/resolve-block-data-source.test.ts`

**Interfaces:**
- Produces: `resolveBlockDataSource` returns `{ kind: "none" }` when the first attr sample is an array (not a plain object).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/resolve-block-data-source.test.ts`:

```typescript
it("returns none when the first attr sample is an array (not a plain object)", () => {
  const src = resolveBlockDataSource(entry({
    blockName: "acf/weird",
    attrSamples: [[{ ID: 1, post_title: "x", post_name: "x", post_type: "beer" }] as unknown as Record<string, unknown>],
  }));
  expect(src).toEqual({ kind: "none" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run lib/jab/resolve-block-data-source.test.ts -t "array"`
Expected: FAIL — today it falls through to `direct-acf` with the array as `sample` (the adversary's `- 0` garbage-lines repro).

- [ ] **Step 3: Add the array guard**

In `apps/web/lib/jab/resolve-block-data-source.ts`, change the sample guard (currently `if (!sample || typeof sample !== "object") return { kind: "none" };`) to also reject arrays:

```typescript
  const sample = entry.attrSamples[0];
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return { kind: "none" };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && npx vitest run lib/jab/resolve-block-data-source.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/jab/resolve-block-data-source.ts lib/jab/resolve-block-data-source.test.ts
git commit -m "fix(patch): resolver rejects array attr-samples (no garbage field lines)"
```

---

### Task 4: Make the 3b relation wrapper derivation match the render path

**Files:**
- Modify: `apps/web/lib/ai/patch-data-shape.ts` (the `relation` branch)
- Test: `apps/web/lib/ai/patch-data-shape.test.ts`

**Interfaces:**
- Produces: the `relation` branch derives the target CPT's by-slug ability name + wrapper key the SAME pure way `related-posts-runtime.ts` does (`jab/get-<snake(postType)>-by-slug`, wrapper `snake(postType)`), NOT via the manifest's custom `required[0]` key — so the section never claims fields the render can't bind.

- [ ] **Step 1: Read the render derivation to mirror it exactly**

Read `apps/web/lib/jab/related-posts-runtime.ts:107-111` — confirm the exact ability-name + wrapper derivation (`jab/get-${postType.toLowerCase().replace(/[\s_]+/g,"-")}-by-slug`, wrapper `postType.toLowerCase().replace(/[\s-]+/g,"_")`). The relation section must extract the CPT ACF schema using THIS wrapper key, not `resolveCptAbilityMeta`'s manifest-preferred key.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/lib/ai/patch-data-shape.test.ts` — a manifest whose beer by-slug ability declares a CUSTOM wrapper key (`beer_item`) that differs from `snake(post_type)` (`beer`). The section must key off `beer` (what the render uses) and therefore find NO acf under the wrong key → return `""` (honest: the render can't bind these either), rather than confidently emitting fields the render never merges:

```typescript
describe("buildDataShapeSection — relation wrapper matches the render path", () => {
  it("derives the wrapper as snake(postType) like the render, not the manifest custom key", () => {
    // Manifest keys the beer record under a CUSTOM wrapper 'beer_item'; the render
    // path reads resp['beer'] (snake postType). The section MUST match the render:
    // since the acf lives under 'beer_item' but the render reads 'beer', the honest
    // output is "" (no false "these fields are available" claim).
    const customManifest = {
      abilities: [
        {
          name: "jab/get-beer-by-slug",
          outputSchema: {
            // `required: ["beer_item"]` is what makes resolveCptAbilityMeta PREFER
            // the custom wrapper key (abilityWrapperKeyFromSchema reads required[0],
            // NOT properties — ability-client.ts:720-729). Without it the fixture
            // falls back to the snake(postType) derivation and passes vacuously,
            // reproducing NOTHING. This line is load-bearing for the repro.
            required: ["beer_item"],
            properties: {
              beer_item: {
                oneOf: [
                  { type: "null" },
                  { type: "object", properties: { acf: { properties: { description: { type: "string" } } } } },
                ],
              },
            },
          },
        },
      ],
    } as unknown as import("@jab/core").Manifest;
    const out = buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, customManifest);
    expect(out).toBe("");
  });

  it("still surfaces fields for the standard case where the wrapper IS snake(postType)", () => {
    // Uses the existing top-of-file `manifest` fixture keyed under 'beer'.
    const out = buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, manifest);
    expect(out).toContain("description");
    expect(out).toContain("item.acf");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts -t "wrapper matches the render"`
Expected: FAIL — the custom-wrapper case currently returns a non-empty section (resolveCptAbilityMeta prefers `beer_item`, extractCptAcfSchema finds the acf, so it emits fields the render can't bind).

- [ ] **Step 4: Fix the relation branch to derive the wrapper like the render**

In the `relation` branch of `buildDataShapeSection`, replace the `resolveCptAbilityMeta(...)` derivation with the SAME pure derivation the render uses (do NOT consult the manifest's custom key):

```typescript
  if (src.kind === "relation") {
    // Derive the target CPT's by-slug ability + wrapper the EXACT way the render
    // path does (related-posts-runtime.ts:109-111) — pure snake/kebab of the
    // post_type, NOT the manifest's custom required[0] key. If a site uses a
    // custom wrapper key the render itself can't hydrate under, this correctly
    // yields no section instead of claiming fields the render never merges.
    const bySlugAbilityName = `jab/get-${src.postType.toLowerCase().replace(/[\s_]+/g, "-")}-by-slug`;
    const bySlugWrapperKey = src.postType.toLowerCase().replace(/[\s-]+/g, "_");
    const schema = extractCptAcfSchema(safeManifest, { bySlugAbilityName, bySlugWrapperKey });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Related-post fields (hydrated at render)\nThe \`${src.fieldName}\` array holds related "${src.postType}" posts. At render each item is hydrated with the FULL record (\`{ ...ref, ...record }\`), so besides \`post_title\`/\`post_name\`/\`featured_image\` each item exposes these ACF fields under \`item.acf\`:\n${summary}\nBind them as \`item.acf.<field>\` (e.g. \`item.acf.description\`). Guard for missing values. Do NOT invent a placeholder container for data you cannot find here.`;
  }
```

Note: `extractCptAcfSchema` looks up the ability by `bySlugAbilityName` and reads `properties[bySlugWrapperKey]` — so with `bySlugWrapperKey = "beer"` on the custom manifest (keyed `beer_item`), `properties["beer"]` is undefined → returns null → `summarizeAcfFields(null)` → `""`. Confirm this trace when the test runs.

The `direct-cpt` branch can KEEP `resolveCptAbilityMeta` (a cpt_template block IS rendered by the app's own emitted template, which uses the resolved wrapper — the render-mismatch only affects the related-posts runtime). Do not change direct-cpt.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run lib/ai/patch-data-shape.test.ts`
Expected: All PASS (standard relation still surfaces fields; custom-wrapper relation returns "").

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && npx tsc --noEmit` → clean.

```bash
cd apps/web
git add lib/ai/patch-data-shape.ts lib/ai/patch-data-shape.test.ts
git commit -m "fix(patch): 3b relation wrapper derivation matches the render path (no phantom fields)"
```

---

### Task 5: Full-suite verification

- [ ] **Step 1:** `cd apps/web && npx vitest run` → all pass.
- [ ] **Step 2:** `cd apps/web && npx tsc --noEmit` → clean.
- [ ] **Step 3:** Document the ACCEPTED residuals (not fixed, by decision): the 30-field `summarizeAcfFields` cap can omit a target field on a CPT with 30+ fields (rare; a prioritize-named-field refinement is a follow-up); a CPT whose registered slug/rest_base ≠ post_type gets no direct-cpt section (fail-soft miss, not a crash). Record these in the commit body or the design doc's residuals.
