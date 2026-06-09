import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  TIMELINE_PHASES,
  STALE_ACTIVE_BUILD_MINUTES,
  phaseLabel,
  isTerminalBuildStatus,
  isStaleActiveBuild,
  type BuildPhase,
} from "@/lib/jab/build-status";
import { formatRelative } from "@/lib/format-relative";

/**
 * Build Progress — Phase 3 of the 2026-06-02 SaaS-app completion plan.
 *
 * Server Component. Reconstructs the build's state from the DB on every
 * load. v1 uses a meta-refresh polling shim (5s) for non-terminal states;
 * Supabase Realtime can replace it later without changing this surface.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist" —
 * the project query returns PGRST116 for both, surfaced as 404. The build
 * query is also RLS-scoped (site_builds_tenant_select policy from
 * migration 0014 verifies the parent project belongs to a tenant the
 * caller is a member of).
 */
export const dynamic = "force-dynamic";

export default async function BuildProgressPage({
  params,
}: {
  params: Promise<{ id: string; buildId: string }>;
}) {
  const { id: projectId, buildId } = await params;
  const supabase = await createClient();

  const [{ data: project, error: projectErr }, { data: build, error: buildErr }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, name, wp_url")
        .eq("id", projectId)
        .single(),
      supabase
        .from("site_builds")
        .select(
          "id, project_id, status, failed_phase, error_text, page_count, block_type_count, component_count, fidelity_avg, preview_url, started_at, finished_at, created_at",
        )
        .eq("id", buildId)
        .eq("project_id", projectId)
        .single(),
    ]);

  if (projectErr?.code === "PGRST116" || !project) notFound();
  if (projectErr) throw projectErr;
  if (buildErr?.code === "PGRST116" || !build) notFound();
  if (buildErr) throw buildErr;

  const status = (build.status ?? "queued") as BuildPhase;
  const failedPhase = (build.failed_phase ?? null) as BuildPhase | null;
  const terminal = isTerminalBuildStatus(status);
  const isFailed = status === "failed";
  const isReady = status === "ready";
  const previewUrl = build.preview_url ?? null;
  const createdAt = build.created_at ? new Date(build.created_at) : null;
  const finishedAt = build.finished_at ? new Date(build.finished_at) : null;
  const elapsedSecs = createdAt
    ? Math.round(((finishedAt ?? new Date()).getTime() - createdAt.getTime()) / 1000)
    : null;

  return (
    <article className="flex flex-col">
      {/* Meta-refresh polling shim — v1 reconstruction-from-DB approach.
          Stops when the build reaches a terminal state so finished pages
          don't keep re-fetching. */}
      {!terminal && (
        // eslint-disable-next-line @next/next/no-head-element
        <meta httpEquiv="refresh" content="5" />
      )}
      {!terminal && isStaleActiveBuild(build.status, build.created_at, Date.now()) && (
        <div className="mx-8 mt-4 rounded-md border border-bord bg-elev px-4 py-3 text-[13px] text-gry">
          This build has been running for over {STALE_ACTIVE_BUILD_MINUTES} minutes and
          appears stuck. Starting a new build from the project page will automatically
          clear it.
        </div>
      )}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-bord bg-surf/95 px-8">
        <Breadcrumb projectId={projectId} projectName={project.name} buildId={buildId} />
        <div className="flex shrink-0 items-center gap-2">
          {isReady && previewUrl && (
            <Link
              href={previewUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-gry-d"
            >
              Open preview
            </Link>
          )}
          {isReady && (
            <Link
              href={`/projects/${projectId}/builds/${buildId}/review`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-teal/40 bg-teal/[0.06] px-3.5 text-[13px] font-semibold text-teal transition-colors hover:border-teal hover:bg-teal/[0.12]"
            >
              Review build →
            </Link>
          )}
        </div>
      </div>

      <header className="border-b border-bord bg-bg px-8 pt-7">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h1 className="mb-1 text-2xl font-extrabold leading-[1.2] tracking-[-0.015em] text-wht">
              Building {project.name}
            </h1>
            <p className="text-sm text-gry">
              <span className="font-mono text-xs text-gry-d">{buildId.slice(0, 8)}</span>{" "}
              · {phaseLabel(status)}
              {createdAt && ` · Started ${formatRelative(createdAt)}`}
              {elapsedSecs !== null && ` · ${elapsedSecs}s elapsed`}
            </p>
          </div>
          <StatusBadge status={status} />
        </div>
      </header>

      <div className="flex-1 px-8 py-7">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Timeline status={status} failedPhase={failedPhase} />
          <CountsCard
            pageCount={build.page_count}
            blockTypeCount={build.block_type_count}
            componentCount={build.component_count}
            fidelityAvg={build.fidelity_avg}
          />
        </div>

        {isFailed && (
          <FailedPanel
            failedPhase={failedPhase}
            errorText={build.error_text}
            projectId={projectId}
          />
        )}
        {isReady && (
          <ReadyPanel
            previewUrl={previewUrl}
            projectId={projectId}
            buildId={buildId}
          />
        )}
      </div>
    </article>
  );
}

/* ───────────────────── Sub-components ───────────────────── */

function Breadcrumb({
  projectId,
  projectName,
  buildId,
}: {
  projectId: string;
  projectName: string;
  buildId: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 font-mono text-xs text-gry-d">
      <Link href="/dashboard" className="text-gry-d no-underline transition-colors hover:text-gry">
        Dashboard
      </Link>
      <ChevronRight />
      <Link
        href={`/projects/${projectId}`}
        className="text-gry-d no-underline transition-colors hover:text-gry"
      >
        {projectName}
      </Link>
      <ChevronRight />
      <span className="text-gry">Build {buildId.slice(0, 8)}</span>
    </nav>
  );
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function StatusBadge({ status }: { status: BuildPhase }) {
  const TONE: Record<BuildPhase, { cls: string; pulse: boolean }> = {
    queued: { cls: "border-bord bg-elev text-gry-d", pulse: false },
    discovering: { cls: "border-amb/30 bg-amb/10 text-amb", pulse: true },
    components: { cls: "border-amb/30 bg-amb/10 text-amb", pulse: true },
    composing: { cls: "border-amb/30 bg-amb/10 text-amb", pulse: true },
    building: { cls: "border-amb/30 bg-amb/10 text-amb", pulse: true },
    verifying: { cls: "border-amb/30 bg-amb/10 text-amb", pulse: true },
    ready: { cls: "border-teal/30 bg-teal/10 text-teal", pulse: false },
    failed: { cls: "border-red/30 bg-red/10 text-red", pulse: false },
    cancelled: { cls: "border-bord bg-elev text-gry", pulse: false },
  };
  const tone = TONE[status] ?? TONE.queued;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${tone.cls}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${tone.pulse ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      {phaseLabel(status)}
    </span>
  );
}

function Timeline({
  status,
  failedPhase,
}: {
  status: BuildPhase;
  failedPhase: BuildPhase | null;
}) {
  const currentIdx = TIMELINE_PHASES.indexOf(status);
  // When the build failed mid-pipeline, the failed_phase is the cursor;
  // otherwise the cursor is the actual status (or `ready` for terminal).
  const failedIdx = failedPhase
    ? TIMELINE_PHASES.indexOf(failedPhase)
    : -1;
  const cursor = status === "failed" && failedIdx >= 0 ? failedIdx : currentIdx;
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="border-b border-bord px-5 py-3.5 text-sm font-bold leading-snug text-wht">
        Pipeline
      </div>
      <ol className="divide-y divide-bord">
        {TIMELINE_PHASES.map((phase, idx) => {
          const isDone = idx < cursor || (status === "ready" && idx <= cursor);
          const isCurrent = idx === cursor && !isDone && status !== "failed";
          const isFailedRung = idx === cursor && status === "failed";
          const isPending = idx > cursor;
          return (
            <li
              key={phase}
              className="flex items-center gap-3 px-5 py-3"
            >
              <RungDot
                isDone={isDone}
                isCurrent={isCurrent}
                isFailedRung={isFailedRung}
                isPending={isPending}
              />
              <span
                className={`flex-1 text-sm ${
                  isFailedRung
                    ? "text-red"
                    : isDone
                      ? "text-wht"
                      : isCurrent
                        ? "text-wht"
                        : "text-gry-d"
                }`}
              >
                {phaseLabel(phase)}
              </span>
              {isCurrent && (
                <span className="font-mono text-[11px] text-amb">in progress</span>
              )}
              {isFailedRung && (
                <span className="font-mono text-[11px] text-red">failed</span>
              )}
              {isDone && (
                <span className="font-mono text-[11px] text-teal">✓</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RungDot({
  isDone,
  isCurrent,
  isFailedRung,
  isPending,
}: {
  isDone: boolean;
  isCurrent: boolean;
  isFailedRung: boolean;
  isPending: boolean;
}) {
  const cls = isFailedRung
    ? "bg-red"
    : isDone
      ? "bg-teal"
      : isCurrent
        ? "bg-amb animate-pulse"
        : "bg-elev border border-bord";
  if (isPending) {
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-elev border border-bord" aria-hidden="true" />;
  }
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden="true" />;
}

function CountsCard({
  pageCount,
  blockTypeCount,
  componentCount,
  fidelityAvg,
}: {
  pageCount: number | null;
  blockTypeCount: number | null;
  componentCount: number | null;
  fidelityAvg: string | null;
}) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Pages", value: formatCount(pageCount) },
    { label: "Block types", value: formatCount(blockTypeCount) },
    { label: "Components", value: formatCount(componentCount) },
    { label: "Avg fidelity", value: fidelityAvg ? `${Math.round(parseFloat(fidelityAvg) * 100)}%` : "—" },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="border-b border-bord px-5 py-3.5 text-sm font-bold leading-snug text-wht">
        Counts
      </div>
      <dl className="divide-y divide-bord">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-5 py-3">
            <dt className="w-32 shrink-0 font-mono text-[11px] text-gry-d">{row.label}</dt>
            <dd className="flex-1 text-right text-sm font-bold text-teal">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatCount(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return String(n);
}

function FailedPanel({
  failedPhase,
  errorText,
  projectId,
}: {
  failedPhase: BuildPhase | null;
  errorText: string | null;
  projectId: string;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-red/30 bg-red/[0.04]">
      <div className="flex items-center justify-between gap-3 border-b border-red/20 px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-red">
          Build failed
        </div>
        <span className="font-mono text-[11px] text-red">
          {failedPhase ? phaseLabel(failedPhase) : "Unknown phase"}
        </span>
      </div>
      <div className="space-y-3 px-5 py-4">
        {errorText ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-bord bg-bg px-3 py-2 font-mono text-[12px] text-gry">
            {errorText}
          </pre>
        ) : (
          <p className="text-sm text-gry">
            No error message was captured. Check the Inngest dashboard for the worker run trace.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/projects/${projectId}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
          >
            Back to project
          </Link>
        </div>
      </div>
    </div>
  );
}

function ReadyPanel({
  previewUrl,
  projectId,
  buildId,
}: {
  previewUrl: string | null;
  projectId: string;
  buildId: string;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-teal/30 bg-teal/[0.04]">
      <div className="flex items-center justify-between gap-3 border-b border-teal/20 px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-teal">
          Build ready
        </div>
      </div>
      <div className="space-y-3 px-5 py-4">
        <p className="text-sm text-gry">
          Every phase completed. Open the preview and step through the review
          screen — publishing promotes this build to production.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {previewUrl && (
            <Link
              href={previewUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
            >
              Open preview ↗
            </Link>
          )}
          <Link
            href={`/projects/${projectId}/builds/${buildId}/review`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110"
          >
            Review build →
          </Link>
        </div>
      </div>
    </div>
  );
}
