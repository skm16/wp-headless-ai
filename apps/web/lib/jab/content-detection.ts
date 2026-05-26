import "server-only";
import type { InventoryEntry } from "./inventory";

/**
 * content-detection.ts — Stage 2 inventory enrichment.
 *
 * Two additional entry kinds beyond the standard `core/*` / `acf/*` block rows:
 *
 * 1. `acf_flex/{cptSlug}/{fieldPath}/{layoutName}` — ACF Flexible Content
 *    layout variants. One entry per unique layout name across the site.
 *    The `spec` column carries the layout's sub_fields schema JSON.
 *    Key format rationale: `cptSlug` scopes the field group (avoiding
 *    collisions when two CPTs use different flexible content fields with
 *    the same layout name); `fieldPath` identifies which `acf_field_type`
 *    group the layout belongs to; `layoutName` is the ACF layout slug.
 *
 * 2. `cpt_template/{cptSlug}` — non-`page` CPT single-post templates.
 *    One entry per CPT. `spec` carries the union of block names found
 *    across sampled posts so Phase B can generate a typed wrapper.
 *    `page` CPT is HARD-EXCLUDED: pages are bespoke marketing surfaces,
 *    not repeatable templates (each has unique block composition).
 *
 * The reducer is PURE — no DB / Storage / network. Called from inventory.ts
 * after `buildInventory()` with the same inputs the discovery worker already
 * has in memory.
 */

export type ContentKind = "block" | "acf_flex" | "cpt_template";

/**
 * Tagged-union enriched entry. `spec` is discriminated by `kind`:
 * - block: absent (undefined)
 * - acf_flex: the ACF layout sub_fields schema JSON (from ability attrs)
 * - cpt_template: array of block name strings in the CPT template
 *
 * Consumers narrowing on `kind` get `spec` typed automatically — no `as` cast.
 */
export type EnrichedInventoryEntry =
  | (InventoryEntry & { kind: "block"; spec?: undefined })
  | (InventoryEntry & { kind: "acf_flex"; spec: Record<string, unknown> })
  | (InventoryEntry & { kind: "cpt_template"; spec: (string | null)[] });

export interface AcfFlexLayoutData {
  cptSlug: string;
  fieldPath: string;
  layoutName: string;
  attrSample: Record<string, unknown>;
  pageSlugs: string[];
}

export interface CptTemplateData {
  cptSlug: string;
  blockNameUnion: (string | null)[];
  pageSlugs: string[];
}

const CPT_TEMPLATE_EXCLUDE = new Set(["page"]);

export function detectContentKinds(
  entries: InventoryEntry[],
  flexLayouts: AcfFlexLayoutData[] = [],
  cptTemplates: CptTemplateData[] = [],
): EnrichedInventoryEntry[] {
  const out: EnrichedInventoryEntry[] = [];

  for (const entry of entries) {
    out.push({ ...entry, kind: "block" });
  }

  for (const flex of flexLayouts) {
    const blockName = `acf_flex/${flex.cptSlug}/${flex.fieldPath}/${flex.layoutName}`;
    out.push({
      blockName,
      occurrenceCount: flex.pageSlugs.length,
      pageSlugs: flex.pageSlugs,
      attrSamples: [flex.attrSample],
      tier: "visual",
      kind: "acf_flex",
      spec: flex.attrSample,
    });
  }

  for (const cpt of cptTemplates) {
    if (CPT_TEMPLATE_EXCLUDE.has(cpt.cptSlug)) continue;
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

  return out;
}
