import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";
import type { BlockNode } from "@/lib/jab/ability-client";
import type { SourcePageForImpact } from "@/lib/jab/edit-impact";
import {
  planApprovalCarryForward,
  type CarriedApprovalStatus,
} from "@/lib/jab/approval-carry-forward";

/**
 * edit-site.helpers — service-role shims for the edit build (spec §3.4).
 * Pure shaping (buildCarryForwardUpdates) is unit-tested; the DB round-trips
 * are thin wrappers exercised by the worker smoke.
 */

/**
 * Columns an edit build's page_inventory clone must copy from the source
 * build. block_tree (0027) and source_modified_gmt (0026) are load-bearing:
 * without them the NEXT edit sourced from this build fail-closes
 * computeChangedPages to ALL pages (full re-review, carry-forward dead) and
 * incremental sync loses its watermark substrate. link (0033) is carried so
 * the compose-time sourcePathname→route_path rewriter works on edit builds.
 * See docs/superpowers/plans/2026-06-09-senior-review-fix-campaign.md (T3).
 */
export const PAGE_INVENTORY_CLONE_COLUMNS =
  "slug, post_type, title, route_path, block_count, source_screenshot_paths, rendering, paradigms, block_tree, source_modified_gmt, link";

/**
 * Columns an edit build's block_inventory clone must copy. Same drift class
 * as PAGE_INVENTORY_CLONE_COLUMNS — the schema-completeness test below forces
 * every future migration to make a conscious clone-or-exclude decision.
 * See docs/superpowers/plans/2026-06-09-senior-review-fix-campaign.md (T3).
 */
export const BLOCK_INVENTORY_CLONE_COLUMNS =
  "block_name, occurrence_count, page_slugs, attr_samples, computed_styles, source_dom_sample, tier, model_used, provider_used, input_tokens_cached, input_tokens_uncached, output_tokens, compile_status, compile_attempt_count, kind, spec";

/**
 * The two shell artifacts an edit build must clone from its source build.
 * Shells live at builds/<id>/project/components/site/{Header,Footer}.tsx —
 * under the project/ prefix, which edit-site's components/+source/ prefix
 * walk does NOT cover. Without this clone, shellArtifactExists() is false
 * on every fresh edit build and compose's edit-build shell reuse (Phase 4)
 * silently regenerates both shells — the exact spend the reuse exists to
 * remove (audit: edit-planner issue 1, CORRECTED clone premise).
 */
export function shellCloneObjects(
  sourceBuildId: string,
  resultBuildId: string,
): Array<{ from: string; to: string }> {
  return (["header", "footer"] as const).map((kind) => ({
    from: buildShellStoragePath(sourceBuildId, kind),
    to: buildShellStoragePath(resultBuildId, kind),
  }));
}

/** Load the SOURCE build's (slug, block_tree) rows for computeChangedPages. */
export async function loadSourcePagesForImpact(sourceBuildId: string): Promise<SourcePageForImpact[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("page_inventory")
    .select("slug, block_tree")
    .eq("site_build_id", sourceBuildId);
  if (error) throw error;
  return ((data ?? []) as Array<{ slug: string; block_tree: unknown }>).map((r) => ({
    slug: r.slug,
    blockTree: Array.isArray(r.block_tree) ? (r.block_tree as BlockNode[]) : null,
  }));
}

export interface SourceApprovalMeta {
  approvedByUserId: string | null;
  approvedAt: string | null;
}

export interface LoadSourceApprovalsResult {
  /** Pre-joined rows: slug + approvalStatus. */
  sourceFidelityRows: Array<{ slug: string; approvalStatus: string }>;
  /** slug → approver/timestamp, so inherited pages keep the human decision's provenance. */
  sourceSlugMeta: Map<string, SourceApprovalMeta>;
}

/**
 * Load the SOURCE build's fidelity rows joined to page slug. We need both the
 * status (for carry-forward) and the approver/timestamp (to preserve provenance
 * on inherited pages). fidelity_reports has no slug column — embed page_inventory.
 */
