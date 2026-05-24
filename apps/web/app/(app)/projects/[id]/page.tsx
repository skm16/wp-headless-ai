import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { regenerateHomepageAction } from "@/lib/actions/onboarding";

type PreviewHtmlStatus = "generating" | "ready" | "failed" | null;
type ProjectIntent = "faithful" | "refresh" | "reimagine";

const INTENT_LABEL: Record<ProjectIntent, string> = {
  faithful: "faithful",
  refresh: "refresh",
  reimagine: "reimagine",
};
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
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership, preview_html, preview_html_status, onboarded_at",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const initials = siteIconInitials(project.name);
  const displayDomain = displayDomainFrom(project.wp_url);
  const {
    lighthouse,
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
          {process.env.NODE_ENV !== "production" && (
            <Link
              href="/ui-kit/workspace-jab"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-teal/40 bg-teal/[0.06] px-3.5 text-[13px] font-medium text-teal transition-colors hover:border-teal hover:bg-teal/[0.12]"
              title="Replit-style workspace mockup · dev only"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
              </svg>
              Open Workspace
              <span className="ml-0.5 rounded border border-teal/30 bg-teal/[0.08] px-1 py-px font-mono text-[9px] uppercase tracking-[0.1em] text-teal/80">
                demo
              </span>
            </Link>
          )}
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
          <HeroPreview
            previewHtml={project.preview_html}
            previewHtmlStatus={project.preview_html_status as PreviewHtmlStatus}
            intent={project.intent as "faithful" | "refresh" | "reimagine" | null}
            displayDomain={displayDomain}
            projectId={project.id}
            hasManifest={hasManifest}
          />
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Left column */}
          <div className="space-y-4">
            {/* In the `live` state we keep the original preview-with-Lighthouse
                card. Pre-deploy that card's content (mocked scores) would lie,
                so we suppress it — the HeroPreview above carries the preview. */}
            {live && (
              <PreviewCard
                lighthouse={lighthouse}
                displayDomain={displayDomain}
                previewHtml={project.preview_html}
                isReady={live}
              />
            )}
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

/* ─────────────────── Hero preview block ─────────────────── */

/**
 * Big preview surface used in the post-setup / pre-deploy state. Sits ABOVE
 * the existing card grid so the wow-preview HTML — the most concrete output
 * the user has at this stage — is the visual anchor of the workspace,
 * paired with a "what's next" panel that signposts the platform-side work.
 *
 * Iframe is sandboxed to `allow-scripts` only (no `allow-same-origin`) so
 * the preview HTML can run its own client code but can't read this page's
 * cookies, localStorage, or DOM. Same posture as PreviewCard.
 */
function HeroPreview({
  previewHtml,
  previewHtmlStatus,
  intent,
  displayDomain,
  projectId,
  hasManifest,
}: {
  previewHtml: string | null;
  previewHtmlStatus: PreviewHtmlStatus;
  intent: ProjectIntent | null;
  displayDomain: string;
  projectId: string;
  hasManifest: boolean;
}) {
  const isGenerating = previewHtmlStatus === "generating";
  const isFailed = previewHtmlStatus === "failed";
  const intentLabel = intent ? INTENT_LABEL[intent] : null;
  // `freshness` describes what the preview HTML in the iframe IS, given
  // the status column. "Regenerated" means the post-onboarding worker
  // ran successfully; "From signup" means we're still showing the
  // public-scrape snapshot from before the intent was chosen.
  const freshness =
    previewHtmlStatus === "ready"
      ? `Regenerated with the ${intentLabel ?? "selected"} treatment`
      : isFailed
        ? "Showing the previous preview — regeneration failed"
        : isGenerating
          ? `Rebuilding with the ${intentLabel ?? "selected"} treatment`
          : "From the public homepage snapshot at signup";
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
          <div className="font-display text-sm font-bold leading-snug text-wht">
            Homepage preview
          </div>
          <span className="font-mono text-[11px] text-gry-d">{freshness}</span>
        </div>
        <div className="p-4">
          <div className="overflow-hidden rounded-md border border-bord">
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
            {/* Three visual states:
                  generating — full-card progress message; the old iframe
                               would be misleading mid-regen (it shows
                               pre-intent HTML).
                  failed     — keep the prior iframe (still better than
                               nothing) plus a banner suggesting retry.
                  ready/null — render the iframe with whatever's in
                               preview_html. */}
            {isGenerating ? (
              <RegeneratingPanel intentLabel={intentLabel} />
            ) : previewHtml ? (
              <>
                {isFailed && <RegenerationFailedBanner projectId={projectId} />}
                <iframe
                  srcDoc={previewHtml}
                  title={`Homepage preview for ${displayDomain || "your site"}`}
                  sandbox="allow-scripts"
                  className="block h-[560px] w-full border-0 bg-bg"
                />
              </>
            ) : (
              <div className="relative flex h-[560px] items-center justify-center bg-bg">
                <p className="font-mono text-xs text-gry-d">
                  No preview saved yet — use Regenerate to build one.
                </p>
              </div>
            )}
          </div>
        </div>
        {/* Footer action row. The Regenerate button always shows post-
            setup so the user can re-roll on demand; we disable it
            mid-generation to prevent double-fires. */}
        <div className="flex items-center justify-between gap-3 border-t border-bord px-5 py-3">
          <p className="font-mono text-[11px] leading-snug text-gry-d">
            Regenerates against your WordPress homepage and the {intentLabel ?? "selected"} intent.
            Takes ~20–30s.
          </p>
          <RegenerateButton
            projectId={projectId}
            disabled={isGenerating}
            label={isFailed ? "Retry" : "Regenerate"}
          />
        </div>
      </div>

      <NextStepsPanel projectId={projectId} hasManifest={hasManifest} />
    </div>
  );
}

