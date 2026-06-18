import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { evaluatePublishGate } from "@/lib/jab/publish-gate";
import {
  approvePageAction,
  approvePageWithIssuesAction,
  rejectPageAction,
  publishBuildAction,
} from "@/lib/actions/build-review";
import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";
import { partitionScopedPages } from "@/lib/jab/scoped-review";
import { ScopedReviewBanner } from "./ScopedReviewBanner";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  buildThumbnailRequests,
  pickViewportScore,
} from "@/lib/jab/review-thumbnails";

/**
 * Build Review — Phase 5 of the 2026-06-02 SaaS-app completion plan.
 *
 * Mandatory pre-publish surface. Lists every page with its source +
 * generated screenshot thumbs, fidelity score, structured issues, and
 * three per-page approval actions (approve / approve-with-issues /
 * reject). The Publish button is disabled until evaluatePublishGate
 * reports ok=true.
 *
 * RLS-scoped via the user supabase client. Cross-tenant requests
 * resolve as 404, same posture as the project + progress pages.
 */
export const dynamic = "force-dynamic";

interface FidelityRow {
  id: string;
  page_inventory_id: string;
  score: string | null;
  pixel_diff: string | null;
  issues: Array<{
    block_name: string;
    severity: "low" | "medium" | "high";
    description: string;
  }>;
  approval_status: string;
  generated_screenshot_paths: { source?: Record<string, string> } | null;
  viewport_scores: Record<string, { score: number | null; pixel_diff: number | null; http_status: number | null; skipped: boolean }> | null;
  approved_at: string | null;
  approved_by_user_id: string | null;
}

interface PageRow {
  id: string;
  slug: string;
  post_type: string;
  title: string | null;
  route_path: string;
  source_screenshot_paths: { source?: Record<string, string> } | null;
}

