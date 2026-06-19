import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FailedPhase } from "@/lib/jab/build-status";
import { isPublishDraftConfig } from "@/lib/jab/build-config";

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
    .eq("project_id", input.projectId)
    // A user discard (status='cancelled') must not be relabeled as a system failure.
    .neq("status", "cancelled");
  // Intentionally swallow update errors. The caller is already throwing;
  // logging the secondary failure here would just bury the original cause
  // in Inngest's error trace.

  await unlockPublishDraftLock(supabase, input.buildId, input.projectId);
}

/**
 * Live-Draft publish bridge: a publish build that reaches a terminal failure
 * MUST unlock its draft (publishing→active) so the user can fix + retry — never
 * strand a draft at 'publishing'. CAS on the 'publishing' lock so a concurrent
 * cancel (publishing→active) or a successful publish (publishing→published) is
 * never clobbered, and re-running is a no-op. Full/edit/non-publish builds carry
 * no draft and skip this entirely.
 *
 * Exported because several failure sites bypass markBuildFailed — they write
 * status='failed' directly and return WITHOUT throwing (deploy-site's
 * pollResult.outcome∈{ERROR,CANCELED,TIMEOUT} branch, compose's compile-gate
 * early-return, the stale-build sweep) — so the unlock must be callable there too.
 */
export async function unlockPublishDraftLock(
  supabase: ReturnType<typeof createAdminClient>,
  buildId: string,
  projectId: string,
): Promise<void> {
  const { data: buildRow } = await supabase
    .from("site_builds")
    .select("config")
    .eq("id", buildId)
    .eq("project_id", projectId)
    .maybeSingle<{ config: unknown }>();
  if (isPublishDraftConfig(buildRow?.config)) {
    await supabase
      .from("drafts")
      .update({ status: "active" })
      .eq("id", buildRow.config.draft_id)
      .eq("status", "publishing");
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
