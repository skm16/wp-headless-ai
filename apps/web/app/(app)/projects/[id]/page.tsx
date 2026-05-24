import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import {
  deploymentStatusFrom,
  displayDomainFrom,
  siteIconInitials,
  type DeploymentStatus,
} from "@/lib/derive";
import {
  SITE_DETAIL_MOCKS,
  type AiPromptHistoryRow,
  type DeployRow,
  type LighthouseScores,
  type QuickStat,
  type WpConnection,
} from "./mocks";

/**
 * Site Detail — per-project workspace matching the JAB design mockup
 * (handoff bundle, JAB Site Detail.html). The page itself is a Server
 * Component because the real data (project name, client, WP URL, status)
 * comes from a single Supabase query; everything that isn't yet persisted
 * (Lighthouse, deploys, WP sync metadata, AI history) flows from
 * `./mocks` so the swap is mechanical when Phase 2 lands.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist":
 * if the project belongs to another tenant, supabase returns 0 rows with
 * `code: "PGRST116"`. We surface as 404 in both cases so an attacker
 * can't enumerate IDs to discover other tenants' project IDs.
 *
 * The old GitHub-tied flow (GenerationPanel, LocalDevGuide) is unhooked
 * here. Those component files still exist on disk — orphaned for now
 * pending a sweep once Phase 2's deployments table replaces the GitHub
 * push entirely. DesignTokensReview is also unrendered for this page;
 * the design has no slot for it. It moves to a future Settings tab.
 */
