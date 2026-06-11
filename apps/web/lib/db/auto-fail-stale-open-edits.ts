// apps/web/lib/db/auto-fail-stale-open-edits.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPEN_EDIT_STATUSES, type OpenEditStatus } from "@/lib/jab/open-edits";

/**
 * Sweeps stranded workspace_edits rows — the edit analogue of
 * autoFailStaleActiveBuild (lib/db/auto-fail-stale-build.ts).
 *
 * Why this exists: edit-site runs with retries:0. A transport-level failure
 * on the worker invoke (e.g. the Next dev server answering mid-HMR-recompile
 * with an HTML error page — the 2026-06-10 stranded edit) kills the run
 * before ANY step executes, so the worker's own failure handling never
 * writes status='failed'. The row wedges at 'queued' ("Submitting…")
 * forever and nothing in the UI explains why.
 *
 * Thresholds: a healthy dispatch is picked up in well under a second, so
 * 10 minutes at 'queued' is conclusive. 'running' gets the same 45-minute
 * ceiling as builds (clone + regen takes minutes, not tens of minutes).
 */
export const STALE_QUEUED_EDIT_MINUTES = 10;
export const STALE_RUNNING_EDIT_MINUTES = 45;

const STALE_MS: Record<OpenEditStatus, number> = {
  queued: STALE_QUEUED_EDIT_MINUTES * 60 * 1000,
  running: STALE_RUNNING_EDIT_MINUTES * 60 * 1000,
};

export function isStaleOpenEdit(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!status || !(OPEN_EDIT_STATUSES as readonly string[]).includes(status) || !createdAt) {
    return false;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > STALE_MS[status as OpenEditStatus];
}

export async function autoFailStaleOpenEdits(projectId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error: readErr } = await admin
    .from("workspace_edits")
    .select("id, status, created_at")
    .eq("project_id", projectId)
    .in("status", [...OPEN_EDIT_STATUSES]);
  if (readErr) {
    console.error(`[auto-fail-stale-edits] read failed for project ${projectId}: ${readErr.message}`);
    return false;
  }
  const now = Date.now();
  const stale = (data ?? []).filter((e) =>
    isStaleOpenEdit(
      (e as { status: string }).status,
      (e as { created_at: string }).created_at,
      now,
    ),
  ) as Array<{ id: string; status: OpenEditStatus; created_at: string }>;
  if (stale.length === 0) return false;

  let healed = 0;
  for (const e of stale) {
    const minutes =
      e.status === "queued" ? STALE_QUEUED_EDIT_MINUTES : STALE_RUNNING_EDIT_MINUTES;
    const { data: updated, error } = await admin
      .from("workspace_edits")
      .update({
        status: "failed",
        error_text: `auto-failed: '${e.status}' for over ${minutes} minutes (worker lost, crashed, or the dispatch died before any step ran)`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", e.id)
      .eq("status", e.status) // compare-and-set: never clobber a row that just progressed
      .select("id");
    if (error) {
      console.error(`[auto-fail-stale-edits] update failed for ${e.id}: ${error.message}`);
    } else if ((updated ?? []).length > 0) {
      healed++;
    }
  }
  return healed > 0;
}
