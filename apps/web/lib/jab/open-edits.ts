import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * open-edits — shared vocabulary + cheap existence probe for in-flight
 * workspace edits.
 *
 * "Open" = the edit row itself is still moving (queued/running). A
 * status='completed' edit is NOT open — completed means "dispatched to the
 * pipeline"; from that point the LINKED build's active status is the signal
 * (ProjectBuildState.hasActiveBuild covers it). Keeping 'completed' out of
 * this set avoids polling forever on edits whose builds already finished.
 */
export const OPEN_EDIT_STATUSES = ["queued", "running"] as const;
export type OpenEditStatus = (typeof OPEN_EDIT_STATUSES)[number];

/**
 * Head-count probe used by the preview-pane poll (5s cadence) and the
 * workspace page render. RLS applies when called with the user client —
 * unauthorized callers see 0 rows, which reads as "nothing open".
 * Fails soft on query errors: a transient read failure must degrade to
 * "stop polling early", never throw into the pane.
 */
export async function hasOpenWorkspaceEdit(
  client: SupabaseClient,
  projectId: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("workspace_edits")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .in("status", [...OPEN_EDIT_STATUSES]);
  if (error) {
    console.warn(`[open-edits] count failed for project ${projectId}: ${error.message}`);
    return false;
  }
  return (count ?? 0) > 0;
}