export default async function BuildReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; buildId: string }>;
  searchParams?: Promise<{ all?: string }>;
}) {
  const { id: projectId, buildId } = await params;
  const showAll = (await searchParams)?.all === "1";
  const supabase = await createClient();

  const [
    { data: project, error: projErr },
    { data: build, error: buildErr },
    { data: pages, error: pagesErr },
    { data: fidelity, error: fidelityErr },
  ] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", projectId).single(),
    supabase
      .from("site_builds")
      .select(
        "id, project_id, status, preview_url, page_count, block_type_count, component_count, fidelity_avg, config",
      )
      .eq("id", buildId)
      .eq("project_id", projectId)
      .single(),
    supabase
      .from("page_inventory")
      .select("id, slug, post_type, title, route_path, source_screenshot_paths")
      .eq("site_build_id", buildId)
      .order("route_path", { ascending: true }),
    supabase
      .from("fidelity_reports")
      .select(
        "id, page_inventory_id, score, pixel_diff, issues, approval_status, generated_screenshot_paths, viewport_scores, approved_at, approved_by_user_id",
      )
      .eq("site_build_id", buildId),
  ]);

  if (projErr?.code === "PGRST116" || !project) notFound();
  if (projErr) throw projErr;
  if (buildErr?.code === "PGRST116" || !build) notFound();
  if (buildErr) throw buildErr;
  if (pagesErr) throw pagesErr;
  if (fidelityErr) throw fidelityErr;

  const pageRows = (pages ?? []) as PageRow[];
  const fidelityRows = (fidelity ?? []) as FidelityRow[];
  const fidelityByPage = new Map<string, FidelityRow>();
  for (const row of fidelityRows) {
    fidelityByPage.set(row.page_inventory_id, row);
  }

  // Scoped review — only applies when the build was created by an edit
  // (config.mode === "edit"). When scoped, show only changed pages by default;
  // null changedSlugs or change_reason "shell_all" means everything changed.
  const editConfig = isEditConfig(build.config as BuildConfig | null)
    ? (build.config as Extract<BuildConfig, { mode: "edit" }>)
    : null;

  // Join each pageRow with its approval_status from the fidelity row
  const pagesWithStatus = pageRows.map((p) => ({
    ...p,
    approvalStatus: fidelityByPage.get(p.id)?.approval_status ?? "pending",
  }));

  const scoped = editConfig
    ? partitionScopedPages(
        pagesWithStatus,
        editConfig.change_reason === "shell_all" || editConfig.change_reason === null
          ? null
          : editConfig.changed_slugs,
      )
    : null;

  // When editing + not showing all, restrict to changed pages; otherwise show everything
  const listPages =
    editConfig && scoped && !showAll ? scoped.changed : pagesWithStatus;

  // Batch-sign source + generated thumbnails for the pages we will render.
  // The site-screenshots bucket is private, so each <img> needs a signed URL.
  // One createSignedUrls call covers the whole visible page set.
  const thumbRequests = buildThumbnailRequests(
    listPages.map((p) => ({ id: p.id, source_screenshot_paths: p.source_screenshot_paths })),
    fidelityByPage,
  );
  const signedThumbs = new Map<string, string>();
  if (thumbRequests.length > 0) {
    // Thumbnails are presentational — a Storage outage (or any non-StorageError
    // that supabase-js re-throws) must NOT 500 the whole review page and block
    // approve/publish. Degrade to no-thumbnails; every score/issue/action below
    // renders from Postgres data alone.
    try {
      const { data: signed } = await supabase.storage
        .from(SITE_SCREENSHOTS_BUCKET)
        .createSignedUrls(
          thumbRequests.map((r) => r.path),
          60 * 30, // 30 min — comfortably longer than a review session.
        );
      if (signed) {
        signed.forEach((s, i) => {
          if (s.signedUrl) signedThumbs.set(thumbRequests[i].key, s.signedUrl);
        });
      }
    } catch (err) {
      console.warn("[review] thumbnail signing failed; rendering without thumbnails", err);
    }
  }

  const gate = evaluatePublishGate({
    buildStatus: build.status,
    fidelityReports: fidelityRows.map((r) => ({
      approval_status: r.approval_status,
    })),
  });

  const previewUrl = build.preview_url ?? null;
  const fidelityAvg = build.fidelity_avg
    ? Math.round(parseFloat(build.fidelity_avg) * 100)
    : null;
  const coverageWithSource = pageRows.filter(
    (p) => Object.keys(p.source_screenshot_paths?.source ?? {}).length > 0,
  ).length;

  const approveAction = async (formData: FormData) => {
    "use server";
    const pageId = formData.get("pageInventoryId");
    if (typeof pageId !== "string") throw new Error("missing pageInventoryId");
    await approvePageAction(buildId, pageId, projectId);
  };
  const approveWithIssuesAction = async (formData: FormData) => {
    "use server";
    const pageId = formData.get("pageInventoryId");
    if (typeof pageId !== "string") throw new Error("missing pageInventoryId");
    await approvePageWithIssuesAction(buildId, pageId, projectId);
  };
  const rejectAction = async (formData: FormData) => {
    "use server";
    const pageId = formData.get("pageInventoryId");
    if (typeof pageId !== "string") throw new Error("missing pageInventoryId");
    await rejectPageAction(buildId, pageId, projectId);
  };
  const publishAction = async () => {
    "use server";
    await publishBuildAction({ buildId });
  };

  return (
    <article className="flex flex-col">
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-bord bg-surf/95 px-8">
        <Breadcrumb projectId={projectId} projectName={project.name} buildId={buildId} />
        <div className="flex shrink-0 items-center gap-2">
          {previewUrl && (
            <Link
              href={previewUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-gry-d"
            >
              Open preview
            </Link>
          )}
          <form action={publishAction}>
            <button
              type="submit"
              disabled={!gate.ok}
              title={gate.ok ? "Promote this build to production" : gate.reason}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-teal px-3.5 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Publish to production →
            </button>
          </form>
        </div>
      </div>

      <header className="border-b border-bord bg-bg px-8 pt-7">
        <h1 className="mb-1 text-2xl font-extrabold leading-[1.2] tracking-[-0.015em] text-wht">
          Review {project.name}
        </h1>
        <p className="text-sm text-gry">
          <span className="font-mono text-xs text-gry-d">{buildId.slice(0, 8)}</span>{" "}
          · {pageRows.length} page(s) · {build.block_type_count ?? "—"} block types ·{" "}
          {build.component_count ?? "—"} components · {coverageWithSource}/{pageRows.length} source captures{" "}
          {fidelityAvg !== null && ` · avg fidelity ${fidelityAvg}%`}
        </p>
      </header>

      <div className="flex-1 px-8 py-7">
        {!gate.ok && (
          <div className="mb-4 rounded-lg border border-amb/30 bg-amb/[0.04] px-5 py-4">
            <div className="text-sm font-bold text-amb">Not yet publishable</div>
            <p className="mt-1 text-sm text-gry">{gate.reason}</p>
          </div>
        )}
        {editConfig && scoped && (
          <ScopedReviewBanner
            action={editConfig.action}
            changedCount={scoped.changedCount}
            carriedCount={scoped.carried.length}
          />
        )}
        <div className="overflow-hidden rounded-lg border border-bord bg-bg">
          <div className="flex items-center justify-between border-b border-bord px-5 py-3.5">
            <div className="text-sm font-bold leading-snug text-wht">Pages</div>
            {editConfig && scoped && scoped.carried.length > 0 && (
              <Link
                href={
                  showAll
                    ? `/projects/${projectId}/builds/${buildId}/review`
                    : `/projects/${projectId}/builds/${buildId}/review?all=1`
                }
                className="font-mono text-[11px] text-teal hover:underline"
              >
                {showAll
                  ? `Show changed only (${scoped.changedCount})`
                  : `Show all pages (${pageRows.length})`}
              </Link>
            )}
          </div>
          <ul className="divide-y divide-bord">
            {listPages.map((page) => {
              const fidelityRow = fidelityByPage.get(page.id);
              return (
                <PageReviewRow
                  key={page.id}
                  page={page}
                  fidelity={fidelityRow ?? null}
                  signedThumbs={signedThumbs}
                  approveAction={approveAction}
                  approveWithIssuesAction={approveWithIssuesAction}
                  rejectAction={rejectAction}
                />
              );
            })}
            {listPages.length === 0 && (
              <li className="px-5 py-6 text-center text-sm text-gry">
                {editConfig && scoped && !showAll
                  ? "No changed pages to review — all pages carried their prior approval."
                  : "No pages were discovered for this build."}
              </li>
            )}
          </ul>
        </div>
      </div>
    </article>
  );
}

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
      <Chevron />
      <Link
        href={`/projects/${projectId}`}
        className="text-gry-d no-underline transition-colors hover:text-gry"
      >
        {projectName}
      </Link>
      <Chevron />
      <Link
        href={`/projects/${projectId}/builds/${buildId}/progress`}
        className="text-gry-d no-underline transition-colors hover:text-gry"
      >
        Build {buildId.slice(0, 8)}
      </Link>
      <Chevron />
      <span className="text-gry">Review</span>
    </nav>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ViewportThumbs({
  pageId,
  viewport,
  label,
  signedThumbs,
  viewportScore,
}: {
  pageId: string;
  viewport: string;
  label: string;
  signedThumbs: Map<string, string>;
  viewportScore: { score: number | null; blocking: boolean } | null;
}) {
  const source = signedThumbs.get(`${pageId}:${viewport}:source`);
  const generated = signedThumbs.get(`${pageId}:${viewport}:generated`);
  if (!source && !generated) return null;
  const pct =
    viewportScore && viewportScore.score !== null ? `${Math.round(viewportScore.score * 100)}%` : "—";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-gry-d">
        <span>{label}</span>
        <span>·</span>
        <span className={viewportScore?.blocking ? "text-red" : "text-gry"}>{pct}</span>
        {viewportScore?.blocking && (
          <span className="rounded-sm border border-red/40 bg-red/10 px-1 text-[9px] text-red">broken</span>
        )}
      </div>
      <div className="flex gap-1">
        {[
          { url: source, alt: `${label} source` },
          { url: generated, alt: `${label} generated` },
        ].map(({ url, alt }, i) =>
          url ? (
            <a key={i} href={url} target="_blank" rel="noreferrer noopener" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={alt}
                loading="lazy"
                className="h-24 w-20 rounded border border-bord object-cover object-top"
              />
            </a>
          ) : (
            <div
              key={i}
              className="flex h-24 w-20 items-center justify-center rounded border border-dashed border-bord text-[9px] text-gry-d"
            >
              none
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface PageReviewRowProps {
  page: PageRow;
  fidelity: FidelityRow | null;
  signedThumbs: Map<string, string>;
  approveAction: (formData: FormData) => Promise<void>;
  approveWithIssuesAction: (formData: FormData) => Promise<void>;
  rejectAction: (formData: FormData) => Promise<void>;
}

function PageReviewRow({
  page,
  fidelity,
  signedThumbs,
  approveAction,
  approveWithIssuesAction,
  rejectAction,
}: PageReviewRowProps) {
  const score = fidelity?.score ? Math.round(parseFloat(fidelity.score) * 100) : null;
  const status = fidelity?.approval_status ?? "pending";
  const issueCount = fidelity?.issues?.length ?? 0;
  const STATUS_TONE: Record<string, string> = {
    pending: "border-bord bg-elev text-gry",
    approved: "border-teal/30 bg-teal/10 text-teal",
    approved_with_issues: "border-amb/30 bg-amb/10 text-amb",
    rejected: "border-red/30 bg-red/10 text-red",
  };
  return (
    <li className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-wht">
            {page.title || page.slug}
          </span>
          <span className="shrink-0 rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[10px] text-gry">
            {page.post_type}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px] text-gry-d">
          <span>{page.route_path}</span>
          {fidelity ? (
            <>
              <span>·</span>
              <span>score {score !== null ? `${score}%` : "—"}</span>
              {fidelity.pixel_diff !== null && (
                <>
                  <span>·</span>
                  <span>diff {Math.round(parseFloat(fidelity.pixel_diff) * 100)}%</span>
                </>
              )}
              {issueCount > 0 && (
                <>
                  <span>·</span>
                  <span>{issueCount} issue(s)</span>
                </>
              )}
            </>
          ) : (
            <>
              <span>·</span>
              <span>no fidelity row</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-3">
        <ViewportThumbs
          pageId={page.id}
          viewport="1280"
          label="desktop"
          signedThumbs={signedThumbs}
          viewportScore={pickViewportScore(fidelity?.viewport_scores, "1280")}
        />
        <ViewportThumbs
          pageId={page.id}
          viewport="375"
          label="mobile"
          signedThumbs={signedThumbs}
          viewportScore={pickViewportScore(fidelity?.viewport_scores, "375")}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`inline-flex h-6 items-center rounded-full border px-2.5 font-mono text-[10px] ${
            STATUS_TONE[status] ?? STATUS_TONE.pending
          }`}
        >
          {status.replace(/_/g, " ")}
        </span>
        {fidelity && (
          <>
            <form action={approveAction}>
              <input type="hidden" name="pageInventoryId" value={page.id} />
              <button
                type="submit"
                className="inline-flex h-7 items-center rounded-md border border-teal/40 bg-teal/[0.06] px-2.5 text-[12px] font-medium text-teal transition-colors hover:border-teal hover:bg-teal/[0.12]"
              >
                Approve
              </button>
            </form>
            <form action={approveWithIssuesAction}>
              <input type="hidden" name="pageInventoryId" value={page.id} />
              <button
                type="submit"
                className="inline-flex h-7 items-center rounded-md border border-amb/40 bg-amb/[0.06] px-2.5 text-[12px] font-medium text-amb transition-colors hover:border-amb hover:bg-amb/[0.12]"
              >
                Approve w/issues
              </button>
            </form>
            <form action={rejectAction}>
              <input type="hidden" name="pageInventoryId" value={page.id} />
              <button
                type="submit"
                className="inline-flex h-7 items-center rounded-md border border-red/40 bg-red/[0.06] px-2.5 text-[12px] font-medium text-red transition-colors hover:border-red hover:bg-red/[0.12]"
              >
                Reject
              </button>
            </form>
          </>
        )}
      </div>
    </li>
  );
}
