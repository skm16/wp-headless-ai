import "server-only";
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
  // Intentionally swallow update errors. The caller is already throwing;
  // logging the secondary failure here would just bury the original cause
  // in Inngest's error trace.
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
