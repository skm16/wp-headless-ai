"use server";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import {
  WorkspaceEditError,
  validateEditInput,
  type WorkspaceEditScope,
} from "@/lib/jab/workspace-edit-validation";

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
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    throw new Error(
      `workspace_edits insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
  }

  await inngest.send({
    name: "site/edit.requested",
    data: {
      editId: inserted.id,
      projectId: input.projectId,
      tenantId: project.tenant_id,
      sourceBuildId: input.sourceBuildId,
      scope: input.scope,
      target: input.target,
      prompt: input.prompt,
    },
  });

  return { editId: inserted.id };
}