export async function loadSourceApprovals(sourceBuildId: string): Promise<LoadSourceApprovalsResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("fidelity_reports")
    .select("approval_status, approved_by_user_id, approved_at, page_inventory:page_inventory_id(slug)")
    .eq("site_build_id", sourceBuildId);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    approval_status: string;
    approved_by_user_id: string | null;
    approved_at: string | null;
    page_inventory: { slug: string } | { slug: string }[] | null;
  }>;
  const sourceFidelityRows: Array<{ slug: string; approvalStatus: string }> = [];
  const sourceSlugMeta = new Map<string, SourceApprovalMeta>();
  for (const r of rows) {
    const pi = Array.isArray(r.page_inventory) ? r.page_inventory[0] : r.page_inventory;
    const slug = pi?.slug;
    if (!slug) continue;
    sourceFidelityRows.push({ slug, approvalStatus: r.approval_status });
    sourceSlugMeta.set(slug, {
      approvedByUserId: r.approved_by_user_id,
      approvedAt: r.approved_at,
    });
  }
  return { sourceFidelityRows, sourceSlugMeta };
}

export interface CarryForwardUpdate {
  pageInventoryId: string;
  approvalStatus: CarriedApprovalStatus;
  approvedByUserId: string | null;
  approvedAt: string | null;
}

/**
 * Pure shaper: turn the carry-forward plan + source provenance into per-row
 * UPDATE payloads. Reset pages → pending + null provenance. Inherited pages →
 * the source slug's approver/timestamp (null when the source row had none).
 */
export function buildCarryForwardUpdates(args: {
  carry: Array<{ pageInventoryId: string; status: CarriedApprovalStatus }>;
  resetToPending: string[];
  resultIdToSlug: Map<string, string>;
  sourceSlugMeta: Map<string, SourceApprovalMeta>;
}): CarryForwardUpdate[] {
  const reset = new Set(args.resetToPending);
  return args.carry.map((c) => {
    const slug = args.resultIdToSlug.get(c.pageInventoryId);
    const isReset = slug !== undefined && reset.has(slug);
    if (isReset || c.status === "pending") {
      return {
        pageInventoryId: c.pageInventoryId,
        approvalStatus: "pending",
        approvedByUserId: null,
        approvedAt: null,
      };
    }
    const meta = slug ? args.sourceSlugMeta.get(slug) : undefined;
    return {
      pageInventoryId: c.pageInventoryId,
      approvalStatus: c.status,
      approvedByUserId: meta?.approvedByUserId ?? null,
      approvedAt: meta?.approvedAt ?? null,
    };
  });
}

/**
 * Apply approval carry-forward to the RESULT build's cloned fidelity_reports.
 * Loads source approvals + result page slugs, computes the plan, shapes the
 * updates, and issues per-row UPDATEs via service-role.
 */
export async function applyCarryForwardApprovals(args: {
  resultBuildId: string;
  sourceBuildId: string;
  changedSlugs: string[];
}): Promise<{ updated: number }> {
  const supabase = createAdminClient();

  const { data: resultPagesRaw, error: resultPagesError } = await supabase
    .from("page_inventory")
    .select("id, slug")
    .eq("site_build_id", args.resultBuildId);
  if (resultPagesError) throw resultPagesError;
  const resultPages = ((resultPagesRaw ?? []) as Array<{ id: string; slug: string }>).map((p) => ({
    slug: p.slug,
    pageInventoryId: p.id,
  }));
  const resultIdToSlug = new Map(resultPages.map((p) => [p.pageInventoryId, p.slug]));

  const { sourceFidelityRows, sourceSlugMeta } = await loadSourceApprovals(args.sourceBuildId);

  const plan = planApprovalCarryForward({
    sourceFidelityRows,
    resultPages,
    changedSlugs: args.changedSlugs,
  });

  const updates = buildCarryForwardUpdates({
    carry: plan.carry,
    resetToPending: plan.resetToPending,
    resultIdToSlug,
    sourceSlugMeta,
  });

  let updated = 0;
  const errors: string[] = [];
  for (const u of updates) {
    const { error } = await supabase
      .from("fidelity_reports")
      .update({
        approval_status: u.approvalStatus,
        approved_by_user_id: u.approvedByUserId,
        approved_at: u.approvedAt,
      })
      .eq("site_build_id", args.resultBuildId)
      .eq("page_inventory_id", u.pageInventoryId);
    if (error) {
      errors.push(`page ${u.pageInventoryId}: ${error.message}`);
    } else {
      updated++;
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `applyCarryForwardApprovals: ${errors.length} fidelity UPDATE(s) failed:\n${errors.join("\n")}`,
    );
  }
  return { updated };
}
