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

  const carry: CarryForwardPlan["carry"] = [];
  const resetToPending: string[] = [];

  for (const page of input.resultPages) {
    if (changed.has(page.slug)) {
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
