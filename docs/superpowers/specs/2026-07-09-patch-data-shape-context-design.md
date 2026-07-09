# Patch Data-Shape Context — Design (Defect 3)

**Date:** 2026-07-09
**Status:** Approved, ready for implementation plan
**Surface:** `apps/web` Live Draft chat-edit patch path (the `draft-edit` worker + `patchUnitSource`)

## Problem

The patch LLM (`patchUnitSource`, `lib/ai/patch-component.ts`) regenerates a component from
exactly five inputs: `currentTsx`, `guidance`, `exportName`, `themeClassNames`, `tokens`.
It has **no data-shape context** — no ACF field inventory, no CPT schema, no sample record.

For a block like "Featured Beer" (an `acf_flex` layout rendering related beer posts), the
beer's `description` field does not appear anywhere the patch LLM can see it: the current TSX
renders only `post_title` + a Details link, the captured `attr_samples` carry beers as thin
post-refs (`{ID, post_title, post_name}`), and the full beer record — including
`acf.description` — is merged onto each item only at RENDER time by `resolveRelationshipRefs`
(`related-posts-runtime.ts:327`, `const merged = { ...ref, ...hit.record }`).

So a request like "show the beer description on hover" is un-actionable: the model cannot
know the field's name or path, so it hallucinates a hover container (the reported "black
box") bound to nothing. The output still passes `postprocessGeneratedTsx` + `validateTsx`
(they only check export name + parse validity, not semantic correctness), the compile gate
passes, and `draft-edit.ts` marks the edit `completed`. **This is the worst failure class —
the pipeline succeeds while producing wrong output, so there is no error to act on.**

Critically, even the Phase B generator (the presumed "reference") shares this blind spot:
`acfFlexPrompt`'s `postRelationWarning` (`component-generator.ts:889-892`) tells the LLM only
that related items carry `featured_image` + title/slug — never the target CPT's own fields.
So surfacing arbitrary related-post fields is genuinely NEW resolution work, not pure reuse.

## Constraints (decided during brainstorming)

1. **Efficiency first.** Do NOT attach the full schema to every patch. Most chat edits are
   cosmetic ("make it bigger", "change the color") and need zero data context. A relevance
   gate runs BEFORE any work; on a miss the patch is byte-identical to today — no manifest
   read, no schema extraction, no prompt tokens.
2. **The field inventory is compact, not raw JSON Schema.** Reuse `summarizeAcfFields`
   (`component-generator.ts:692`), which caps at 30 fields and emits one terse line per field
   (`- description: string`). A few hundred tokens, not thousands.
3. **Two phases** (ship value incrementally): 3a = direct-ACF fields (reuses existing
   machinery cleanly); 3b = relation-target fields (the novel resolution; where the reported
   bug lives).
4. **Fail-soft, honest.** Missing manifest / unresolvable CPT / null schema → attach no
   section, never block the edit. Never fabricate fields.
