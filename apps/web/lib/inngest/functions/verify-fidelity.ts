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
  flagForVision,
  visionScore,
  VISION_PER_BUILD_CAP,
} from "@/lib/ai/fidelity-score";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";
import { applyCarryForwardApprovals } from "@/lib/inngest/functions/edit-site.helpers";
import { isBuildCancelled } from "@/lib/jab/build-cancel";

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
        await step.run("mark-ready-empty", async () => {
          const supabase = createAdminClient();
          await supabase
            .from("site_builds")
            .update({
              status: "ready",
              finished_at: new Date().toISOString(),
            })
            .eq("id", buildId)
            .eq("project_id", projectId)
            .neq("status", "cancelled");
        });
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
      const scoring = await step.run("score-pages", async () => {
        const supabase = createAdminClient();
        const rows: Array<{
          page_inventory_id: string;
          score: number | null;
          pixel_diff: number | null;
          issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }>;
          generated_screenshot_paths: VerifyPageResult["generatedScreenshotPaths"];
          skipped: boolean;
        }> = [];

        let visionCallsRemaining = VISION_PER_BUILD_CAP;
        for (const page of pages) {
          const generated = generatedResults.find(
            (g) => g.pageInventoryId === page.id,
          );
          const sourcePaths =
            (page.source_screenshot_paths?.source as Record<string, string> | undefined) ?? {};
          // v1: score against the 1280 viewport only. The page_inventory
          // schema accepts multiple viewports; verification only needs one
          // axis to flag drift. Multi-viewport scoring is a follow-up.
          const sourcePath = sourcePaths["1280"] ?? null;
          const generatedPath =
            generated?.generatedScreenshotPaths.source["1280"] ?? null;

          if (!sourcePath || !generatedPath) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? {
                source: {},
              },
              skipped: true,
            });
            continue;
          }

          const [sourceBuf, generatedBuf] = await Promise.all([
            downloadBucket(supabase, sourcePath),
            downloadBucket(supabase, generatedPath),
          ]);
          if (!sourceBuf || !generatedBuf) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? {
                source: {},
              },
              skipped: true,
            });
            continue;
          }

          const diff = pixelDiffScore({
            sourceBuffer: sourceBuf,
            generatedBuffer: generatedBuf,
          });
          let scored = diff.score;
          let issues: Array<{
            block_name: string;
            severity: "low" | "medium" | "high";
            description: string;
          }> = [];
          if (flagForVision(diff.diffRatio) && visionCallsRemaining > 0) {
            visionCallsRemaining--;
            const vision = await visionScore({ pixelDiffScore: diff.score });
            scored = vision.score;
            issues = vision.issues;
          }
          rows.push({
            page_inventory_id: page.id,
            score: scored,
            pixel_diff: diff.diffRatio,
            issues,
            generated_screenshot_paths: generated!.generatedScreenshotPaths,
            skipped: false,
          });
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

      await step.run("finalize-ready", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
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
          .neq("status", "cancelled");
        if (error) {
          throw new Error(`verify-fidelity: finalize-ready update failed: ${error.message}`);
        }
      });

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
