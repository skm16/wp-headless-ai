import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  captureGeneratedScreenshots,
  type VerifyPageDescriptor,
  type VerifyPageResult,
  type NavPerf,
} from "@/lib/jab/playwright-verify";
import {
  pixelDiffScore,
  visionScore,
  selectVisionPages,
  sizeMismatchIssue,
  visionUnavailableIssue,
  httpFailureRow,
  mobileDivergenceIssue,
  viewportScoreEntry,
  skippedViewportEntry,
  buildViewportScores,
  resolveCanonicalScore,
  SCORED_VIEWPORTS,
  type ViewportScoreEntry,
} from "@/lib/ai/fidelity-score";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";
import { applyCarryForwardApprovals } from "@/lib/inngest/functions/edit-site.helpers";
import { isBuildCancelled } from "@/lib/jab/build-cancel";
import { ACTIVE_BUILD_PHASES } from "@/lib/jab/build-status";

/**
 * verifyFidelity — Phase E (Phase 4 of the 2026-06-02 SaaS-app completion
 * plan) worker.
 *
 * Triggered by `site/verify.requested` (dispatched by deploy-site.ts on
 * a READY Vercel deployment). Sequence:
 *
 *    1. load-build              — confirm we have preview_url + page_inventory
 *    2. capture-generated       — Playwright pass against the preview URL
 *    3. score-pages             — pixel-diff every page against its source
 *                                 capture; flagged pages get a vision pass
 *                                 (currently a stub that echoes the pixel
 *                                 score — see fidelity-score.ts).
 *    4. persist                 — upsert one fidelity_reports row per page
 *    5. finalize                — write fidelity_avg + flip status='ready'
 *
 * Pages whose source captures are missing get a skipped row (score=null,
 * pixel_diff=null) so the review screen can show "we couldn't verify
 * this page" rather than silently dropping it.
 */

