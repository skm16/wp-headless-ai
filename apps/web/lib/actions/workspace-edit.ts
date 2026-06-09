"use server";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  WorkspaceEditError,
  validateEditInput,
  type WorkspaceEditScope,
} from "@/lib/jab/workspace-edit-validation";
import { isUniqueViolation } from "@/lib/db/pg-error";
import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
import { evaluateEditConcurrency } from "@/lib/jab/active-edit-guard";
import { isEditAwaitingReview } from "@/lib/jab/workspace-edit-state";

/**
 * workspace-edit — Phase 7 entry point. The workspace UI calls
 * requestWorkspaceEditAction when the user submits a targeted edit
 * prompt against a build. We:
 *
 *   1. RLS-verify project membership (single SELECT).
 *   2. Verify the source build is the latest 'ready' build for the
 *      project (we deliberately disallow editing older builds — the
 *      project always edits forward from the current state).
 *   3. Validate scope + target shape (component / shell only in v1)
 *      via validateEditInput from lib/jab/workspace-edit-validation.ts.
 *   4. Insert a workspace_edits row scoped to the calling user.
 *   5. Dispatch site/edit.requested for the worker to pick up.
 *
 * Non-async exports (WorkspaceEditError, validateEditInput, the scope
 * type) live in lib/jab/workspace-edit-validation.ts because Next.js
 * forbids non-async exports from "use server" files.
 */

export interface RequestWorkspaceEditInput {
  projectId: string;
  sourceBuildId: string;
  scope: WorkspaceEditScope;
  /**
   * Block name for `scope='component'`, 'header'/'footer' for
   * `scope='shell'`. Validated against the scope below.
   */
  target: string;
  prompt: string;
  /** NEW — planner guidance; falls back to `prompt` when omitted (manual form). */
  regenerationPrompt?: string;
  /** NEW — planner action summary. */
  action?: string;
  /** NEW — the chat message that triggered this edit. */
  messageId?: string | null;
}

export interface RequestWorkspaceEditResult {
  editId: string;
}

export async function requestWorkspaceEditAction(
  input: RequestWorkspaceEditInput,
): Promise<RequestWorkspaceEditResult> {
  validateEditInput(input);
  const supabase = await createClient();

  // Resolve project + tenant via RLS-scoped SELECT (PGRST116 = not yours).
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", input.projectId)
    .single<{ id: string; tenant_id: string }>();
  if (projectErr?.code === "PGRST116" || !project) {
    throw new WorkspaceEditError("not_found", "Project not found.");
  }
  if (projectErr) throw projectErr;

  // Source build must be 'ready' AND belong to this project. RLS already
  // checks the project; double-check the build status here.
  const { data: build, error: buildErr } = await supabase
    .from("site_builds")
    .select("id, status")
    .eq("id", input.sourceBuildId)
    .eq("project_id", input.projectId)
    .single<{ id: string; status: string }>();
  if (buildErr?.code === "PGRST116" || !build) {
    throw new WorkspaceEditError("not_found", "Source build not found.");
  }
  if (buildErr) throw buildErr;
  if (build.status !== "ready") {
    throw new WorkspaceEditError(
      "source_not_ready",
      `Source build is in status='${build.status}'. Targeted edits only run against 'ready' builds.`,
    );
  }

  // Concurrency guard (§3.4). Readiness derives from the LINKED site_builds
  // status, never workspace_edits.status. Service-role reads — project
  // membership was RLS-verified above.
  const guardAdmin = createAdminClient();
  const [{ data: latestBuilds }, { data: openEdits }] = await Promise.all([
    guardAdmin
      .from("site_builds")
      .select("status")
      .eq("project_id", input.projectId)
      .order("created_at", { ascending: false })
      .limit(1),
    guardAdmin
      .from("workspace_edits")
      .select("status, result_promoted_deployment_id, result_build:result_build_id(status)")
      .eq("project_id", input.projectId)
      .in("status", ["completed"]),
  ]);
  const latestStatus = (latestBuilds?.[0] as { status: string } | undefined)?.status ?? null;
  const editInReviewCount = (openEdits ?? []).filter((e) => {
    const row = e as {
      status: string;
      result_promoted_deployment_id: string | null;
      result_build: { status: string } | { status: string }[] | null;
    };
    const rb = Array.isArray(row.result_build) ? row.result_build[0] : row.result_build;
    return isEditAwaitingReview({
      editStatus: row.status,
      buildStatus: rb?.status ?? null,
      promoted: row.result_promoted_deployment_id !== null,
    });
  }).length;

  const concurrency = evaluateEditConcurrency({ latestBuildStatus: latestStatus, editInReviewCount });
  if (!concurrency.ok) {
    throw new WorkspaceEditError(concurrency.code, concurrency.reason);
  }

  // Resolve the calling user — auth.users.id is the user_id column on
  // workspace_edits (matched by the RLS WITH CHECK auth.uid() = user_id).
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new Error("Not authenticated.");
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("workspace_edits")
    .insert({
      project_id: input.projectId,
      tenant_id: project.tenant_id,
      source_build_id: input.sourceBuildId,
      user_id: user.id,
      scope: input.scope,
      target: input.target,
      prompt: input.prompt,
      regeneration_prompt: input.regenerationPrompt ?? input.prompt,
      action: input.action ?? null,
      message_id: input.messageId ?? null,
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    // The 0031 one-active-build index can surface 23505 if a concurrent edit
    // produced a second active build for this project. Translate to the
    // friendly 'active_build' error rather than leaking a raw Postgres code.
    // (workspace_edits itself is not the indexed table — the 23505 originates
    // from the result-build phase transition — but the edit path shares the
    // active-build guard, so we translate here for a consistent UX; spec §3.4.)
    if (isUniqueViolation(insertErr)) {
      throw new WorkspaceEditError(
        "active_build",
        "Another build is already active for this project. Wait for it to finish before editing.",
      );
    }
    throw new Error(
      `workspace_edits insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
  }

  const payload: SiteEditRequestedData = {
    editId: inserted.id,
    projectId: input.projectId,
    tenantId: project.tenant_id,
    sourceBuildId: input.sourceBuildId,
    scope: input.scope,
    target: input.target,
    prompt: input.prompt,
    regenerationPrompt: input.regenerationPrompt ?? input.prompt,
    action: input.action,
    messageId: input.messageId ?? null,
  };
  try {
    await inngest.send({ name: EDIT_REQUESTED_EVENT, data: payload });
  } catch (err) {
    // Same stranded-'queued' class as triggerBuildAction — here it's the
    // workspace_edits row that would stick at 'queued' and wedge the
    // edit-concurrency guard.
    await guardAdmin
      .from("workspace_edits")
      .update({
        status: "failed",
        error_text: `edit dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    throw new WorkspaceEditError(
      "dispatch_failed",
      "The edit couldn't be handed to the worker queue (is Inngest running?). Retry when the queue is back.",
    );
  }

  return { editId: inserted.id };
}

