"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluatePublishGate } from "@/lib/jab/publish-gate";
import { loadVercelClient } from "@/lib/vercel/load-client";
import { BuildReviewError } from "@/lib/jab/build-review-errors";

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
 *   2. Load every fidelity_reports row + the page_inventory count,
 *      evaluate gate (F3: gate refuses if a page has no fidelity row).
 *   3. Find the most-recent ready preview `deployments` row for the build.
 *   4. Load the project's vercel_project_id.
 *   5. vercel.requestPromote(vercel_project_id, provider_deployment_id).
 *   6. promote_build_to_production RPC (migration 0026): supersede prior
 *      ready production rows + insert the new one in ONE transaction (F4).
 *
 * Step 5 is the only network call; if it throws, the RPC never runs, so
 * no production row is written and no prior rows are superseded. The RPC
 * (step 6) is itself atomic, and Vercel's promote is idempotent, so a
 * retry after an RPC failure re-promotes harmlessly and re-runs the
 * transaction — the publish is atomic from the user's perspective.
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
    .select("id, project_id, status")
    .eq("id", input.buildId)
    .single<{ id: string; project_id: string; status: string }>();
  if (buildErr?.code === "PGRST116" || !build) {
    throw new BuildReviewError("not_found", "Build not found.");
  }
  if (buildErr) throw buildErr;

  const { data: fidelityRows, error: fidelityErr } = await userClient
    .from("fidelity_reports")
    .select("approval_status")
    .eq("site_build_id", input.buildId);
  if (fidelityErr) throw fidelityErr;

  // F3: count the build's pages so the gate can refuse to publish when a
  // page has no fidelity row (partial verification). Same RLS-scoped
  // client; head:true avoids transferring rows.
  const { count: pageInventoryCount, error: pageCountErr } = await userClient
    .from("page_inventory")
    .select("id", { count: "exact", head: true })
    .eq("site_build_id", input.buildId);
  if (pageCountErr) throw pageCountErr;

  const gate = evaluatePublishGate({
    buildStatus: build.status,
    fidelityReports: (fidelityRows ?? []) as Array<{ approval_status: string }>,
    pageInventoryCount: pageInventoryCount ?? 0,
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

  // F4: atomic publish. The promote_build_to_production RPC (migration
  // 0026) supersedes prior ready production rows and inserts the new one
  // in one Postgres transaction, so a double-submit or a failure between
  // the two writes can't leave two ready production rows. Called via the
  // user client so SECURITY DEFINER + auth.uid() inside the RPC see the
  // right tenant member. The Vercel promote above is idempotent, so a
  // retry after an RPC failure is safe.
  const { data: rpcRows, error: rpcErr } = await userClient.rpc(
    "promote_build_to_production",
    {
      p_build_id: input.buildId,
      p_provider_deployment_id: previewRow.provider_deployment_id,
      p_url: previewRow.url,
      p_promoted_from_deployment_id: previewRow.id,
    },
  );
  if (rpcErr) {
    throw new Error(`promote_build_to_production RPC failed: ${rpcErr.message}`);
  }
  const rpcRow = (
    rpcRows as Array<{ deployment_id: string; superseded_count: number }> | null
  )?.[0];
  if (!rpcRow) {
    throw new Error("promote_build_to_production RPC returned no row");
  }

  revalidatePath(`/projects/${build.project_id}`);
  revalidatePath(`/projects/${build.project_id}/builds/${input.buildId}/review`);

  return {
    productionDeploymentId: rpcRow.deployment_id,
    productionUrl: previewRow.url ?? "",
    supersededCount: rpcRow.superseded_count,
  };
}
