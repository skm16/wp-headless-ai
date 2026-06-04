import { isActiveBuildStatus } from "./build-status";

/**
 * active-edit-guard — pure concurrency decision for the workspace edit slot
 * (spec §3.4). One active build at a time AND one unpromoted-ready edit
 * ("edit_in_review") at a time. Readiness is derived by the CALLER from the
 * linked site_builds.status (never workspace_edits.status); this function
 * just takes the already-derived latest build status + in-review count.
 */

export interface EvaluateEditConcurrencyInput {
  /** Latest site_builds.status for the project (any config.mode). */
  latestBuildStatus: string | null | undefined;
  /**
   * Count of edits whose LINKED build is ready, not promoted, not cancelled —
   * derived by the caller from the join, per the §3.4 state-machine table.
   */
  editInReviewCount: number;
}

export type EditConcurrencyResult =
  | { ok: true }
  | { ok: false; code: "active_build" | "edit_in_review"; reason: string };

export function evaluateEditConcurrency(
  input: EvaluateEditConcurrencyInput,
): EditConcurrencyResult {
  if (isActiveBuildStatus(input.latestBuildStatus)) {
    return {
      ok: false,
      code: "active_build",
      reason: `A build is already in flight for this project (status=${input.latestBuildStatus}). Wait for it to finish before editing.`,
    };
  }
  if (input.editInReviewCount > 0) {
    return {
      ok: false,
      code: "edit_in_review",
      reason:
        "An edit is already waiting for review. Review (approve & promote) or discard it before starting another.",
    };
  }
  return { ok: true };
}