export default async function ProjectDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership, preview_html",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const status = deploymentStatusFrom(project.status);
  const initials = siteIconInitials(project.name);
  const displayDomain = displayDomainFrom(project.wp_url);
  const {
    lighthouse,
    quickStats,
    deploys,
    wpConnection,
    aiHistory,
    aiCreditsRemaining,
    lastDeployedRelative,
  } = SITE_DETAIL_MOCKS;

  // Onboarding state — derived from which wizard outputs are persisted on
  // the row. The wizard auto-saves per step, so this is always in sync
  // with how far the user has walked the flow.
  const isReady = project.status === "ready";
  const isArchived = project.status === "archived";
  const stepCompletedCount =
    (project.intent ? 1 : 0) +
    (project.manifest ? 1 : 0) +
    (project.content_ownership ? 1 : 0);
  const showOnboardingBanner = !isReady && !isArchived;
  const hasManifest = Boolean(project.manifest);

  return (
    <article className="flex flex-col">
      {/* ── TOPBAR ──────────────────────────────────────────── */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-bord bg-surf/95 px-8">
        <Breadcrumb projectName={project.name} />
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={project.wp_url ?? "#"}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-gry-d"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            View site
          </Link>
          <Button size="sm" disabled title="Manual deploys land with Phase 2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
            </svg>
            Deploy
          </Button>
        </div>
      </div>

      {/* ── ONBOARDING BANNER ───────────────────────────────── */}
      {showOnboardingBanner && (
        <OnboardingResumeBanner
          projectId={project.id}
          projectName={project.name}
          stepCompletedCount={stepCompletedCount}
        />
      )}

      {/* ── SITE HEADER ─────────────────────────────────────── */}
      <header className="border-b border-bord bg-bg px-8 pt-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-bord bg-gradient-to-br from-elev to-surf font-display text-lg font-extrabold text-teal">
              {initials}
            </div>
            <div>
              <h1 className="mb-1 font-display text-2xl font-extrabold leading-[1.2] tracking-[-0.015em] text-wht">
                {project.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2.5">
                {project.wp_url && (
                  <a
                    className="font-mono text-xs text-blue no-underline hover:underline"
                    href={project.wp_url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {displayDomain}
                  </a>
                )}
                <StatusChip status={status} />
                {isReady && (
                  <span className="font-mono text-[11px] text-gry-d">
                    Deployed {lastDeployedRelative}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Quick stats — only meaningful once the project is live. */}
        {isReady && (
          <div className="flex flex-wrap items-center">
            {quickStats.map((stat, idx) => (
              <SiteStat key={stat.label} stat={stat} isFirst={idx === 0} />
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="mt-1 flex items-center">
          <ActiveTab>Overview</ActiveTab>
          <InactiveTab>Content</InactiveTab>
          <InactiveTab>AI</InactiveTab>
          <InactiveTab>Deploy</InactiveTab>
          <InactiveTab>Settings</InactiveTab>
        </div>
      </header>

      {/* ── OVERVIEW TAB CONTENT ──────────────────────────── */}
      <div className="flex-1 px-8 py-7">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Left column */}
          <div className="space-y-4">
            <PreviewCard
              lighthouse={lighthouse}
              displayDomain={displayDomain}
              previewHtml={project.preview_html}
              isReady={isReady}
            />
            <WordPressConnectionCard
              connection={wpConnection}
              hasManifest={hasManifest}
              projectId={project.id}
            />
          </div>

          {/* Right column */}
          <div className="space-y-4">
            <DeployHistoryCard deploys={deploys} isReady={isReady} />
            <AiUpdateCard
              history={aiHistory}
              creditsRemaining={aiCreditsRemaining}
              isReady={isReady}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

/* ─────────────────── Onboarding banner ──────────────────── */

const NEXT_STEP_HINT = [
  "pick a project intent",
  "install the Jab plugin",
  "connect for the live data sync",
  "decide where each content type lives",
] as const;

function OnboardingResumeBanner({
  projectId,
  projectName,
  stepCompletedCount,
}: {
  projectId: string;
  projectName: string;
  stepCompletedCount: number;
}) {
  const clamped = Math.min(stepCompletedCount, 3);
  const nextHint = NEXT_STEP_HINT[clamped]!;
  return (
    <div className="border-b border-teal/30 bg-teal/10 px-8 py-3.5">
      <div className="flex flex-wrap items-center gap-4">
        <span
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-teal"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 text-sm text-wht">
          <span className="font-semibold">Finish setting up {projectName}.</span>{" "}
          <span className="text-gry">
            You&apos;re {stepCompletedCount} of 4 steps in — {nextHint}.
          </span>
        </p>
        <Link
          href={`/projects/${projectId}/onboard`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-teal px-3.5 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110"
        >
          Resume setup →
        </Link>
      </div>
    </div>
  );
}

/* ───────────────────────── Topbar ───────────────────────── */

function Breadcrumb({ projectName }: { projectName: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-2 font-mono text-xs text-gry-d"
    >
      <Link href="/dashboard" className="text-gry-d no-underline transition-colors hover:text-gry">
        Dashboard
      </Link>
      <ChevronRight />
      <Link href="/dashboard" className="text-gry-d no-underline transition-colors hover:text-gry">
        My Sites
      </Link>
      <ChevronRight />
      <span className="text-gry">{projectName}</span>
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

/* ─────────────────── Header sub-components ─────────────── */

function StatusChip({ status }: { status: DeploymentStatus }) {
  const TONE_CLASSES: Record<DeploymentStatus["tone"], string> = {
    live: "bg-teal/10 text-teal border-teal/20",
    building: "bg-amb/10 text-amb border-amb/20",
    error: "bg-red/10 text-red border-red/20",
    draft: "bg-elev text-gry-d border-bord",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${TONE_CLASSES[status.tone]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${status.pulse ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      {status.label}
    </span>
  );
}

function SiteStat({ stat, isFirst }: { stat: QuickStat; isFirst: boolean }) {
  return (
    <div
      className={`flex flex-col gap-0.5 border-r border-bord px-6 py-3.5 ${isFirst ? "pl-0" : ""}`}
    >
      <div className="font-display text-xl font-extrabold leading-[1.15] tracking-[-0.01em] text-teal">
        {stat.value}
      </div>
      <div className="font-mono text-[11px] text-gry-d">{stat.label}</div>
    </div>
  );
}

function ActiveTab({ children }: { children: React.ReactNode }) {
  return (
    <span className="cursor-default whitespace-nowrap border-b-2 border-teal px-5 py-3.5 text-sm font-medium text-wht">
      {children}
    </span>
  );
}

function InactiveTab({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="cursor-not-allowed whitespace-nowrap border-b-2 border-transparent px-5 py-3.5 text-sm font-medium text-gry transition-colors hover:text-wht"
      title="Coming soon"
    >
      {children}
    </span>
  );
}

/* ───────────────────── Preview card ─────────────────────── */

function PreviewCard({
  lighthouse,
  displayDomain,
  previewHtml,
  isReady,
}: {
  lighthouse: LighthouseScores;
  displayDomain: string;
  previewHtml: string | null;
  isReady: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="font-display text-sm font-bold leading-snug text-wht">
          Preview
        </div>
        {isReady && (
          <a href="#" className="font-mono text-[11px] text-gry-d no-underline transition-colors hover:text-teal">
            Open full preview →
          </a>
        )}
      </div>
      <div className="p-4">
        <div className="overflow-hidden rounded-md border border-bord">
          {/* Browser chrome */}
          <div className="flex items-center gap-2.5 border-b border-bord bg-surf px-3.5 py-2.5">
            <div className="flex gap-1.5" aria-hidden="true">
              <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
              <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
              <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
            </div>
            <div className="flex flex-1 items-center gap-1.5 rounded-sm border border-bord bg-elev px-2.5 py-1 font-mono text-[11px] text-gry">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--teal))" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span className="truncate">{displayDomain || "preview pending"}</span>
            </div>
          </div>
          {/* Body — use the saved preview HTML when present, else a placeholder */}
          {previewHtml ? (
            <iframe
              srcDoc={previewHtml}
              title="Site preview"
              sandbox="allow-scripts"
              className="block h-[260px] w-full border-0 bg-bg"
            />
          ) : (
            <div className="relative h-[260px] overflow-hidden bg-bg">
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage: "radial-gradient(circle, #1e3a5f 1px, transparent 1px)",
                  backgroundSize: "32px 32px",
                }}
                aria-hidden="true"
              />
              <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-gry-d">
                <div className="text-center">
                  <svg width="24" height="24" viewBox="0 0 48 48" fill="none" className="mx-auto mb-2 opacity-20" aria-hidden="true">
                    <circle cx="24" cy="24" r="18" stroke="rgb(var(--gry))" strokeWidth="1.5" />
                    <path d="M24 6C18 14 18 34 24 42M24 6C30 14 30 34 24 42" stroke="rgb(var(--gry))" strokeWidth="1.5" />
                    <path d="M6 24H42" stroke="rgb(var(--gry))" strokeWidth="1.5" />
                  </svg>
                  <div>Site preview</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Perf metrics — real values once a deploy has run; placeholders for drafts. */}
      <div className="grid grid-cols-4 gap-px bg-bord">
        <PerfItem value={isReady ? lighthouse.performance : null} label="Performance" />
        <PerfItem value={isReady ? lighthouse.accessibility : null} label="Accessibility" />
        <PerfItem value={isReady ? lighthouse.bestPractices : null} label="Best Practices" />
        <PerfItem value={isReady ? lighthouse.seo : null} label="SEO" />
      </div>
      {!isReady && (
        <p className="border-t border-bord bg-surf/40 px-4 py-2 text-center font-mono text-[11px] text-gry-d">
          Scores available after the first deploy.
        </p>
      )}
    </div>
  );
}

function PerfItem({ value, label }: { value: number | null; label: string }) {
  // Color thresholds match Lighthouse's own: ≥90 green, ≥50 amber, else red.
  // A null value renders an em-dash placeholder in muted text — used on
  // draft projects where no real Lighthouse run exists yet.
  const tone =
    value === null
      ? "text-gry-d"
      : value >= 90
        ? "text-teal"
        : value >= 50
          ? "text-amb"
          : "text-red";
  return (
    <div className="bg-bg p-4 text-center">
      <div
        className={`mb-0.5 font-display text-2xl font-extrabold leading-[1.15] tracking-[-0.01em] ${tone}`}
      >
        {value ?? "—"}
      </div>
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-gry-d">
        {label}
      </div>
    </div>
  );
}

/* ──────────────── WordPress connection card ────────────── */

function WordPressConnectionCard({
  connection,
  hasManifest,
  projectId,
}: {
  connection: WpConnection;
  hasManifest: boolean;
  projectId: string;
}) {
  if (!hasManifest) {
    return (
      <div className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
          <div className="font-display text-sm font-bold leading-snug text-wht">
            WordPress Connection
          </div>
          <span className="rounded-full border border-bord bg-elev px-2.5 py-0.5 font-mono text-[11px] text-gry-d">
            ● Not connected
          </span>
        </div>
        <div className="space-y-3 px-5 py-6 text-center">
          <p className="text-sm text-gry">
            Connect the Jab plugin to see this site&apos;s content types,
            drafts, and custom fields.
          </p>
          <Link
            href={`/projects/${projectId}/onboard`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-teal bg-teal/10 px-3.5 text-[13px] font-medium text-teal transition-colors hover:bg-teal/20"
          >
            Connect →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="font-display text-sm font-bold leading-snug text-wht">
          WordPress Connection
        </div>
        <span className="rounded-full border border-teal/20 bg-teal/10 px-2.5 py-0.5 font-mono text-[11px] text-teal">
          ● Connected
        </span>
      </div>

      <WpRow label="Endpoint">
        <span className="font-mono text-xs text-blue">{connection.endpoint}</span>
      </WpRow>
      <WpRow label="Last sync">
        <span className="text-sm text-wht">{connection.lastSyncRelative}</span>{" "}
        <span className="font-mono text-[11px] text-teal">✓ Success</span>
      </WpRow>
      <WpRow label="Content types">
        <div className="flex flex-wrap gap-1.5">
          {connection.contentTypes.map((t) => (
            <span
              key={t}
              className="rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[11px] text-gry"
            >
              {t}
            </span>
          ))}
          {connection.hiddenContentTypeCount > 0 && (
            <span className="rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[11px] text-gry">
              +{connection.hiddenContentTypeCount} more
            </span>
          )}
        </div>
      </WpRow>
      <WpRow label="Auto-sync">
        <span className="text-sm text-wht">{connection.autoSyncDescription}</span>
      </WpRow>
    </div>
  );
}

function WpRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-bord px-5 py-3.5 last:border-b-0">
      <div className="w-24 shrink-0 font-mono text-[11px] text-gry-d">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ───────────────── Deploy history card ──────────────────── */

function DeployHistoryCard({
  deploys,
  isReady,
}: {
  deploys: DeployRow[];
  isReady: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="font-display text-sm font-bold leading-snug text-wht">
          Deploy History
        </div>
        {isReady && (
          <a href="#" className="font-mono text-[11px] text-gry-d no-underline transition-colors hover:text-teal">
            View all
          </a>
        )}
      </div>
      {isReady ? (
        deploys.map((d) => <DeployHistoryRow key={d.id} deploy={d} />)
      ) : (
        <p className="px-5 py-6 text-center text-sm text-gry">
          No deploys yet. Finish onboarding and we&apos;ll cut your first
          preview deploy.
        </p>
      )}
    </div>
  );
}

function DeployHistoryRow({ deploy }: { deploy: DeployRow }) {
  const ENV_CLASSES: Record<DeployRow["env"], string> = {
    prod: "bg-teal/10 text-teal border-teal/20",
    preview: "bg-elev text-gry-d border-bord",
  };
  const STATUS_CONFIG: Record<DeployRow["status"], { label: string; tone: string; Icon: React.FC }> = {
    live: { label: "Live", tone: "text-teal", Icon: CheckIcon },
    ready: { label: "Ready", tone: "text-teal", Icon: CheckIcon },
    failed: { label: "Failed", tone: "text-red", Icon: XIcon },
  };
  const cfg = STATUS_CONFIG[deploy.status];
  const Icon = cfg.Icon;
  return (
    <div className="flex items-center gap-3 border-b border-bord px-5 py-2.5 text-[13px] last:border-b-0">
      <div className="w-[52px] shrink-0 font-mono text-[11px] text-gry-d">
        {deploy.id}
      </div>
      <span
        className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${ENV_CLASSES[deploy.env]}`}
      >
        {deploy.env}
      </span>
      <div className="min-w-0 flex-1 truncate text-xs text-gry">
        {deploy.message}
      </div>
      <div className={`flex shrink-0 items-center gap-1 font-mono text-[11px] ${cfg.tone}`}>
        <Icon />
        {cfg.label}
      </div>
      <div className="shrink-0 whitespace-nowrap font-mono text-[11px] text-gry-d">
        {deploy.when}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* ────────────────────── AI update card ──────────────────── */

function AiUpdateCard({
  history,
  creditsRemaining,
  isReady,
}: {
  history: AiPromptHistoryRow[];
  creditsRemaining: number;
  isReady: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="font-display text-sm font-bold leading-snug text-wht">
          AI Update
        </div>
        {isReady && (
          <span className="font-mono text-[11px] text-gry-d">
            {creditsRemaining.toLocaleString()} credits left
          </span>
        )}
      </div>

      <div className="border-b border-bord px-5 py-4">
        <textarea
          rows={3}
          disabled={!isReady}
          placeholder={
            isReady
              ? "e.g. Make the hero image full-bleed, use the brand's navy color…"
              : "Finish onboarding to start iterating with AI."
          }
          className="w-full resize-none rounded-md border-[1.5px] border-bord bg-surf px-3.5 py-2.5 text-sm leading-normal text-wht outline-none transition-colors placeholder:text-gry-d focus:border-teal focus:shadow-[0_0_0_3px_rgba(0,201,167,0.1)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-2.5 flex items-center justify-between">
          <div className="font-mono text-[11px] text-gry-d">
            {isReady
              ? "Deploys automatically to preview"
              : "Available once setup is complete"}
          </div>
          <button
            type="button"
            disabled
            title={
              isReady
                ? "AI prompt iteration ships in Phase 2"
                : "Finish onboarding first"
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-teal px-4 py-1.5 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
            </svg>
            Run prompt
          </button>
        </div>
      </div>

      {isReady &&
        history.map((row, idx) => (
          <AiHistoryRow key={`${row.deployId}-${idx}`} row={row} />
        ))}
    </div>
  );
}

function AiHistoryRow({ row }: { row: AiPromptHistoryRow }) {
  const STATUS_CHIP: Record<AiPromptHistoryRow["status"], { label: string; cls: string }> = {
    deployed: {
      label: "✓ Deployed",
      cls: "bg-teal/10 text-teal border-teal/20",
    },
    failed: {
      label: "✗ Failed",
      cls: "bg-red/10 text-red border-red/20",
    },
    pending: {
      label: "● Pending",
      cls: "bg-amb/10 text-amb border-amb/20",
    },
  };
  const chip = STATUS_CHIP[row.status];
  return (
    <div className="flex flex-col gap-1 border-b border-bord px-5 py-3 last:border-b-0">
      <div className="text-[13px] text-wht">{row.prompt}</div>
      <div className="flex items-center gap-2 font-mono text-[11px] text-gry-d">
        <span className={`rounded-sm border px-1.5 py-0.5 ${chip.cls}`}>
          {chip.label}
        </span>
        <span>{row.when}</span>
        <span>{row.deployId}</span>
      </div>
    </div>
  );
}
