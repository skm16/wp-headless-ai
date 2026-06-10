import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InventoryEntry, EnrichedInventoryEntry } from "./inventory";
import type { PageDiscoveryResult } from "./discovery-types";
import type { Paradigm } from "./paradigm-detection";
import type { BlockNode } from "./ability-client";

/**
 * persist-discovery.ts — Phase A outputs → DB.
 *
 * Two write functions, both using upsert on the (site_build_id, *) unique
 * index Stage 0 created. NOTE on RLS: `block_inventory` / `page_inventory`
 * do NOT have a `tenant_id` column — tenant scoping rides on the
 * `site_builds.project_id → projects.tenant_id` join (see RLS policies
 * in 0014_saas_v2_schema.sql). `project_id` is denormalized on these
 * rows for query/RLS performance; we write it explicitly so a stray
 * service-role dispatch can't land on the wrong project even though
 * service role bypasses RLS itself.
 *
 * Schema mirror: see apps/web/lib/db/schema.ts and
 * apps/web/drizzle/migrations/0014_saas_v2_schema.sql. If columns drift,
 * the upsert call silently writes wrong shapes; integration smoke (Task
 * 22) catches this against the real DB.
 */

export interface PersistInventoryInput {
  buildId: string;
  projectId: string;
  entries: (InventoryEntry | EnrichedInventoryEntry)[];
  /**
   * Map block_name → aggregated computed-styles JSON per design doc §6.1
   * shape `{ median, range, viewports }`. Inventory entries without
   * computed-styles data (passthrough blocks, blocks with no rendered
   * instance captured) get null in the column.
   */
  computedStylesByBlockName: Record<string, unknown>;
  /**
   * Map block_name → representative outerHTML from the source DOM.
   * Produced by aggregate-dom-samples — uses per-kind correlation rules
   * (wp-block-{name} for `block`, positional for `acf_flex`, article-
   * wrapper for `cpt_template`). Entries with null or missing values
   * leave block_inventory.source_dom_sample null — better to omit than
   * persist a wrong correlation. Optional so older callers (tests, pre-
   * 2026-05-28 worker invocations) keep compiling.
   */
  domSamplesByBlockName?: Map<string, string | null>;
}

export async function persistInventory(input: PersistInventoryInput): Promise<void> {
  if (input.entries.length === 0) return;
  const supabase = createAdminClient();

  const rows = input.entries.map((entry) => {
    // The null-blockName row needs a deterministic string key in the
    // unique index — we use the literal "__null__" so downstream queries
    // can find it. The schema's UNIQUE INDEX is on (site_build_id, block_name)
    // and block_name is `text NOT NULL`, so we must coerce.
    const blockNameKey = entry.blockName ?? "__null__";
    const enriched = entry as Partial<EnrichedInventoryEntry>;
    return {
      site_build_id: input.buildId,
      project_id: input.projectId,
      block_name: blockNameKey,
      occurrence_count: entry.occurrenceCount,
      page_slugs: entry.pageSlugs,
      attr_samples: entry.attrSamples,
      computed_styles: input.computedStylesByBlockName[blockNameKey] ?? null,
      source_dom_sample: input.domSamplesByBlockName?.get(blockNameKey) ?? null,
      tier: entry.tier,
      kind: enriched.kind ?? "block",
      spec: enriched.spec ?? null,
    };
  });

  const { error } = await supabase
    .from("block_inventory")
    .upsert(rows, { onConflict: "site_build_id,block_name" });
  if (error) {
    throw new Error(`block_inventory upsert failed: ${error.message}`);
  }
}

export interface PersistPagesPage {
  slug: string;
  post_type: string;
  title: string;
  route_path: string;
  block_count: number;
  paradigms: Paradigm[];
  discovery: PageDiscoveryResult;
  /** WP modified_gmt of the source post (v0.7.0 row field). NULL when unknown. */
  sourceModifiedGmt?: string | null;
  /**
   * Raw WP BlockNode[] for this page (migration 0027). Persisted so a later
   * incremental build can re-aggregate block_inventory from stored trees
   * instead of re-fetching this page. Optional — older callers omit it.
   */
  blockTree?: BlockNode[] | null;
  /** Absolute source permalink (WP get_permalink). NULL when unknown. */
  link?: string | null;
}

export interface PersistPagesInput {
  buildId: string;
  projectId: string;
  pages: PersistPagesPage[];
}

/**
 * Pure mapper from a discovered page to its page_inventory upsert row.
 * Extracted so the column mapping (incl. v0.7.0 source_modified_gmt) is
 * unit-testable without a live Supabase client.
 */
export function toPageInventoryRow(page: PersistPagesPage, buildId: string, projectId: string) {
  return {
    site_build_id: buildId,
    project_id: projectId,
    slug: page.slug,
    post_type: page.post_type,
    title: page.title,
    route_path: page.route_path,
    block_count: page.block_count,
    paradigms: page.paradigms,
    source_screenshot_paths: { source: page.discovery.screenshotPaths },
    rendering: "dynamic" as const,
    link: page.link ?? null,
    source_modified_gmt: page.sourceModifiedGmt ?? null,
    block_tree: page.blockTree ?? null,
  };
}

export async function persistPages(input: PersistPagesInput): Promise<void> {
  if (input.pages.length === 0) return;
  const supabase = createAdminClient();

  const rows = input.pages.map((page) => toPageInventoryRow(page, input.buildId, input.projectId));

  const { error } = await supabase
    .from("page_inventory")
    .upsert(rows, { onConflict: "site_build_id,slug,post_type" });
  if (error) {
    throw new Error(`page_inventory upsert failed: ${error.message}`);
  }
}
