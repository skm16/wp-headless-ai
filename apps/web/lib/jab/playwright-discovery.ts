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

/**
 * Capture screenshots + per-block computed styles for one page across all
 * configured viewports.
 *
 * BEST-EFFORT BY DESIGN (decided 2026-05-26 against the Two Roads pilot):
 *   Headless Chromium captures are unreliable against Cloudflare-protected
 *   sites — even with realistic UA, locale, and the inline stealth init
 *   script (which masks the standard four bot-detection signals), CF's bot
 *   management routinely serves JS challenges that crash the renderer.
 *   Stealth tooling can be pushed further (playwright-extra, residential
 *   proxies, TLS fingerprint masking) but each step is a maintenance burden
 *   and an arms race we don't want to fight.
 *
 *   The product answer is to make screenshots OPTIONAL Phase A signal,
 *   supplemented by client-uploaded screenshots during onboarding. The
 *   client picks representative pages, uploads from their real Chrome
 *   session (or design files), and the page_inventory.source_screenshot_paths
 *   shape already tolerates partial / empty coverage. Phase B's component
 *   generator reads what's present and falls back to block-tree-only for
 *   pages without screenshots. Most core Gutenberg blocks don't need visual
 *   context anyway — the block-type schema carries the structural info.
 *
 *   This function therefore returns a PageDiscoveryResult that may have
 *   any combination of `screenshotPaths` populated (0–3 viewports per
 *   page). Failures are recorded in `failures` for telemetry but never
 *   thrown — a 0/30 capture run is still a successful discovery from the
 *   orchestrator's perspective.
 */
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
    // Stability flags + sandbox-disable. Required for headless captures
    // against real sites under Cloudflare/WAFs: --no-sandbox lets the renderer
    // start in restricted Linux/CI environments and skips a Windows
    // permission edge case; --disable-dev-shm-usage uses /tmp instead of
    // /dev/shm (which is undersized in containers, causing renderer OOM
    // crashes); --disable-blink-features=AutomationControlled removes the
    // `navigator.webdriver` flag many anti-bot rules trip on.
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
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
    // Realistic Chrome UA. The pilot smoke against Two Roads (on Cloudflare)
    // showed that the previous self-identifying bot UA tripped Cloudflare's
    // bot management. The UA alone isn't enough — Cloudflare also checks
    // `navigator.webdriver`, `navigator.plugins`, `navigator.languages`,
    // and the existence of `window.chrome`. The init script below masks
    // those, which together with the UA was enough to pass CF's standard
    // bot challenge on the Two Roads pilot. Honest self-identification
    // happens via the `X-Jab-Discovery` header for site owners watching
    // access logs.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "X-Jab-Discovery": "1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Inline stealth — masks the four "definitely a headless bot" signals
  // anti-bot systems check beyond UA. Equivalent to a minimal subset of
  // puppeteer-extra-plugin-stealth's evasions, kept inline so we don't
  // pull a 200KB dependency that's mostly evasions we don't use.
  // Runs before any page script on each navigation in this context.
  await context.addInitScript(() => {
    // 1. navigator.webdriver: real browsers return undefined; headless returns true.
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
    // 2. navigator.plugins: real browsers have at least PDF Viewer etc.
    //    Empty array is the strongest bot signal Chromium emits.
    Object.defineProperty(Navigator.prototype, "plugins", {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
    // 3. navigator.languages: empty array in headless, ['en-US','en'] is normal.
    Object.defineProperty(Navigator.prototype, "languages", {
      get: () => ["en-US", "en"],
      configurable: true,
    });
    // 4. window.chrome: present in real Chrome, absent in headless.
    //    A minimal stub satisfies the existence check most detectors do.
    if (!(window as unknown as { chrome?: unknown }).chrome) {
      Object.defineProperty(window, "chrome", {
        get: () => ({ runtime: {} }),
        configurable: true,
      });
    }
  });

  const page = await context.newPage();

  try {
    // `networkidle` (no network for 500ms) hangs forever on real sites with
    // analytics/chat widgets/long-polling. `domcontentloaded` returns once
    // the HTML is parsed, then we give the `load` event a short budget but
    // tolerate it not firing — many sites have a hanging tracker that never
    // completes but doesn't block the first paint.
    await page.goto(descriptor.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);

    // `animations: disabled` freezes CSS animations to a stable frame so the
    // screenshot is deterministic. Explicit shorter timeout so a slow font
    // CDN doesn't burn 30s per viewport — the "waiting for fonts to load…"
    // hangs we saw on the Two Roads pilot were Playwright's internal
    // stability wait, not an upload issue.
    const screenshotBuffer = await page.screenshot({
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: 15_000,
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
 * Map every visible block instance on the page to its bounding rect.
 * Strategy (in fallback order):
 *
 *   1. Find every element matching `[class*="wp-block-"]`. Pull the block
 *      name from the `wp-block-{name}` class — converts to `core/{name}`
 *      for built-ins (the WP renderer prefixes core/ classes as just
 *      `wp-block-paragraph`, `wp-block-heading`, etc.; namespaced blocks
 *      like `acf/hero` render as `wp-block-acf-hero` — we reverse-map).
 *   2. Capture each element's `getBoundingClientRect()` + `getComputedStyle`
 *      property subset (Task 9 fills in the computed-styles fields; this
 *      task ships an empty object as a placeholder).
 *
 * We deliberately do NOT try to perfectly align with the BlockNode tree
 * order — that's the inventory builder's job. Block instances captured
 * here are typed by name only; the inventory reducer correlates names
 * with the tree to compute occurrence_count.
 */
async function captureBlockInstances(
  page: Page,
  _descriptor: PageDescriptor,
): Promise<BlockInstanceCapture[]> {
  return await page.evaluate(() => {
    // Properties we want — keep in sync with ComputedStyles in
    // discovery-types.ts. Strings on purpose: getComputedStyle returns
    // strings, and the LLM prompts consume them as strings.
    const PROPS = [
      "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "color", "backgroundColor", "backgroundImage",
      "textAlign", "textTransform",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "marginTop", "marginRight", "marginBottom", "marginLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "borderColor", "borderRadius",
      "display", "flexDirection", "gap", "gridTemplateColumns",
      "alignItems", "justifyContent",
      "boxShadow", "opacity",
    ] as const;

    const out: Array<{
      blockName: string | null;
      boundingRect: { x: number; y: number; width: number; height: number };
      computedStyles: Record<string, string>;
    }> = [];

    const elements = document.querySelectorAll<HTMLElement>('[class*="wp-block-"]');
    for (const el of elements) {
      const classes = Array.from(el.classList);
      const wpBlockClass = classes.find((c) => c.startsWith("wp-block-"));
      if (!wpBlockClass) continue;

      const rest = wpBlockClass.slice("wp-block-".length);
      const knownNs = ["acf", "jetpack", "woocommerce", "yoast"];
      let blockName: string;
      const firstSeg = rest.split("-")[0];
      if (knownNs.includes(firstSeg)) {
        blockName = `${firstSeg}/${rest.slice(firstSeg.length + 1)}`;
      } else {
        blockName = `core/${rest}`;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const cs = window.getComputedStyle(el);
      const computedStyles: Record<string, string> = {};
      for (const prop of PROPS) {
        // getPropertyValue uses CSS-cased names; the cssText property uses
        // camelCase via the StyleDeclaration object. Both work — using the
        // object-property syntax is shorter and stays type-stable.
        const value = cs[prop as keyof CSSStyleDeclaration];
        if (typeof value === "string" && value !== "") {
          computedStyles[prop] = value;
        }
      }

      out.push({
        blockName,
        boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyles,
      });
    }
    return out;
  });
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
