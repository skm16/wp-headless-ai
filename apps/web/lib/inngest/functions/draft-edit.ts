import "server-only";
import { inngest } from "@/lib/inngest/client";
import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureActiveDraft, bumpDraftVersion, loadDraftVersions, loadDraftSteps } from "@/lib/db/drafts";
import { effectiveUnitVersions, nextUnitVersionNo } from "@/lib/draft/state";
import { buildVersionedDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { draftComponentName } from "@/lib/draft/bundle";
import { patchUnitSource } from "@/lib/ai/patch-component";
import { modelClientForTier } from "@/lib/ai/model-client";
import { computeChangedPages } from "@/lib/jab/edit-impact";
import { loadSourcePagesForImpact } from "./edit-site.helpers";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * draft-edit — Live Draft replacement for the retired edit-site worker
 * (spec §6.2). One chat/manual edit = one draft step: patch the unit's
 * current TSX, bundle-gate the whole effective set, commit a new draft
 * version. NO site_builds row, NO compose/deploy/verify — those run once
 * at publish (Phase 3).
 *
 * retries: 0 — same rationale as edit-site (no duplicate LLM spend);
 * stranded rows are swept by autoFailStaleOpenEdits.
 */

export function unitKeyFor(scope: "component" | "shell", target: string): string {
  return scope === "shell" ? `shell:${target}` : target;
}

export function exportNameFor(scope: "component" | "shell", target: string): string {
  if (scope === "shell") return target === "header" ? "Header" : "Footer";
  return draftComponentName(target);
}

export function maxBytesFor(scope: "component" | "shell"): number {
  return scope === "shell" ? 24_000 : 10_000;
}

export const draftEdit = inngest.createFunction(
  { id: "draft-edit", retries: 0 },
  { event: EDIT_REQUESTED_EVENT },
  async ({ event, step }) => {
    const data = event.data as SiteEditRequestedData;
    const { editId, projectId, tenantId, scope, target } = data;
    const guidance = (data.regenerationPrompt ?? data.prompt ?? "").trim();
    const admin = createAdminClient();

    const failEdit = async (message: string) => {
      await admin
        .from("workspace_edits")
        .update({ status: "failed", error_text: message, finished_at: new Date().toISOString() })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
      if (data.messageId) {
        await admin
          .from("chat_messages")
          .update({ content: `That edit couldn't be applied: ${message}`, needs_clarification: true })
          .eq("id", data.messageId);
      }
    };

    // 1. Claim the edit.
    await step.run("mark-edit-running", async () => {
      await admin
        .from("workspace_edits")
        .update({ status: "running" })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
    });

    // 2. Ensure the draft + link the edit row to it.
    const draft = await step.run("ensure-draft", async () => {
      const d = await ensureActiveDraft(projectId, tenantId);
      if (d.status !== "active") {
        throw new Error(`draft ${d.id} is '${d.status}' — publish in progress, retry after it finishes`);
      }
      await admin.from("workspace_edits").update({ draft_id: d.id }).eq("id", editId);
      return d;
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!draft) return { failed: true };

    // 3. Load the unit's CURRENT source: latest active draft snapshot, else base build.
    const current = await step.run("load-current-source", async () => {
      const unitKey = unitKeyFor(scope, target);
      const [versions, steps] = await Promise.all([loadDraftVersions(draft.id), loadDraftSteps(draft.id)]);
      const effective = effectiveUnitVersions(versions, steps);
      const snapshot = effective.get(unitKey);
      if (snapshot) return { tsx: snapshot.tsx, versions };

      const storage = admin.storage.from(SITE_SCREENSHOTS_BUCKET);
      const path =
        scope === "shell"
          ? `builds/${draft.base_build_id}/project/components/site/${target === "header" ? "Header" : "Footer"}.tsx`
          : `builds/${draft.base_build_id}/components/${draftComponentName(target)}.tsx`;
      const { data: file } = await storage.download(path);
      if (!file) {
        throw new Error(`no source found for unit '${unitKey}' in draft or base build (${path})`);
      }
      return { tsx: await file.text(), versions };
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!current) return { failed: true };

    // 4. Patch LLM.
    const patched = await step.run("patch-unit", async () => {
      const result = await patchUnitSource({
        currentTsx: current.tsx,
        guidance,
        exportName: exportNameFor(scope, target),
        maxBytes: maxBytesFor(scope),
        client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
      });
      if (!result.ok) throw new Error(`patch failed after ${result.attempts} attempts: ${result.error}`);
      return result.tsx;
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!patched) return { failed: true };

    // 5. Bundle gate + CSS over the WHOLE effective set, upload at v(N+1).
    const artifacts = await step.run("bundle-and-css", async () => {
      const steps = await loadDraftSteps(draft.id);
      const effective = effectiveUnitVersions(current.versions, steps);
      const overrides = new Map<string, string>();
      for (const [key, row] of effective) overrides.set(key, row.tsx);
      overrides.set(unitKeyFor(scope, target), patched);
      return buildVersionedDraftArtifacts(
        { draftId: draft.id, nextVersion: draft.version + 1, baseBuildId: draft.base_build_id, overrides },
        defaultArtifactDeps(projectId),
      );
    }).catch(async (err: unknown) => {
      await failEdit(`compile gate: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!artifacts) return { failed: true };

    // 6. Commit: CAS version bump FIRST (gate), then version row + edit row.
    // Ordering matters: bumpDraftVersion throws if a concurrent worker already
    // moved drafts.version — doing it first means nothing else has been written
    // yet, so a race failure is clean (no orphaned version rows, no phantom
    // completed edit row).
    await step.run("commit", async () => {
      const sourcePages = await loadSourcePagesForImpact(draft.base_build_id);
      const impact = computeChangedPages({ scope, target, sourcePages });
      const changedSlugs =
        impact.reason === null ? sourcePages.map((p) => p.slug) : impact.changedSlugs;

      // CAS gate: throws "concurrent writer moved draft" if lost the race.
      await bumpDraftVersion(draft.id, draft.version);

      const unitKey = unitKeyFor(scope, target);
      const { data: versionRow, error: vErr } = await admin
        .from("draft_unit_versions")
        .insert({
          draft_id: draft.id,
          project_id: projectId,
          tenant_id: tenantId,
          unit_key: unitKey,
          version_no: nextUnitVersionNo(current.versions, unitKey),
          tsx: patched,
          created_by_edit_id: editId,
        })
        .select("id")
        .single();
      if (vErr) throw new Error(`version insert failed: ${vErr.message}`);

      const { error: eErr } = await admin
        .from("workspace_edits")
        .update({
          status: "completed",
          unit_version_id: versionRow.id,
          changed_slugs: changedSlugs,
          change_reason: impact.reason,
          finished_at: new Date().toISOString(),
        })
        .eq("id", editId)
        .eq("status", "running");
      if (eErr) throw new Error(`edit update failed: ${eErr.message}`);
    }).catch(async (err: unknown) => {
      await failEdit(`commit: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    return { draftId: draft.id, version: draft.version + 1 };
  },
);
