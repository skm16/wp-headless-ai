# Paradigm-aware Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase A's "ask for blocks, walk blocks" model with paradigm-aware detection — each page is classified into gutenberg / classic / acf_flex / acf_template / unknown, and the inventory is enriched accordingly so Phase B has typed surface to generate against (including the CPTs that render via ACF + theme templates).

**Architecture:** Three small pure modules (`paradigm-detection.ts`, plus two helpers in `content-detection.ts`) consumed by the existing `discoverSite` Inngest worker. One additive migration adds `paradigms TEXT[]` to `page_inventory`. No plugin change required — the data already flows through the v0.6.3 manifest and `jab/get-{cpt}-by-slug` response.

**Tech Stack:** TypeScript, Vitest, Drizzle, Supabase (Postgres), Inngest worker. Plugin floor v0.6.3.

**Spec:** [`docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md`](../specs/2026-05-27-paradigm-aware-discovery-design.md). Read it before starting any task.

**Working directory:** `c:/Projects/wp-headless/apps/web` for all `pnpm` / `npx tsc` commands. The harness auto-cwd's there in most sessions; if not, `cd apps/web` first.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `apps/web/lib/jab/paradigm-detection.ts` | NEW | Pure functions: `findFlexibleContentFieldNames(cptSchema)`, `extractCptAcfSchema(manifest, cpt)`, `detectParadigms(post, cptSchema)`. Single-responsibility: classify a post into paradigm(s) based on its returned blocks + ACF payload. |
| `apps/web/lib/jab/paradigm-detection.test.ts` | NEW | Vitest suite covering all 5 paradigms, hybrid combinations, and edge cases enumerated in the spec. |
| `apps/web/lib/jab/ability-client.ts` | MODIFY | Add `acf?: Record<string, unknown>` to `PageBySlugRecord`. Validate-pass through `callJabAbility` (existing validator is structural only — no schema change needed there). |
| `apps/web/lib/jab/content-detection.ts` | EXTEND | Add `collectAcfFlexLayouts(pages, manifest)` + `collectCptTemplates(pages, paradigmsByPage, manifest)`. Existing `detectContentKinds` signature stays. The `CPT_TEMPLATE_EXCLUDE` rule becomes conditional inside the new helper, not a hard module constant. |
| `apps/web/lib/jab/content-detection.test.ts` | EXTEND | Add tests for the two new helpers, including the `page` CPT conditional. |
| `apps/web/drizzle/migrations/0016_page_inventory_paradigms.sql` | NEW | Additive: `ALTER TABLE page_inventory ADD COLUMN paradigms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`. |
| `apps/web/lib/db/schema.ts` | MODIFY | Add `paradigms` to Drizzle `pageInventory` table (uses `text("paradigms").array().notNull().default([])`). |
| `apps/web/lib/jab/persist-discovery.ts` | MODIFY | Extend `PersistPagesInput.pages[]` with `paradigms: string[]`; pass through to upsert. |
| `apps/web/lib/inngest/functions/discover-site.ts` | MODIFY | Three new step.run boundaries: `detect-paradigms` (per-page loop, in-memory), updated `enrich-inventory` (calls `collectAcfFlexLayouts` + `collectCptTemplates`), updated `persist-pages` (passes paradigms through). Captures `acf` from the per-page record in the existing `blocks-{cpt}-{slug}` step. |
| (smoke) `scripts/smoke-discover-site.ts` | UNCHANGED | Reused for validation. |

---

## Task 1: `findFlexibleContentFieldNames` helper

**Goal:** Pure function that, given a per-CPT ACF schema (subset of the manifest's `output_schema.properties.{wrapperKey}.oneOf[0].properties.acf`), returns the names of every flexible_content field. The flexible_content shape in the manifest is `{ type: "array", items: <variant> | { oneOf: [<variant1>, <variant2>, ...] } }` where each variant is an object with `properties.acf_fc_layout.enum: [string]`.

**Files:**
- Create: `apps/web/lib/jab/paradigm-detection.ts`
- Create: `apps/web/lib/jab/paradigm-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/paradigm-detection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findFlexibleContentFieldNames } from "./paradigm-detection";

describe("findFlexibleContentFieldNames", () => {
  it("returns empty array for null schema", () => {
    expect(findFlexibleContentFieldNames(null)).toEqual([]);
  });

  it("returns empty array for schema with no properties", () => {
    expect(findFlexibleContentFieldNames({ type: "object" })).toEqual([]);
  });

  it("returns empty array when no field looks like flexible_content", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual([]);
  });

  it("detects single-layout flex (items is the variant directly)", () => {
    const schema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            required: ["acf_fc_layout"],
            properties: {
              acf_fc_layout: { type: "string", enum: ["hero"] },
              heading: { type: "string" },
            },
          },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual(["sections"]);
  });

  it("detects multi-layout flex (items.oneOf)", () => {
    const schema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                required: ["acf_fc_layout"],
                properties: { acf_fc_layout: { type: "string", enum: ["hero"] } },
              },
              {
                type: "object",
                required: ["acf_fc_layout"],
                properties: { acf_fc_layout: { type: "string", enum: ["cta"] } },
              },
            ],
          },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual(["sections"]);
  });

  it("detects multiple flex fields on the same CPT", () => {
    const schema = {
      type: "object",
      properties: {
        sidebar: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["link_list"] } } },
        },
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema).sort()).toEqual(["sections", "sidebar"]);
  });

  it("ignores arrays that aren't flexible_content", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        related: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: FAIL with "Failed to resolve module" / "findFlexibleContentFieldNames is not exported."

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/lib/jab/paradigm-detection.ts`:

```typescript
import "server-only";
import type { Manifest } from "@jab/core";
import type { BlockNode, PageBySlugRecord } from "./ability-client";

/**
 * paradigm-detection.ts — Phase A per-page classification.
 *
 * Pure functions, no I/O. The discoverSite worker calls these after every
 * jab/get-{cpt}-by-slug response to classify what content paradigm the
 * page is actually using (gutenberg / classic / acf_flex / acf_template /
 * unknown). Outputs drive paradigms persistence on page_inventory and
 * Phase B's inventory enrichment.
 *
 * Spec: docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md
 */

export type Paradigm = "gutenberg" | "classic" | "acf_flex" | "acf_template" | "unknown";

/**
 * Subset of JSON Schema we care about for ACF detection. The manifest's
 * outputSchema is typed as `Record<string, unknown>` because it's the raw
 * shape WP emits — we narrow ad-hoc as needed via runtime predicates.
 */
type JsonSchema = Record<string, unknown>;

/**
 * Walk a CPT's ACF schema (the `acf` property under
 * `output_schema.properties.{wrapperKey}.oneOf[0].properties`) and return
 * the names of every flexible_content field. The flexible_content shape
 * is always:
 *   { type: "array", items: <variant> | { oneOf: [<variant>, ...] } }
 * where each variant has properties.acf_fc_layout with an enum (the
 * layout discriminator emitted by AcfSchema::flexible_content_variants).
 *
 * Returns [] for null / non-object inputs.
 */
export function findFlexibleContentFieldNames(cptAcfSchema: JsonSchema | null): string[] {
  if (!cptAcfSchema || typeof cptAcfSchema !== "object") return [];
  const props = (cptAcfSchema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];

  const names: string[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== "object") continue;
    const field = raw as { type?: unknown; items?: unknown };
    if (field.type !== "array") continue;
    if (!field.items || typeof field.items !== "object") continue;

    // Two shapes: items is a single variant, or items.oneOf is a list of variants.
    const items = field.items as { oneOf?: unknown; properties?: unknown };
    const variants: unknown[] = Array.isArray(items.oneOf)
      ? items.oneOf
      : [items];

    const allHaveDiscriminator = variants.every((v) => {
      if (!v || typeof v !== "object") return false;
      const variant = v as { properties?: Record<string, unknown> };
      const fcProp = variant.properties?.acf_fc_layout;
      if (!fcProp || typeof fcProp !== "object") return false;
      const fc = fcProp as { enum?: unknown };
      return Array.isArray(fc.enum);
    });

    if (variants.length > 0 && allHaveDiscriminator) names.push(name);
  }
  return names;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0 (no errors).

- [ ] **Step 6: Commit**

```bash
git add lib/jab/paradigm-detection.ts lib/jab/paradigm-detection.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): findFlexibleContentFieldNames — paradigm-detection pure helper

