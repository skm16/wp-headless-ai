"use server";
import { redirect } from "next/navigation";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveBuildStatus } from "@/lib/jab/build-status";
import { isUniqueViolation } from "@/lib/jab/postgres-errors";
import {
  TriggerBuildError,
  validateProjectReadyForBuild,
} from "@/lib/jab/trigger-build-validation";

/**
 * triggerBuildAction — Phase 2 plan: the single user-facing entry point
 * to the full Phase A → D → E pipeline. Replaces the smoke-only
 * triggerDiscovery shim.
 *
 * Flow:
 *   1. Verify project membership (RLS-scoped SELECT — same indistinguishable-
 *      from-not-found posture as the project detail page).
 *   2. Verify the project is ready to build (validateProjectReadyForBuild
 *      from lib/jab/trigger-build-validation.ts).
 *   3. Verify no active build already in flight for this project.
 *   4. Insert site_builds via service-role (table has no INSERT RLS policy).
 *   5. Dispatch site/discover.requested with { projectId, tenantId, buildId }.
 *
 * Returns { buildId }. Non-async helpers (TriggerBuildError class,
 * validateProjectReadyForBuild) live in lib/jab/trigger-build-validation.ts
 * because Next.js forbids non-async exports from "use server" files.
 */

export interface TriggerBuildInput {
  projectId: string;
}

export interface TriggerBuildResult {
  buildId: string;
}

interface ProjectGateRow {
  id: string;
  tenant_id: string;
  status: string;
  wp_url: string | null;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
  manifest: unknown;
}

export async function triggerBuildAction(
  input: TriggerBuildInput,
): Promise<TriggerBuildResult> {
  const supabase = await createClient();

  // RLS-scoped SELECT — if the project belongs to another tenant, the
  // query returns 0 rows / PGRST116 and we surface as not_found. Don't
  // distinguish "exists but not yours" from "doesn't exist" — same
  // posture as `/projects/[id]/page.tsx`.
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, tenant_id, status, wp_url, wp_username, wp_app_password_encrypted, manifest",
    )
    .eq("id", input.projectId)
    .single();

  if (error?.code === "PGRST116" || !project) {
    throw new TriggerBuildError("not_found", "Project not found.");
  }
  if (error) throw error;

  validateProjectReadyForBuild(project as ProjectGateRow);

  // Concurrency guard: query the latest build for this project. If it's
  // in any active status, refuse. Use service-role here to be defensive
  // against the case where site_builds RLS SELECT is missing on a
  // partially-applied migration; the projectId scoping is the security
  // boundary (we already verified ownership above).
  const admin = createAdminClient();
  const { data: latestBuilds, error: buildErr } = await admin
    .from("site_builds")
    .select("id, status")
    .eq("project_id", input.projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (buildErr) {
    throw new Error(`triggerBuildAction: latest-build lookup failed: ${buildErr.message}`);
  }
  const latest = (latestBuilds ?? [])[0] as { id: string; status: string } | undefined;
  if (latest && isActiveBuildStatus(latest.status)) {
    throw new TriggerBuildError(
      "active_build",
      `An active build is already in flight for this project (status=${latest.status}). Wait for it to finish or fail before retriggering.`,
    );
  }

  const { data: inserted, error: insertErr } = await admin
    .from("site_builds")
    .insert({
      project_id: input.projectId,
      status: "queued",
      config: { mode: "full" },
    })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    // The check-then-insert above is a friendly pre-check; the
    // site_builds_active_project_idx partial unique index (migration 0025)
    // is the real concurrency boundary. Two simultaneous triggers both
    // pass the pre-check, then one insert wins and the other trips 23505 —
    // translate that to the same active_build surface the pre-check uses.
    if (isUniqueViolation(insertErr)) {
      throw new TriggerBuildError(
        "active_build",
        "An active build is already in flight for this project. Wait for it to finish or fail before retriggering.",
      );
    }
    throw new Error(
      `triggerBuildAction: site_builds insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
  }

  await inngest.send({
    name: "site/discover.requested",
    data: {
      projectId: input.projectId,
      tenantId: (project as ProjectGateRow).tenant_id,
      buildId: inserted.id,
    },
  });

  return { buildId: inserted.id };
}

/**
 * triggerBuildFormAction — `<form action>`-compatible wrapper. Reads the
 * projectId out of FormData, triggers the build, then redirects to the
 * Phase 3 progress route.
 */
export async function triggerBuildFormAction(formData: FormData): Promise<void> {
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("triggerBuildFormAction: projectId missing from form data");
  }
  const { buildId } = await triggerBuildAction({ projectId });
  redirect(`/projects/${projectId}/builds/${buildId}/progress`);
}
