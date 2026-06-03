import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { loadDashboardBuildStates } from "@/lib/jab/load-project-builds";
import { phaseLabel } from "@/lib/jab/build-status";

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
}: {
  status: string;
  stepCompletedCount: number;
  isLive: boolean;
  hasActiveBuild: boolean;
}) {
  const isInSetup = status === "draft" || status === "onboarding";
  if (isInSetup) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Setup · Step {Math.min(stepCompletedCount + 1, 4)} of 4
      </Badge>
    );
  }
  if (hasActiveBuild) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Building
      </Badge>
    );
  }
  if (isLive) {
    return (
      <Badge tone="success" className="shrink-0">
        <StatusDot tone="success" />
        Live
      </Badge>
    );
  }
  const meta = STATUS_META[status] ?? STATUS_META.draft!;
  return (
    <Badge tone={meta.tone} className="shrink-0">
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
    </Badge>
  );
}

/**
 * Today's `projects.status` is the project-lifecycle column
 * (draft / onboarding / ready / archived). The richer deployment-derived
 * status (Building / Live / Failed) lives one schema-decision away —
 * keep this mapping close to the DB values so swapping in the new shape
 * is a one-record edit.
 */
const STATUS_META: Record<
  string,
  {
    tone: "neutral" | "warning" | "success" | "danger" | "info";
    label: string;
    pulse: boolean;
  }
> = {
  draft: { tone: "neutral", label: "Draft", pulse: false },
  onboarding: { tone: "warning", label: "Onboarding", pulse: true },
  ready: { tone: "success", label: "Ready", pulse: false },
  archived: { tone: "neutral", label: "Archived", pulse: false },
};
