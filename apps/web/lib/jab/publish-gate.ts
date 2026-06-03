/**
 * publish-gate — pure rules that decide whether a build is publishable.
 *
 * Phase 5 of the 2026-06-02 SaaS-app completion plan. The gate is a
 * deliberately small set of synchronous checks so unit tests can exhaust
 * every reject-branch. The publish server action calls evaluatePublishGate
 * and refuses on `ok: false`.
 */

export interface PublishGateInput {
  buildStatus: string | null | undefined;
  fidelityReports: ReadonlyArray<{ approval_status: string }>;
}

export type PublishGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "build_not_ready"
        | "no_fidelity_rows"
        | "unapproved_pages"
        | "rejected_pages";
      reason: string;
      unapprovedCount?: number;
      rejectedCount?: number;
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
