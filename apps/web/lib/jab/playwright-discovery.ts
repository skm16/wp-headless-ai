import "server-only";
import { chromium, type Browser, type Page } from "playwright";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  type BlockInstanceCapture,
  type PageDescriptor,
  type PageDiscoveryResult,
  type ViewportWidth,
  VIEWPORT_WIDTHS,
} from "./discovery-types";

/**
 * playwright-discovery.ts — Phase A capture per page per viewport.
 *
 * Three jobs:
 *   1. Navigate to the live WP URL with a sane wait state (`networkidle`)
 *      across each of the three viewports (375 / 768 / 1280).
 *   2. Take a full-page screenshot per viewport, upload to the
 *      site-screenshots bucket at
 *      `<buildId>/source/<viewport>/<slug>.png`.
 *   3. (Tasks 8 + 9) Map per-block bounding rects + computed styles. The
 *      placeholder in this task returns an empty array; Tasks 8 and 9
 *      replace it with the real implementation.
 *
 * Errors policy: fail-soft per viewport. A navigation timeout on tablet
 * does NOT abort capture for mobile or desktop. Failures are collected on
 * the `failures` field of the result; the worker decides whether to count
 * the page as inventoried (yes — blocks come from the MCP call) or
 * screenshot-less (yes — degraded fidelity, surfaced in Phase E later).
 *
 * Browser reuse: we launch chromium ONCE per `capturePage` call. The
 * DiscoveryRunner in Task 6 iterates pages sequentially in v1 — if Stage 1
 * telemetry shows the per-page launch overhead is significant, batch
 * pages per browser as a follow-up.
 */

export interface CapturePageInput {
  page: PageDescriptor;
  buildId: string;
  projectId: string;
  tenantId: string;
}

export async function capturePage(input: CapturePageInput): Promise<PageDiscoveryResult> {
  const { page: descriptor, buildId } = input;
  const result: PageDiscoveryResult = {
    slug: descriptor.slug,
    post_type: descriptor.post_type,
    screenshotPaths: {},
    blockCapturesByViewport: {},
  };
  const failures: NonNullable<PageDiscoveryResult["failures"]> = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of VIEWPORT_WIDTHS) {
      try {
        const captured = await captureAtViewport(browser, descriptor, viewport, buildId);
        result.screenshotPaths[String(viewport)] = captured.screenshotPath;
        result.blockCapturesByViewport[String(viewport)] = captured.blockCaptures;
      } catch (err) {
        failures.push({
          viewport,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) result.failures = failures;
  return result;
}

async function captureAtViewport(
  browser: Browser,
  descriptor: PageDescriptor,
  viewport: ViewportWidth,
  buildId: string,
): Promise<{ screenshotPath: string; blockCaptures: BlockInstanceCapture[] }> {
  const context = await browser.newContext({
    viewport: { width: viewport, height: heightFor(viewport) },
    // Headless UA — some hosts gate Cloudflare / WAF behavior on this.
    // Identifying as the agent is honest and easy to allowlist if a site
    // owner asks why their fidelity is degraded.
    userAgent: "JAB-Discovery/1.0 (+https://jab.app/bot)",
  });
  const page = await context.newPage();

  try {
    await page.goto(descriptor.url, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    const storagePath = `${buildId}/source/${viewport}/${sanitizeSlugForPath(descriptor.slug || "front-page")}.png`;
    const supabase = createAdminClient();
    const { error: uploadErr } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(storagePath, screenshotBuffer, {
        contentType: "image/png",
        upsert: true,
        cacheControl: "3600",
      });
    if (uploadErr) {
      throw new Error(`screenshot upload failed: ${uploadErr.message}`);
    }

    // Placeholder — Tasks 8 + 9 fill this in. Task 7 only delivers the
    // navigation + screenshot path; tests at this layer expect [].
    const blockCaptures: BlockInstanceCapture[] = await captureBlockInstances(page, descriptor);

    return { screenshotPath: storagePath, blockCaptures };
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

/**
 * Placeholder — Tasks 8 + 9 implement bounding-rect + computed-CSS capture.
 * Lives behind this function so the test in Task 7 mocks `page.evaluate`
 * to return [] and gets a stable contract.
 */
async function captureBlockInstances(
  _page: Page,
  _descriptor: PageDescriptor,
): Promise<BlockInstanceCapture[]> {
  return [];
}

function heightFor(width: ViewportWidth): number {
  // Aspect ratios picked to bias toward enough first-paint content while
  // staying within reasonable headed-equivalent windows.
  if (width === 375) return 812;   // iPhone X-ish
  if (width === 768) return 1024;  // iPad portrait-ish
  return 800;                       // 1280×800 laptop default
}

/**
 * Storage paths can't contain control chars or '..'. WP slugs are already
 * URL-safe (lowercase, hyphens, alnum) but defence-in-depth keeps a
 * malformed slug from breaking the upload call.
 */
function sanitizeSlugForPath(slug: string): string {
  return slug.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "untitled";
}
