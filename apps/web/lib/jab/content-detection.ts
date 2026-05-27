import "server-only";
import type { InventoryEntry } from "./inventory";
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
