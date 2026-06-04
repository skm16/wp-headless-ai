import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type {
  EnrichedInventoryEntry,
  Tier,
  ContentKind,
  CptTemplateSpec,
} from "@/lib/jab/inventory";

/**
 * inventory-entry-from-row — the single row→EnrichedInventoryEntry transform
 * + the page-slug→source-screenshot resolution, extracted from
 * generate-components.ts (Phase 2 / spec §3.3). Phase B and the chat-driven
 * regen worker share this so a regenerated component reconstructs the exact
 * same generator input the full build used — including the visual-tier
 * screenshot (verifier major: the screenshot lookup is its own step).
 */

export interface BlockInventoryRowForEntry {
  block_name: string;
  tier: string | null;
  kind: string | null;
  spec: unknown;
  attr_samples: unknown;
  page_slugs: string[] | null;
  occurrence_count: number | null;
  source_dom_sample: string | null;
  computed_styles: unknown;
}

/** The columns the regen + Phase B SELECTs must request to build an entry. */
export const BLOCK_ENTRY_COLUMNS =
  "block_name, tier, kind, spec, attr_samples, page_slugs, occurrence_count, source_dom_sample, computed_styles" as const;

export function blockRowToEnrichedEntry(row: BlockInventoryRowForEntry): EnrichedInventoryEntry {
  const kind = (row.kind ?? "block") as ContentKind;
  const tier = (row.tier ?? "passthrough") as Tier;
  // DB stores the "no block name" sentinel as the literal string "__null__"
  // because block_name is NOT NULL; the TS-side discriminator is
  // blockName: string | null. Convert here so the entry type is correct.
  const blockName = row.block_name === "__null__" ? null : row.block_name;
  // Narrow the JSONB computed_styles blob to the shape the prompt
  // builder expects. Missing/malformed → null (prompt builder no-ops).
  const cs = row.computed_styles as { viewports?: unknown } | null;
  const computedStyles =
    cs && typeof cs === "object" && cs.viewports && typeof cs.viewports === "object"
      ? (cs as { viewports: Record<string, Record<string, string[]>> })
      : null;
  const base = {
    blockName,
    tier,
    attrSamples: Array.isArray(row.attr_samples)
      ? (row.attr_samples as Array<Record<string, unknown>>)
      : [],
    pageSlugs: row.page_slugs ?? [],
    occurrenceCount: row.occurrence_count ?? 0,
    sourceDomSample: row.source_dom_sample,
    computedStyles,
  };
  if (kind === "acf_flex") {
    return { ...base, kind, spec: (row.spec ?? {}) as Record<string, unknown> };
  }
  if (kind === "cpt_template") {
    // Normalize spec to the current `{ blockNames, acfSchema }` shape so
    // downstream consumers (the prompt) don't branch.
    // - Pre-2026-05-27 builds persisted `(string|null)[]` directly →
    //   map to { blockNames: legacy, acfSchema: null }.
    // - Current builds persist `{ blockNames, acfSchema }` from
    //   detectContentKinds → pass through with defensive field reads.
    const raw = row.spec;
    let spec: CptTemplateSpec;
    if (Array.isArray(raw)) {
      spec = { blockNames: raw as (string | null)[], acfSchema: null };
    } else if (raw && typeof raw === "object") {
      const obj = raw as { blockNames?: unknown; acfSchema?: unknown };
      spec = {
        blockNames: Array.isArray(obj.blockNames)
          ? (obj.blockNames as (string | null)[])
          : [],
        acfSchema:
          obj.acfSchema && typeof obj.acfSchema === "object"
            ? (obj.acfSchema as Record<string, unknown>)
            : null,
      };
    } else {
      spec = { blockNames: [], acfSchema: null };
    }
    return { ...base, kind, spec };
  }
  return { ...base, kind: "block", spec: undefined };
}

/** page_inventory row shape needed to rebuild the slug→1280-path map. */
export interface PageScreenshotRow {
  slug: string;
  source_screenshot_paths: { source?: Record<string, string> } | null;
}

/** Pure: slug → 1280 source-screenshot Storage path, omitting pages with no 1280 capture. */
export function slugToScreenshotPathMap(pages: PageScreenshotRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const page of pages) {
    const paths = page.source_screenshot_paths?.source ?? {};
    const path1280 = paths["1280"];
    if (path1280) result[page.slug] = path1280;
  }
  return result;
}

/**
 * Resolve the base64 1280 screenshot for a single slug from page_inventory.
 * Returns null fail-soft (no row, no 1280 path, or download error) so
 * visual-tier regen still runs on the remaining inputs.
 */
export async function loadHomeOrSlugScreenshotBase64(
  supabase: SupabaseClient,
  buildId: string,
  slug: string,
): Promise<string | null> {
  const { data: pages } = await supabase
    .from("page_inventory")
    .select("slug, source_screenshot_paths")
    .eq("site_build_id", buildId)
    .eq("slug", slug);
  const map = slugToScreenshotPathMap((pages ?? []) as PageScreenshotRow[]);
  const path = map[slug];
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer()).toString("base64");
  } catch {
    return null;
  }
}
