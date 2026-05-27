# Paradigm-aware Discovery — Design

> **Date:** 2026-05-27
> **Status:** Approved (Sean), implementation plan pending
> **Predecessor:** [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase A
> **Companion:** [`docs/conversion-pipeline.md`](../../conversion-pipeline.md) §10 G3 (cpt_template / acf_flex wire-up gap)
> **Surfaces:** `apps/web` Phase A discovery worker, `block_inventory`, `page_inventory`
> **Pilot validation target:** Two Roads Brewing (canonical pilot WP install)

## Why

Phase A currently asks WP for `blocks: BlockNode[]` and walks them into `block_inventory`. CPTs whose content lives in ACF fields rather than `post_content` — which describes most non-page CPTs on real WP sites — produce zero block entries and contribute nothing to the inventory. The Two Roads smoke run on 2026-05-27 confirmed this: 8 of 10 sampled pages came back with `block_count=0` because the brewery's CPTs (beer, coa, distributor, event, flavor, food-truck-event, location) render via ACF + theme templates, not Gutenberg.

The plugin already exposes the data we need — the `acf` property on every `jab/get-{cpt}-by-slug` response when the CPT has ACF field groups, with a rich typed schema including discriminated `flexible_content` layouts (see [`packages/wp-plugin/includes/Acf/Schema.php`](../../../packages/wp-plugin/includes/Acf/Schema.php) and [`PostTypeBySlugAbility.php:218-221`](../../../packages/wp-plugin/includes/Abilities/PostTypeBySlugAbility.php#L218-L221)). The SaaS is throwing it away — `PageBySlugRecord` doesn't even have an `acf` field in its TypeScript interface.

This design replaces "ask for blocks, walk blocks" with "detect what each page is using, retrieve and inventory accordingly."

**No plugin change is required.** All five paradigms detect off data the plugin already returns at v0.6.0+.

## Paradigm taxonomy

Each sampled page is classified into one or more of five paradigms. Multi-paradigm pages carry the full list; `unknown` is exclusive (never combined with others).

| Paradigm | Detection signal | Inventory contribution | Phase C render strategy |
|---|---|---|---|
| **`gutenberg`** | `blocks` contains ≥1 entry with `blockName !== null` (a real block name like `core/heading`, `acf/hero`, `tworoads/beer-card`). | Standard `block_inventory` entries — one per unique `blockName`, walked recursively into `innerBlocks`. | Walk the page's BlockNode tree; dispatch per blockName to its generated component. |
| **`classic`** | Exactly one block with `blockName === null` carrying non-empty `innerHTML` (the raw `post_content` HTML when WP's parser can't type it). | One shared `__null__` passthrough entry across all classic pages (existing behavior). | Render `innerHTML` through DOMPurify-sanitized `RichTextContent`. |
| **`acf_flex`** | `acf` contains ≥1 `flexible_content` field (detected via the manifest's typed schema for the CPT) with at least one non-empty layout entry. | One `acf_flex/{cpt}/{fieldPath}/{layoutName}` entry per declared layout. Spec is the layout's sub_fields schema from the manifest. | Walk `acf[fieldName]` array; dispatch per `acf_fc_layout` discriminator to its generated component. |
| **`acf_template`** | `acf` is present and contains ≥1 non-null/non-empty value in a non-flexible-content field. | One `cpt_template/{cpt}` entry per CPT (shared across all `acf_template`-bearing pages of that CPT). Spec is the full ACF field-group schema for the CPT *minus* any flexible_content fields covered by `acf_flex` entries. | Render a generated CPT-template component that reads ACF fields directly (analogous to a theme's `single-{cpt}.php`). |
| **`unknown`** | None of the above signals fire — `blocks` empty/`__null__`-only AND `acf` absent or all-empty, yet the post is published and has a slug. | **No inventory entry.** Phase C handles `unknown` inline via a `RenderedPassthrough` platform shim. | Fetch the page with `include={ render: true }`, sanitize via DOMPurify, render through `RichTextContent`. |

### Detection algorithm

```ts
function detectParadigms(
  post: PageBySlugRecord,
  cptAcfSchema: AcfSchema | null,
): Paradigm[] {
  const paradigms: Paradigm[] = [];
  const blocks = post.blocks ?? [];
  const acf = post.acf ?? null;

  const hasRealBlocks = blocks.some((b) => b.blockName !== null);
  const hasClassicNull =
    blocks.length === 1 &&
    blocks[0].blockName === null &&
    (blocks[0].innerHTML ?? "").trim().length > 0;

  // ACF first — ACF data is overwhelmingly "frame" content (header overrides,
  // hero defaults, sidebar widgets, footer info) that the theme template
  // renders AROUND the block content. Putting ACF first in the array tells
  // Phase C to render the frame before the content it wraps.
  if (acf && cptAcfSchema) {
    const flexFieldNames = findFlexibleContentFieldNames(cptAcfSchema);
    const hasFlex = flexFieldNames.some(
      (name) => Array.isArray(acf[name]) && (acf[name] as unknown[]).length > 0,
    );
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

  // Then content: gutenberg or classic (mutually exclusive — classic only
  // fires when there are no typed blocks).
  if (hasRealBlocks) paradigms.push("gutenberg");
  if (hasClassicNull && !hasRealBlocks) paradigms.push("classic");

  // Fallback only when nothing else detected.
  if (paradigms.length === 0) paradigms.push("unknown");
  return paradigms;
}
```

Pure function. No I/O. Deterministic for a given input pair. Stable order: **ACF paradigms first (acf_flex, then acf_template), then gutenberg or classic, then unknown only if nothing else fired.** Phase C iterates the array in this order, letting ACF establish the page frame before block content fills the main area.

### Edge cases (explicit)

| Case | Classification |
|---|---|
| `blocks: []` and `acf` absent | `unknown` |
| `blocks: []` and `acf` present with values | `acf_template` (and/or `acf_flex` if applicable) |
| `blocks` has both `core/*` blocks AND `__null__` blocks mixed | `gutenberg` only (the `__null__` blocks are inventoried as passthrough rows by the standard walk) |
| `acf` present in response shape, all values null/empty | NO `acf_template` (predicate filters empties) — falls to `unknown` if no other signal |
| ACF Flex field present but its array is empty | NO `acf_flex` (predicate requires `length > 0`) |
| CPT has no ACF field groups (manifest has no `acf` key for it) | `cptAcfSchema = null` — only `gutenberg` / `classic` / `unknown` possible |
| Page CPT with paradigm `acf_template` | `cpt_template/page` IS generated (the bespoke-marketing exclusion only applies to pure-gutenberg page CPTs) |
| `page` CPT with paradigm `gutenberg` | `cpt_template/page` is NOT generated (each page is a bespoke marketing surface) |

## Inventory shape

### `block_inventory` — no schema change

The existing three `kind` values (`block`, `acf_flex`, `cpt_template`) cover all five paradigms — `gutenberg` and `classic` produce `kind=block` entries (the existing walk), `acf_flex` and `acf_template` produce their named kinds, and `unknown` produces no entry at all.

What changes is *which* function fills `flexLayouts` and `cptTemplates` into `detectContentKinds`. Currently the worker passes neither (the bug surfaced by the smoke). Under this design, two new helpers populate both:

- **`collectAcfFlexLayouts(pages, manifest)`** — for each `acf_flex`-bearing page, look up the manifest's flexible_content layout schema for the CPT, and emit one `AcfFlexLayoutData` per (cpt, fieldPath, layoutName) combination observed in any page's `acf` payload.
- **`collectCptTemplates(pages, manifest, paradigmsByPage)`** — for each unique CPT where ≥1 sampled page has `acf_template` in its paradigms (including `page` when applicable), emit one `CptTemplateData` with `blockNameUnion` (union of block names across `gutenberg` pages of that CPT, or empty if none) and the CPT's ACF schema (minus the flex fields already covered).

Both helpers are pure functions taking already-fetched per-page payloads — no additional network calls.

### `page_inventory` — new `paradigms` column

```sql
ALTER TABLE public.page_inventory
  ADD COLUMN paradigms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.page_inventory.paradigms IS
  'Detected content paradigms for this page in render order: acf_flex / acf_template (frame) then gutenberg / classic (content) then unknown (fallback). Multi-paradigm pages list all that apply. unknown is exclusive (never combined). Empty array means detection has not run (e.g. legacy builds before migration 0016).';
```

Phase C cross-references `page_inventory.post_type` + `page_inventory.paradigms` to dispatch its per-page render strategy:

```ts
for (const paradigm of page.paradigms) {
  switch (paradigm) {
    case "gutenberg": renderBlockTree(page); break;
    case "classic":   renderClassicContent(page); break;
    case "acf_flex":  renderFlexFields(page); break;
    case "acf_template": renderCptTemplate(page); break;
    case "unknown":   renderPassthrough(page); break;
  }
}
```

Each strategy fetches its own data at compose time (Phase C does not re-walk block trees from inventory — it re-fetches the per-page payload). `paradigms` is purely a dispatch hint.

## Plugin contract — no change

The plugin's `jab/get-{cpt}-by-slug` ability already returns the `acf` property when applicable. The manifest already exposes the typed ACF schema per CPT. v0.6.3 is the floor; no v0.6.4 or v0.7.x is required for this work.

The one thing the SaaS needs to add to its call site: pass `include={ content: true, blocks: true, render: false }` *unchanged* (we don't need rendered_content during Phase A — that's reserved for Phase C's `unknown` path).

## File-level change list

| File | Status | Change |
|---|---|---|
| [`packages/wp-plugin/**`](../../../packages/wp-plugin) | unchanged | No plugin change. v0.6.3 is the floor. |
| [`apps/web/lib/jab/ability-client.ts`](../../../apps/web/lib/jab/ability-client.ts) | modify | Add `acf?: Record<string, unknown>` to `PageBySlugRecord`. Validation pass-through. |
| `apps/web/lib/jab/paradigm-detection.ts` | NEW | `detectParadigms(post, cptAcfSchema)`, `findFlexibleContentFieldNames(schema)`. TDD with tests covering all 5 paradigms, hybrid combinations, and edge cases above. |
| [`apps/web/lib/jab/content-detection.ts`](../../../apps/web/lib/jab/content-detection.ts) | extend | Add `collectAcfFlexLayouts(pages, manifest)` + `collectCptTemplates(pages, manifest, paradigmsByPage)` helpers. Existing `detectContentKinds` signature stays. |
| [`apps/web/lib/inngest/functions/discover-site.ts`](../../../apps/web/lib/inngest/functions/discover-site.ts) | modify | New step `load-manifest-acf-schemas` (extracts per-CPT ACF schemas from `projects.manifest`). New step `detect-paradigms` (per page). Pass collected flex/cpt data into `detectContentKinds` at the `enrich-inventory` boundary. Persist `paradigms` on each page row. |
| `apps/web/drizzle/migrations/0016_page_inventory_paradigms.sql` | NEW | Adds `paradigms TEXT[]` to `page_inventory`. |
| [`apps/web/lib/db/schema.ts`](../../../apps/web/lib/db/schema.ts) | modify | Add `paradigms` to the Drizzle `pageInventory` table shape. |
| [`apps/web/lib/jab/inventory.ts`](../../../apps/web/lib/jab/inventory.ts) | unchanged | Existing block walker keeps its current behavior — paradigm detection happens around it, not inside it. |
| [`apps/web/lib/ai/component-generator.ts`](../../../apps/web/lib/ai/component-generator.ts) | unchanged | `acfFlexPrompt` and `cptTemplatePrompt` from T12 finally get exercised with real data. No code change. |
| Phase C (Stage 3) — `lib/jab/scaffold.ts` and friends | future | `RenderedPassthrough` platform shim for `unknown` paradigm. Per-paradigm dispatch in the page composer. Not in this design's scope. |

## Manifest access pattern

`projects.manifest` JSONB is the source of truth. The discoverSite worker already has `projectId` and a service-role Supabase client — one additional SELECT extracts the manifest, which is a **single-shot snapshot of every CPT's ACF schema** (embedded in each `jab/get-{cpt}-by-slug` ability's `output_schema.acf`). No per-CPT roundtrip is needed.

The worker materializes a `Map<cptSlug, AcfSchema>` at the top of Phase A, threaded through `detectParadigms`, `collectAcfFlexLayouts`, and `collectCptTemplates`. This keeps the per-page detection step cheap (single Map lookup) and avoids re-walking the manifest tree for every sampled page.

**Known drift risk:** the manifest was persisted at onboarding time. If an admin adds a new ACF field group between onboarding and the current build, the cached manifest is stale. Acceptable for v1 — the agency can re-run `connectWpAction` to refresh the manifest, and we surface manifest staleness as a fast-follow if it bites in practice. Refreshing the manifest at the start of every Phase A run is the alternate path; not chosen because (a) it adds a network roundtrip on every build, (b) the v0.6.x plugin's ACF schema cache is already TTL-protected so freshness is bounded anyway, and (c) onboarding is the canonical refresh trigger by design.

## Non-post-type ACF — explicit gap

The plugin's ACF integration covers field groups attached to a **post type only** (via `post_type==X` location rules or page-implying rules like `page_template==X`; see [`Acf/Schema.php:347-375`](../../../packages/wp-plugin/includes/Acf/Schema.php#L347-L375)). This design inherits that scope. The following ACF locations are **NOT** in the manifest and are therefore **invisible** to paradigm-aware discovery as designed:

| ACF location | Typical content | Out-of-scope impact |
|---|---|---|
| **Options Pages** | Site-wide settings — header config, footer links, social URLs, brand address, etc. | A Two Roads-style brewery almost certainly has an "Options" page. Site-wide content (e.g., the footer's contact block) will be missing from generated Phase C output. |
| **Taxonomy term fields** | Per-term metadata — e.g., beer-style descriptions, distributor-region copy. | Lower-impact than Options. If a CPT renders enriched term info, that copy will be missing. |
| **User fields** | Author bios, staff metadata. | Rarely material for an agency-grade site. |
| **Block fields (`acf/*` Gutenberg blocks)** | ACF fields attached to ACF Blocks themselves. | Already covered by v0.6.0's typed-block moat (the ACF Block attribute enrichment via `AcfValueWalker`). Not affected by this design. |

**Closing this gap is a v0.7.x plugin track**, deliberately not bundled into this design:

- The plugin would need a new ability (likely `jab/get-options` returning all option fields' values + a `jab/v1/options-schema` manifest extension) and a new schema-emission path for fields with no post_type anchor.
- A new permission gate: Options data can contain sensitive payloads (API keys, internal notes) that the post-published model doesn't apply to. Requires explicit opt-in via a per-field allowlist filter.
- Pairs naturally with the Gravity Forms work in [`docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`](../plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md) — both are v0.7.x scope expansions of the plugin's API surface.

For this design, the workaround is the `unknown` paradigm: pages whose content depends on Options-page data will still render via `rendered_content`, which is what WP would serve a public visitor *including* the Options-resolved template wrappers. Lower fidelity than typed components, but the content is present in the rendered HTML.

## What this fixes — concrete expected results for Two Roads

Re-running the same `pnpm smoke:discover` against project `075e33fd-...` after this design lands should produce:

- **`block_inventory`**: ~10-15 rows, up from 3
  - The existing 3 `block` entries from the homepage (`__null__`, `core/paragraph`, `core/quote`)
  - ~7 `cpt_template` entries (one per non-page CPT with ACF, after probing which of beer/coa/distributor/event/flavor/food-truck-event/location have field groups attached)
  - Possibly 1-3 `acf_flex` entries if any CPT uses Flexible Content fields (unclear without inspecting Two Roads' field groups; the smoke surfaces this)
- **`page_inventory.paradigms`**: each page tagged with its paradigm set. Homepage probably `["gutenberg"]` or `["classic"]`; CPT pages probably `["acf_template"]`; one CPT might be `["acf_flex"]` or `["acf_flex", "acf_template"]`.
- **Stage 1 success criterion (≥ 20 inventory rows)**: still a stretch with only 10 sampled pages — but unblocked. The criterion was written for a larger sample; either the smoke's `maxPages` should be raised or the criterion adjusted in the roadmap.

The unblocking effect for T16 is the bigger win: Phase B finally has typed surface to generate against. `cpt_template/{cpt}` prompts (Sonnet 4.6 standard tier) and any `acf_flex/{...}` prompts (Sonnet 4.6 visual tier, vision-enabled) get exercised with real data instead of returning zero rows.

## Risks + open items

| Risk | Mitigation |
|---|---|
| `acf` field absent from response shape on CPTs without ACF — the validator throws | The plugin's `output_schema` lists `acf` in `required` only when the CPT has ACF; the SaaS callJabAbility validation is structural-only (no schema enforcement), so absence is tolerated. Defensive read: `post.acf ?? null`. |
| Manifest staleness (new ACF field groups added post-onboarding) | Documented above. Agency-resolvable via `connectWpAction` re-trigger. |
| Two Roads pages with `block_count=0` AND no ACF (e.g., page-builder content stored in postmeta) | These fall into `unknown` paradigm — render via `rendered_content` in Phase C. Lower fidelity but the page still appears. |
| Wide CPTs (>100 entries) | Out of scope — see `docs/conversion-pipeline.md` §10 G6. Phase A's seed-page selection mitigates inventory exhaustion; this design doesn't change that. |
| Detection mis-classifying a hybrid page | Multi-paradigm modeling means a hybrid page lands with BOTH paradigms in its array — by design Phase C renders both. The risk reduces to "did we attribute the right blocks vs ACF to the right paradigm," and the answer is yes because each predicate is independent. |
| `findFlexibleContentFields` schema-walker complexity (recursive into repeaters/groups?) | v1: walk only top-level ACF properties. ACF Flex nested inside a repeater is rare and out of scope for v1. Document the limitation. |

## Out of scope (deliberately)

- **Phase C compose strategy.** This design specifies *what Phase C will read*; the dispatch + `RenderedPassthrough` shim are Stage 3 work.
- **Phase B prompt changes.** `cptTemplatePrompt` and `acfFlexPrompt` already exist (T12). This design doesn't alter prompts — it just feeds them data.
- **Manifest refresh policy.** Onboarding remains the canonical refresh trigger. A future stage may add an explicit "re-discover" button that re-fetches the manifest.
- **CPT-with-paginated-content.** The 100-entry cap on `listPostType` is a separate gap (G6 in conversion-pipeline.md).
- **ACF location rules beyond simple `post_type==X` and page-implying rules.** The plugin's location matcher (Schema.php:347) handles these explicitly; v1 inherits that scope.
- **Non-post-type ACF data** — Options Pages, taxonomy term fields, user fields. Detailed in the "Non-post-type ACF — explicit gap" section above. Paired with a future v0.7.x plugin track.
- **Detection of fields populated by client-side AJAX / nuxt-style hydration.** If a page's content arrives via fetch-from-API rather than server-rendered HTML, neither blocks nor ACF nor rendered_content will surface it. The fidelity report (Phase E) is the channel for surfacing this.

## Success criteria

The implementation is done when:

1. A fresh `pnpm smoke:discover` against the Two Roads pilot produces a `block_inventory` with ≥10 rows (up from 3) and a `page_inventory` where every row's `paradigms` array is non-empty.
2. The 7 non-page Two Roads CPTs (beer, coa, etc.) that have ACF field groups produce one `cpt_template/{cpt}` inventory entry each.
3. Pages with paradigm `unknown` are present in `page_inventory` and their slugs render via `rendered_content` when Phase C runs (verified against the smoke, not against a deployed page — Phase C is post-Stage-3).
4. The new `paradigm-detection.test.ts` covers every paradigm and the edge cases in the table above.
5. T16's smoke-generate-components against the re-discovered build produces ≥10 `.tsx` files with `compile_status` populated, with failure rate ≤10%.

## Implementation handoff

The next step is the `writing-plans` skill, which produces a TDD-grained sub-plan at `docs/superpowers/plans/2026-05-27-paradigm-aware-discovery.md`. The plan will sequence:

1. `paradigm-detection.ts` (TDD, isolated)
2. `PageBySlugRecord.acf` (interface extension)
3. `collectAcfFlexLayouts` + `collectCptTemplates` helpers (TDD, isolated)
4. Migration 0016 + Drizzle schema sync
5. `discover-site.ts` wire-up — load manifest, detect paradigms per page, pass collected data into `detectContentKinds`, persist paradigms on page rows
6. Smoke re-run against Two Roads as the validation gate
7. Commit + roadmap update

Total effort estimate: 1 full focused session. The TDD steps are short; the integration in step 5 is the substantive work.
