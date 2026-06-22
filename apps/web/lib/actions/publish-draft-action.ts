"use server";
import { revalidatePath } from "next/cache";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findLiveDraft, loadDraftSteps } from "@/lib/db/drafts";
import { activeSteps, type DraftStepRow } from "@/lib/draft/state";
import { autoFailStaleActiveBuild } from "@/lib/db/auto-fail-stale-build";
import { ACTIVE_BUILD_PHASES, isActiveBuildStatus } from "@/lib/jab/build-status";
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
  // findLiveDraft also returns 'active' drafts; there is nothing to cancel unless
  // the draft is mid-publish. Early-return skips the build-find/cancel loop
  // entirely. (A stray 'ready' publish_draft build for an active draft — which
  // shouldn't exist — is still backstopped by publishBuildAction's P2 re-check.)
  if (draft.status !== "publishing") return { ok: false, error: "not_publishing" };

  const admin = createAdminClient();

  // Find the in-flight publish_draft build(s) for THIS draft across active +
  // ready rows — NOT just the latest. triggerBuildAction blocks only an ACTIVE
  // latest build, so a normal rebuild can start while this draft's publish_draft
  // build sits at 'ready' (review), inserting a newer non-publish build that
  // becomes the latest. Inspecting only the latest would MISS the publish_draft
  // build: cancel would unlock the draft while the old 'ready' publish_draft
  // build stayed claimable + promotable to production, and its finalize CAS would
  // then miss after production had already changed. (C1 residual.)
  const { data: builds, error: buildsErr } = await admin
    .from("site_builds")
    .select("id, status, config")
    .eq("project_id", projectId)
    .in("status", [...ACTIVE_BUILD_PHASES, "ready"])
    .order("created_at", { ascending: false });
  if (buildsErr) {
    // FAIL-CLOSED: if we can't enumerate the candidate builds we cannot know
    // whether a publish_draft build is still claimable. Unlocking the draft here
    // (the old fail-open behaviour) is exactly what strands a still-'ready'
    // publish_draft build that a later re-publish can then promote from its old
    // review URL. Refuse and let the user retry.
    return { ok: false, error: `cancel build lookup failed: ${buildsErr.message}` };
  }
  const publishBuilds = (
    (builds ?? []) as Array<{
      id: string;
      status: string;
      config: { mode?: string; draft_id?: string } | null;
    }>
  ).filter((b) => b.config?.mode === "publish_draft" && b.config.draft_id === draft.id);

  // CAS-cancel each publish_draft build FIRST — but REFUSE the cancel if any has
  // already claimed promotion (promoting_at set): the Vercel production redeploy
  // is underway and irreversible, so we must NOT free the draft out from under
  // it. `.is("promoting_at", null)` is the same mutex publishBuildAction's claim
  // races on; 0 rows means the publish won. Cancelling also makes
  // evaluatePublishGate refuse the build (the gate requires status='ready').
  for (const pb of publishBuilds) {
    // CAS ONLY on `promoting_at IS NULL` — NOT on the read-time status. The
    // promoting_at guard is the security-critical one (0 rows ⇒ a publish has
    // claimed this build → refuse). Pinning `.eq("status", pb.status)` too would
    // false-fail when the build merely PROGRESSED a phase (e.g. composing→building)
    // between this query and the update — returning a misleading
    // 'promote_in_progress' for a build that is just advancing normally.
    // Cancelling an in-flight publish build regardless of its current phase is
    // exactly the intent (the worker cancel-guards then stop the pipeline).
    const { data: cancelled } = await admin
      .from("site_builds")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", pb.id)
      .is("promoting_at", null)
      .select("id");
    if (!cancelled || cancelled.length === 0) {
      return { ok: false, error: "promote_in_progress" };
    }
  }

  // Only now unlock the draft (publishing → active) so the user can resume
  // editing. (If there was no in-flight publish build — e.g. a draft stranded at
  // 'publishing' after the build was already cleared — this still recovers it.)
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
