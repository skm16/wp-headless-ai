import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * workspace-edit-history — server-only reader for the workspace UI.
 *
 * Moved out of `lib/actions/workspace-edit.ts` to fix the F2 finding:
 * the prior module was a "use server" file, so every exported function
 * was a Next.js server action that could be invoked from any client
 * with an arbitrary projectId. The previous implementation used
 * `createAdminClient()` and never verified caller membership, so a
 * crafted RSC payload would have leaked any project's edit history.
 *
 * This module uses the RLS-scoped user client (`createClient()`); the
 * `workspace_edits_tenant_select` policy in migration 0024 already
 * scopes reads to projects the caller's tenant owns. A cross-tenant
 * request therefore returns 0 rows, not another tenant's data.
 *
 * Marked `server-only` so a misclick that imports this from a client
 * component fails at build time, not at runtime.
 */

export interface WorkspaceEditHistoryRow {
  id: string;
  scope: string;
  target: string;
  prompt: string;
  status: string;
  resultBuildId: string | null;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export async function loadWorkspaceEditHistory(
  projectId: string,
  limit = 10,
): Promise<WorkspaceEditHistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
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