First piece of paradigm-aware discovery: extract flexible_content field
names from a CPT's ACF schema. The flexible_content shape in the
manifest is always { type: array, items: <variant> | { oneOf: variants } }
where each variant has properties.acf_fc_layout with an enum — exactly
what AcfSchema::flexible_content_variants emits on the plugin side.

Pure, no I/O. Returns [] for null / non-object inputs so the caller
gets a safe fallback rather than throws.

Tests cover null schema, no properties, no flex fields, single-layout
flex (items is the variant directly), multi-layout flex (items.oneOf),
multiple flex fields, and non-flex arrays (tags, related posts).

Spec: docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `extractCptAcfSchema` helper

**Goal:** Given a manifest and a CPT abilities-meta (wrapperKey + bySlugAbilityName), extract the per-CPT ACF schema from the manifest's `outputSchema.properties.{wrapperKey}.oneOf[0].properties.acf`. Returns `null` when no ACF schema is present (CPT has no ACF field groups attached, or ACF is inactive on the WP install).

**Files:**
- Modify: `apps/web/lib/jab/paradigm-detection.ts`
- Modify: `apps/web/lib/jab/paradigm-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/paradigm-detection.test.ts`:

```typescript
import { extractCptAcfSchema } from "./paradigm-detection";
import type { Manifest } from "@jab/core";

const makeManifestAbility = (
  name: string,
  wrapperKey: string,
  itemProperties: Record<string, unknown>,
): Manifest["abilities"][number] => ({
  name,
  label: name,
  description: "",
  inputSchema: {},
  outputSchema: {
    type: "object",
    required: [wrapperKey],
    properties: {
      [wrapperKey]: {
        oneOf: [
          { type: "object", properties: itemProperties },
          { type: "null" },
        ],
      },
    },
  },
});

const makeManifest = (abilities: Manifest["abilities"]): Manifest => ({
  schemaVersion: 1,
  source: "https://example.test",
  fetchedAt: new Date().toISOString(),
  server: { namespace: "jab", route: "/wp-json/jab/v1" },
  abilities,
});

describe("extractCptAcfSchema", () => {
  it("returns null when manifest is null", () => {
    expect(extractCptAcfSchema(null, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });

  it("returns null when ability is not in manifest", () => {
    const manifest = makeManifest([makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" } })]);
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-event-by-slug", bySlugWrapperKey: "event" }),
    ).toBeNull();
  });

  it("returns null when item properties lack an acf key", () => {
    const manifest = makeManifest([makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" } })]);
    expect(extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });

  it("extracts the acf schema from a properly-shaped ability", () => {
    const acfSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        abv: { type: "number" },
        ibu: { type: "number" },
      },
    };
    const manifest = makeManifest([
      makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" }, acf: acfSchema }),
    ]);
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" }),
    ).toEqual(acfSchema);
  });

  it("returns null when oneOf has no non-null variant", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      source: "https://example.test",
      fetchedAt: new Date().toISOString(),
      server: { namespace: "jab", route: "/wp-json/jab/v1" },
      abilities: [
        {
          name: "jab/get-beer-by-slug",
          label: "",
          description: "",
          inputSchema: {},
          outputSchema: {
            type: "object",
            required: ["beer"],
            properties: { beer: { oneOf: [{ type: "null" }] } },
          },
        },
      ],
    };
    expect(extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: FAIL — "extractCptAcfSchema is not exported."

- [ ] **Step 3: Append the implementation**

Append to `apps/web/lib/jab/paradigm-detection.ts`:

```typescript
/**
 * Drill into a manifest to extract the per-CPT ACF schema. The manifest's
 * by-slug ability output_schema is:
 *
 *   { type: object,
 *     properties: {
 *       [wrapperKey]: { oneOf: [ItemSchema, { type: "null" }] }
 *     } }
 *
 * and ItemSchema includes `acf` only when the CPT has ACF field groups
 * attached (per AcfSchema::for_post_type). Returns null when:
 *   - manifest is null
 *   - ability isn't in manifest.abilities
 *   - outputSchema is missing the wrapper / oneOf shape
 *   - no oneOf variant carries an acf property
 *
 * Callers pass `bySlugWrapperKey` from resolveCptAbilityMeta so we don't
 * re-derive the wrapper key here.
 */
