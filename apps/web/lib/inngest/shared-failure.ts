import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FailedPhase } from "@/lib/jab/build-status";

/**
 * markBuildFailed — idempotent failure writer for the site_builds state
 * machine. Phase 2 of the 2026-06-02 SaaS-app completion plan extracts
 * the duplicated try/catch update calls from each worker into one place.
 *
 * Idempotency: re-running on a row already in `status='failed'` is a
 * no-op-equivalent (the new row UPDATE just overwrites with the same
 * shape). Workers should call this BEFORE re-throwing so Inngest's
 * surface and the DB stay in sync.
 *
 * F5: if the failing build is the result of a targeted workspace edit,
 * the originating workspace_edits row's terminal state is owned by the
 * downstream pipeline (edit-site only dispatched compose). So this helper
 * also flips the matching workspace_edits row (by result_build_id) to
 * 'failed' — gated on status='running' so it's a no-op for full
 * (non-edit) builds and idempotent on replay.
 *
 * Service-role on purpose — site_builds has no UPDATE policy for
 * authenticated users; the workers are the only writers.
 */
export interface MarkBuildFailedInput {
  buildId: string;
  projectId: string;
  phase: FailedPhase;
  error: unknown;
}

export async function markBuildFailed(
  input: MarkBuildFailedInput,
): Promise<void> {
  const errorText = formatErrorText(input.error);
  const supabase = createAdminClient();
  await supabase
    .from("site_builds")
    .update({
      status: "failed",
      failed_phase: input.phase,
      error_text: errorText,
      finished_at: new Date().toISOString(),
    })
    .eq("id", input.buildId)
    .eq("project_id", input.projectId);

  // F5: cascade the failure to the originating workspace_edits row (if any).
  await cascadeWorkspaceEditFailure(supabase, input.buildId, errorText);

  // Intentionally swallow update errors. The caller is already throwing;
  // logging the secondary failure here would just bury the original cause
  // in Inngest's error trace.
}

/**
 * cascadeWorkspaceEditFailure — F5 shared chokepoint. If `buildId` is the
 * result build of a targeted workspace edit, flip that workspace_edits row
 * to 'failed' with the same error text.
 *
 * Best-effort + idempotent: gated on status='running' so it's a no-op for
 * full (non-edit) builds — which have no workspace_edits row pointing at
 * them — and for replays. Swallows its own error (logs a warning): callers
 * are already on a failure path, and a cascade miss must neither mask the
 * original failure nor fail an Inngest step.
 *
 * Shared so the THREE writers that set site_builds.status='failed' stay
 * consistent: markBuildFailed (above), deploy-site's Vercel-poll on-failure
 * step, and compile-generated-project's typecheck-failure update. The
 * latter two write phase-specific columns (build_log_storage_path,
 * vercel_deployment_id) directly rather than routing through
 * markBuildFailed — but they MUST still cascade the edit row, or an edit
 * whose deploy/compose fails is stuck 'running' forever.
 */
export async function cascadeWorkspaceEditFailure(
  supabase: SupabaseClient,
  buildId: string,
  errorText: string,
): Promise<void> {
  const { error } = await supabase
    .from("workspace_edits")
    .update({
      status: "failed",
      error_text: errorText,
      finished_at: new Date().toISOString(),
    })
    .eq("result_build_id", buildId)
    .eq("status", "running");
  if (error) {
    console.warn(
      `[cascadeWorkspaceEditFailure] update failed for result_build_id=${buildId}: ${error.message}`,
    );
  }
}

export function formatErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
