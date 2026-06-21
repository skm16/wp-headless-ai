import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ACTIVE_BUILD_PHASES,
  FAILED_PHASES,
  STALE_ACTIVE_BUILD_MINUTES,
  isStaleActiveBuild,
  type FailedPhase,
} from "@/lib/jab/build-status";
import { unlockPublishDraftLock } from "@/lib/inngest/shared-failure";

/**
 * Sweeps ALL active site_builds rows for the project that are older than
 * STALE_ACTIVE_BUILD_MINUTES and flips them to failed. An older wedged active
 * row (e.g. latest=queued + older=composing after a race) is unreachable
 * forever if only the latest row is checked.
 *
 * Compare-and-set on status so a build that just progressed is never clobbered.
 * Returns true when at least one row was actually healed (row-count checked
 * via .select).
 *
 * // The linked workspace_edit gets no write here; the edit-history chip derives
 * // from the linked build status (T8 wires deriveEditUiState into the chip).
 */
export async function autoFailStaleActiveBuild(projectId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error: readErr } = await admin
    .from("site_builds")
    .select("id, status, created_at")
    .eq("project_id", projectId)
    .in("status", ACTIVE_BUILD_PHASES as unknown as string[]);
  if (readErr) {
    console.error(`[auto-fail-stale-build] read failed for project ${projectId}: ${readErr.message}`);
    return false;
  }
  const now = Date.now();
  const stale = (data ?? []).filter((b) =>
    isStaleActiveBuild((b as { status: string }).status, (b as { created_at: string }).created_at, now),
  ) as Array<{ id: string; status: string; created_at: string }>;
  if (stale.length === 0) return false;

  let healed = 0;
  for (const b of stale) {
    const failedPhase = (FAILED_PHASES as readonly string[]).includes(b.status)
      ? (b.status as FailedPhase)
      : null;
    const { data: updated, error } = await admin
      .from("site_builds")
      .update({
        status: "failed",
        failed_phase: failedPhase,
        error_text: `auto-failed: active for over ${STALE_ACTIVE_BUILD_MINUTES} minutes in '${b.status}' (wedged worker or lost dispatch)`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", b.id)
      .eq("status", b.status) // compare-and-set: never clobber a row that just progressed
      .select("id");
    if (error) {
      console.error(`[auto-fail-stale-build] update failed for ${b.id}: ${error.message}`);
    } else if ((updated ?? []).length > 0) {
      healed++;
      // A wedged publish build must unlock its draft (publishing→active), or the
      // sweep heals the build but the draft stays stranded at 'publishing'.
      await unlockPublishDraftLock(admin, b.id, projectId);
    }
  }
  return healed > 0;
}
