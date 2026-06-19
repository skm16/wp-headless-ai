"use server";
import { revalidatePath } from "next/cache";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findLiveDraft, loadDraftSteps } from "@/lib/db/drafts";
import { activeSteps, type DraftStepRow } from "@/lib/draft/state";
import { autoFailStaleActiveBuild } from "@/lib/db/auto-fail-stale-build";
import { isActiveBuildStatus } from "@/lib/jab/build-status";
import { isUniqueViolation } from "@/lib/db/pg-error";
import {
  DRAFT_PUBLISH_REQUESTED_EVENT,
  type DraftPublishRequestedData,
} from "@/lib/inngest/publish-draft-event";
import type { BuildConfig } from "@/lib/jab/build-config";

/**
 * publish-draft-action — the Live-Draft publish bridge entry point (2026-06-18
 * plan, Task 6). publishDraftAction snapshots the project's live draft into a new
 * queued publish_draft site_builds row, CAS-locks the draft to 'publishing', and
 * dispatches draft/publish.requested → the publish-draft worker (clone base +
 * overlay draft units) → the EXISTING compose/deploy/verify/review/publish
 * pipeline.
 *
 * Flow (mirrors triggerBuildAction's insert/dispatch + requestWorkspaceEditAction's
 * concurrency guard):
 *   1. RLS-verify project membership + resolve tenant (single SELECT).
 *   2. findLiveDraft — error if none; require ≥1 active (completed, non-undone)
 *      step (refuse "nothing to publish").
 *   3. Concurrency: autoFailStaleActiveBuild then refuse if a build is in flight.
 *   4. Insert a queued publish_draft site_builds row (placeholder config — the
 *      worker fills the real config in stamp-config).
 *   5. CAS lock the draft (active → publishing); 0 rows = a publish raced — throw.
 *   6. Dispatch draft/publish.requested; on dispatch failure mark the build
 *      failed AND unlock the draft (revert to active) — never strand a lock.
 *   7. revalidatePath; return { buildId }.
 *
 * cancelPublishAction lets a user abandon a publish (e.g. stuck at review) and
 * resume editing: CAS revert publishing → active + best-effort cancel of the
 * in-flight publish build.
 */

export interface PublishDraftResult {
  buildId: string;
}

export async function publishDraftAction(projectId: string): Promise<PublishDraftResult> {
  const supabase = await createClient();

  // 1. RLS-scoped SELECT — PGRST116 / no row = not yours = not_found (same
  //    posture as triggerBuildAction / requestWorkspaceEditAction).
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .single<{ id: string; tenant_id: string }>();
  if (projectErr?.code === "PGRST116" || !project) {
    throw new Error("not_found");
  }
  if (projectErr) throw projectErr;
  const tenantId = project.tenant_id;

  // 2. The draft must exist and carry ≥1 active edit — nothing to publish
  //    otherwise. findLiveDraft returns both 'active' and 'publishing' drafts;
  //    a 'publishing' draft is already mid-publish (the CAS lock at step 5 will
  //    also refuse, but surfacing it early is a clearer error).
  const draft = await findLiveDraft(projectId);
  if (!draft) throw new Error("no_draft");
  if (draft.status !== "active") {
    throw new Error("already_publishing");
  }

  const steps = (await loadDraftSteps(draft.id)) as DraftStepRow[];
  if (activeSteps(steps).length === 0) {
    throw new Error("nothing_to_publish");
  }

  const admin = createAdminClient();

  // 3. Concurrency guard. Self-heal a wedged active build first, then refuse on
  //    the latest build if it's still in an active status (a publish creates a
  //    full pipeline build; only one may be in flight per project).
  await autoFailStaleActiveBuild(projectId);
  const { data: latestBuilds, error: latestErr } = await admin
    .from("site_builds")
    .select("id, status")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestErr) {
    throw new Error(`publishDraftAction: latest-build lookup failed: ${latestErr.message}`);
  }
  const latest = (latestBuilds ?? [])[0] as { id: string; status: string } | undefined;
  if (latest && isActiveBuildStatus(latest.status)) {
    throw new Error(
      `active_build: a build is already in flight for this project (status=${latest.status}). Wait for it to finish before publishing.`,
    );
  }

  // 4. Insert the queued publish_draft build. Placeholder config — the worker's
  //    stamp-config step fills the real config (changed_slugs / tokens / carried
  //    front-page keys) once it has resolved the draft state.
  const placeholderConfig: Extract<BuildConfig, { mode: "publish_draft" }> = {
    mode: "publish_draft",
    draft_id: draft.id,
    base_build_id: draft.base_build_id,
    source_build_id: draft.base_build_id,
    changed_slugs: [],
    front_page_slug: null,
  };
  const { data: inserted, error: insertErr } = await admin
    .from("site_builds")
    .insert({ project_id: projectId, status: "queued", config: placeholderConfig })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    if (isUniqueViolation(insertErr)) {
      throw new Error(
        "active_build: a build is already in flight for this project. Wait for it to finish before publishing.",
      );
    }
    throw new Error(
      `publishDraftAction: site_builds insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
  }
  const buildId = inserted.id;

  // 5. CAS lock the draft: active → publishing. 0 rows means a concurrent
  //    publish already locked it — abandon this one (mark the orphan build
  //    failed) and throw. The locked draft blocks new edits (draft-edit's
  //    ensure-draft throws on a non-'active' draft).
  const { data: locked, error: lockErr } = await admin
    .from("drafts")
    .update({ status: "publishing" })
    .eq("id", draft.id)
    .eq("status", "active")
    .select("id");
  if (lockErr) {
    await failOrphanBuild(admin, buildId, `draft lock failed: ${lockErr.message}`);
    throw new Error(`publishDraftAction: draft lock failed: ${lockErr.message}`);
  }
  if (!locked || locked.length === 0) {
    await failOrphanBuild(admin, buildId, "draft already publishing (lost the publish race)");
    throw new Error("already_publishing");
  }

  // 6. Dispatch the worker. On dispatch failure, unwind BOTH the orphan build
  //    (stranded 'queued' otherwise — active for the guard but outside the 0031
  //    partial index, so nothing ever clears it) AND the draft lock (revert to
  //    'active' so the user can retry — never strand a lock).
  const payload: DraftPublishRequestedData = { projectId, tenantId, draftId: draft.id, buildId };
  try {
    await inngest.send({ name: DRAFT_PUBLISH_REQUESTED_EVENT, data: payload });
  } catch (err) {
    await failOrphanBuild(
      admin,
      buildId,
      `publish dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await unlockDraft(admin, draft.id);
    throw new Error(
      "dispatch_failed: the publish couldn't be handed to the worker queue (is Inngest running?). Retry when the queue is back.",
    );
  }

  revalidatePath(`/projects/${projectId}/workspace`);
  return { buildId };
}

