import "server-only";
import { chromium } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { VIEWPORT_WIDTHS, type ViewportWidth } from "./discovery-types";

/**
 * playwright-verify.ts — Phase E (Phase 4 of the 2026-06-02 SaaS-app
 * completion plan) capture-the-deployed-preview pass.
 *
 * Companion to playwright-discovery.ts. Where discovery captures the live
 * WordPress site, this one captures the freshly-deployed preview at
 * `${previewUrl}${page.route_path}` and uploads to the
 * `builds/<buildId>/generated/<page_inventory_id>/<viewport>.png` path
 * (matching `fidelity_reports.generated_screenshot_paths`).
 *
 * Fail-soft per page + per viewport, same posture as discovery. The
 * caller (verify-fidelity worker) decides how to interpret per-viewport
 * coverage gaps — partial coverage means the page is scored against the
 * viewports that DID capture, and the gap is recorded for the review UI.
 */

export interface VerifyPageDescriptor {
  pageInventoryId: string;
  slug: string;
  postType: string;
  routePath: string;
}

export interface VerifyCaptureInput {
  buildId: string;
  previewUrl: string;
  pages: VerifyPageDescriptor[];
  supabase: SupabaseClient;
  /** Override viewports for testing; defaults to the discovery-pass set. */
  viewports?: ReadonlyArray<ViewportWidth>;
}

export interface VerifyPageResult {
  pageInventoryId: string;
  slug: string;
  postType: string;
  /**
   * Per-viewport storage path (relative to SITE_SCREENSHOTS_BUCKET) for
   * the captured PNG. Keyed by stringified viewport width to match the
   * fidelity_reports.generated_screenshot_paths shape:
   *   { source: { "1280": "<path>", … } }
   */
  generatedScreenshotPaths: { source: Partial<Record<string, string>> };
  failures: Array<{ viewport: ViewportWidth; message: string }>;
}

const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 600;

export async function captureGeneratedScreenshots(
  input: VerifyCaptureInput,
): Promise<VerifyPageResult[]> {
  const viewports = input.viewports ?? VIEWPORT_WIDTHS;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const results: VerifyPageResult[] = [];
    for (const page of input.pages) {
      const pageResult: VerifyPageResult = {
        pageInventoryId: page.pageInventoryId,
        slug: page.slug,
        postType: page.postType,
        generatedScreenshotPaths: { source: {} },
        failures: [],
      };
      for (const viewport of viewports) {
        try {
          const context = await browser.newContext({
            viewport: { width: viewport, height: 900 },
            userAgent:
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          });
          const browserPage = await context.newPage();
          const target = joinUrl(input.previewUrl, page.routePath);
          await browserPage.goto(target, {
            waitUntil: "networkidle",
            timeout: NAV_TIMEOUT_MS,
          });
          await browserPage.waitForTimeout(SETTLE_MS);
          const buf = await browserPage.screenshot({ fullPage: true });
          await context.close();

          const path = `builds/${input.buildId}/generated/${page.pageInventoryId}/${viewport}.png`;
          const { error: uploadErr } = await input.supabase.storage
            .from(SITE_SCREENSHOTS_BUCKET)
            .upload(path, buf, {
              contentType: "image/png",
              upsert: true,
            });
          if (uploadErr) {
            pageResult.failures.push({
              viewport,
              message: `upload failed: ${uploadErr.message}`,
            });
            continue;
          }
          pageResult.generatedScreenshotPaths.source[String(viewport)] = path;
        } catch (err) {
          pageResult.failures.push({
            viewport,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      results.push(pageResult);
    }
    return results;
  } finally {
    await browser.close();
  }
}

export function joinUrl(base: string, path: string): string {
  if (!path) return base;
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
