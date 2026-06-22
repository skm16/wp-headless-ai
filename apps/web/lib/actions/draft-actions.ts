"use server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  findLiveDraft,
  bumpDraftVersion,
  loadDraftVersions,
  loadDraftSteps,
  loadActiveTokenDeltas,
  type DraftRow,
} from "@/lib/db/drafts";
import { effectiveUnitVersions } from "@/lib/draft/state";
import { buildVersionedDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { mergeTokenDeltas } from "@/lib/jab/token-override";

/**
 * draft-actions — server actions for undo, revert-to-version, and discard.
 *
 * Auth pattern: RLS-scoped SELECT on projects (PGRST116 = not yours = not found).
 * All writes go through the service-role admin client.
 */

// ── auth helper ──────────────────────────────────────────────────────────────

async function assertProjectAccess(projectId: string): Promise<void> {
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (error?.code === "PGRST116" || !project) {
    throw new Error("not_found");
  }
  if (error) throw error;
}

// ── internal helper ──────────────────────────────────────────────────────────

/**
 * Rebuild draft artifacts from the current set of active unit versions,
 * then bump the draft's version counter. Returns the new version number.
 *
 * Called after any mutation that changes which edits are active (undo, revert).
 */
async function rebuildDraftArtifacts(draft: DraftRow, projectId: string): Promise<number> {
  const [versions, steps, tokenDeltas] = await Promise.all([
    loadDraftVersions(draft.id),
    loadDraftSteps(draft.id),
    loadActiveTokenDeltas(draft.id),
  ]);
  const effective = effectiveUnitVersions(versions, steps);
  const overrides = new Map<string, string>();
  for (const [key, row] of effective) overrides.set(key, row.tsx);
  // Recompute the global token override from the active (non-undone) set so
  // undo/revert of a token edit restyles the preview. mergeTokenDeltas([]) → {}
  // → applyTokenOverride is a no-op, byte-identical for drafts with no token edits.
  const tokenOverride = mergeTokenDeltas(tokenDeltas);
  const nextVersion = draft.version + 1;
  await buildVersionedDraftArtifacts(
    { draftId: draft.id, nextVersion, baseBuildId: draft.base_build_id, overrides, tokenOverride },
    defaultArtifactDeps(projectId),
  );
  await bumpDraftVersion(draft.id, draft.version);
  return nextVersion;
}

// ── actions ──────────────────────────────────────────────────────────────────

export type UndoLastEditResult =
  | { ok: true; newVersion: number }
  | { ok: false; error: "nothing_to_undo" | "no_draft" | "draft_locked" };

/**
 * Undo the most recent completed, non-undone edit for the project's live draft.
 *
 * Steps:
 *   1. Auth check via RLS
 *   2. findLiveDraft — no_draft if null
 *   3. Load the most recent completed, undone_at IS NULL edit
 *   4. If none: nothing_to_undo
 *   5. Mark it undone (CAS: only if still undone_at IS NULL)
 *   6. Rebuild artifacts
 *   7. Return { ok: true, newVersion }
 */
export async function undoLastEditAction(
  projectId: string,
): Promise<UndoLastEditResult> {
  await assertProjectAccess(projectId);

  const draft = await findLiveDraft(projectId);
  if (!draft) return { ok: false, error: "no_draft" };
  // C2 publish lock: findLiveDraft also returns 'publishing' drafts. A draft
  // mid-publish must be immutable — the publish worker is snapshotting
  // effectiveUnitVersions, and an undo here would silently diverge the
  // published result from what the user reviewed. Cancel the publish first.
  if (draft.status !== "active") return { ok: false, error: "draft_locked" };

  const admin = createAdminClient();

  // Load the most recent completed, non-undone edit for this draft
  const { data: edits, error: editsErr } = await admin
    .from("workspace_edits")
    .select("id, created_at")
    .eq("draft_id", draft.id)
    .eq("status", "completed")
    .is("undone_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (editsErr) throw new Error(`undoLastEditAction: failed to load edits: ${editsErr.message}`);
  if (!edits || edits.length === 0) return { ok: false, error: "nothing_to_undo" };

  const editId = (edits[0] as { id: string }).id;

  // CAS mark-undone: only updates if undone_at is still null
  const undoneAt = new Date().toISOString();
  const { error: updateErr } = await admin
    .from("workspace_edits")
    .update({ undone_at: undoneAt })
    .eq("id", editId)
    .is("undone_at", null);

  if (updateErr) throw new Error(`undoLastEditAction: failed to mark edit undone: ${updateErr.message}`);

  // Rebuild artifacts. If rebuild fails, roll back the undone_at mark so the
  // edit stays active — otherwise the UI shows a permanent "Undone" row while
  // the preview still reflects the component (the artifact version never moved).
  try {
    const newVersion = await rebuildDraftArtifacts(draft, projectId);
    return { ok: true, newVersion };
  } catch (rebuildErr) {
    await admin
      .from("workspace_edits")
      .update({ undone_at: null })
      .eq("id", editId)
      .eq("undone_at", undoneAt);
    throw rebuildErr;
  }
}

export type RevertToVersionResult =
  | { ok: true; newVersion: number }
  | { ok: false; error: "no_draft" | "edit_not_found" | "draft_locked" };

/**
 * Revert the draft to the state it was in after a specific edit.
 *
 * All completed edits AFTER the target are marked undone; the target edit
 * itself is un-undone (restored) if it was previously undone.
 *
 * Steps:
 *   1. Auth check via RLS
 *   2. findLiveDraft — no_draft if null
 *   3. Verify targetEditId belongs to this draft
 *   4. Load ALL completed edits for this draft ordered by created_at ASC
 *   5. Mark all edits after the target as undone
 *   6. Un-undo the target edit if it was undone
 *   7. Rebuild artifacts
 *   8. Return { ok: true, newVersion }
 */
export async function revertToVersionAction(
  projectId: string,
  targetEditId: string,
): Promise<RevertToVersionResult> {
  await assertProjectAccess(projectId);

  const draft = await findLiveDraft(projectId);
  if (!draft) return { ok: false, error: "no_draft" };
  // C2 publish lock — see undoLastEditAction. A revert mid-publish would
  // retarget the draft the publish worker is snapshotting.
  if (draft.status !== "active") return { ok: false, error: "draft_locked" };

  const admin = createAdminClient();

  // Verify the target edit belongs to this draft
  const { data: targetEdit, error: targetErr } = await admin
    .from("workspace_edits")
    .select("id, created_at, undone_at")
    .eq("id", targetEditId)
    .eq("draft_id", draft.id)
    .maybeSingle();

  if (targetErr) throw new Error(`revertToVersionAction: failed to load target edit: ${targetErr.message}`);
  if (!targetEdit) return { ok: false, error: "edit_not_found" };

  const target = targetEdit as { id: string; created_at: string; undone_at: string | null };

  // Load all completed edits for this draft in chronological order
  const { data: allEdits, error: allEditsErr } = await admin
    .from("workspace_edits")
    .select("id, created_at, undone_at")
    .eq("draft_id", draft.id)
    .eq("status", "completed")
    .order("created_at", { ascending: true });

  if (allEditsErr) throw new Error(`revertToVersionAction: failed to load all edits: ${allEditsErr.message}`);

  const rows = (allEdits ?? []) as { id: string; created_at: string; undone_at: string | null }[];

  const now = new Date().toISOString();

  // Mark all edits AFTER the target as undone.
  const afterIds = rows
    .filter((r) => r.created_at > target.created_at && r.undone_at === null)
    .map((r) => r.id);
  if (afterIds.length > 0) {
    const { error: markErr } = await admin
      .from("workspace_edits")
      .update({ undone_at: now })
      .in("id", afterIds);
    if (markErr) throw new Error(`revertToVersionAction: failed to mark later edits undone: ${markErr.message}`);
  }

  // Un-undo ALL edits from the beginning through the target (inclusive).
  // This ensures "revert to v3" restores v1+v2+v3 even if v2 was previously
  // individually undone — the effective set after revert is always a contiguous
  // prefix ending at the target.
  const restoreIds = rows
    .filter((r) => r.created_at <= target.created_at && r.undone_at !== null)
    .map((r) => r.id);
  if (restoreIds.length > 0) {
    const { error: restoreErr } = await admin
      .from("workspace_edits")
      .update({ undone_at: null })
      .in("id", restoreIds);
    if (restoreErr) throw new Error(`revertToVersionAction: failed to restore target edits: ${restoreErr.message}`);
  }

  const newVersion = await rebuildDraftArtifacts(draft, projectId);
  return { ok: true, newVersion };
}

export type DiscardDraftResult =
  | { ok: true }
  | { ok: false; error: "no_draft" | "draft_locked" };

/**
 * Discard the project's live draft (sets status to 'discarded').
 *
 * No artifact rebuild needed — the draft is gone.
 */
export async function discardDraftAction(
  projectId: string,
): Promise<DiscardDraftResult> {
  await assertProjectAccess(projectId);

  const draft = await findLiveDraft(projectId);
  if (!draft) return { ok: false, error: "no_draft" };
  // C2 publish lock — a 'publishing' draft is immutable; refuse rather than
  // CAS-no-op and return a false {ok:true}. (Cancel the publish to discard.)
  if (draft.status !== "active") return { ok: false, error: "draft_locked" };

  const admin = createAdminClient();
  const { data: discarded, error } = await admin
    .from("drafts")
    .update({ status: "discarded" })
    .eq("id", draft.id)
    .eq("status", "active")
    .select("id");

  if (error) throw new Error(`discardDraftAction: failed to discard draft: ${error.message}`);
  // CAS race: the draft flipped active→publishing/discarded between the read and
  // the update → 0 rows. Report it honestly rather than a false success.
  if (!discarded || discarded.length === 0) return { ok: false, error: "draft_locked" };
  return { ok: true };
}
