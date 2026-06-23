import "server-only";
import { chromium, type Page } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { VIEWPORT_WIDTHS, type ViewportWidth } from "./discovery-types";
import { normalizeHarvestedLinks } from "./link-harvest";

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
  /** HTTP status of the 1280-viewport navigation; null when unavailable. */
  httpStatus?: number | null;
  /** HTTP status per captured viewport, keyed by width string. */
  httpStatusByViewport?: Partial<Record<string, number | null>>;
  /** Home-route navigation-timing perf, present only on the route_path==='/' result. */
  perf?: NavPerf;
  /**
   * Internal `<a href>` route paths harvested from the rendered clone at 1280
   * (normalized, deduped, asset/external-stripped). Feeds the broken-link gate
   * in verify-fidelity. Undefined when harvesting failed (fail-soft).
   */
  internalLinks?: string[];
}

/** Navigation-timing perf for a single route. NULL fields = uncaptured/invalid. */
export interface NavPerf {
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
}

/** Shape of performance.getEntriesByType('navigation')[0] we depend on. */
export interface NavTimingJson {
  requestStart: number;
  responseStart: number;
  startTime: number;
  loadEventEnd: number;
  transferSize: number;
}

/**
 * Pure derivation of TTFB / load / transfer from a navigation-timing entry.
 * Negative or zero-derived timings clamp to null (a failed/partial capture
 * must never be recorded as a real 0ms). Phase-2-owned; Phase 3 re-homes this
 * into lib/jab/perf-capture.ts (extractPerf).
 */
export function extractNavPerf(nav: NavTimingJson | null | undefined): NavPerf {
  if (!nav || typeof nav !== "object") {
    return { ttfbMs: null, loadMs: null, transferBytes: null };
  }
  const ttfbRaw = (nav.responseStart ?? 0) - (nav.requestStart ?? 0);
  const loadRaw = (nav.loadEventEnd ?? 0) - (nav.startTime ?? 0);
  const ttfbMs = ttfbRaw > 0 ? Math.round(ttfbRaw) : null;
  const loadMs = loadRaw > 0 ? Math.round(loadRaw) : null;
  const transferBytes =
    typeof nav.transferSize === "number" && nav.transferSize >= 0 ? nav.transferSize : null;
  return { ttfbMs, loadMs, transferBytes };
}

/**
 * Best-effort home-route perf capture, reusing the SAME Chromium context the
 * screenshot pass already launches (no extra cold launch). Fail-soft: any error
 * returns all-null. Call inside the existing per-page loop for the home route.
 */
export async function collectPerfForHomeRoute(browserPage: Page): Promise<NavPerf> {
  try {
    const nav = (await browserPage.evaluate(() => {
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!entry) return null;
      return {
        requestStart: entry.requestStart,
        responseStart: entry.responseStart,
        startTime: entry.startTime,
        loadEventEnd: entry.loadEventEnd,
        transferSize: entry.transferSize,
      };
    })) as NavTimingJson | null;
    return extractNavPerf(nav);
  } catch {
    return { ttfbMs: null, loadMs: null, transferBytes: null };
  }
}

/**
 * Best-effort harvest of internal `<a href>` route paths from the rendered
 * clone, reusing the SAME live page the screenshot pass already loaded. Reads
 * the browser-resolved absolute `.href` of every anchor, then normalizes to
 * internal non-asset pathnames off-DOM. Fail-soft: any error returns [] so a
 * harvest failure never fails an already-successful capture.
 */
export async function harvestInternalLinks(
  browserPage: Page,
  previewUrl: string,
): Promise<string[]> {
  try {
    const rawHrefs = (await browserPage.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map(
        (a) => (a as HTMLAnchorElement).href,
      ),
    )) as string[];
    return normalizeHarvestedLinks(rawHrefs, { previewUrl });
  } catch {
    return [];
  }
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
        httpStatusByViewport: {},
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
          const response = await browserPage.goto(target, {
            waitUntil: "networkidle",
            timeout: NAV_TIMEOUT_MS,
          });
          const status = response ? response.status() : null;
          pageResult.httpStatusByViewport![String(viewport)] = status;
          if (viewport === 1280) {
            pageResult.httpStatus = status;
          }
          await browserPage.waitForTimeout(SETTLE_MS);
          const buf = await browserPage.screenshot({ fullPage: true });

          // Capture home-route perf once, off the SAME browserPage before the
          // context closes. Gate on the descriptor's route + the 1280 viewport.
          if (page.routePath === "/" && viewport === 1280) {
            pageResult.perf = await collectPerfForHomeRoute(browserPage);
          }

          // Harvest internal links once, off the SAME live page before close
          // (the link set is viewport-invariant, so 1280 only). Own try/catch:
          // a harvest failure must never fail an already-successful screenshot.
          if (viewport === 1280) {
            pageResult.internalLinks = await harvestInternalLinks(browserPage, input.previewUrl);
          }

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
