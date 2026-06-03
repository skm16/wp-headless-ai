"use server";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * workspace-edit — Phase 7 entry point. The workspace UI calls
 * requestWorkspaceEditAction when the user submits a targeted edit
 * prompt against a build. We:
 *
 *   1. RLS-verify project membership (single SELECT).
 *   2. Verify the source build is the latest 'ready' build for the
 *      project (we deliberately disallow editing older builds — the
 *      project always edits forward from the current state).
 *   3. Validate scope + target shape (component / shell only in v1).
 *   4. Insert a workspace_edits row scoped to the calling user.
 *   5. Dispatch site/edit.requested for the worker to pick up.
 *
 * Returns the edit row id so the UI can navigate to a per-edit progress
 * surface (Phase 7 v1 just shows the row in the workspace history).
 */

export type WorkspaceEditScope = "component" | "shell";

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

export class WorkspaceEditError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "source_not_ready"
      | "invalid_scope"
      | "invalid_target"
      | "prompt_too_short"
      | "page_scope_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceEditError";
  }
}

export function validateEditInput(
  input: Pick<RequestWorkspaceEditInput, "scope" | "target" | "prompt"> & {
    rawScope?: string;
  },
): void {
  const scopeValue = input.rawScope ?? input.scope;
  if (scopeValue === "page") {
    throw new WorkspaceEditError(
      "page_scope_unsupported",
      "scope='page' is not supported in v1. Use scope='component' or 'shell'.",
    );
  }
  if (scopeValue !== "component" && scopeValue !== "shell") {
    throw new WorkspaceEditError(
      "invalid_scope",
      `scope must be 'component' or 'shell' (got '${scopeValue}').`,
    );
  }
  if (input.scope === "shell" && input.target !== "header" && input.target !== "footer") {
    throw new WorkspaceEditError(
      "invalid_target",
      `For scope='shell', target must be 'header' or 'footer' (got '${input.target}').`,
    );
  }
  if (input.scope === "component" && !input.target.trim()) {
    throw new WorkspaceEditError(
      "invalid_target",
      "For scope='component', target must be a non-empty block name.",
    );
  }
  if (!input.prompt || input.prompt.trim().length < 5) {
    throw new WorkspaceEditError(
      "prompt_too_short",
      "prompt must be at least 5 characters.",
    );
  }
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

/**
 * Lightweight selector used by the workspace page to render edit
 * history. Reuses createAdminClient deliberately so the workspace UI
 * doesn't need a fresh RLS round-trip (the RLS-protected SELECT happens
 * on the projects query a moment earlier).
 */
export async function loadWorkspaceEditHistory(
  projectId: string,
  limit = 10,
): Promise<
  Array<{
    id: string;
    scope: string;
    target: string;
    prompt: string;
    status: string;
    resultBuildId: string | null;
    errorText: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_edits")
    .select(
      "id, scope, target, prompt, status, result_build_id, error_text, created_at, finished_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    scope: String(row.scope),
    target: String(row.target),
    prompt: String(row.prompt),
    status: String(row.status),
    resultBuildId: (row.result_build_id as string | null) ?? null,
    errorText: (row.error_text as string | null) ?? null,
    createdAt: String(row.created_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }));
}
