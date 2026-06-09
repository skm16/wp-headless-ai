/**
 * load-workspace-edit-history — RSC-side reader for the workspace edit list.
 * Lives OUTSIDE the "use server" action module on purpose: exported action
 * functions compile into public POST endpoints, and this read needs to be a
 * render-time helper, not an endpoint. RLS user client; unauthorized → [].
 * (2026-06-09 review, T4 follow-up.)
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";

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
    resultBuildStatus: string | null;
    promoted: boolean;
    errorText: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>
> {
  // RLS-scoped read. workspace_edits carries workspace_edits_tenant_select
  // (migration 0024); the result_build join is covered by site_builds' tenant
  // SELECT policy. Unauthorized callers get [] instead of another tenant's
  // prompts/errors.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_edits")
    .select(
      "id, scope, target, prompt, status, result_build_id, result_promoted_deployment_id, result_build:result_build_id(status), error_text, created_at, finished_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => {
    const rb = Array.isArray(row.result_build)
      ? (row.result_build as Array<{ status: string }>)[0]
      : (row.result_build as { status: string } | null);
    return {
      id: String(row.id),
      scope: String(row.scope),
      target: String(row.target),
      prompt: String(row.prompt),
      status: String(row.status),
      resultBuildId: (row.result_build_id as string | null) ?? null,
      resultBuildStatus: rb?.status ?? null,
      promoted: (row.result_promoted_deployment_id as string | null) !== null,
      errorText: (row.error_text as string | null) ?? null,
      createdAt: String(row.created_at),
      finishedAt: (row.finished_at as string | null) ?? null,
    };
  });
}