export type CancelPublishResult = { ok: true } | { ok: false; error: string };

/**
 * cancelPublishAction — abandon an in-flight publish and resume editing.
 * CAS reverts the draft publishing → active and best-effort cancels the latest
 * in-flight publish_draft build. Idempotent; safe to call when nothing is
 * publishing (returns ok:false with a reason).
 */
export async function cancelPublishAction(projectId: string): Promise<CancelPublishResult> {
  const supabase = await createClient();
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single<{ id: string }>();
  if (projectErr || !project) {
    return { ok: false, error: "not_found" };
  }

  const draft = await findLiveDraft(projectId);
  if (!draft) return { ok: false, error: "no_draft" };

  const admin = createAdminClient();
  const { data: unlocked, error: unlockErr } = await admin
    .from("drafts")
    .update({ status: "active" })
    .eq("id", draft.id)
    .eq("status", "publishing")
    .select("id");
  if (unlockErr) return { ok: false, error: unlockErr.message };
  if (!unlocked || unlocked.length === 0) {
    return { ok: false, error: "not_publishing" };
  }

  // Best-effort cancel of the in-flight publish build so it stops occupying the
  // concurrency slot. Failures here don't block the unlock — the stale-build
  // sweep / publish failure path will eventually clear it.
  const { data: builds } = await admin
    .from("site_builds")
    .select("id, status, config")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = (builds ?? [])[0] as
    | { id: string; status: string; config: { mode?: string; draft_id?: string } | null }
    | undefined;
  if (
    latest &&
    latest.config?.mode === "publish_draft" &&
    latest.config.draft_id === draft.id &&
    isActiveBuildStatus(latest.status)
  ) {
    await admin
      .from("site_builds")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", latest.id)
      .eq("status", latest.status);
  }

  revalidatePath(`/projects/${projectId}/workspace`);
  return { ok: true };
}

// ── internal cleanup helpers ──────────────────────────────────────────────────

/** Mark an orphan publish build failed (best-effort) so it never strands 'queued'. */
async function failOrphanBuild(
  admin: ReturnType<typeof createAdminClient>,
  buildId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("site_builds")
    .update({ status: "failed", error_text: reason, finished_at: new Date().toISOString() })
    .eq("id", buildId);
  if (error) {
    console.error(`[publish-draft-action] orphan-build cleanup failed for ${buildId}: ${error.message}; reason: ${reason}`);
  }
}

/** CAS revert a draft publishing → active (recover the lock on a failed dispatch). */
async function unlockDraft(
  admin: ReturnType<typeof createAdminClient>,
  draftId: string,
): Promise<void> {
  const { error } = await admin
    .from("drafts")
    .update({ status: "active" })
    .eq("id", draftId)
    .eq("status", "publishing");
  if (error) {
    console.error(`[publish-draft-action] draft unlock failed for ${draftId}: ${error.message}`);
  }
}
