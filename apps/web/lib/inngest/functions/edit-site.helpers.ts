import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BlockNode } from "@/lib/jab/ability-client";
import type { SourcePageForImpact } from "@/lib/jab/edit-impact";
import {
  planApprovalCarryForward,
  isBlockingFidelityRow,
  type CarriedApprovalStatus,
} from "@/lib/jab/approval-carry-forward";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

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

/**
 * Load the RESULT build's slugs whose freshly-scored fidelity row is blocking
 * (forced-zero score, a high-severity issue, or a per-viewport blocking flag).
 * Runs AFTER persist-fidelity, so the rows reflect THIS build's scoring. These
 * slugs are fed to carry-forward so a carried (content-unchanged) page that now
 * renders broken cannot inherit a stale `approved` and slip past the gate.
 */
export async function loadResultBlockingSlugs(resultBuildId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("fidelity_reports")
    .select("score, issues, viewport_scores, page_inventory:page_inventory_id(slug)")
    .eq("site_build_id", resultBuildId);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    score: string | null;
    issues: Array<{ severity?: string }> | null;
    viewport_scores: Record<string, { blocking?: boolean }> | null;
    page_inventory: { slug: string } | { slug: string }[] | null;
  }>;
  const out: string[] = [];
  for (const r of rows) {
    const pi = Array.isArray(r.page_inventory) ? r.page_inventory[0] : r.page_inventory;
    const slug = pi?.slug;
    if (!slug) continue;
    if (isBlockingFidelityRow({ score: r.score, issues: r.issues, viewportScores: r.viewport_scores })) {
      out.push(slug);
    }
  }
  return out;
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
  const resultBlockingSlugs = await loadResultBlockingSlugs(args.resultBuildId);

  const plan = planApprovalCarryForward({
    sourceFidelityRows,
    resultPages,
    changedSlugs: args.changedSlugs,
    resultBlockingSlugs,
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

/**
 * Recursively list every object under a Storage prefix. supabase.storage
 * .list() is paginated and one-level-deep — we descend into directories
 * manually because the components/ and source/ prefixes have nested
 * viewport folders.
 *
 * Moved here from the retired edit-site.ts (Live Draft Phase 2, Task 6) so
 * callers like discard-edit.ts are not broken by the deletion.
 */
export async function listAllUnderPrefix(
  supabase: ReturnType<typeof createAdminClient>,
  prefix: string,
): Promise<string[]> {
  const queue: string[] = [prefix];
  const out: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { data, error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .list(current, { limit: 1000 });
    if (error || !data) continue;
    for (const item of data) {
      // Folders surface as entries with id===null in Supabase Storage.
      if (item.id === null) {
        queue.push(`${current}/${item.name}`);
      } else {
        out.push(`${current}/${item.name}`);
      }
    }
  }
  return out;
}