5. **Patch path only.** The planner-clarify path (fail-closed when a user names a field that
   doesn't exist) is a documented follow-up, NOT in this plan.

## Architecture

### Relevance gate (runs first, pure, no I/O)

`isDataRelevantEdit(guidance: string, blockType: BlockDataCategory): boolean` in a new pure
module `lib/ai/patch-data-relevance.ts`. Returns true when EITHER:

- the guidance contains data-ish intent — a small keyword set matched case-insensitively:
  `description`, `field`, `show the`, `add the`, `pull`, `display`, `bind`, `text`, `content`,
  `title`, `date`, `price`; OR
- the block is a known data-bearing category (`direct-acf`, `relation`, `cpt-template`,
  `flex`) AND the guidance is non-trivial (not a pure style verb like "bigger", "bolder", a
  color name, spacing).

The gate takes ONLY `(guidance, category)` — both known BEFORE any I/O (the category comes
from the persisted inventory row, not the manifest). It must NOT depend on the resolved
schema, or the "skip the manifest read on a miss" guarantee is circular. On false → the patch
prompt is unchanged and NO manifest read happens. Cosmetic edits pay nothing.

The gate is deliberately biased toward a few false-positives (attaching context when not
strictly needed) over false-negatives (missing a real data edit) — a false-positive costs a
few hundred tokens; a false-negative reproduces the original bug. A secondary refinement —
suppressing the section when, AFTER resolving the schema, the guidance names none of the real
fields AND mentioned no data verb — is a documented OPTIONAL follow-up, not v1 (it would only
save tokens on an already-rare false-positive).

### Block → data-source resolution (pure)

`resolveBlockDataSource(target, inventoryEntry) → BlockDataSource` in a new pure module
`lib/jab/resolve-block-data-source.ts`. Classifies the target block into one of:

- `{ kind: "direct-cpt"; bySlugAbilityName; bySlugWrapperKey }` — a CPT-template block; pull
  that CPT's ACF schema directly.
- `{ kind: "relation"; postType }` — a block with a post-relation field (detected via the
  existing `findPostRelationFieldsInSample` over the block's `attr_samples`); pull the
  RELATION-TARGET CPT's ACF schema.
- `{ kind: "direct-acf"; sample }` — an `acf/*` or flex layout whose fields live on the block
  itself; use the persisted `attr_samples`.
- `{ kind: "none" }` — trivial/passthrough/shell; no data shape.

Phase 3a implements `direct-cpt` + `direct-acf`; Phase 3b adds `relation`.

### Data-shape section builders (pure)

`lib/ai/patch-data-shape.ts` — given a resolved source + the persisted manifest, produce the
prompt section string, reusing `extractCptAcfSchema` (`paradigm-detection.ts:90`, pure) +
`summarizeAcfFields`:

- **3a direct-cpt / direct-acf:** "## Runtime data shape" listing the block's own fields.
- **3b relation:** "## Related-post fields (hydrated at render)" — resolve the target CPT,
  summarize ITS acf fields, and state the exact merged shape and nesting: each item is
  `{ ...ref, ...record }`, so bind `item.acf.<field>` (or the real path the schema shows),
  with the featured_image guidance preserved from the existing warning.

### Wiring (the only I/O site)

`draft-edit.ts` `patch-unit` step: run the gate first; ONLY on a hit read `projects.manifest`
(already persisted — a DB read, not a live WP round-trip; extend the existing
`loadBaseThemeClassNames` pattern), resolve the block data source, build the section, and pass
it into `patchUnitSource` via a new optional `dataShape?: string` field on `PatchPromptInput`
/ `PatchUnitOptions`. `buildPatchPrompt` renders the section when present; absent → byte-
identical to today.

## Data flow

```
guidance + target block
    → isDataRelevantEdit(guidance, category)          [pure, no I/O]
        ├─ false → patchUnitSource() unchanged         [zero added cost]
        └─ true  → load projects.manifest              [DB read, on hit only]
                   → resolveBlockDataSource(...)         [pure]
                   → extractCptAcfSchema + summarizeAcfFields  [pure, capped 30]
                   → buildDataShapeSection(...)          [pure]
                   → patchUnitSource({ ..., dataShape }) [section rendered in prompt]
```

## Units (each one responsibility, independently testable)

| File | Responsibility | I/O |
|---|---|---|
| `lib/ai/patch-data-relevance.ts` (new) | Pure relevance gate | none |
| `lib/jab/resolve-block-data-source.ts` (new) | Pure block → data-source classification | none |
| `lib/ai/patch-data-shape.ts` (new) | Pure section-string builders (3a + 3b) | none |
| `lib/ai/patch-component.ts` (modify) | Accept + render optional `dataShape` | none |
| `lib/inngest/functions/draft-edit.ts` (modify) | Gate → conditional manifest read → wire | DB (manifest), on hit only |

## Error handling

- Manifest missing / CPT unresolvable / `extractCptAcfSchema` returns null → attach NO section,
  proceed with the edit (fail-soft, mirrors `loadBaseThemeClassNames`).
- Never fabricate a field. If the schema doesn't expose what the user named, the LLM works
  from what it has; the honest "that field doesn't exist" refusal is a planner-layer follow-up.
- The gate erring toward false-positives is intentional — a wasted few-hundred-token section
  is cheaper than reproducing the silent-wrong-output bug.

## Testing

- `isDataRelevantEdit` — cosmetic guidance → false; field-mention / data-verb → true; data-
  bearing block + non-trivial guidance → true; pure style verb on a data block → false.
- `resolveBlockDataSource` — each category classified correctly from fixture inventory entries
  (direct-cpt, relation with a target post_type, direct-acf, none).
- `buildDataShapeSection` — 3a lists the block's fields; 3b names the target CPT's fields with
  the `item.acf.<field>` nesting and merged-shape explanation.
- `patchUnitSource` — `dataShape` present renders the section; absent is byte-identical.
- No live-LLM test. Final validation is MANUAL against the real Two Roads Featured Beer block:
  "show the beer description on hover" must bind the real field, not a black box.

## Out of scope (this plan)

- Planner-layer fail-closed / clarify when a user names a non-existent field (documented
  follow-up — keeps this focused on the patch path).
- Multi-CPT `acf_flex` layouts referencing several CPTs at once: v1 resolves the FIRST/primary
  relation target; a layout referencing multiple CPTs surfaces the primary one and is a
  documented limitation, not a hard failure.
- Feeding a full sample RECORD (vs. the field inventory) — the capped field list is the v1
  contract; a sample-record attachment is a possible future refinement.

## Post-implementation: adversarial review outcome (2026-07-09)

The feature shipped, then a 3-adversary review broke it (all `holdsUp:false`), a
remediation landed, and a re-adversarial pass confirmed the fixes. **Fixed:** the
relevance gate was fundamentally recalibrated (attach-by-default on data blocks,
word-boundary matching, style words never suppress a data edit — the original design
reproduced the very bug it existed to fix on "make the ABV bigger"); `buildDataShapeSection`
made fail-soft against every malformed-manifest shape (`{}`, `{abilities:null}`,
`{abilities:[null]}`); array attr-samples rejected; the 3b relation wrapper derivation
aligned byte-exact with the render path (`related-posts-runtime.ts:109-111`) so it never
claims phantom fields; `heading`/`layout` treated as content; the manifest read made lazy
(direct-acf skips it); and `resolveDataShapeForEdit` extracted with tests that regression-lock
the "manifest read is gated" efficiency invariant.

**Accepted residuals (documented, not fixed):**
- The 30-field `summarizeAcfFields` cap can omit a target field on a CPT with 30+ fields
  (rare; a prioritize-named-field refinement is a follow-up).
- A CPT whose registered slug/rest_base ≠ post_type gets no direct-cpt section (fail-soft
  miss, not a crash).
- `block_inventory` is read once on every component-scope edit (structurally necessary — the
  gate needs the resolved category); only the manifest read is gated.
- A heading-SIZING edit ("make the heading bigger") now attaches a cheap capped section (the
  accepted false-positive that guarantees "change the heading" is never dropped).

## Phasing

- **Phase 3a** — relevance gate + resolver (`direct-cpt`, `direct-acf`, `none`) + 3a section
  builder + patch/worker wiring. Ships the efficient scaffold and covers direct-ACF blocks.
- **Phase 3b** — add the `relation` resolver branch + the relation-target section builder
  (resolve the target CPT, summarize its ACF fields, state the merged nesting). Fixes the
  reported beer-description bug.

Each phase is independently shippable and leaves the suite green.
