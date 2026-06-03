import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isActiveBuildStatus } from "./build-status";

/**
 * load-project-builds — Phase 6 data accessor for the project detail
 * page + the dashboard. Returns the canonical "what is this project's
 * actual deploy state?" tuple in one round-trip per project.
 *
 * Why this lives here and not inline: phase 6 wires the same shape into
 * both `/projects/[id]` (single project) and `/dashboard` (N projects).
 * Keep one source of truth so the dashboard's batched accessor and the
 * single-project accessor can never drift on what "live" means.
 *
 * `live = !!productionDeployment` — that's the only signal. Don't infer
 * live from `site_builds.status='ready'` (those are stalled previews
 * pre-publish), don't infer from `projects.status='ready'` (those are
 * post-onboarding placeholders before any build).
 */

export interface ProjectBuildState {
  /** Latest site_builds row, or null when the project has never built. */
  latestBuild: BuildSummary | null;
  /** Latest READY preview deployment for the latest build (null when no preview). */
  latestPreview: DeploymentSummary | null;
  /** Latest READY production deployment for the project (null when not live). */
  productionDeployment: DeploymentSummary | null;
  /** Deploy history (newest first), capped at 10 entries. */
  deployHistory: DeploymentSummary[];
  /** True when latestBuild is in any active phase (queued..verifying). */
  hasActiveBuild: boolean;
}

export interface BuildSummary {
  id: string;
  status: string;
  failedPhase: string | null;
  previewUrl: string | null;
  pageCount: number | null;
  blockTypeCount: number | null;
  componentCount: number | null;
  fidelityAvg: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DeploymentSummary {
  id: string;
  siteBuildId: string;
  environment: "preview" | "production";
  status: "pending" | "ready" | "failed" | "superseded";
  url: string | null;
  providerDeploymentId: string | null;
  readyAt: string | null;
  createdAt: string;
}

/**
 * Single-project accessor. Caller passes an RLS-scoped Supabase client
 * (createClient from lib/supabase/server) so the SELECTs are
 * tenant-bounded; service-role usage would defeat the multi-tenancy
 * boundary.
 */
export async function loadProjectBuildState(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectBuildState> {
  const [{ data: latestBuilds }, { data: deployments }] = await Promise.all([
    supabase
      .from("site_builds")
      .select(
        "id, status, failed_phase, preview_url, page_count, block_type_count, component_count, fidelity_avg, created_at, finished_at",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("deployments")
      .select(
        "id, site_build_id, environment, status, url, provider_deployment_id, ready_at, created_at",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const latestBuild = (latestBuilds?.[0] ?? null) as
    | ProjectBuildState["latestBuild"]
    | null;
  const deployList = (deployments ?? []) as Array<{
    id: string;
    site_build_id: string;
    environment: string;
    status: string;
    url: string | null;
    provider_deployment_id: string | null;
    ready_at: string | null;
    created_at: string;
  }>;

  const history: DeploymentSummary[] = deployList.map((d) => ({
    id: d.id,
    siteBuildId: d.site_build_id,
    environment: d.environment as "preview" | "production",
    status: d.status as DeploymentSummary["status"],
    url: d.url,
    providerDeploymentId: d.provider_deployment_id,
    readyAt: d.ready_at,
    createdAt: d.created_at,
  }));

  const productionDeployment =
    history.find((d) => d.environment === "production" && d.status === "ready") ??
    null;
  const latestPreview = latestBuild
    ? history.find(
        (d) =>
          d.siteBuildId === latestBuild.id &&
          d.environment === "preview" &&
          d.status === "ready",
      ) ?? null
    : null;

  // Renormalize the row column names to the camelCase BuildSummary shape.
  // Drizzle's snake_case → camelCase doesn't run for raw Supabase calls.
  const normalizedBuild = latestBuild
    ? {
        ...latestBuild,
        // Cast through unknown because the raw row uses snake_case keys.
        ...(latestBuild as unknown as Record<string, unknown>),
      }
    : null;
  const buildSummary = normalizedBuild
    ? toBuildSummary(normalizedBuild as unknown as Record<string, unknown>)
    : null;

  return {
    latestBuild: buildSummary,
    latestPreview,
    productionDeployment,
    deployHistory: history,
    hasActiveBuild: buildSummary
      ? isActiveBuildStatus(buildSummary.status)
      : false,
  };
}

function toBuildSummary(raw: Record<string, unknown>): BuildSummary {
  return {
    id: String(raw.id),
    status: String(raw.status ?? "queued"),
    failedPhase: (raw.failed_phase as string | null) ?? null,
    previewUrl: (raw.preview_url as string | null) ?? null,
    pageCount: (raw.page_count as number | null) ?? null,
    blockTypeCount: (raw.block_type_count as number | null) ?? null,
    componentCount: (raw.component_count as number | null) ?? null,
    fidelityAvg: (raw.fidelity_avg as string | null) ?? null,
    createdAt: String(raw.created_at),
    finishedAt: (raw.finished_at as string | null) ?? null,
  };
}

/**
 * Batched accessor for the dashboard. One query gets the latest build per
 * project; another gets the latest production-ready deployment per
 * project. Returns a Map keyed by projectId.
 *
 * The latest-build query is a window-function-equivalent ROW_NUMBER()
 * partition-by-projectId pattern. Supabase's PostgREST client doesn't
 * expose window functions cleanly, so we instead fetch *all* recent
 * builds for the projects in scope (one per project at most) and pick
 * client-side. Bounded by the dashboard's `projects` count (small).
 */
export interface DashboardProjectBuildState {
  hasActiveBuild: boolean;
  latestBuildStatus: string | null;
  productionUrl: string | null;
  previewUrl: string | null;
}

export async function loadDashboardBuildStates(
  supabase: SupabaseClient,
  projectIds: string[],
): Promise<Map<string, DashboardProjectBuildState>> {
  if (projectIds.length === 0) return new Map();

  const [{ data: builds }, { data: deployments }] = await Promise.all([
    supabase
      .from("site_builds")
      .select("id, project_id, status, preview_url, created_at")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("deployments")
      .select("project_id, environment, status, url, created_at")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false }),
  ]);

  const latestBuildByProject = new Map<
    string,
    { status: string; previewUrl: string | null }
  >();
  for (const b of (builds ?? []) as Array<{
    project_id: string;
    status: string;
    preview_url: string | null;
  }>) {
    if (!latestBuildByProject.has(b.project_id)) {
      latestBuildByProject.set(b.project_id, {
        status: b.status,
        previewUrl: b.preview_url,
      });
    }
  }
  const productionByProject = new Map<string, string | null>();
  for (const d of (deployments ?? []) as Array<{
    project_id: string;
    environment: string;
    status: string;
    url: string | null;
  }>) {
    if (
      d.environment === "production" &&
      d.status === "ready" &&
      !productionByProject.has(d.project_id)
    ) {
      productionByProject.set(d.project_id, d.url);
    }
  }

  const result = new Map<string, DashboardProjectBuildState>();
  for (const projectId of projectIds) {
    const build = latestBuildByProject.get(projectId);
    result.set(projectId, {
      hasActiveBuild: build ? isActiveBuildStatus(build.status) : false,
      latestBuildStatus: build?.status ?? null,
      productionUrl: productionByProject.get(projectId) ?? null,
      previewUrl: build?.previewUrl ?? null,
    });
  }
  return result;
}
