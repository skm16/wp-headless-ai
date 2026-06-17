import { isActiveBuildStatus } from "./build-status";

/**
 * workspace-edit-state — the §3.4 edit state machine as a pure function.
 * Readiness derives from the LINKED site_builds.status, never
 * workspace_edits.status ('completed' means "dispatched", not "preview-ready").
 */

export interface EditUiStateInput {
  editStatus: string;
  /** Linked site_builds.status; null when no result build yet. */
  buildStatus: string | null;
  /** True when result_promoted_deployment_id is set. */
  promoted: boolean;
}

export type EditUiLabel =
  | "Applied"
  | "Submitting…"
  | "Building…"
  | "Review ready"
  | "Live"
  | "Discarded"
  | "Failed";

export interface EditUiState {
  label: EditUiLabel;
  awaitingReview: boolean;
}

/**
 * Derive the canonical UI label and review-gate flag for a workspace edit.
 *
 * Precedence order (most specific / terminal first):
 *   1. Discarded / cancelled — terminal, show "Discarded"
 *   2. Failed (edit or build) — terminal, show "Failed"
 *   3. queued / running (no build dispatched yet) — "Submitting…"
 *   4. completed + build ready + promoted — "Live"
 *   5. completed + build ready — "Review ready"
 *   6. completed + build active — "Building…" (future build-based edits)
 *   7. completed + no build — "Applied" (Live Draft: edit applied to draft, no build)
 */
export function deriveEditUiState(input: EditUiStateInput): EditUiState {
  // 1. Terminal: discarded or build cancelled
  if (input.editStatus === "discarded" || input.buildStatus === "cancelled") {
    return { label: "Discarded", awaitingReview: false };
  }

  // 2. Terminal: failed
  if (input.editStatus === "failed" || input.buildStatus === "failed") {
    return { label: "Failed", awaitingReview: false };
  }

  // 3. Pre-dispatch: edit hasn't been picked up yet
  if (input.editStatus === "queued" || input.editStatus === "running") {
    return { label: "Submitting…", awaitingReview: false };
  }

  // 4–7. edit is "completed" (dispatched) — derive readiness from the linked build
  if (input.buildStatus === "ready") {
    if (input.promoted) return { label: "Live", awaitingReview: false };
    return { label: "Review ready", awaitingReview: true };
  }

  if (isActiveBuildStatus(input.buildStatus)) {
    return { label: "Building…", awaitingReview: false };
  }

  // completed with no linked build — Live Draft path: edit applied to the draft
  return { label: "Applied", awaitingReview: false };
}

export function isEditAwaitingReview(input: EditUiStateInput): boolean {
  return deriveEditUiState(input).awaitingReview;
}
