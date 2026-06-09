import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  FAILED_PHASES,
  isStaleActiveBuild,
  type FailedPhase,
} from "@/lib/jab/build-status";

/**
 * If the project's LATEST build is active but stale (wedged worker / lost
 * dispatch), flip it to failed so the user can build/edit again without the
 * operator SQL documented on migration 0031. Compare-and-set on status so a
 * build that just progressed is never clobbered. The linked workspace_edit
 * (if any) needs no write — its UI state derives from the build status
 * (deriveEditUiState). Returns true when a row was auto-failed.
 */
export async function autoFailStaleActiveBuild(projectId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("site_builds")
    .select("id, status, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = (data ?? [])[0] as
    | { id: string; status: string; created_at: string }
    | undefined;
  if (!latest || !isStaleActiveBuild(latest.status, latest.created_at, Date.now())) {
    return false;
  }
  const failedPhase = (FAILED_PHASES as readonly string[]).includes(latest.status)
    ? (latest.status as FailedPhase)
    : null;
  const { error } = await admin
    .from("site_builds")
    .update({
      status: "failed",
      failed_phase: failedPhase,
      error_text: `auto-failed: stuck in '${latest.status}' for over 45 minutes (wedged worker or lost dispatch)`,
      finished_at: new Date().toISOString(),
    })
    .eq("id", latest.id)
    .eq("status", latest.status);
  if (error) {
    console.error(`[auto-fail-stale-build] update failed for ${latest.id}: ${error.message}`);
    return false;
  }
  return true;
}
