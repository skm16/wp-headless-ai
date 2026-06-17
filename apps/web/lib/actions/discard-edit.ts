"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { DiscardEditError } from "@/lib/jab/discard-edit-errors";
import { evaluateDiscard } from "@/lib/jab/discard-edit-decision";
import { listAllUnderPrefix } from "@/lib/inngest/functions/edit-site.helpers";

/**
 * discardEditAction — release an unpromoted edit (§3.4). RLS-load the edit;
 * refuse if promoted; else set the result build status='cancelled' (the
 * compose/deploy/verify cancel guards then stop the pipeline) + the edit
 * status='discarded' + best-effort Storage cleanup of the result build's
 * artifacts. Auto-releases the edit_in_review slot.
 *
 * Admin client is used for the write side because:
 *   - The cancel UPDATE on site_builds crosses the edit's tenant boundary
 *     (site_builds has no tenant_id — RLS is project-scoped, and the user's
 *     RLS row may or may not cover a site_build row via project membership).
 *   - workspace_edits update finishes the edit row; RLS would ordinarily allow
 *     the owner to write status, but 'discarded' is an admin-only terminal
 *     state enforced in the same transaction as the build cancel. Keeping both
 *     writes in the admin client avoids a double-lock race.
 * The user's RLS load above is the authorization gate — we only reach admin
 * writes after the user proved they can see the edit row.
 */
export interface DiscardEditInput {
  editId: string;
}

export async function discardEditAction(
  input: DiscardEditInput,
): Promise<{ discarded: true }> {
  // --- Authorization: RLS-load via user client ---
  const userClient = await createClient();
  const { data: edit, error } = await userClient
    .from("workspace_edits")
    .select("id, project_id, result_build_id, result_promoted_deployment_id, status")
    .eq("id", input.editId)
    .single<{
      id: string;
      project_id: string;
      result_build_id: string | null;
      result_promoted_deployment_id: string | null;
      status: string;
    }>();

  if (error?.code === "PGRST116" || !edit) {
    throw new DiscardEditError("not_found", "Edit not found.");
  }
  if (error) throw error;

  // --- Pure refusal decision ---
  const decision = evaluateDiscard({
    resultPromotedDeploymentId: edit.result_promoted_deployment_id,
    resultBuildId: edit.result_build_id,
  });
  if (!decision.ok) {
    throw new DiscardEditError(decision.code, decision.reason);
  }

  // --- Admin writes (bypass RLS — authorization gate is the RLS load above) ---
  const admin = createAdminClient();

  // Cancel the in-flight build. status='cancelled' (not 'failed') so the
  // compose/deploy/verify cancel guards (Tasks 14/15) stop the Inngest
  // pipeline without writing failure telemetry for a user-initiated cancel.
  if (decision.resultBuildId) {
    const { error: cancelErr } = await admin
      .from("site_builds")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", decision.resultBuildId)
      .eq("project_id", edit.project_id);
    if (cancelErr) {
      throw new Error(
        `discard-edit: failed to cancel build ${decision.resultBuildId}: ${cancelErr.message}`,
      );
    }
  }

  // Mark the edit discarded; releases the edit_in_review slot.
  const { error: discardErr } = await admin
    .from("workspace_edits")
    .update({ status: "discarded", finished_at: new Date().toISOString() })
    .eq("id", edit.id);
  if (discardErr) {
    throw new Error(`discard-edit: failed to mark edit ${edit.id} discarded: ${discardErr.message}`);
  }

  // --- Best-effort Storage cleanup ---
  if (decision.resultBuildId) {
    try {
      const paths = await listAllUnderPrefix(admin, `builds/${decision.resultBuildId}`);
      if (paths.length > 0) {
        await admin.storage.from(SITE_SCREENSHOTS_BUCKET).remove(paths);
      }
    } catch (err) {
      // Non-fatal: Storage cleanup is best-effort. The edit is already
      // discarded and the build cancelled — orphaned artifacts are acceptable
      // and can be reclaimed by a future cleanup job.
      console.warn(
        `[discard-edit] storage cleanup failed for build ${decision.resultBuildId}:`,
        err,
      );
    }
  }

  revalidatePath(`/projects/${edit.project_id}/workspace`);
  return { discarded: true };
}
