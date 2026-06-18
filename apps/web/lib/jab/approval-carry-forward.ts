/**
 * approval-carry-forward — pure approval inheritance for edit builds (spec §3.4).
 *
 * Untouched pages inherit the SOURCE build's human approval; changed pages
 * reset to pending. Matches on SLUG (stable across builds), never
 * page_inventory.id (regenerated per build). A source-pending page is never
 * upgraded; a result page with no source row → pending. Fail-closed: a
 * genuinely-changed page can never inherit a stale approval.
 */

export type CarriedApprovalStatus =
  | "approved"
  | "approved_with_issues"
  | "rejected"
  | "pending";

export interface CarryForwardInput {
  /** Source build fidelity rows, keyed by page slug. */
  sourceFidelityRows: Array<{ slug: string; approvalStatus: string }>;
  /** Result build page rows: which result page_inventory.id maps to which slug. */
  resultPages: Array<{ slug: string; pageInventoryId: string }>;
  /** Slugs the edit actually changed (from computeChangedPages). */
  changedSlugs: string[];
  /**
   * Slugs whose NEW (this-build) fidelity row is blocking — a forced-zero
   * canonical score, a high-severity issue, or a per-viewport blocking flag
   * (see isBlockingFidelityRow). These are treated like changed pages: they
   * reset to pending and never inherit a stale approval, even when their
   * CONTENT is unchanged. Without this, a carried page that newly fails
   * (e.g. a mobile-layout break detected for the first time) would launder
   * the source build's `approved` status straight past the publish gate.
   * Optional — defaults to none (back-compat).
   */
  resultBlockingSlugs?: string[];
}

/**
 * Does THIS build's fidelity row count as blocking for carry-forward purposes?
 * True when the canonical score was forced to a hard 0 (desktop/mobile HTTP
 * failure or catastrophic-mobile divergence — see resolveCanonicalScore), OR
 * any issue is high-severity, OR any viewport entry is flagged blocking (the
 * catastrophic-mobile-divergence shape keeps its real, non-zero per-viewport
 * score but stamps `blocking: true`, so a score check alone would miss it).
 * Pure + defensive: tolerates the text-typed score column and missing fields.
 */
export function isBlockingFidelityRow(row: {
  score?: number | string | null;
  issues?: Array<{ severity?: string }> | null;
  viewportScores?: Record<string, { blocking?: boolean }> | null;
}): boolean {
  const scoreNum =
    typeof row.score === "number"
      ? row.score
      : typeof row.score === "string" && row.score.trim() !== ""
        ? Number.parseFloat(row.score)
        : null;
  if (scoreNum === 0) return true;
  if (Array.isArray(row.issues) && row.issues.some((i) => i?.severity === "high")) return true;
  if (row.viewportScores && typeof row.viewportScores === "object") {
    for (const entry of Object.values(row.viewportScores)) {
      if (entry && typeof entry === "object" && entry.blocking === true) return true;
    }
  }
  return false;
}

export interface CarryForwardPlan {
  /** Each result page's carried status, keyed by result page_inventory.id. */
  carry: Array<{ pageInventoryId: string; status: CarriedApprovalStatus }>;
  /** Slugs that were forced to pending (changed or result-only). */
  resetToPending: string[];
}

function normalize(status: string): CarriedApprovalStatus {
  if (
    status === "approved" ||
    status === "approved_with_issues" ||
    status === "rejected" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

export function planApprovalCarryForward(input: CarryForwardInput): CarryForwardPlan {
  const sourceBySlug = new Map<string, CarriedApprovalStatus>();
  for (const row of input.sourceFidelityRows) {
    sourceBySlug.set(row.slug, normalize(row.approvalStatus));
  }
  const changed = new Set(input.changedSlugs);
  const blocking = new Set(input.resultBlockingSlugs ?? []);

  const carry: CarryForwardPlan["carry"] = [];
  const resetToPending: string[] = [];

  for (const page of input.resultPages) {
    // A changed page OR a page whose NEW fidelity row is blocking resets to
    // pending and never inherits a stale approval — fail-closed in both the
    // content-diff sense AND the rendering-regression sense.
    if (changed.has(page.slug) || blocking.has(page.slug)) {
      carry.push({ pageInventoryId: page.pageInventoryId, status: "pending" });
      resetToPending.push(page.slug);
      continue;
    }
    const inherited = sourceBySlug.get(page.slug);
    if (inherited === undefined) {
      // Result-only page with no source approval → pending.
      carry.push({ pageInventoryId: page.pageInventoryId, status: "pending" });
      resetToPending.push(page.slug);
      continue;
    }
    carry.push({ pageInventoryId: page.pageInventoryId, status: inherited });
  }

  return { carry, resetToPending };
}
