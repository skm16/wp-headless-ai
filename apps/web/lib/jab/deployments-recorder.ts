import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * deployments-recorder — single-source-of-truth writer for the
 * `deployments` table.
 *
 * Phase 1 of the 2026-06-02 SaaS-app completion plan: the `deploy-site`
 * worker stops being the canonical "what got deployed" record by writing
 * one `deployments` row per Vercel deployment attempt. Phase 5's publish
 * gate writes the production row.
 *
 * Why a separate module: keeps the SQL surface narrow, unit-testable
 * without an Inngest harness, and shareable with the Phase 5 publish
 * action (which writes the production row + the supersede sweep).
 */

export type DeploymentEnvironment = "preview" | "production";
export type DeploymentStatus = "pending" | "ready" | "failed" | "superseded";

export interface RecordDeploymentInput {
  buildId: string;
  projectId: string;
  environment: DeploymentEnvironment;
  status: DeploymentStatus;
  /**
   * Vercel deployment id (`dpl_...`). Always present even on `failed`
   * outcomes — Vercel issues an id at the create-deployment step before
   * the build actually starts.
   */
  providerDeploymentId: string;
  /**
   * Normalized URL (https:// prefix). Optional on `failed` outcomes
   * because Vercel doesn't always materialize a hostname for builds that
   * fail in the QUEUED/INITIALIZING phase.
   */
  url?: string | null;
  /** Source preview row id when this is the publish-promote insert. */
  promotedFromDeploymentId?: string | null;
  /** Optional excerpt of the build log surfaced on the review screen. */
  buildLogExcerpt?: string | null;
}

export interface RecordedDeployment {
  id: string;
}

/**
 * Insert one `deployments` row. Caller is responsible for using a
 * service-role client — the table has no INSERT RLS policy.
 */
export async function recordDeployment(
  supabase: SupabaseClient,
  input: RecordDeploymentInput,
): Promise<RecordedDeployment> {
  const readyAt = input.status === "ready" ? new Date().toISOString() : null;
  const { data, error } = await supabase
    .from("deployments")
    .insert({
      site_build_id: input.buildId,
      project_id: input.projectId,
      environment: input.environment,
      status: input.status,
      provider: "vercel",
      provider_deployment_id: input.providerDeploymentId,
      url: input.url ?? null,
      promoted_from_deployment_id: input.promotedFromDeploymentId ?? null,
      build_log_excerpt: input.buildLogExcerpt ?? null,
      ready_at: readyAt,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    throw new Error(
      `deployments insert failed (build=${input.buildId}, env=${input.environment}): ${error?.message ?? "no row returned"}`,
    );
  }
  return { id: data.id };
}

/**
 * Mark every prior production deployment for the same project as
 * `superseded`, except for the one just promoted. Phase 5 publish path.
 */
export async function supersedePreviousProductionDeployments(
  supabase: SupabaseClient,
  input: { projectId: string; keepDeploymentId: string },
): Promise<{ supersededCount: number }> {
  const { data, error } = await supabase
    .from("deployments")
    .update({ status: "superseded" })
    .eq("project_id", input.projectId)
    .eq("environment", "production")
    .eq("status", "ready")
    .neq("id", input.keepDeploymentId)
    .select("id");
  if (error) {
    throw new Error(
      `deployments supersede update failed (project=${input.projectId}): ${error.message}`,
    );
  }
  return { supersededCount: data?.length ?? 0 };
}
