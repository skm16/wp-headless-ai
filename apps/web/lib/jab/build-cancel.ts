import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * build-cancel — shared cancel check for the edit pipeline workers (spec §3.4).
 * discardEditAction sets site_builds.status='cancelled' directly; compose,
 * deploy, and verify re-read at entry and bail if cancelled so a discard
 * actually stops the pipeline (not cosmetic). Fail-open on read error
 * (deliberate — a transient read must not abort a legitimate build; verify's
 * final ready flip is WHERE status != 'cancelled' as the real backstop).
 */
export async function isBuildCancelled(
  supabase: SupabaseClient,
  buildId: string,
  projectId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("site_builds")
    .select("status")
    .eq("id", buildId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { status: string }).status === "cancelled";
}
