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
 * DesignTokensReview is unrendered for this page; the design has no slot
 * for it. It moves to a future Settings tab.
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
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership, onboarded_at",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const initials = siteIconInitials(project.name);
  const displayDomain = displayDomainFrom(project.wp_url);
  const {
    quickStats,
    deploys,
    aiHistory,
    aiCreditsRemaining,
    lastDeployedRelative,
  } = SITE_DETAIL_MOCKS;

  // Three lifecycle states — these are mutually exclusive and replace the
  // earlier two-way `isReady` gate.
  //
  //   inSetup       — wizard hasn't finished. Resume banner + draft chrome.
  //   setupComplete — wizard finished but no real deploy exists yet (Phase 1
  //                   reality for every project). Shows the wow-preview as
  //                   the hero, real WP connection data, and a "what's next"
  //                   explainer. No mocked Lighthouse / deploys / AI history.
  //   live          — a real deploy exists (Phase 2 work — there's no
  //                   `deployments` table yet, so this is always false today;
  //                   the rich populated UI stays dormant behind it).
  //
  // The status column doesn't distinguish setupComplete from live, but
  // `onboarded_at` does — and since no deployment pipeline runs yet, every
  // `ready` row is implicitly setupComplete. When Phase 2 lands, swap `live`
  // for a real deployment-existence query and the rest of this page lights up.
  const isArchived = project.status === "archived";
  const setupComplete = project.status === "ready" || Boolean(project.onboarded_at);
  const live = false; // TODO(phase 2): true once a successful deployment row exists.
  const inSetup = !setupComplete && !isArchived;
  const stepCompletedCount =
    (project.intent ? 1 : 0) +
    (project.manifest ? 1 : 0) +
    (project.content_ownership ? 1 : 0);
  const hasManifest = Boolean(project.manifest);
  const status = headerStatusFor({ live, setupComplete, raw: project.status });

  // Real WP connection summary derived from the columns we have. Replaces
  // the `wordpress.tworoadsbrewing.com` mock — the user's own endpoint and
  // their content_ownership choices are the truth.
  const realWpConnection = realWpConnectionFrom({
    wpUrl: project.wp_url,
    contentOwnership: project.content_ownership as Record<string, "wp-managed" | "jab-managed"> | null,
  });

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
            {live ? "View site" : "View WordPress"}
          </Link>
          <Link
            href={`/projects/${project.id}/workspace`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-teal/40 bg-teal/[0.06] px-3.5 text-[13px] font-medium text-teal transition-colors hover:border-teal hover:bg-teal/[0.12]"
            title="Open the Replit-style workspace for this project"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
            </svg>
            Open Workspace
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
      {inSetup && (
        <OnboardingResumeBanner
          projectId={project.id}
          projectName={project.name}
          stepCompletedCount={stepCompletedCount}
        />
      )}
      {setupComplete && !live && (
        <SetupCompleteBanner projectName={project.name} />
      )}

      {/* ── SITE HEADER ─────────────────────────────────────── */}
      <header className="border-b border-bord bg-bg px-8 pt-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-bord bg-gradient-to-br from-elev to-surf font-display text-lg font-extrabold text-teal">
              {initials}
            </div>
            <div>
              <h1 className="mb-1 text-2xl font-extrabold leading-[1.2] tracking-[-0.015em] text-wht">
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
                {live && (
                  <span className="font-mono text-[11px] text-gry-d">
                    Deployed {lastDeployedRelative}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Quick stats — only meaningful once the project is live. */}
        {live && (
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
        {/* Hero preview slot — only when the wizard's done but no real deploy
            has happened yet. The wow-preview HTML is the single most concrete
            thing the user has at this stage, so we give it the room. */}
        {setupComplete && !live && (
          <ReadyToBuildPanel
            displayDomain={displayDomain}
            projectId={project.id}
            hasManifest={hasManifest}
            contentTypeCount={contentTypeCountFrom(project.content_ownership as Record<string, "wp-managed" | "jab-managed"> | null)}
          />
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Left column */}
          <div className="space-y-4">
            <WordPressConnectionCard
              connection={realWpConnection}
              hasManifest={hasManifest}
              projectId={project.id}
              live={live}
            />
          </div>

          {/* Right column */}
          <div className="space-y-4">
            <DeployHistoryCard
              deploys={deploys}
              live={live}
              setupComplete={setupComplete}
            />
            <AiUpdateCard
              history={aiHistory}
              creditsRemaining={aiCreditsRemaining}
              live={live}
              setupComplete={setupComplete}
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

/* ───────────────── Setup-complete banner ────────────────── */

function SetupCompleteBanner({ projectName }: { projectName: string }) {
  return (
    <div className="border-b border-teal/30 bg-gradient-to-r from-teal/15 via-teal/10 to-transparent px-8 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal text-bg"
          aria-hidden="true"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-sm text-wht">
          <span className="font-semibold">Setup complete for {projectName}.</span>{" "}
          <span className="text-gry">
            Your homepage preview is below. Hosting + first deploy ships in the next platform release.
          </span>
        </p>
      </div>
    </div>
  );
}

/* ─────────────────── Ready-to-build panel ──────────────────── */

/**
 * Replaces the v1 HeroPreview. With the preview path gone, the post-
 * onboarding workspace's hero is a confidence anchor instead of a
 * generated artifact — it tells the user the platform sees their site
 * and is ready to build it, surfacing the content-type count discovered
 * at connect time as the proof point.
 *
 * The "Build site" affordance lands in Stage 7 (orchestration); the
 * placeholder button here is disabled with explanatory text so the surface
 * doesn't pretend to do more than it can.
 */
function ReadyToBuildPanel({
  displayDomain,
  projectId,
  hasManifest,
  contentTypeCount,
}: {
  displayDomain: string;
  projectId: string;
  hasManifest: boolean;
  contentTypeCount: number;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
          <div className="text-sm font-bold leading-snug text-wht">
            Ready to build
          </div>
          <span className="font-mono text-[11px] text-gry-d">{displayDomain}</span>
        </div>
        <div className="space-y-4 px-6 py-7">
          <div className="space-y-1.5">
            <p className="text-base font-bold text-wht">
              Your WordPress site is connected and discoverable.
            </p>
            <p className="text-sm leading-relaxed text-gry">
              {hasManifest
                ? `We can see ${contentTypeCount} content type${contentTypeCount === 1 ? "" : "s"} on this site. When you trigger a build, the pipeline will discover every page, generate a typed React component per unique WordPress block, and deploy a real Next.js site to a preview URL.`
                : "Once the WordPress plugin is connected we'll have the full picture: every content type, every block, every page."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled
              title="Build trigger lands in the orchestration stage"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Build site
            </button>
            <Link
              href={`/projects/${projectId}/onboard`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
            >
              Adjust setup
            </Link>
          </div>
        </div>
      </div>
      <ReadyNextSteps projectId={projectId} hasManifest={hasManifest} />
    </div>
  );
}

function ReadyNextSteps({
  projectId,
  hasManifest,
}: {
  projectId: string;
  hasManifest: boolean;
}) {
  const steps: Array<{
    status: "now" | "next-release" | "blocked";
    title: string;
    body: string;
    actionLabel?: string;
    actionHref?: string;
  }> = [
    {
      status: hasManifest ? "now" : "blocked",
      title: "Adjust content ownership",
      body: "Change which content types live in WordPress vs. Jab any time.",
      actionLabel: "Open setup",
      actionHref: `/projects/${projectId}/onboard`,
    },
    {
      status: "next-release",
      title: "Trigger your first build",
      body: "The 6-phase pipeline produces a typed component library + page routes + a preview URL.",
    },
    {
      status: "next-release",
      title: "Review fidelity + publish",
      body: "Per-page fidelity reports gate publish. Regenerate any component that drifts.",
    },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          What&apos;s next
        </div>
      </div>
      <ol className="divide-y divide-bord">
        {steps.map((step) => (
          <ReadyNextStep key={step.title} {...step} />
        ))}
      </ol>
    </div>
  );
}

function ReadyNextStep({
  status,
  title,
  body,
  actionLabel,
  actionHref,
}: {
  status: "now" | "next-release" | "blocked";
  title: string;
  body: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  const STATUS_META: Record<
    "now" | "next-release" | "blocked",
    { dot: string; chip: string; chipClass: string }
  > = {
    now: {
      dot: "bg-teal",
      chip: "Ready",
      chipClass: "border-teal/20 bg-teal/10 text-teal",
    },
    "next-release": {
      dot: "bg-amb",
      chip: "Next release",
      chipClass: "border-amb/20 bg-amb/10 text-amb",
    },
    blocked: {
      dot: "bg-gry-d",
      chip: "Blocked",
      chipClass: "border-bord bg-elev text-gry-d",
    },
  };
  const meta = STATUS_META[status];
  return (
    <li className="flex flex-col gap-1.5 px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
        <span className="flex-1 truncate text-[13px] font-semibold text-wht">{title}</span>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${meta.chipClass}`}>
          {meta.chip}
        </span>
      </div>
      <p className="pl-4 text-[12px] leading-snug text-gry">{body}</p>
      {actionLabel && actionHref && (
        <div className="pl-4">
          <Link
            href={actionHref}
            className="inline-flex h-7 items-center rounded-md border border-bord px-2.5 text-[11px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
          >
            {actionLabel} →
          </Link>
        </div>
      )}
    </li>
  );
}

/**
 * Derive the post-type / content-ownership count from the persisted map.
 * Used by ReadyToBuildPanel as the wow-moment proof point ("we can see N
 * content types on this site"). Falls back to 0 when nothing is persisted
 * — the panel's copy handles that case explicitly.
 */
function contentTypeCountFrom(
  ownership: Record<string, "wp-managed" | "jab-managed"> | null,
): number {
  if (!ownership) return 0;
  return Object.keys(ownership).length;
}

/* ───────────── Status + connection derivations ──────────── */

/**
 * Map the project's raw lifecycle state onto the chip rendered in the
 * header. `setupComplete && !live` is the new in-between state — the row
 * is `status="ready"` but no deploy actually exists, so we surface it as
 * "Setup complete" (not "Live") to match what's actually true.
 */
function headerStatusFor({
  live,
  setupComplete,
  raw,
}: {
  live: boolean;
  setupComplete: boolean;
  raw: string | null | undefined;
}): DeploymentStatus {
  if (live) return { tone: "live", label: "Live", pulse: false };
  if (setupComplete)
    return { tone: "building", label: "Setup complete", pulse: false };
  return deploymentStatusFrom(raw);
}

/**
 * Build the WordPress connection summary from real project columns. The
 * `wordpress.tworoadsbrewing.com` mock that lived in `./mocks` was load-
 * bearing for the design comp but lies on every real project — the user's
 * own endpoint + their content_ownership choices are the truth.
 *
 * `contentTypes` is sliced to the first 6 to keep the chip row from
 * wrapping into a wall; `hiddenContentTypeCount` carries the overflow.
 * `lastSyncRelative` and `autoSyncDescription` are passed through but
 * the consumer (`WordPressConnectionCard`) hides them in `!live` state
 * since there's no real sync pipeline yet.
 */
function realWpConnectionFrom({
  wpUrl,
  contentOwnership,
}: {
  wpUrl: string | null | undefined;
  contentOwnership: Record<string, "wp-managed" | "jab-managed"> | null;
}): WpConnection {
  const endpoint = displayDomainFrom(wpUrl) || "—";
  const slugs = contentOwnership ? Object.keys(contentOwnership).sort() : [];
  const VISIBLE_CAP = 6;
  return {
    endpoint,
    lastSyncRelative: "—",
    contentTypes: slugs.slice(0, VISIBLE_CAP),
    hiddenContentTypeCount: Math.max(0, slugs.length - VISIBLE_CAP),
    autoSyncDescription: "—",
  };
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
      <div className="text-xl font-extrabold leading-[1.15] tracking-[-0.01em] text-teal">
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

/* ──────────────── WordPress connection card ────────────── */

function WordPressConnectionCard({
  connection,
  hasManifest,
  projectId,
  live,
}: {
  connection: WpConnection;
  hasManifest: boolean;
  projectId: string;
  live: boolean;
}) {
  if (!hasManifest) {
    return (
      <div className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
          <div className="text-sm font-bold leading-snug text-wht">
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
        <div className="text-sm font-bold leading-snug text-wht">
          WordPress Connection
        </div>
        <span className="rounded-full border border-teal/20 bg-teal/10 px-2.5 py-0.5 font-mono text-[11px] text-teal">
          ● Connected
        </span>
      </div>

      <WpRow label="Endpoint">
        <span className="font-mono text-xs text-blue">{connection.endpoint}</span>
      </WpRow>
      {/* Last sync only after Phase 2's sync pipeline exists. Pre-deploy
          there's no recurring sync — just the one-shot manifest pull from
          the wizard, which is misleading to show as "Last sync 2m ago". */}
      {live && (
        <WpRow label="Last sync">
          <span className="text-sm text-wht">{connection.lastSyncRelative}</span>{" "}
          <span className="font-mono text-[11px] text-teal">✓ Success</span>
        </WpRow>
      )}
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
      {/* Auto-sync description ditto — Phase 2. */}
      {live && (
        <WpRow label="Auto-sync">
          <span className="text-sm text-wht">{connection.autoSyncDescription}</span>
        </WpRow>
      )}
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
  live,
  setupComplete,
}: {
  deploys: DeployRow[];
  live: boolean;
  setupComplete: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          Deploy History
        </div>
        {live && (
          <a href="#" className="font-mono text-[11px] text-gry-d no-underline transition-colors hover:text-teal">
            View all
          </a>
        )}
      </div>
      {live ? (
        deploys.map((d) => <DeployHistoryRow key={d.id} deploy={d} />)
      ) : (
        <p className="px-5 py-6 text-center text-sm text-gry">
          {setupComplete
            ? "Hosting + preview deploys ship in the next platform release. We'll cut your first deploy automatically when they land."
            : "No deploys yet. Finish onboarding and we'll cut your first preview deploy."}
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
  live,
  setupComplete,
}: {
  history: AiPromptHistoryRow[];
  creditsRemaining: number;
  live: boolean;
  setupComplete: boolean;
}) {
  const placeholder = live
    ? "e.g. Make the hero image full-bleed, use the brand's navy color…"
    : setupComplete
      ? "AI iteration unlocks once your first deploy lands."
      : "Finish onboarding to start iterating with AI.";
  const footerLabel = live
    ? "Deploys automatically to preview"
    : setupComplete
      ? "Available once your first deploy lands"
      : "Available once setup is complete";
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          AI Update
        </div>
        {live && (
          <span className="font-mono text-[11px] text-gry-d">
            {creditsRemaining.toLocaleString()} credits left
          </span>
        )}
      </div>

      <div className="border-b border-bord px-5 py-4">
        <textarea
          rows={3}
          disabled={!live}
          placeholder={placeholder}
          className="w-full resize-none rounded-md border-[1.5px] border-bord bg-surf px-3.5 py-2.5 text-sm leading-normal text-wht outline-none transition-colors placeholder:text-gry-d focus:border-teal focus:shadow-[0_0_0_3px_rgba(0,201,167,0.1)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-2.5 flex items-center justify-between">
          <div className="font-mono text-[11px] text-gry-d">{footerLabel}</div>
          <button
            type="button"
            disabled
            title={
              live
                ? "AI prompt iteration ships in Phase 2"
                : setupComplete
                  ? "Available after the first deploy lands"
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

      {live &&
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
