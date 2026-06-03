import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PriorPage } from "./incremental";
import type { BlockNode } from "./ability-client";
import { pageKey, type PriorBlockSample, type PriorPageRow } from "./carry-forward";

export function toPriorPages(
  rows: Array<{ slug: string; post_type: string; source_modified_gmt: string | null }>,
): PriorPage[] {
  return rows.map((r) => ({ slug: r.slug, postType: r.post_type, modifiedGmt: r.source_modified_gmt }));
}

/** Build the (post_type, slug) → tree map, skipping rows with no stored tree. */
export function toPriorTreesByKey(
  rows: Array<{ slug: string; post_type: string; block_tree: BlockNode[] | null }>,
): Map<string, BlockNode[]> {
  const map = new Map<string, BlockNode[]>();
  for (const r of rows) {
    // A present-but-empty tree ([]) is still carriable — the page genuinely
    // has zero blocks. Only a null/non-array tree (pre-0027 rows) is skipped.
    if (r.block_tree != null && Array.isArray(r.block_tree)) {
      map.set(pageKey(r.post_type, r.slug), r.block_tree);
    }
  }
  return map;
}

/** Map prior block_inventory rows to the sample shape the fill step consumes. */
export function toPriorBlockSamples(
  rows: Array<{ block_name: string; computed_styles: unknown | null; source_dom_sample: string | null }>,
): PriorBlockSample[] {
  return rows.map((r) => ({
    blockName: r.block_name,
    computedStyles: r.computed_styles ?? null,
    sourceDomSample: r.source_dom_sample ?? null,
  }));
}

export interface PriorBuildArtifacts {
  buildId: string;
  watermark: string | null;
  priorPages: PriorPage[];
  priorRowsByKey: Map<string, PriorPageRow>;
  priorTreesByKey: Map<string, BlockNode[]>;
  priorBlockSamples: PriorBlockSample[];
}

/**
 * Load the most recent `ready` build for a project: its sync watermark, the
 * per-page modified map, the per-page stored trees + full rows (for carry-
 * forward), and the prior block_inventory samples (for filling computed/dom of
 * blocks that appear only on carried pages). Returns null when no prior ready
 * build exists (first build → full sync).
 *
 * tenantId is accepted for signature symmetry but unused: site_builds has no
 * tenant_id column; RLS rides project_id → projects.tenant_id, and this runs
 * under the service role.
 */
export async function loadPriorReadyBuild(
  projectId: string,
  _tenantId: string,
): Promise<PriorBuildArtifacts | null> {
  const supabase = createAdminClient();
  const { data: build } = await supabase
    .from("site_builds")
    .select("id, config, status")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; config: Record<string, unknown> | null; status: string }>();
  if (!build) return null;

  const { data: pages } = await supabase
    .from("page_inventory")
    .select(
      "slug, post_type, title, route_path, block_count, paradigms, source_screenshot_paths, source_modified_gmt, block_tree",
    )
    .eq("site_build_id", build.id);
  const pageRows = (pages ?? []) as PriorPageRow[];

  const { data: blocks } = await supabase
    .from("block_inventory")
    .select("block_name, computed_styles, source_dom_sample")
    .eq("site_build_id", build.id);

  const priorRowsByKey = new Map<string, PriorPageRow>();
  for (const r of pageRows) priorRowsByKey.set(pageKey(r.post_type, r.slug), r);

  return {
    buildId: build.id,
    watermark: (build.config?.last_sync_watermark as string | undefined) ?? null,
    priorPages: toPriorPages(pageRows),
    priorRowsByKey,
    priorTreesByKey: toPriorTreesByKey(pageRows),
    priorBlockSamples: toPriorBlockSamples(
      (blocks ?? []) as Array<{ block_name: string; computed_styles: unknown | null; source_dom_sample: string | null }>,
    ),
  };
}
