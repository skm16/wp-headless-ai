import "server-only";
import { chromium, type Browser, type Page } from "playwright";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  type BlockInstanceCapture,
  type PageDescriptor,
  type PageDiscoveryResult,
  type PageDomSnapshot,
  type ViewportWidth,
  VIEWPORT_WIDTHS,
} from "./discovery-types";

const MAX_DOM_SAMPLE_BYTES = 50_000;
const MAX_MAIN_SECTIONS = 30;
const MAX_WP_BLOCK_SAMPLES = 60;

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
        // DOM snapshot is invariant across viewports (HTML doesn't change
        // responsively, only CSS does). Capture once on 1280 — the largest
        // viewport gives the richest layout (some themes hide sections at
        // smaller widths via `display:none`, which would clip the captured
        // outerHTML's effective scope for sample matching).
        if (viewport === 1280 && captured.domSnapshot) {
          result.domSnapshot = captured.domSnapshot;
        }
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
): Promise<{ screenshotPath: string; blockCaptures: BlockInstanceCapture[]; domSnapshot?: PageDomSnapshot }> {
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

    // Capture per-page DOM snapshot ONCE per page on the 1280-viewport
    // pass — DOM is viewport-invariant, only the CSS rules that target
    // it change responsively. The aggregator in aggregate-dom-samples.ts
    // consumes this for block_inventory.source_dom_sample population.
    let domSnapshot: PageDomSnapshot | undefined;
    if (viewport === 1280) {
      domSnapshot = await captureDomSnapshot(page);
    }

    return { screenshotPath: storagePath, blockCaptures, domSnapshot };
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

/**
 * Capture the page's invariant DOM signal for block-to-DOM correlation
 * downstream. Runs once per page (on 1280 only) since HTML doesn't change
 * across viewports — only the CSS rules that target it do.
 *
 * Three outputs:
 *
 *   1. `wpBlockSamples` — every `[class*="wp-block-"]` element with its
 *      parsed block name and outerHTML. Empty for custom-themed sites that
 *      don't emit those classes; falls back to the positional heuristics
 *      below in that case.
 *
 *   2. `mainSections` — direct children of the page's main content
 *      container (`<main>`, `[role=main]`, or the closest fallback the
 *      theme uses). Ordered. Used by the aggregator's positional rule:
 *      Nth ACF flex entry in `record.acf.{field}` ↔ Nth main section.
 *      Captures classNames separately so the aggregator can use them
 *      as a debugging / disambiguation signal if positional matching is
 *      ambiguous.
 *
 *   3. `articleOuterHtml` — `<article>` outerHTML if present, else the
 *      main content container's outerHTML. Used as the DOM sample for
 *      `cpt_template/{cpt}` entries (which wrap whole pages, not blocks).
 *
 * All outerHTML is capped at MAX_DOM_SAMPLE_BYTES per element. The cap is
 * a string-slice tail-truncation; the head — where global structural
 * markup tends to live — is preserved.
 */
async function captureDomSnapshot(page: Page): Promise<PageDomSnapshot> {
  return await page.evaluate(
    ({ maxBytes, maxSections, maxWpSamples }) => {
      const knownNs = ["acf", "jetpack", "woocommerce", "yoast"];

      function parseBlockName(wpBlockClass: string): string {
        const rest = wpBlockClass.slice("wp-block-".length);
        const firstSeg = rest.split("-")[0];
        if (knownNs.includes(firstSeg)) {
          return `${firstSeg}/${rest.slice(firstSeg.length + 1)}`;
        }
        return `core/${rest}`;
      }

      function clip(html: string): string {
        return html.length > maxBytes ? html.slice(0, maxBytes) : html;
      }

      /**
       * Browser-side DOM normalizer — clones the element, strips noise that
       * inflates the prompt without carrying signal for component generation,
       * returns the normalized outerHTML.
       *
       * What's stripped (all on the CLONE — live page DOM untouched):
       *   - <script>, <style>, <noscript>, <template> subtrees
       *   - HTML comment nodes
       *   - WP post-meta class fragments: `post-NNN`, `postid-NNN`,
       *     `attachment-NNN`, `type-*`, `status-publish|draft|...`, `hentry`.
       *     These describe the specific sampled record (post id, post type
       *     state) and add no semantic value for a typed component.
       *   - Long `src` / `href` attribute values (>80 chars) truncated to
       *     `…/<filename>` — the filename carries meaning, the CDN path doesn't.
       *   - Analytics / tracking attrs: `data-gtm-*`, `data-event*`,
       *     `data-track*`, `data-ga-*`.
       *
       * What's preserved (deliberately):
       *   - Bootstrap-shaped layout classes (`container`, `row`, `col-12`).
       *     These are SIGNAL — the LLM can translate them to Tailwind
       *     equivalents. The premise that "framework class soup is noise"
       *     is partially wrong; the *post-meta* + script/comment debris IS
       *     the noise.
       *   - `aria-hidden` (some are decorative, some are accessibility
       *     hints — disambiguating requires more analysis than the win
       *     justifies).
       *
       * Expected byte reduction on typical WP DOM samples: 20–40%.
       * Counter-measure for the marginal cpt_template/beer regression in
       * the source_dom_sample wiring smoke; doesn't fix the custom-html
       * case (that needs the Phase B suppression rule).
       */
      function normalizeForCapture(el: HTMLElement): string {
        const clone = el.cloneNode(true) as HTMLElement;

        // 1. Strip element subtrees that don't render content.
        for (const tag of ["script", "style", "noscript", "template"]) {
          clone.querySelectorAll(tag).forEach((n) => n.remove());
        }

        // 2. Strip comment nodes via TreeWalker (querySelectorAll can't
        //    target comments — they're not elements).
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
        const comments: Comment[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) comments.push(node as Comment);
        for (const c of comments) c.remove();

        // 3. Per-element attribute + class cleanup. Walk the clone + all
        //    descendants once.
        const allEls = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
        for (const e of allEls) {
          // 3a. Filter WP post-meta class fragments.
          if (e.classList.length > 0) {
            const kept: string[] = [];
            for (const cls of Array.from(e.classList)) {
              if (/^(post|postid|attachment)-\d+$/.test(cls)) continue;
              if (/^type-/.test(cls)) continue;
              if (/^status-(publish|draft|pending|private|inherit|future|trash|auto-draft)$/.test(cls)) continue;
              if (cls === "hentry") continue;
              kept.push(cls);
            }
            if (kept.length === 0) {
              e.removeAttribute("class");
            } else if (kept.length !== e.classList.length) {
              e.className = kept.join(" ");
            }
          }

          // 3b. Truncate long URL attribute values. Preserve the filename
          //     tail (last path segment, pre-query/fragment) — that carries
          //     semantic meaning the LLM might use ("ipa-hero.jpg" vs
          //     "winter-heave-glass.png"). Drop the CDN host + nested path.
          for (const attr of ["src", "href", "data-src", "data-bg"]) {
            const v = e.getAttribute(attr);
            if (v && v.length > 80) {
              const m = v.match(/\/([^/?#]+)(?:[?#]|$)/);
              const tail = m ? m[1] : v.slice(-40);
              e.setAttribute(attr, `…/${tail}`);
            }
          }

          // 3c. Strip tracking / analytics attrs.
          for (const attr of Array.from(e.attributes)) {
            const n = attr.name;
            if (
              n.startsWith("data-gtm-") ||
              n.startsWith("data-event") ||
              n.startsWith("data-track") ||
              n.startsWith("data-ga-")
            ) {
              e.removeAttribute(n);
            }
          }
        }

        return clone.outerHTML;
      }

      // 1. wp-block-* samples
      const wpBlockSamples: Array<{ blockName: string; outerHTML: string }> = [];
      const seen = new Set<string>();
      const wpEls = document.querySelectorAll<HTMLElement>('[class*="wp-block-"]');
      for (const el of Array.from(wpEls)) {
        if (wpBlockSamples.length >= maxWpSamples) break;
        const classes = Array.from(el.classList);
        const wpBlockClass = classes.find((c) => c.startsWith("wp-block-"));
        if (!wpBlockClass) continue;
        const blockName = parseBlockName(wpBlockClass);
        // One sample per blockName per page — aggregator only needs one
        // representative occurrence to pair with the inventory row.
        if (seen.has(blockName)) continue;
        seen.add(blockName);
        wpBlockSamples.push({ blockName, outerHTML: clip(normalizeForCapture(el)) });
      }

      // 2. Main-section samples.
      // Fallback chain for theme-agnostic content area lookup. Stops at
      // the first hit; later entries cover progressively more obscure
      // theme patterns. <body> is the last-resort fallback so a degenerate
      // page (no semantic structure at all) still yields a snapshot.
      const mainEl =
        document.querySelector<HTMLElement>("main") ??
        document.querySelector<HTMLElement>("[role='main']") ??
        document.querySelector<HTMLElement>("#main, #content, .main, .content, .site-main, .site-content") ??
        document.body;
      const mainSections: Array<{ index: number; outerHTML: string; classNames: string[] }> = [];
      if (mainEl) {
        const children = Array.from(mainEl.children) as HTMLElement[];
        for (let i = 0; i < Math.min(children.length, maxSections); i++) {
          const child = children[i];
          mainSections.push({
            index: i,
            outerHTML: clip(normalizeForCapture(child)),
            classNames: Array.from(child.classList),
          });
        }
      }

      // 3. Article-level outerHTML for cpt_template wrappers.
      const articleEl =
        document.querySelector<HTMLElement>("article") ??
        (mainEl && mainEl.tagName !== "BODY" ? mainEl : null);
      const articleOuterHtml = articleEl ? clip(normalizeForCapture(articleEl)) : null;

      return { wpBlockSamples, mainSections, articleOuterHtml };
    },
    {
      maxBytes: MAX_DOM_SAMPLE_BYTES,
      maxSections: MAX_MAIN_SECTIONS,
      maxWpSamples: MAX_WP_BLOCK_SAMPLES,
    },
  );
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
