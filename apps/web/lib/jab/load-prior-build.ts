import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PriorPage } from "./incremental";

export function toPriorPages(
  rows: Array<{ slug: string; post_type: string; source_modified_gmt: string | null }>,
): PriorPage[] {
  return rows.map((r) => ({ slug: r.slug, postType: r.post_type, modifiedGmt: r.source_modified_gmt }));
}

/**
 * Load the most recent `ready` build for a project: its sync watermark (from
 * site_builds.config.last_sync_watermark) and the per-page modified map. Used
 * to compute the incremental change set on a re-build. Returns null when no
 * prior ready build exists (first build → full sync).
 *
 * tenantId is accepted for signature symmetry with the other loaders but is
 * not used in the WHERE clause: site_builds has no tenant_id column; RLS rides
 * project_id → projects.tenant_id, and this runs under the service role.
 */
export async function loadPriorReadyBuild(
  projectId: string,
  _tenantId: string,
): Promise<{ buildId: string; watermark: string | null; priorPages: PriorPage[] } | null> {
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
    .select("slug, post_type, source_modified_gmt")
    .eq("site_build_id", build.id);
  return {
    buildId: build.id,
    watermark: (build.config?.last_sync_watermark as string | undefined) ?? null,
    priorPages: toPriorPages(pages ?? []),
  };
}
