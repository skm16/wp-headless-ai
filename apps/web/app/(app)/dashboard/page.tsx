import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { loadDashboardBuildStates } from "@/lib/jab/load-project-builds";
import { phaseLabel } from "@/lib/jab/build-status";
import {
  deriveProjectStatusLabel,
  projectStatusLabelText,
} from "@/lib/jab/project-status-label";

/**
 * Dashboard — list of projects in the user's tenant(s).
 *
 * RLS auto-scopes the query to projects whose tenant_id is in
 * current_user_tenant_ids(). No explicit `.eq("tenant_id", ...)` here
 * because we trust the database to enforce the boundary. (If a future
 * code change accidentally drops the eq, RLS still saves us.)
 *
 * Phase 6: each project card surfaces real build/deploy state via
 * loadDashboardBuildStates — production URL when published, latest
 * build status otherwise. The static `projects.status` column ("ready"
 * etc.) still drives the setup-progress badge during onboarding.
 */
export default async function Dashboard() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select(
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <Alert tone="danger" title="Couldn't load your projects">
        {error.message}
      </Alert>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Connect a client's WordPress site and finish a four-step onboarding — that's everything we need to build."
        action={
          <Link href="/projects/new">
            <Button>Connect your first site →</Button>
          </Link>
        }
      />
    );
  }

  const buildStates = await loadDashboardBuildStates(
    supabase,
    projects.map((p) => p.id),
  );

  return (
    <div className="space-y-7 px-8 py-8">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-extrabold leading-[1.15] tracking-[-0.02em] text-wht">
            My Sites
          </h1>
          <p className="mt-1 text-sm text-gry">
            One per client WordPress site you&apos;ve connected.
          </p>
        </div>
        <Link href="/projects/new">
          <Button>New project</Button>
        </Link>
      </header>

      <ul className="divide-y divide-bord overflow-hidden rounded-lg border border-bord bg-bg">
        {projects.map((p) => {
          const stepCompletedCount =
            (p.intent ? 1 : 0) +
            (p.manifest ? 1 : 0) +
            (p.content_ownership ? 1 : 0);
          const buildState = buildStates.get(p.id) ?? {
            hasActiveBuild: false,
            latestBuildStatus: null,
            productionUrl: null,
            previewUrl: null,
          };
          return (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="group block px-5 py-4 transition-colors hover:bg-white/[0.025] focus-visible:bg-white/[0.025] focus-visible:outline-none"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-bold leading-snug text-wht group-hover:text-teal">
                      {p.name}
                    </h2>
                    <p className="mt-1 truncate font-mono text-xs text-gry-d">
                      {p.client_name ?? "No client name"}
                      {p.wp_url ? ` · ${p.wp_url}` : ""}
                    </p>
                    {buildState.productionUrl && (
                      <p className="mt-1 truncate font-mono text-xs text-teal">
                        ● Live at {buildState.productionUrl.replace(/^https?:\/\//, "")}
                      </p>
                    )}
                    {!buildState.productionUrl && buildState.latestBuildStatus && (
                      <p className="mt-1 truncate font-mono text-xs text-gry-d">
                        Latest build: {phaseLabel(buildState.latestBuildStatus)}
                      </p>
                    )}
                  </div>
                  <ProjectStatusBadge
                    status={p.status}
                    stepCompletedCount={stepCompletedCount}
                    isLive={!!buildState.productionUrl}
                    hasActiveBuild={buildState.hasActiveBuild}
                    latestBuildStatus={buildState.latestBuildStatus}
                  />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Status badge with step-aware copy for projects mid-onboarding.
 *
 * Lifecycle priority:
 *   1. inSetup (draft/onboarding)     — "Setup · Step N of 4"
 *   2. hasActiveBuild                 — "Building"
 *   3. isLive                         — "Live"
 *   4. otherwise                      — static label from STATUS_META
 */
function ProjectStatusBadge({
  status,
  stepCompletedCount,
  isLive,
  hasActiveBuild,
  latestBuildStatus,
}: {
  status: string;
  stepCompletedCount: number;
  isLive: boolean;
  hasActiveBuild: boolean;
  latestBuildStatus: string | null;
}) {
  // Onboarding keeps the finer-grained step badge (predates any build).
  const isInSetup = status === "draft" || status === "onboarding";
  if (isInSetup) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Setup · Step {Math.min(stepCompletedCount + 1, 4)} of 4
      </Badge>
    );
  }
  // Everything past onboarding uses the one shared status word (spec §2.2).
  const label = deriveProjectStatusLabel({
    productionDeployment: isLive ? { id: "live" } : null,
    hasActiveBuild,
    latestBuild: latestBuildStatus ? { status: latestBuildStatus } : null,
    // editAwaitingReview wired by S4 later; absent here -> "live".
  });
  const text = projectStatusLabelText(label);
  return (
    <Badge tone={text.tone} className="shrink-0">
      <StatusDot tone={text.tone} pulse={text.pulse} />
      {text.label}
    </Badge>
  );
}

