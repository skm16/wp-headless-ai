/**
 * publish-gate — pure rules that decide whether a build is publishable.
 *
 * Phase 5 of the 2026-06-02 SaaS-app completion plan, hardened by F3
 * (code-review 2026-06-03): the gate now requires the fidelity row count
 * to match the page inventory count so a partial verification can't pass
 * on the subset of pages that happen to have a row.
 *
 * The gate is a deliberately small set of synchronous checks so unit
 * tests can exhaust every reject-branch. The publish server action calls
 * evaluatePublishGate and refuses on `ok: false`.
 */

export interface PublishGateInput {
  buildStatus: string | null | undefined;
  fidelityReports: ReadonlyArray<{ approval_status: string }>;
  /**
   * Expected number of fidelity rows (= number of pages in the build's
   * inventory). When provided and the actual row count is lower, the gate
   * rejects with `missing_fidelity_rows`. Optional for backwards
   * compatibility with the existing unit-test surface — production callers
   * (publishBuildAction + the review page) ALWAYS pass it.
   */
  pageInventoryCount?: number;
}

export type PublishGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "build_not_ready"
        | "no_fidelity_rows"
        | "missing_fidelity_rows"
        | "unapproved_pages"
        | "rejected_pages";
      reason: string;
      unapprovedCount?: number;
      rejectedCount?: number;
      missingCount?: number;
    };

const ACCEPTING_STATUSES = new Set(["approved", "approved_with_issues"]);

export function evaluatePublishGate(
  input: PublishGateInput,
): PublishGateResult {
  if (input.buildStatus !== "ready") {
    return {
      ok: false,
      code: "build_not_ready",
      reason: `Build is in status='${input.buildStatus ?? "unknown"}'. Only 'ready' builds can be published.`,
    };
  }
  if (input.fidelityReports.length === 0) {
    return {
      ok: false,
      code: "no_fidelity_rows",
      reason:
        "No fidelity reports were written for this build. Re-trigger verification before publishing.",
    };
  }
  // F3: every page in the inventory must have a fidelity row. Checked
  // before the approval branches because a missing row is a more
  // fundamental incompleteness than an unapproved/rejected one — you
  // can't approve a page that was never scored.
  if (
    typeof input.pageInventoryCount === "number" &&
    input.pageInventoryCount > input.fidelityReports.length
  ) {
    const missingCount = input.pageInventoryCount - input.fidelityReports.length;
    return {
      ok: false,
      code: "missing_fidelity_rows",
      reason: `${missingCount} page(s) have no fidelity row. Re-trigger verification so every page is scored before publishing.`,
      missingCount,
    };
  }
  const rejectedCount = input.fidelityReports.filter(
    (r) => r.approval_status === "rejected",
  ).length;
  if (rejectedCount > 0) {
    return {
      ok: false,
      code: "rejected_pages",
      reason: `${rejectedCount} page(s) are still rejected. Resolve them (approve, approve-with-issues, or re-run the build) before publishing.`,
      rejectedCount,
    };
  }
  const unapprovedCount = input.fidelityReports.filter(
    (r) => !ACCEPTING_STATUSES.has(r.approval_status),
  ).length;
  if (unapprovedCount > 0) {
    return {
      ok: false,
      code: "unapproved_pages",
      reason: `${unapprovedCount} page(s) are still pending review. Approve each page (approve or approve-with-issues) before publishing.`,
      unapprovedCount,
    };
  }
  return { ok: true };
}
