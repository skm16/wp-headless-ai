"use server";
import { createClient } from "@/lib/supabase/server";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import {
  deriveWorkspacePreviewState,
  type WorkspacePreviewState,
} from "@/lib/jab/workspace-preview-state";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "@/lib/vercel/preview-protection";
import { hasOpenWorkspaceEdit } from "@/lib/jab/open-edits";

/**
 * workspace-preview — the poll target for the workspace preview pane.
 *
 * The client sends ONLY a projectId. We re-validate tenant membership per
 * call via an RLS-scoped SELECT (PGRST116 = not yours = not_found), then
 * re-derive the preview state from the canonical loadProjectBuildState. No
 * new deploy, no Vercel write — a cheap read invoked on a 5s poll while the
 * pane is in the `building` state (spec §3.2: "poll, not meta-refresh").
 *
 * Vercel Deployment Protection is checked fail-soft: a protected preview
 * sets `protected: true` so the pane can show a banner, but never throws to
 * the client (operator-recoverable, must not blank the UI). Only run the
 * reachability probe when there's actually a ready URL to probe.
 */

export type LoadWorkspacePreviewStateResult =
  | { ok: false; reason: "not_found" }
  | {
      ok: true;
      state: WorkspacePreviewState;
      protected: boolean;
      /**
       * True while any workspace_edits row for the project is queued/running.
       * The pane keeps polling on this even when state is 'ready' — it covers
       * the window between edit dispatch and the worker creating the result
       * build (during which the derived state is still 'ready').
       */
      hasOpenEdit: boolean;
    };

export async function loadWorkspacePreviewStateAction(
  projectId: string,
): Promise<LoadWorkspacePreviewStateResult> {
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();

  if (error?.code === "PGRST116" || !project) {
    return { ok: false, reason: "not_found" };
  }
  if (error) throw error;

  const buildState = await loadProjectBuildState(supabase, projectId);
  const state = deriveWorkspacePreviewState(buildState);

  let isProtected = false;
  if (state.kind === "ready") {
    try {
      await assertPreviewReachable(state.url);
    } catch (err) {
      if (err instanceof PreviewProtectedError) {
        isProtected = true;
        console.warn(`[workspace-preview] ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  const hasOpenEdit = await hasOpenWorkspaceEdit(supabase, projectId);

  return { ok: true, state, protected: isProtected, hasOpenEdit };
}