export function extractCptAcfSchema(
  manifest: Manifest | null,
  opts: { bySlugAbilityName: string; bySlugWrapperKey: string },
): Record<string, unknown> | null {
  if (!manifest) return null;
  const ability = manifest.abilities.find((a) => a.name === opts.bySlugAbilityName);
  if (!ability || !ability.outputSchema) return null;

  const wrapper = (ability.outputSchema as { properties?: Record<string, unknown> }).properties?.[
    opts.bySlugWrapperKey
  ];
  if (!wrapper || typeof wrapper !== "object") return null;

  const variants = (wrapper as { oneOf?: unknown }).oneOf;
  if (!Array.isArray(variants)) return null;

  for (const variant of variants) {
    if (!variant || typeof variant !== "object") continue;
    const v = variant as { type?: unknown; properties?: Record<string, unknown> };
    if (v.type === "null") continue;
    const acf = v.properties?.acf;
    if (acf && typeof acf === "object") {
      return acf as Record<string, unknown>;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: PASS (12 tests total — 7 from Task 1 plus 5 new).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add lib/jab/paradigm-detection.ts lib/jab/paradigm-detection.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): extractCptAcfSchema — manifest → per-CPT ACF schema lookup

Pure helper that drills into the manifest's by-slug ability output_schema
to pull out the CPT's ACF schema (output_schema.properties.{wrapperKey}.
oneOf[<non-null variant>].properties.acf). Returns null at every layer
that's missing — null manifest, missing ability, missing wrapper, missing
oneOf, or missing acf property — so callers get a safe fallback path
when the CPT has no ACF field groups.

Skips the { type: "null" } oneOf variant to find the actual item schema
regardless of whether it's [0] or [1] in the variant list.

Tests cover all five null-return paths plus the happy path with a real
acf schema embedded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `detectParadigms` core function

**Goal:** Pure function implementing the spec's detection algorithm exactly — ACF first (acf_flex then acf_template), then gutenberg or classic (mutually exclusive), then unknown only if nothing else fired.

**Files:**
- Modify: `apps/web/lib/jab/paradigm-detection.ts`
- Modify: `apps/web/lib/jab/paradigm-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/paradigm-detection.test.ts`:

```typescript
import { detectParadigms } from "./paradigm-detection";

const makePost = (overrides: Partial<{
  blocks: Array<{ blockName: string | null; attrs: Record<string, unknown>; innerBlocks: unknown[]; innerHTML: string; innerContent: (string | null)[] }>;
  acf: Record<string, unknown> | undefined;
}> = {}) => ({
  id: 1,
  title: "X",
  slug: "x",
  link: "https://example.test/x",
  date: "2026-05-27T00:00:00Z",
  excerpt: "",
  blocks: overrides.blocks,
  acf: overrides.acf,
}) as Parameters<typeof detectParadigms>[0];

describe("detectParadigms", () => {
  it("returns ['unknown'] when no signal fires", () => {
    expect(detectParadigms(makePost({ blocks: [], acf: undefined }), null)).toEqual(["unknown"]);
  });

  it("returns ['gutenberg'] for a post with typed blocks", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });

  it("returns ['classic'] for a single __null__ block with HTML", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "<p>hi</p>", innerContent: ["<p>hi</p>"] },
          ],
        }),
        null,
      ),
    ).toEqual(["classic"]);
  });

  it("returns ['gutenberg'] when typed blocks coexist with __null__ (classic suppressed)", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "<p>...</p>", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });

  it("returns ['unknown'] when blocks is a single empty __null__ (no innerHTML)", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "   ", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["unknown"]);
  });

  it("returns ['acf_template'] for ACF data with no flex fields and no blocks", () => {
    const cptSchema = {
      type: "object",
      properties: { abv: { type: "number" }, name: { type: "string" } },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { abv: 5.5, name: "IPA" } }),
        cptSchema,
      ),
    ).toEqual(["acf_template"]);
  });

  it("returns ['acf_flex'] when ACF flex field has entries", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [{ acf_fc_layout: "hero", heading: "Hi" }] } }),
        cptSchema,
      ),
    ).toEqual(["acf_flex"]);
  });

  it("returns ['acf_flex', 'acf_template'] for hybrid ACF (flex + non-flex fields)", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
        footer_text: { type: "string" },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [{ acf_fc_layout: "hero" }], footer_text: "© 2026" } }),
        cptSchema,
      ),
    ).toEqual(["acf_flex", "acf_template"]);
  });

  it("ACF paradigms come before gutenberg in the array", () => {
    const cptSchema = {
      type: "object",
      properties: { hero_text: { type: "string" } },
    };
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
          acf: { hero_text: "Welcome" },
        }),
        cptSchema,
      ),
    ).toEqual(["acf_template", "gutenberg"]);
  });

  it("does NOT classify ACF when all values are null/empty", () => {
    const cptSchema = {
      type: "object",
      properties: { hero_text: { type: "string" }, sections: { type: "array" } },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { hero_text: "", sections: [] } }),
        cptSchema,
      ),
    ).toEqual(["unknown"]);
  });

  it("does NOT classify acf_flex when the flex array is empty", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [] } }),
        cptSchema,
      ),
    ).toEqual(["unknown"]);
  });

  it("CPT with no ACF schema in manifest can still classify gutenberg", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
          acf: undefined,
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: FAIL — "detectParadigms is not exported."

- [ ] **Step 3: Append the implementation**

Append to `apps/web/lib/jab/paradigm-detection.ts`:

```typescript
/**
 * Per-page paradigm classification — pure, deterministic, no I/O.
 *
 * Push order matches the spec exactly: ACF first (acf_flex, then
 * acf_template), then gutenberg or classic (mutually exclusive — classic
 * only fires when no typed blocks exist), then unknown if and only if
 * nothing else fired.
 *
 * Phase C iterates the resulting paradigms array in order, letting ACF
 * frame content (header/footer/sidebar overrides) render before the
 * block-tree main content it wraps.
 *
 * `cptAcfSchema` should be the result of extractCptAcfSchema(manifest, cpt)
 * for the post's post_type. Pass null when the CPT has no ACF (the
 * detection falls through to gutenberg/classic/unknown paths cleanly).
 */
export function detectParadigms(
  post: PageBySlugRecord,
  cptAcfSchema: Record<string, unknown> | null,
): Paradigm[] {
  const paradigms: Paradigm[] = [];
  const blocks = post.blocks ?? [];
  const acf = post.acf ?? null;

  const hasRealBlocks = blocks.some((b: BlockNode) => b.blockName !== null);
  const hasClassicNull =
    blocks.length === 1 &&
    blocks[0].blockName === null &&
    (blocks[0].innerHTML ?? "").trim().length > 0;

  // ACF first — frame content.
  if (acf && cptAcfSchema) {
    const flexFieldNames = findFlexibleContentFieldNames(cptAcfSchema);

    const hasFlex = flexFieldNames.some((name) => {
      const v = acf[name];
      return Array.isArray(v) && v.length > 0;
    });

    const hasTemplate = Object.entries(acf).some(([k, v]) => {
      if (flexFieldNames.includes(k)) return false;
      if (v == null) return false;
      if (typeof v === "string" && v.trim() === "") return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    });

    if (hasFlex) paradigms.push("acf_flex");
    if (hasTemplate) paradigms.push("acf_template");
  }

  // Then content — gutenberg suppresses classic when both signals would fire.
  if (hasRealBlocks) paradigms.push("gutenberg");
  if (hasClassicNull && !hasRealBlocks) paradigms.push("classic");

  if (paradigms.length === 0) paradigms.push("unknown");
  return paradigms;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: PASS (24 tests total). If a test fails because of `PageBySlugRecord.acf` not existing yet, do **not** add the field here — Task 4 handles it. As a workaround for this task only, the `makePost` helper casts the post via `as Parameters<typeof detectParadigms>[0]` which suppresses the type error in the test file. The function signature accepts the `acf` field via the cast; runtime behavior is correct.

If TypeScript flags `post.acf` access in the implementation, add `(post as { acf?: Record<string, unknown> }).acf` cast inline for now — Task 4 cleans it up.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0. If you get an error about `post.acf` not existing on `PageBySlugRecord`, use the local cast inside `detectParadigms` — the proper field landing is the next task.

- [ ] **Step 6: Commit**

```bash
git add lib/jab/paradigm-detection.ts lib/jab/paradigm-detection.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): detectParadigms — per-page paradigm classification

Pure function implementing the spec's detection algorithm. Order:
ACF first (acf_flex then acf_template), then gutenberg or classic
(mutually exclusive), then unknown if and only if nothing else
fired. Phase C iterates the resulting array in this order so ACF
frame content renders before the block content it wraps.

Predicates filter empty / null / whitespace-only ACF values to
avoid mis-classifying CPTs whose ACF schema is present in the
response shape but whose values are all empty.

13 tests cover: every paradigm in isolation, hybrid combinations,
empty-block + empty-ACF (fallback to unknown), mutually-exclusive
classic suppression, ACF-first ordering, and the manifest-null
fall-through path (gutenberg/classic still work without ACF schema).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `PageBySlugRecord.acf` interface extension

**Goal:** Add the `acf` field to the TypeScript interface so it flows through the existing `getPostBySlug` validation. The plugin already returns this field on the wire (per `PostTypeBySlugAbility::output_schema`); we're just stopping the silent drop on the SaaS side.

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts`

- [ ] **Step 1: Make the edit**

In `apps/web/lib/jab/ability-client.ts`, find the `PageBySlugRecord` interface (around line 52). Change it from:

```typescript
export interface PageBySlugRecord {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  excerpt: string;
  content?: string;
  blocks?: BlockNode[];
  rendered_content?: string;
}
```

to:

```typescript
export interface PageBySlugRecord {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  excerpt: string;
  content?: string;
  blocks?: BlockNode[];
  /**
   * Per-CPT ACF field-group payload. Populated by the plugin's
   * PostTypeBySlugAbility (`output_schema` lists `acf` as required when
   * AcfSchema::for_post_type returns a non-null schema for this CPT).
   * Shape mirrors the ACF schema in the manifest — scalars, repeaters
   * as arrays of nested objects, flexible_content as discriminated
   * unions keyed on `acf_fc_layout`. Absent when the CPT has no ACF
   * field groups attached (or when the WP install has no ACF plugin).
   */
  acf?: Record<string, unknown>;
  rendered_content?: string;
}
```

- [ ] **Step 2: If Task 3's implementation used the inline cast, remove it**

Open `apps/web/lib/jab/paradigm-detection.ts`. Find any `(post as { acf?: ... }).acf` casts inside `detectParadigms` and replace them with the direct property access `post.acf`. (If you didn't need the cast in Task 3 because the build worked through `as Parameters<...>`, skip this step.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 4: Re-run the paradigm tests**

Run: `pnpm vitest run lib/jab/paradigm-detection.test.ts`
Expected: PASS (24 tests). The `makePost` helper's cast may no longer be needed, but leave it — the test data still uses fewer fields than the full interface, and the cast keeps tests independent of unrelated `PageBySlugRecord` changes.

- [ ] **Step 5: Commit**

```bash
git add lib/jab/ability-client.ts lib/jab/paradigm-detection.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): PageBySlugRecord.acf — capture ACF payload from by-slug calls

The plugin's PostTypeBySlugAbility output_schema lists `acf` as required
on every CPT that has ACF field groups attached (per AcfSchema::
for_post_type). The SaaS-side interface was silently dropping the
property — we were getting the data on the wire and throwing it away.

Adding the optional field to the typed interface so paradigm detection
and per-CPT ACF schema lookups can consume it. Wire-up to the discover
worker comes in a later task.

No runtime change. callJabAbility's existing structural validator
already passes through unknown fields unchanged; this just lets
TypeScript see the property.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `collectAcfFlexLayouts` helper

**Goal:** Pure function that, given a list of per-page payloads (post + paradigms) and the manifest, returns the data shape `detectContentKinds` already accepts as its `flexLayouts` argument. One `AcfFlexLayoutData` per (cpt, fieldPath, layoutName) combination observed across all pages, with `pageSlugs` accumulated and `attrSample` taken from the first occurrence.

**Files:**
- Modify: `apps/web/lib/jab/content-detection.ts`
- Modify: `apps/web/lib/jab/content-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/content-detection.test.ts`:

```typescript
import { collectAcfFlexLayouts, type CollectablePage } from "./content-detection";

const makeAcfFlexPage = (
  slug: string,
  postType: string,
  fieldName: string,
  layouts: Array<Record<string, unknown>>,
): CollectablePage => ({
  slug,
  post_type: postType,
  blocks: [],
  acf: { [fieldName]: layouts },
  paradigms: ["acf_flex"],
});

describe("collectAcfFlexLayouts", () => {
  it("returns [] when no pages have ACF flex content", () => {
    const result = collectAcfFlexLayouts([], new Map());
    expect(result).toEqual([]);
  });

  it("groups same (cpt,field,layout) across multiple pages", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      makeAcfFlexPage("home", "page", "sections", [{ acf_fc_layout: "hero", heading: "A" }]),
      makeAcfFlexPage("about", "page", "sections", [{ acf_fc_layout: "hero", heading: "B" }]),
    ];

    const result = collectAcfFlexLayouts(pages, cptAcfSchemas);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      cptSlug: "page",
      fieldPath: "sections",
      layoutName: "hero",
      attrSample: { acf_fc_layout: "hero", heading: "A" },
      pageSlugs: ["home", "about"],
    });
  });

  it("separates distinct layout names within the same field", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            oneOf: [
              { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
              { type: "object", properties: { acf_fc_layout: { enum: ["cta"] } } },
            ],
          },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      {
        slug: "home",
        post_type: "page",
        blocks: [],
        acf: {
          sections: [
            { acf_fc_layout: "hero", heading: "Welcome" },
            { acf_fc_layout: "cta", label: "Buy" },
          ],
        },
        paradigms: ["acf_flex"],
      },
    ];

    const result = collectAcfFlexLayouts(pages, cptAcfSchemas);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.layoutName).sort()).toEqual(["cta", "hero"]);
  });

  it("ignores layouts not declared in the manifest schema", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      {
        slug: "home",
        post_type: "page",
        blocks: [],
        acf: { sections: [{ acf_fc_layout: "spooky_unknown_layout" }] },
        paradigms: ["acf_flex"],
      },
    ];

    expect(collectAcfFlexLayouts(pages, cptAcfSchemas)).toEqual([]);
  });

  it("ignores pages whose CPT has no ACF schema in the manifest", () => {
    const pages: CollectablePage[] = [
      makeAcfFlexPage("ipa", "beer", "sections", [{ acf_fc_layout: "hero" }]),
    ];
    expect(collectAcfFlexLayouts(pages, new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run lib/jab/content-detection.test.ts`
Expected: FAIL — "collectAcfFlexLayouts is not exported."

- [ ] **Step 3: Append the implementation**

At the top of `apps/web/lib/jab/content-detection.ts`, ADD these imports + types (after the existing `import type { InventoryEntry } from "./inventory"`):

```typescript
import { findFlexibleContentFieldNames } from "./paradigm-detection";
import type { Paradigm } from "./paradigm-detection";
import type { BlockNode } from "./ability-client";

/**
 * Input shape for the collect-* helpers below. Each entry is what the
 * discoverSite worker accumulates per sampled page after the by-slug
 * call returns. Pure functions consume this; no DB / network.
 */
export interface CollectablePage {
  slug: string;
  post_type: string;
  blocks: BlockNode[];
  acf?: Record<string, unknown>;
  paradigms: Paradigm[];
}
```

Then append the function at the bottom of the file (after `detectContentKinds`):

```typescript
/**
 * Walk every page's ACF payload to collect distinct flexible_content
 * layout occurrences. Output goes directly into detectContentKinds's
 * second argument.
 *
 * Algorithm:
 *   1. For each page with `acf_flex` in its paradigms, look up the CPT's
 *      ACF schema from the Map<cptSlug, AcfSchema>.
 *   2. For each flexible_content field discovered in that schema, walk
 *      the page's acf[fieldName] array.
 *   3. For each layout entry with a known `acf_fc_layout` value (one
 *      declared in the schema), accumulate into a key
 *      `${cptSlug}::${fieldName}::${layoutName}`.
 *   4. The first attrSample wins (deterministic — keyed by insertion order).
 *      pageSlugs collects every slug that exhibited the layout, dedupe'd.
 *
 * Ignores layouts whose `acf_fc_layout` isn't in the manifest schema
 * (defensive against bad data — the plugin's WP-side validator should
 * reject these, but worker tolerance keeps detection robust).
 */
export function collectAcfFlexLayouts(
  pages: CollectablePage[],
  cptAcfSchemas: Map<string, Record<string, unknown>>,
): AcfFlexLayoutData[] {
  const accum = new Map<
    string,
    {
      cptSlug: string;
      fieldPath: string;
      layoutName: string;
      attrSample: Record<string, unknown>;
      pageSlugs: string[];
    }
  >();

  for (const page of pages) {
    if (!page.paradigms.includes("acf_flex")) continue;
    if (!page.acf) continue;
    const cptSchema = cptAcfSchemas.get(page.post_type);
    if (!cptSchema) continue;

    const flexFields = findFlexibleContentFieldNames(cptSchema);
    for (const fieldName of flexFields) {
      const value = page.acf[fieldName];
      if (!Array.isArray(value)) continue;
      const declaredLayouts = declaredLayoutNamesForField(cptSchema, fieldName);
      for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as { acf_fc_layout?: unknown };
        const layoutName = typeof e.acf_fc_layout === "string" ? e.acf_fc_layout : "";
        if (!layoutName || !declaredLayouts.includes(layoutName)) continue;
        const key = `${page.post_type}::${fieldName}::${layoutName}`;
        const existing = accum.get(key);
        if (existing) {
          if (!existing.pageSlugs.includes(page.slug)) existing.pageSlugs.push(page.slug);
        } else {
          accum.set(key, {
            cptSlug: page.post_type,
            fieldPath: fieldName,
            layoutName,
            attrSample: entry as Record<string, unknown>,
            pageSlugs: [page.slug],
          });
        }
      }
    }
  }

  return Array.from(accum.values());
}

/**
 * For a CPT ACF schema + field name, return the set of layout names
 * declared on that flexible_content field (via the items/oneOf shape
 * from AcfSchema::flexible_content_variants).
 */
function declaredLayoutNamesForField(
  cptSchema: Record<string, unknown>,
  fieldName: string,
): string[] {
  const props = (cptSchema as { properties?: Record<string, unknown> }).properties;
  if (!props) return [];
  const field = props[fieldName];
  if (!field || typeof field !== "object") return [];
  const items = (field as { items?: unknown }).items;
  if (!items || typeof items !== "object") return [];
  const variants: unknown[] = Array.isArray((items as { oneOf?: unknown[] }).oneOf)
    ? ((items as { oneOf: unknown[] }).oneOf)
    : [items];
  const out: string[] = [];
  for (const v of variants) {
    if (!v || typeof v !== "object") continue;
    const variant = v as { properties?: Record<string, unknown> };
    const fcProp = variant.properties?.acf_fc_layout;
    if (!fcProp || typeof fcProp !== "object") continue;
    const fc = fcProp as { enum?: unknown };
    if (Array.isArray(fc.enum)) {
      for (const e of fc.enum) {
        if (typeof e === "string") out.push(e);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/jab/content-detection.test.ts`
Expected: PASS (all existing tests + 5 new for `collectAcfFlexLayouts`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add lib/jab/content-detection.ts lib/jab/content-detection.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): collectAcfFlexLayouts — pages → AcfFlexLayoutData list

Walks every page's ACF payload to extract unique flexible_content
layout occurrences, keyed by (cptSlug, fieldPath, layoutName). Output
goes directly into detectContentKinds's existing 2nd argument — the
function has accepted this shape since Stage 2 T4 but no helper
populated it. This closes that wire-up gap surfaced by docs/
conversion-pipeline.md §10 G3.

Defensive: layouts whose acf_fc_layout isn't in the manifest schema
get ignored (the WP-side validator should reject them, but worker
robustness wins). First-seen attrSample wins. pageSlugs accumulate
across all pages that exhibit the layout, deduplicated.

Tests cover: empty input, same-layout-across-pages aggregation,
distinct-layouts-same-field separation, unknown-layout-name rejection,
and missing-cpt-schema fall-through.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `collectCptTemplates` helper (with conditional `page` rule)

**Goal:** Pure function that returns the data `detectContentKinds` accepts as its `cptTemplates` argument. One entry per CPT where at least one sampled page has `acf_template` in its paradigms. The `page` CPT is INCLUDED when this condition is met (overriding the existing hard-exclude in `content-detection.ts`'s `CPT_TEMPLATE_EXCLUDE`).

**Files:**
- Modify: `apps/web/lib/jab/content-detection.ts`
- Modify: `apps/web/lib/jab/content-detection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/content-detection.test.ts`:

```typescript
import { collectCptTemplates } from "./content-detection";

describe("collectCptTemplates", () => {
  it("returns [] when no pages have acf_template paradigm", () => {
    const pages: CollectablePage[] = [
      { slug: "ipa", post_type: "beer", blocks: [], paradigms: ["unknown"] },
    ];
    expect(collectCptTemplates(pages, new Map())).toEqual([]);
  });

  it("emits one entry per CPT with acf_template-bearing pages", () => {
    const pages: CollectablePage[] = [
      {
        slug: "ipa",
        post_type: "beer",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }],
        paradigms: ["acf_template", "gutenberg"],
      },
      {
        slug: "stout",
        post_type: "beer",
        blocks: [],
        paradigms: ["acf_template"],
      },
      {
        slug: "event-1",
        post_type: "event",
        blocks: [],
        paradigms: ["acf_template"],
      },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.cptSlug === "beer")?.pageSlugs.sort()).toEqual(["ipa", "stout"]);
    expect(result.find((r) => r.cptSlug === "event")?.pageSlugs).toEqual(["event-1"]);
  });

  it("INCLUDES page CPT when at least one page has acf_template paradigm", () => {
    const pages: CollectablePage[] = [
      { slug: "about", post_type: "page", blocks: [], paradigms: ["acf_template"] },
      { slug: "contact", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
    ];
    const result = collectCptTemplates(pages, new Map());
    const pageEntry = result.find((r) => r.cptSlug === "page");
    expect(pageEntry).toBeDefined();
    expect(pageEntry?.pageSlugs).toEqual(["about"]); // contact excluded — pure gutenberg
  });

  it("EXCLUDES page CPT when no page has acf_template", () => {
    const pages: CollectablePage[] = [
      { slug: "about", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
      { slug: "contact", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
    ];
    expect(collectCptTemplates(pages, new Map())).toEqual([]);
  });

  it("blockNameUnion aggregates block names across acf_template pages of the same CPT", () => {
    const pages: CollectablePage[] = [
      {
        slug: "ipa",
        post_type: "beer",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }],
        paradigms: ["acf_template", "gutenberg"],
      },
      {
        slug: "stout",
        post_type: "beer",
        blocks: [
          { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
        ],
        paradigms: ["acf_template", "gutenberg"],
      },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result).toHaveLength(1);
    const beer = result[0];
    expect(beer.cptSlug).toBe("beer");
    expect(beer.blockNameUnion.sort()).toEqual(["core/heading", "core/paragraph"]);
  });

  it("blockNameUnion is empty for CPTs whose acf_template pages have no blocks", () => {
    const pages: CollectablePage[] = [
      { slug: "ipa", post_type: "beer", blocks: [], paradigms: ["acf_template"] },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result[0].blockNameUnion).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run lib/jab/content-detection.test.ts`
Expected: FAIL — "collectCptTemplates is not exported."

- [ ] **Step 3: Append the implementation**

Append to `apps/web/lib/jab/content-detection.ts` (after `collectAcfFlexLayouts`):

```typescript
/**
 * Walk pages to derive cpt_template entries — one per CPT that has at
 * least one page with `acf_template` paradigm.
 *
 * The `page` CPT is INCLUDED here when the predicate matches, overriding
 * the historical hard-exclude in content-detection.ts. Rationale (per
 * the design spec): the original exclude existed because pages are
 * typically bespoke marketing surfaces (each page has unique block
 * composition, no "single-page.php" template to generate). But pages
 * driven by ACF field groups DO have a repeatable template — the theme's
 * single-page.php reads structured ACF fields the same way it would for
 * a custom CPT. Including `page` here surfaces those typed templates for
 * Phase B.
 *
 * `blockNameUnion` collects the set of block names found across the
 * acf_template-bearing pages of each CPT (in case the page also has
 * gutenberg paradigm — hybrid). Empty array when the CPT's
 * acf_template pages have no blocks.
 *
 * cptAcfSchemas is currently unused (the spec data lives on the
 * block_inventory.spec column populated downstream by detectContentKinds
 * from CptTemplateData.blockNameUnion). Parameter kept for symmetry with
 * collectAcfFlexLayouts and forward-compat with a future enhancement
 * that emits the ACF schema as part of spec.
 */
export function collectCptTemplates(
  pages: CollectablePage[],
  _cptAcfSchemas: Map<string, Record<string, unknown>>,
): CptTemplateData[] {
  const accum = new Map<
    string,
    { cptSlug: string; pageSlugs: string[]; blockNames: Set<string | null> }
  >();

  for (const page of pages) {
    if (!page.paradigms.includes("acf_template")) continue;
    const cptSlug = page.post_type;
    let entry = accum.get(cptSlug);
    if (!entry) {
      entry = { cptSlug, pageSlugs: [], blockNames: new Set<string | null>() };
      accum.set(cptSlug, entry);
    }
    if (!entry.pageSlugs.includes(page.slug)) entry.pageSlugs.push(page.slug);
    for (const block of page.blocks) {
      entry.blockNames.add(block.blockName);
    }
  }

  return Array.from(accum.values()).map((entry) => ({
    cptSlug: entry.cptSlug,
    pageSlugs: entry.pageSlugs,
    blockNameUnion: Array.from(entry.blockNames),
  }));
}
```

- [ ] **Step 4: Remove the hard-exclude on `page` CPT inside `detectContentKinds`**

In the same file, find the existing loop in `detectContentKinds`:

```typescript
for (const cpt of cptTemplates) {
  if (CPT_TEMPLATE_EXCLUDE.has(cpt.cptSlug)) continue;
  const blockName = `cpt_template/${cpt.cptSlug}`;
  out.push({
    ...
  });
}
```

Replace it with:

```typescript
for (const cpt of cptTemplates) {
  // No hard-exclude here anymore — collectCptTemplates is the gate. When
  // `page` CPT is in the input, it's because at least one sampled page
  // had paradigm `acf_template` (per the spec's conditional rule). Pure-
  // gutenberg pages never make it into this list.
  const blockName = `cpt_template/${cpt.cptSlug}`;
  out.push({
    blockName,
    occurrenceCount: cpt.pageSlugs.length,
    pageSlugs: cpt.pageSlugs,
    attrSamples: [],
    tier: "standard",
    kind: "cpt_template",
    spec: cpt.blockNameUnion,
  });
}
```

Also remove the now-unused `CPT_TEMPLATE_EXCLUDE` constant declaration at the top of the file (around line 57): `const CPT_TEMPLATE_EXCLUDE = new Set(["page"]);` — delete the line. The existing test that asserts the hard-exclude (`hard-excludes page CPT from cpt_template`) needs to be updated.

- [ ] **Step 5: Update the existing test that locked the hard-exclude**

In `apps/web/lib/jab/content-detection.test.ts`, find this test:

```typescript
it("hard-excludes page CPT from cpt_template", () => {
  const cptData = [
    { cptSlug: "page", blockNameUnion: ["core/heading"], pageSlugs: ["about"] },
  ];
  const result = detectContentKinds([], [], cptData);
  expect(result).toHaveLength(0);
});
```

Replace it with:

```typescript
it("emits cpt_template entries for any CPT in the input (gating moved to collectCptTemplates)", () => {
  const cptData = [
    { cptSlug: "page", blockNameUnion: ["core/heading"], pageSlugs: ["about"] },
  ];
  const result = detectContentKinds([], [], cptData);
  expect(result).toHaveLength(1);
  expect(result[0].blockName).toBe("cpt_template/page");
});
```

The page CPT gating is now solely in `collectCptTemplates` (the test for that lives a few `describe` blocks down).

- [ ] **Step 6: Run all content-detection tests**

Run: `pnpm vitest run lib/jab/content-detection.test.ts`
Expected: PASS (all existing tests + 6 new for `collectCptTemplates` + the updated former-hard-exclude test).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 8: Commit**

```bash
git add lib/jab/content-detection.ts lib/jab/content-detection.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): collectCptTemplates — pages → CptTemplateData with page CPT gating

Closes the other half of the cpt_template wire-up gap (G3 in conversion-
pipeline.md). One entry per CPT where at least one sampled page has
acf_template in its paradigms.

The page CPT is now CONDITIONALLY included — when at least one sampled
page CPT post has acf_template paradigm (i.e., it has real ACF field
data, not just Gutenberg blocks). Pure-gutenberg pages still don't
generate a cpt_template entry. This matches the spec's conditional
rule and unblocks Two Roads-style sites where some pages are ACF-driven.

Removes the legacy CPT_TEMPLATE_EXCLUDE constant from content-detection.ts
(`page` was the only member). Gating now lives in collectCptTemplates
where the per-page paradigm info is available. detectContentKinds
becomes a pure inventory-row emitter — no hard rules baked into it.

blockNameUnion accumulates across all acf_template pages of each CPT,
including any hybrid (acf_template + gutenberg) cases — block names
from hybrid pages flow into the union so Phase B knows the template
can contain both ACF fields AND blocks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Migration 0016 + Drizzle schema sync

**Goal:** Add `paradigms TEXT[]` to `page_inventory` and mirror in the Drizzle TS schema.

**Files:**
- Create: `apps/web/drizzle/migrations/0016_page_inventory_paradigms.sql`
- Modify: `apps/web/lib/db/schema.ts`

- [ ] **Step 1: Write the migration**

Create `apps/web/drizzle/migrations/0016_page_inventory_paradigms.sql`:

```sql
-- ============================================================================
-- 0016_page_inventory_paradigms.sql — paradigm-aware discovery
-- ----------------------------------------------------------------------------
-- Adds a paradigms column to page_inventory so Phase C knows how to render
-- each page. Detected by Phase A's per-page paradigm classifier.
--
--   paradigms TEXT[] — ordered list of detected content paradigms:
--     acf_flex / acf_template (frame) → gutenberg / classic (content) → unknown
--   - Multi-paradigm pages list all applicable paradigms in render order
--   - `unknown` is exclusive (never combined)
--   - Empty array = detection hasn't run (e.g. legacy builds before 0016)
--
-- Additive-only migration. Existing rows get [] via the default; the next
-- discoverSite run populates them when re-triggered for that build.
--
-- Spec: docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md
-- ============================================================================

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS paradigms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.page_inventory.paradigms IS
  'Detected content paradigms for this page in render order: acf_flex / acf_template (frame) then gutenberg / classic (content) then unknown (fallback). Multi-paradigm pages list all that apply. unknown is exclusive (never combined). Empty array means detection has not run (e.g. legacy builds before migration 0016).';

-- ============================================================================
-- End 0016_page_inventory_paradigms.sql
-- ============================================================================
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool. Project ID is `ajfurojjxthhzkjqttri`.

Call `mcp__supabase__apply_migration` with:
- `project_id`: `ajfurojjxthhzkjqttri`
- `name`: `page_inventory_paradigms`
- `query`: the full SQL contents of `0016_page_inventory_paradigms.sql` (from `ALTER TABLE` through the closing `COMMENT`)

Expected: success response.

- [ ] **Step 3: Verify the column exists**

Use `mcp__supabase__execute_sql` with the same `project_id` and query:

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'page_inventory' AND column_name = 'paradigms';
```

Expected: one row showing `data_type='ARRAY'`, `column_default='ARRAY[]::text[]'`.

- [ ] **Step 4: Update the Drizzle schema**

In `apps/web/lib/db/schema.ts`, find the `pageInventory` definition (around line 264). Add the `paradigms` field after `rendering`:

Change:

```typescript
    rendering: text("rendering").notNull().default("dynamic"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
```

To:

```typescript
    rendering: text("rendering").notNull().default("dynamic"),
    paradigms: text("paradigms").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add drizzle/migrations/0016_page_inventory_paradigms.sql lib/db/schema.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): migration 0016 — paradigms TEXT[] on page_inventory

Adds the per-page paradigm signal so Phase C can dispatch per-page
render strategy without re-walking inventory data. Render order:
acf_flex / acf_template (frame) → gutenberg / classic (content) →
unknown (fallback). Multi-paradigm pages list all applicable; unknown
is exclusive.

Additive-only — existing rows get [] via the default. Next discoverSite
run populates them when the per-page detect-paradigms step (added in a
later task) writes through to persistPages.

Drizzle schema mirror synced. text().array().notNull().default([]) gives
the same shape the SQL ALTER establishes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Extend `persistPages` to write paradigms

**Goal:** Thread `paradigms: string[]` through `PersistPagesInput.pages[]` so the discover worker can write the per-page detection results.

**Files:**
- Modify: `apps/web/lib/jab/persist-discovery.ts`

- [ ] **Step 1: Make the edit**

In `apps/web/lib/jab/persist-discovery.ts`, find the `PersistPagesInput` interface (around line 70):

```typescript
export interface PersistPagesInput {
  buildId: string;
  projectId: string;
  pages: Array<{
    slug: string;
    post_type: string;
    title: string;
    route_path: string;
    block_count: number;
    discovery: PageDiscoveryResult;
  }>;
}
```

Change to:

```typescript
export interface PersistPagesInput {
  buildId: string;
  projectId: string;
  pages: Array<{
    slug: string;
    post_type: string;
    title: string;
    route_path: string;
    block_count: number;
    paradigms: string[];
    discovery: PageDiscoveryResult;
  }>;
}
```

Then find the `persistPages` function body's row construction (around line 87):

```typescript
const rows = input.pages.map((page) => ({
  site_build_id: input.buildId,
  project_id: input.projectId,
  slug: page.slug,
  post_type: page.post_type,
  title: page.title,
  route_path: page.route_path,
  block_count: page.block_count,
  source_screenshot_paths: { source: page.discovery.screenshotPaths },
  rendering: "dynamic",
}));
```

Change to:

```typescript
const rows = input.pages.map((page) => ({
  site_build_id: input.buildId,
  project_id: input.projectId,
  slug: page.slug,
  post_type: page.post_type,
  title: page.title,
  route_path: page.route_path,
  block_count: page.block_count,
  paradigms: page.paradigms,
  source_screenshot_paths: { source: page.discovery.screenshotPaths },
  rendering: "dynamic",
}));
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0 — note that `discover-site.ts` won't yet pass `paradigms` so TypeScript will flag the missing property at the call site. We'll address that in the next task. To verify ONLY persist-discovery.ts compiles cleanly, you can temporarily skip the integration error or expect it.

Actually let's be precise: the typecheck WILL fail with one error at the `persistPages({ ... pages: pageBlocks.map(...) })` call site in `discover-site.ts` because that map result is missing `paradigms`. That's expected and the next task fixes it. If you want a clean typecheck before commit, do this task and Task 9 together as one commit.

**Decision:** combine this task's commit with Task 9's commit to keep typecheck clean. Defer the commit to Task 9, step 9.

---

## Task 9: Wire everything into `discoverSite` worker

**Goal:** The integration task — load manifest, build per-CPT ACF schema map, capture ACF on each per-page response, detect paradigms per page, pass collected flex + cpt data into `detectContentKinds`, persist paradigms via the now-extended `persistPages`.

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`

- [ ] **Step 1: Add the new imports**

At the top of `apps/web/lib/inngest/functions/discover-site.ts`, find the existing imports and ADD:

```typescript
import {
  detectParadigms,
  extractCptAcfSchema,
  type Paradigm,
} from "@/lib/jab/paradigm-detection";
import {
  collectAcfFlexLayouts,
  collectCptTemplates,
  type CollectablePage,
} from "@/lib/jab/content-detection";
```

The existing `import { buildInventory, detectContentKinds, type PageBlocksInput } from "@/lib/jab/inventory";` line stays as is — those names are still in use.

- [ ] **Step 2: Extend the per-page accumulator type**

Find the existing line (around line 160):

```typescript
const pageBlocks: Array<PageBlocksInput & { title: string; url: string }> = [];
```

Change to:

```typescript
const pageBlocks: Array<PageBlocksInput & { title: string; url: string; acf?: Record<string, unknown>; paradigms: Paradigm[] }> = [];
```

- [ ] **Step 3: Build the per-CPT ACF schema map**

Find the existing line where `seedCptLists` is computed (around line 150). Right after it (BEFORE the per-CPT outer for-loop that starts with `capLoop: for (const { cpt, meta, rows } of seedCptLists)`), insert:

```typescript
// Build a Map<cptSlug, AcfSchema> from the manifest. Used by paradigm
// detection per page and by the flex-layouts collector at enrich time.
// One traversal of the manifest, then constant-time lookups.
const cptAcfSchemas = new Map<string, Record<string, unknown>>();
for (const { cpt, meta } of seedCptLists) {
  const schema = extractCptAcfSchema(manifest, meta);
  if (schema) cptAcfSchemas.set(cpt.slug, schema);
}
```

- [ ] **Step 4: Capture ACF + run paradigm detection per page**

Find the existing per-page push (around line 175-181):

```typescript
if (!record) continue;
pageBlocks.push({
  slug: row.slug,
  post_type: cpt.slug,
  title: row.title ?? "",
  url: row.link,
  blocks: (record.blocks ?? []) as BlockNode[],
});
```

Change to:

```typescript
if (!record) continue;
const cptSchema = cptAcfSchemas.get(cpt.slug) ?? null;
const paradigms = detectParadigms(record, cptSchema);
pageBlocks.push({
  slug: row.slug,
  post_type: cpt.slug,
  title: row.title ?? "",
  url: row.link,
  blocks: (record.blocks ?? []) as BlockNode[],
  acf: record.acf,
  paradigms,
});
```

- [ ] **Step 5: Update the `enrich-inventory` step**

Find the existing step (around line 218):

```typescript
const enrichedInventory = await step.run("enrich-inventory", async () => {
  return detectContentKinds(inventory);
});
```

Change to:

```typescript
const enrichedInventory = await step.run("enrich-inventory", async () => {
  const collectablePages: CollectablePage[] = pageBlocks.map((p) => ({
    slug: p.slug,
    post_type: p.post_type,
    blocks: p.blocks,
    acf: p.acf,
    paradigms: p.paradigms,
  }));
  const flexLayouts = collectAcfFlexLayouts(collectablePages, cptAcfSchemas);
  const cptTemplates = collectCptTemplates(collectablePages, cptAcfSchemas);
  return detectContentKinds(inventory, flexLayouts, cptTemplates);
});
```

- [ ] **Step 6: Pass `paradigms` through to persistPages**

Find the existing `persistPages` call (around line 267):

```typescript
await step.run("persist-pages", () =>
  persistPages({
    buildId,
    projectId,
    pages: pageBlocks.map((p) => {
      const discovery = discoveryResults.find((d) => d.slug === p.slug && d.post_type === p.post_type) ?? {
        slug: p.slug,
        post_type: p.post_type,
        screenshotPaths: {},
        blockCapturesByViewport: {},
      };
      return {
        slug: p.slug,
        post_type: p.post_type,
        title: p.title,
        route_path: routePathFor(p.post_type, p.slug),
        block_count: p.blocks.length,
        discovery,
      };
    }),
  }),
);
```

Change to:

```typescript
await step.run("persist-pages", () =>
  persistPages({
    buildId,
    projectId,
    pages: pageBlocks.map((p) => {
      const discovery = discoveryResults.find((d) => d.slug === p.slug && d.post_type === p.post_type) ?? {
        slug: p.slug,
        post_type: p.post_type,
        screenshotPaths: {},
        blockCapturesByViewport: {},
      };
      return {
        slug: p.slug,
        post_type: p.post_type,
        title: p.title,
        route_path: routePathFor(p.post_type, p.slug),
        block_count: p.blocks.length,
        paradigms: p.paradigms,
        discovery,
      };
    }),
  }),
);
```

- [ ] **Step 7: Add a diagnostic log for paradigm distribution**

Right after the `pageBlocks` loop completes (after the smoke-cap log block around line 188 — that is, just before `// ── Capture screenshots + computed CSS ──`), insert:

```typescript
// Diagnostic: paradigm distribution across sampled pages. Helps the
// agency see at a glance what content shapes their site uses without
// poking at the DB. One log line per build.
const paradigmCounts: Record<string, number> = {};
for (const p of pageBlocks) {
  const key = p.paradigms.join("+") || "(none)";
  paradigmCounts[key] = (paradigmCounts[key] ?? 0) + 1;
}
console.log(
  `[discoverSite ${buildId}] paradigm distribution:`,
  Object.entries(paradigmCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(", "),
);
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: EXIT 0. All the cross-file pieces now match.

- [ ] **Step 9: Commit (combines Task 8 + Task 9)**

```bash
git add lib/jab/persist-discovery.ts lib/inngest/functions/discover-site.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): discoverSite — paradigm-aware discovery integration

The integration step that ties paradigm detection into Phase A:

- Build a Map<cptSlug, AcfSchema> once at the top of the worker via
  extractCptAcfSchema(manifest, meta) — one manifest traversal per
  CPT, constant-time lookups everywhere downstream.
- Capture record.acf on every per-page by-slug response and run
  detectParadigms(record, cptSchema) inline — paradigms land on each
  pageBlocks entry alongside the existing blocks data.
- enrich-inventory step now maps pageBlocks → CollectablePage[] and
  calls collectAcfFlexLayouts + collectCptTemplates, feeding both
  into detectContentKinds. This finally exercises the 2nd + 3rd args
  that have been accepted but never populated since Stage 2 T4.
- persistPages threads paradigms[] through to the per-page row write
  (PersistPagesInput.pages[].paradigms — Task 8 typed the field).
- Diagnostic console log emits the paradigm distribution across
  sampled pages — e.g. "acf_template=7, gutenberg=2, unknown=1".

No new step.run boundaries. The new logic fits inside the existing
trace shape — the run trace stays comparable to prior builds, easier
to debug regressions against.

Two Roads expected: 8 of 10 pages should now classify as acf_template
(beer/coa/distributor/event/flavor/food-truck-event/location) where
they previously contributed block_count=0 and nothing else. Phase B
finally has typed surface to generate against.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Smoke validation against Two Roads

**Goal:** Re-run `pnpm smoke:discover` against the Two Roads pilot to verify the wire-up produces the expected paradigm-aware inventory. This is a manual verification gate — no new code.

**Files:** None (verification only).

- [ ] **Step 1: Confirm prerequisites**

- Next.js dev server is running on `http://localhost:3000` (from `pnpm dev` in `apps/web`).
- Inngest dev server is running: `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest` in a second terminal.

If either is missing, start them.

- [ ] **Step 2: Run the smoke**

```bash
pnpm smoke:discover 075e33fd-8984-4e48-b58e-a9eab54d1828 01d5b66f-2d9b-42a8-bc5b-109af0b62579
```

Wait for completion (≈2 minutes). Capture the new `buildId` printed at startup — you'll need it for the assertions below.

- [ ] **Step 3: Verify paradigm distribution log line**

In the dev server's console output for the `discoverSite` run, find the line:

```
[discoverSite <buildId>] paradigm distribution: <counts>
```

Expected: at least one entry for `acf_template` (multiple CPT pages should classify this way). Pure `unknown` distributions indicate the manifest's ACF schema didn't extract correctly — check the schema map step (Task 9 step 3).

- [ ] **Step 4: Verify the `block_inventory` row counts**

Use the Supabase MCP `mcp__supabase__execute_sql` (project_id `ajfurojjxthhzkjqttri`):

```sql
SELECT kind, COUNT(*) FROM block_inventory
WHERE site_build_id = '<NEW_BUILD_ID>'
GROUP BY kind ORDER BY kind;
```

Expected: at least one row per `kind` value that has data. Two Roads should produce:
- `block` — 3-10 rows (the existing entries plus any blocks found across all pages)
- `cpt_template` — 5-7 rows (one per non-page CPT that has ACF field groups)
- `acf_flex` — 0-3 rows (depending on whether any Two Roads CPT uses Flexible Content)

Total row count ≥ 8.

- [ ] **Step 5: Verify the `page_inventory.paradigms` column populated**

```sql
SELECT slug, post_type, paradigms FROM page_inventory
WHERE site_build_id = '<NEW_BUILD_ID>'
ORDER BY post_type, slug;
```

Expected: every row has a non-empty `paradigms` array. The CPT pages (beer, coa, distributor, etc.) should show `{acf_template}` or `{acf_template,gutenberg}`. The homepage probably shows `{gutenberg}` or `{classic}`. No rows with `{}`.

- [ ] **Step 6: Verify cpt_template entries name the right CPTs**

```sql
SELECT block_name, occurrence_count, page_slugs FROM block_inventory
WHERE site_build_id = '<NEW_BUILD_ID>' AND kind = 'cpt_template'
ORDER BY block_name;
```

Expected: rows like `cpt_template/beer`, `cpt_template/event`, `cpt_template/coa`, etc. — one per ACF-bearing CPT.

- [ ] **Step 7: Decide based on results**

- **Happy path**: All four assertions above match. Move to Task 11.
- **acf_template not detected but expected**: re-check the manifest schema extraction. The Supabase MCP can pull the manifest:
  ```sql
  SELECT jsonb_path_query(manifest, '$.abilities[*].name') AS ability_name
  FROM projects WHERE id = '075e33fd-8984-4e48-b58e-a9eab54d1828';
  ```
  Confirm the by-slug abilities are present. If yes, drill into one of their outputSchemas and verify the `acf` property exists.
- **Detection runs but `paradigms` is empty in DB**: confirm Task 9 step 6 changed the `persistPages` call site correctly.
- **TypeScript or import errors at runtime**: dev server's stack trace tells you what's missing — usually a missed export from `content-detection.ts` or `paradigm-detection.ts`.

Document anomalies in the next task's commit message so the smoke result is captured in git history.

---

## Task 11: Roadmap update + final commit

**Goal:** Update `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md` to record that paradigm-aware discovery shipped. Reference the spec and the smoke results.

**Files:**
- Modify: `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`

- [ ] **Step 1: Find the Stage 1 section**

Open `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md` and locate the Stage 1 — Phase A Discovery section.

- [ ] **Step 2: Add a completion note**

At the end of the Stage 1 section, after the existing content but before the next stage's header, add:

```markdown
**Update 2026-05-27 — Paradigm-aware discovery shipped:** the Two Roads pilot smoke surfaced that CPTs whose content lives in ACF field groups (beer, coa, distributor, etc.) were contributing nothing to the inventory. The fix landed as a paradigm-detection layer that classifies each sampled page into gutenberg / classic / acf_flex / acf_template / unknown and enriches the inventory accordingly. No plugin change required — the data was already on the wire via the v0.6.x manifest. See [`docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md`](../specs/2026-05-27-paradigm-aware-discovery-design.md) for the design rationale and [`docs/superpowers/plans/2026-05-27-paradigm-aware-discovery.md`](2026-05-27-paradigm-aware-discovery.md) for the implementation plan. Smoke result on Two Roads: `<distribution from Task 10 step 3>` — `<N>` block_inventory rows (up from 3), `<M>` cpt_template entries, all page_inventory rows have non-empty paradigms.
```

Replace `<distribution from Task 10 step 3>`, `<N>`, and `<M>` with the actual smoke numbers from Task 10.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md
git commit -m "$(cat <<'EOF'
📝 docs(roadmap): record paradigm-aware discovery shipment

Two Roads smoke validated: paradigm-detection now classifies CPT-with-
ACF pages correctly. block_inventory grew from 3 rows to <N> rows;
all page_inventory rows have non-empty paradigms; cpt_template entries
emitted for <M> non-page CPTs.

Stage 1 success criterion (≥20 block_inventory rows) is closer but
still pending — depends on whether Two Roads has enough ACF-bearing
CPTs to clear the bar with the current 10-page smoke cap. Larger smoke
cap or the acf_options v0.7.x plugin track will close it fully.

The fix did not require a plugin change. The data was already on the
wire via the v0.6.x manifest's per-CPT ACF schema; the SaaS just
wasn't capturing it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push (optional, ask the user)**

If the user wants to publish:

```bash
git push origin master
```

Otherwise leave the commits local for review.

---

## Self-review checklist (final)

Before declaring the plan complete:

- [ ] All 11 tasks have full TDD steps with complete code blocks (no `TODO`, no `add appropriate validation`, etc.)
- [ ] All file paths are absolute or rooted in `apps/web`
- [ ] Function/method names are consistent across tasks (`detectParadigms` named the same in Task 3 and Task 9)
- [ ] All `pnpm` / `npx` commands match the project's existing patterns (no `npm test` / no `yarn`)
- [ ] Commit messages use the project's emoji + scope conventions
- [ ] No task references "see other task for details" — every task is self-contained
- [ ] The smoke validation step (Task 10) names concrete acceptance criteria, not vague "verify it works"

---

*Implementation plan complete. Next: invoke `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work through the tasks.*
