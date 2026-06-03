"use server";
import { redirect } from "next/navigation";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isActiveBuildStatus } from "@/lib/jab/build-status";

/**
 * triggerBuildAction — Phase 2 plan: the single user-facing entry point
 * to the full Phase A → D → E pipeline. Replaces the smoke-only
 * triggerDiscovery shim.
 *
 * Flow:
 *   1. Verify project membership (RLS-scoped SELECT — same indistinguishable-
 *      from-not-found posture as the project detail page).
 *   2. Verify the project is ready to build: status='ready', wp_url set,
 *      wp_username set, app password encrypted, manifest cached.
 *   3. Verify no active build already in flight for this project.
 *   4. Insert site_builds via service-role (table has no INSERT RLS policy).
 *   5. Dispatch site/discover.requested with { projectId, tenantId, buildId }.
 *
 * Returns { buildId }. Caller decides where to redirect (usually the
 * progress page from Phase 3). When called as a `<form action>` directly
 * we offer triggerBuildFormAction below that wraps redirect for us.
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

export class TriggerBuildError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "not_ready"
      | "active_build"
      | "dispatch_failed",
    message: string,
  ) {
    super(message);
    this.name = "TriggerBuildError";
  }
}

/**
 * Pure validation — exported so tests can exercise the gating logic
 * without a real Supabase client.
 */
export function validateProjectReadyForBuild(row: ProjectGateRow): void {
  if (row.status !== "ready") {
    throw new TriggerBuildError(
      "not_ready",
      `Project is in status='${row.status}'. Finish onboarding before triggering a build.`,
    );
  }
  if (!row.wp_url) {
    throw new TriggerBuildError(
      "not_ready",
      "Project has no WordPress URL. Reconnect via the onboarding wizard.",
    );
  }
  if (!row.wp_username || !row.wp_app_password_encrypted) {
    throw new TriggerBuildError(
      "not_ready",
      "Project has no WordPress credentials on file. Reconnect via the onboarding wizard.",
    );
  }
  if (!row.manifest) {
    throw new TriggerBuildError(
      "not_ready",
      "Project manifest hasn't been captured yet. Reconnect the Jab plugin and retry.",
    );
  }
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