export const verifyFidelity = inngest.createFunction(
  { id: "verify-fidelity", retries: 0 },
  { event: "site/verify.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId: _tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    try {
      const build = await step.run("load-build", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .select("id, project_id, status, preview_url, config")
          .eq("id", buildId)
          .eq("project_id", projectId)
          .single<{ id: string; project_id: string; status: string; preview_url: string | null; config: unknown }>();
        if (error || !data) {
          throw new Error(`verify-fidelity: load-build failed: ${error?.message ?? "no row"}`);
        }
        if (!data.preview_url) {
          throw new Error(
            `verify-fidelity: build ${buildId} has no preview_url. Skipping verification.`,
          );
        }
        return data;
      });

      const config = (build.config ?? { mode: "full" }) as BuildConfig;

      const pages = await step.run("load-pages", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("page_inventory")
          .select("id, slug, post_type, route_path, source_screenshot_paths")
          .eq("site_build_id", buildId)
          .eq("project_id", projectId);
        if (error) {
          throw new Error(`verify-fidelity: load-pages failed: ${error.message}`);
        }
        return (data ?? []) as Array<{
          id: string;
          slug: string;
          post_type: string;
          route_path: string;
          source_screenshot_paths: { source?: Record<string, string> } | null;
        }>;
      });

      if (pages.length === 0) {
        // No pages to score — still mark ready so the build can move on.
        // For an edit build with zero pages, we deliberately do NOT carry forward
        // approvals (there are none to carry). The publish gate's no_fidelity_rows
        // reject then correctly blocks publish — intended fail-closed (§3.4).
        const emptyAdvanced = await step.run("mark-ready-empty", async () => {
          const supabase = createAdminClient();
          const { data, error } = await supabase
            .from("site_builds")
            .update({
              status: "ready",
              finished_at: new Date().toISOString(),
            })
            .eq("id", buildId)
            .eq("project_id", projectId)
            .in("status", [...ACTIVE_BUILD_PHASES])
            .select("id");
          if (error) throw new Error(`verify-fidelity: mark-ready-empty update failed: ${error.message}`);
          return (data ?? []).length > 0;
        });
        if (!emptyAdvanced) {
          console.log(`[verify-fidelity] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — leaving it terminal.`);
        }
        return { buildId, scored: 0, skipped: 0, fidelityAvg: null };
      }

      const descriptors: VerifyPageDescriptor[] = pages.map((p) => ({
        pageInventoryId: p.id,
        slug: p.slug,
        postType: p.post_type,
        routePath: p.route_path,
      }));

      const generatedResults: VerifyPageResult[] = await step.run(
        "capture-generated",
        async () => {
          const supabase = createAdminClient();
          return captureGeneratedScreenshots({
            buildId,
            previewUrl: build.preview_url!,
            pages: descriptors,
            supabase,
          });
        },
      );

      const homePerf: NavPerf =
        generatedResults.find((r) => r.perf)?.perf ?? { ttfbMs: null, loadMs: null, transferBytes: null };

      // Pair source ↔ generated screenshots and score per page.
      //
      // Two-phase allocation (campaign Phase 7):
      //   Phase A — pixel-diff EVERY page first. No vision-budget decisions
      //             happen here, so the cap is never consumed by whatever
      //             happens to come first in DB order.
      //   Phase B — sort flagged pages by measured diffRatio DESC and spend
      //             VISION_PER_BUILD_CAP on the worst ones. Each call is
      //             individually fail-soft: vision is advisory, so any error
      //             falls back to the pixel score with a vision_unavailable
      //             marker instead of failing a build that already paid for
      //             discovery, generation, compose, and a Vercel deploy.
      //
      // Buffers do not survive phase A (a 40-page site × 2 full-page PNGs
      // would be unbounded memory), so phase B re-downloads the ≤15 selected
      // pairs — bounded, and it keeps Buffers out of the step's JSON-
      // serialized return value.
      const scoring = await step.run("score-pages", async () => {
        const supabase = createAdminClient();
        const rows: Array<{
          page_inventory_id: string;
          score: number | null;
          pixel_diff: number | null;
          issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }>;
          generated_screenshot_paths: VerifyPageResult["generatedScreenshotPaths"];
          viewport_scores: Record<string, ViewportScoreEntry>;
          skipped: boolean;
        }> = [];

        // ── Phase A: measure every page ─────────────────────────────────
        const candidates: Array<{ pageInventoryId: string; diffRatio: number }> = [];
        const visionMeta = new Map<
          string,
          { rowIndex: number; pixelScore: number; sourcePath: string; generatedPath: string; routePath: string }
        >();

        for (const page of pages) {
          const generated = generatedResults.find(
            (g) => g.pageInventoryId === page.id,
          );
          const statusByVp = generated?.httpStatusByViewport ?? {};

          // HTTP-failure short-circuit, desktop OR mobile. A 4xx/5xx on either
          // scored viewport means the page is broken — score 0, high issue,
          // build still goes ready (the review gate forces a human decision).
          const desktopHttpFail = httpFailureRow(statusByVp["1280"] ?? generated?.httpStatus, page.route_path);
          const mobileHttpFail = httpFailureRow(statusByVp["375"], page.route_path, "mobile");
          if (desktopHttpFail || mobileHttpFail) {
            const issues = [...(desktopHttpFail?.issues ?? []), ...(mobileHttpFail?.issues ?? [])];
            rows.push({
              page_inventory_id: page.id,
              score: 0,
              pixel_diff: null,
              issues,
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              viewport_scores: buildViewportScores({
                "1280": skippedViewportEntry(statusByVp["1280"] ?? generated?.httpStatus ?? null),
                "375": skippedViewportEntry(statusByVp["375"] ?? null),
              }),
              skipped: false,
            });
            continue;
          }

          const sourcePaths =
            (page.source_screenshot_paths?.source as Record<string, string> | undefined) ?? {};

          // Measure each scored viewport independently; desktop is canonical.
          const perViewport: Partial<Record<string, ViewportScoreEntry>> = {};
          let desktopDiffRatio: number | null = null;
          let desktopScore: number | null = null;
          let desktopSizeMismatch = false;
          let desktopHeightDelta = 0;
          let mobileDiffRatio: number | null = null;

          for (const vp of SCORED_VIEWPORTS) {
            const sourcePath = sourcePaths[vp] ?? null;
            const generatedPath = generated?.generatedScreenshotPaths.source[vp] ?? null;
            if (!sourcePath || !generatedPath) {
              perViewport[vp] = skippedViewportEntry(statusByVp[vp] ?? null);
              continue;
            }
            const [sourceBuf, generatedBuf] = await Promise.all([
              downloadBucket(supabase, sourcePath),
              downloadBucket(supabase, generatedPath),
            ]);
            if (!sourceBuf || !generatedBuf) {
              perViewport[vp] = skippedViewportEntry(statusByVp[vp] ?? null);
              continue;
            }
            const diff = pixelDiffScore({ sourceBuffer: sourceBuf, generatedBuffer: generatedBuf });
            perViewport[vp] = viewportScoreEntry(diff, statusByVp[vp] ?? null);
            if (vp === "1280") {
              desktopDiffRatio = diff.diffRatio;
              desktopScore = diff.score;
              desktopSizeMismatch = diff.sizeMismatch;
              desktopHeightDelta = diff.heightDeltaPx;
            } else if (vp === "375") {
              mobileDiffRatio = diff.diffRatio;
            }
          }

          const viewport_scores = buildViewportScores(perViewport);

          // Desktop is the canonical axis. With no desktop measurement the page
          // is unscored/skipped (same as the prior single-viewport behavior),
          // but we persist whatever viewport_scores we did gather.
          if (desktopDiffRatio === null || desktopScore === null) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              viewport_scores,
              skipped: true,
            });
            continue;
          }

          // Catastrophic-mobile gate (only when mobile actually measured).
          const mobileIssue =
            mobileDiffRatio !== null
              ? mobileDivergenceIssue(desktopDiffRatio, mobileDiffRatio, page.route_path)
              : null;

          const issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }> = [];
          if (desktopSizeMismatch) issues.push(sizeMismatchIssue(desktopHeightDelta));
          if (mobileIssue) issues.push(mobileIssue);

          rows.push({
            page_inventory_id: page.id,
            score: resolveCanonicalScore(desktopScore, mobileIssue !== null),
            pixel_diff: desktopDiffRatio,
            issues,
            generated_screenshot_paths: generated!.generatedScreenshotPaths,
            viewport_scores,
            skipped: false,
          });

          // Vision budget is desktop-driven, unchanged. A page zeroed by a
          // mobile block is NOT a vision candidate (its score is already 0 by
          // policy, not by measured desktop divergence).
          if (!mobileIssue) {
            candidates.push({ pageInventoryId: page.id, diffRatio: desktopDiffRatio });
            visionMeta.set(page.id, {
              rowIndex: rows.length - 1,
              pixelScore: desktopScore,
              sourcePath: sourcePaths["1280"]!,
              generatedPath: generated!.generatedScreenshotPaths.source["1280"]!,
              routePath: page.route_path,
            });
          }
        }

        // ── Phase B: spend the vision cap on the worst measured pages ───
        for (const pageId of selectVisionPages(candidates)) {
          const meta = visionMeta.get(pageId);
          if (!meta) continue;
          const row = rows[meta.rowIndex];
          try {
            const [sourceBuf, generatedBuf] = await Promise.all([
              downloadBucket(supabase, meta.sourcePath),
              downloadBucket(supabase, meta.generatedPath),
            ]);
            const vision = await visionScore({
              pixelDiffScore: meta.pixelScore,
              sourceBuffer: sourceBuf ?? undefined,
              generatedBuffer: generatedBuf ?? undefined,
              routePath: meta.routePath,
              // blockNames deliberately unwired (optional): grounded
              // block-level attribution needs the page's block inventory —
              // wire it in Phase 7.1 alongside the real call.
            });
            row.score = vision.score;
            row.issues = [...row.issues, ...vision.issues];
          } catch (err) {
            // Fail-soft skeleton for the Phase 7.1 real call: the page keeps
            // its pixel-derived score and the row records why vision skipped.
            row.issues = [
              ...row.issues,
              visionUnavailableIssue(err instanceof Error ? err.message : String(err)),
            ];
          }
        }
        return rows;
      });

      await step.run("persist-fidelity", async () => {
        const supabase = createAdminClient();
        for (const row of scoring) {
          const { error } = await supabase.from("fidelity_reports").upsert(
            {
              site_build_id: buildId,
              project_id: projectId,
              page_inventory_id: row.page_inventory_id,
              score: row.score,
              pixel_diff: row.pixel_diff,
              issues: row.issues,
              generated_screenshot_paths: row.generated_screenshot_paths,
              viewport_scores: row.viewport_scores,
            },
            { onConflict: "site_build_id,page_inventory_id" },
          );
          if (error) {
            throw new Error(
              `verify-fidelity: persist row for page ${row.page_inventory_id} failed: ${error.message}`,
            );
          }
        }
        return { rows: scoring.length };
      });

      const scoredRows = scoring.filter((r) => !r.skipped && r.score !== null);
      const fidelityAvg =
        scoredRows.length === 0
          ? null
          : scoredRows.reduce((sum, r) => sum + (r.score ?? 0), 0) /
            scoredRows.length;

      if (isEditConfig(config)) {
        const editCfg = config;
        await step.run("carry-forward-approvals", async () => {
          const supabase = createAdminClient();
          if (await isBuildCancelled(supabase, buildId, projectId)) return { skipped: "cancelled" };
          return applyCarryForwardApprovals({
            resultBuildId: buildId,
            sourceBuildId: editCfg.source_build_id,
            changedSlugs: editCfg.changed_slugs,
          });
        });
      }

      const finalAdvanced = await step.run("finalize-ready", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .update({
            status: "ready",
            fidelity_avg: fidelityAvg !== null ? fidelityAvg.toFixed(3) : null,
            ttfb_ms: homePerf.ttfbMs,
            load_ms: homePerf.loadMs,
            transfer_bytes: homePerf.transferBytes !== null ? String(homePerf.transferBytes) : null,
            finished_at: new Date().toISOString(),
          })
          .eq("id", buildId)
          .eq("project_id", projectId)
          .in("status", [...ACTIVE_BUILD_PHASES])
          .select("id");
        if (error) {
          throw new Error(`verify-fidelity: finalize-ready update failed: ${error.message}`);
        }
        return (data ?? []).length > 0;
      });
      if (!finalAdvanced) {
        console.log(`[verify-fidelity] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — leaving it terminal.`);
      }

      return {
        buildId,
        scored: scoredRows.length,
        skipped: scoring.length - scoredRows.length,
        fidelityAvg,
      };
    } catch (err) {
      await markBuildFailed({ buildId, projectId, phase: "verifying", error: err });
      throw err;
    }
  },
);

async function downloadBucket(
  supabase: ReturnType<typeof createAdminClient>,
  path: string,
): Promise<Buffer | null> {
  const { data, error } = await supabase.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .download(path);
  if (error || !data) return null;
  const arr = await data.arrayBuffer();
  return Buffer.from(arr);
}
