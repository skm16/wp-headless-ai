"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePublishGate } from "@/lib/jab/publish-gate";
import {
  recordDeployment,
  supersedePreviousProductionDeployments,
} from "@/lib/jab/deployments-recorder";
import { loadVercelClient } from "@/lib/vercel/load-client";
import { BuildReviewError } from "@/lib/jab/build-review-errors";
import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";

/**
 * build-review — Phase 5 actions powering the pre-publish gate.
 *
 * Approval actions call the SECURITY DEFINER RPC `approve_fidelity_report`
 * from migration 0023; the RPC enforces tenant membership and
 * column-level write restriction. The actions here just wrap the RPC and
 * revalidate the review path.
 *
 * publishBuildAction:
 *   1. RLS-load build (404 on cross-tenant).
 *   2. Load every fidelity_reports row for the build, evaluate gate.
 *   3. Find the most-recent ready preview `deployments` row for the build.
 *   4. Load the project's vercel_project_id.
 *   5. vercel.requestPromote(vercel_project_id, provider_deployment_id).
 *   6. recordDeployment({ environment: 'production', status: 'ready', … }).
 *   7. supersedePreviousProductionDeployments(...).
 *
 * Step 5 is the only network call; if it throws, no production
 * deployments row is written and no prior rows are superseded — the
 * publish is atomic from the user's perspective.
 *
 * BuildReviewError class lives in lib/jab/build-review-errors.ts because
 * Next.js forbids non-async exports from "use server" files.
 */

export type ApprovalStatus =
  | "approved"
  | "approved_with_issues"
  | "rejected"
  | "pending";

interface SetApprovalInput {
  buildId: string;
  pageInventoryId: string;
  status: ApprovalStatus;
}

async function setApprovalStatus(input: SetApprovalInput): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_fidelity_report", {
    p_build_id: input.buildId,
    p_page_inventory_id: input.pageInventoryId,
    p_status: input.status,
  });
  if (error) {
    throw new Error(`approve_fidelity_report RPC failed: ${error.message}`);
  }
}

export async function approvePageAction(
  buildId: string,
  pageInventoryId: string,
  projectId: string,
): Promise<void> {
  await setApprovalStatus({ buildId, pageInventoryId, status: "approved" });
  revalidatePath(`/projects/${projectId}/builds/${buildId}/review`);
}

export async function approvePageWithIssuesAction(
  buildId: string,
  pageInventoryId: string,
  projectId: string,
): Promise<void> {
  await setApprovalStatus({
    buildId,
    pageInventoryId,
    status: "approved_with_issues",
  });
  revalidatePath(`/projects/${projectId}/builds/${buildId}/review`);
}

export async function rejectPageAction(
  buildId: string,
  pageInventoryId: string,
  projectId: string,
): Promise<void> {
  await setApprovalStatus({ buildId, pageInventoryId, status: "rejected" });
  revalidatePath(`/projects/${projectId}/builds/${buildId}/review`);
}

interface PublishBuildInput {
  buildId: string;
}

export interface PublishBuildResult {
  productionDeploymentId: string;
  productionUrl: string;
  supersededCount: number;
}

export async function publishBuildAction(
  input: PublishBuildInput,
): Promise<PublishBuildResult> {
  const userClient = await createClient();

  // RLS-load the build (also implicitly verifies project membership).
  const { data: build, error: buildErr } = await userClient
    .from("site_builds")
    .select("id, project_id, status, config")
    .eq("id", input.buildId)
    .single<{ id: string; project_id: string; status: string; config: unknown }>();
  if (buildErr?.code === "PGRST116" || !build) {
    throw new BuildReviewError("not_found", "Build not found.");
  }
  if (buildErr) throw buildErr;

  const { data: fidelityRows, error: fidelityErr } = await userClient
    .from("fidelity_reports")
    .select("approval_status")
    .eq("site_build_id", input.buildId);
  if (fidelityErr) throw fidelityErr;

  const gate = evaluatePublishGate({
    buildStatus: build.status,
    fidelityReports: (fidelityRows ?? []) as Array<{ approval_status: string }>,
  });
  if (!gate.ok) {
    throw new BuildReviewError("publish_gate_failed", gate.reason);
  }

  // Find the most-recent ready preview deployment for this build. Use
  // service-role here to avoid RLS round-trips (we already verified
  // project membership above).
  const admin = createAdminClient();
  const { data: previewRow, error: previewErr } = await admin
    .from("deployments")
    .select("id, provider_deployment_id, url")
    .eq("site_build_id", input.buildId)
    .eq("environment", "preview")
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      provider_deployment_id: string;
      url: string | null;
    }>();
  if (previewErr) throw previewErr;
  if (!previewRow) {
    throw new BuildReviewError(
      "no_preview_deployment",
      "No ready preview deployment exists for this build.",
    );
  }

  const { data: projectRow, error: projectErr } = await admin
    .from("projects")
    .select("id, vercel_project_id")
    .eq("id", build.project_id)
    .single<{ id: string; vercel_project_id: string | null }>();
  if (projectErr || !projectRow) {
    throw new BuildReviewError("not_found", "Project not found.");
  }
  if (!projectRow.vercel_project_id) {
    throw new BuildReviewError(
      "project_not_linked",
      "Project has no Vercel link yet — deploy a preview before publishing.",
    );
  }

  const vercel = loadVercelClient();
  await vercel.requestPromote(
    projectRow.vercel_project_id,
    previewRow.provider_deployment_id,
  );

  const recorded = await recordDeployment(admin, {
    buildId: input.buildId,
    projectId: build.project_id,
    environment: "production",
    status: "ready",
    providerDeploymentId: previewRow.provider_deployment_id,
    url: previewRow.url,
    promotedFromDeploymentId: previewRow.id,
  });

  const supersede = await supersedePreviousProductionDeployments(admin, {
    projectId: build.project_id,
    keepDeploymentId: recorded.id,
  });

  // Edit-build lineage: stamp the production deployment onto the edit that
  // produced this build so the audit chain closes (§3.4). Matched by
  // result_build_id; service-role (membership already verified above).
  if (isEditConfig(build.config)) {
    const cfg = build.config as Extract<BuildConfig, { mode: "edit" }>;
    const { error: lineageErr } = await admin
      .from("workspace_edits")
      .update({ result_promoted_deployment_id: recorded.id })
      .eq("id", cfg.edit_id)
      .eq("result_build_id", input.buildId);
    if (lineageErr) {
      // Non-fatal: the promote already succeeded. Log loudly so the broken
      // audit link is visible, but don't fail the user's publish.
      console.warn(
          `[publish] result_promoted_deployment_id write failed for edit ${cfg.edit_id} ` +
            `(buildId=${input.buildId}, deploymentId=${recorded.id}): ${lineageErr.message}. ` +
            `Manual repair: UPDATE workspace_edits SET result_promoted_deployment_id='${recorded.id}' ` +
            `WHERE id='${cfg.edit_id}' AND result_build_id='${input.buildId}';`,
        );
    }
  }

  revalidatePath(`/projects/${build.project_id}`);
  revalidatePath(`/projects/${build.project_id}/builds/${input.buildId}/review`);

  return {
    productionDeploymentId: recorded.id,
    productionUrl: previewRow.url ?? "",
    supersededCount: supersede.supersededCount,
  };
}