/**
 * Full-card progress treatment shown while the worker is in flight.
 * Server-rendered — no client polling — so the user refreshes when
 * they want to see the result. We surface the freshness line above the
 * iframe and the auto-refresh meta tag is intentionally NOT used here
 * (page is sticky-topbar'd; an automatic reload would lose scroll
 * position). The button on the right is disabled to prevent re-dispatch.
 */
function RegeneratingPanel({ intentLabel }: { intentLabel: string | null }) {
  return (
    <div className="relative flex h-[560px] flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-bord border-t-teal"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="font-display text-sm font-bold text-wht">
          Rebuilding your homepage
        </p>
        <p className="font-mono text-[11px] text-gry-d">
          Applying the {intentLabel ?? "selected"} treatment with your real WordPress content.
        </p>
        <p className="font-mono text-[11px] text-gry-d">
          Refresh in 20–30s to see it.
        </p>
      </div>
    </div>
  );
}

function RegenerationFailedBanner({ projectId }: { projectId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-red/30 bg-red/10 px-3.5 py-2 text-[11px]">
      <p className="min-w-0 flex-1 text-red">
        Regeneration failed — showing the previous preview. Inngest logs for project {projectId.slice(0, 8)}… carry the trace.
      </p>
    </div>
  );
}

/**
 * Submit-only form that triggers `regenerateHomepageAction`. Inline form
 * keeps this a Server Component — no client JS required to fire the
 * action. The bound projectId lives in a hidden input rather than
 * being closure-captured because Server Actions serialize their
 * arguments and a hidden input is the cleanest channel.
 */
function RegenerateButton({
  projectId,
  disabled,
  label,
}: {
  projectId: string;
  disabled: boolean;
  label: string;
}) {
  async function regenerate(formData: FormData) {
    "use server";
    const id = String(formData.get("projectId") ?? "");
    if (id) await regenerateHomepageAction(id);
  }
  return (
    <form action={regenerate}>
      <input type="hidden" name="projectId" value={projectId} />
      <button
        type="submit"
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-bord px-2.5 text-[11px] font-medium text-wht transition-colors hover:border-teal hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <polyline points="21 4 21 10 15 10" />
        </svg>
        {label}
      </button>
    </form>
  );
}

/**
 * Sidebar panel that names the concrete next things — deploy / domain / AI
 * iteration — and marks each as either ready, coming, or available now.
 * Designed so the user is never wondering "what do I do next?" — the
 * available actions are explicit, and the unavailable ones are honest about
 * when they ship.
 */
function NextStepsPanel({
  projectId,
  hasManifest,
}: {
  projectId: string;
  hasManifest: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="font-display text-sm font-bold leading-snug text-wht">
          What&apos;s next
        </div>
      </div>
      <ol className="divide-y divide-bord">
        <NextStep
          status="now"
          title="Review the homepage preview"
          body="Open it in a new tab if you want a full-page look."
        />
        <NextStep
          status={hasManifest ? "now" : "blocked"}
          title="Adjust content ownership"
          body="Change which content types live in WordPress vs. Jab any time from setup."
          actionLabel="Open setup"
          actionHref={`/projects/${projectId}/onboard`}
        />
        <NextStep
          status="next-release"
          title="First preview deploy"
          body="We'll cut a hosted preview on a client.jab.app subdomain automatically once the hosting layer ships."
        />
        <NextStep
          status="next-release"
          title="AI iteration"
          body={'Refine the design in natural language — "use their brand blue," "add testimonials."'}
        />
      </ol>
    </div>
  );
}

function NextStep({
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
        <div className="font-display text-sm font-bold leading-snug text-wht">
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
        <div className="font-display text-sm font-bold leading-snug text-wht">
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
