import "server-only";
import { chromium, type Browser } from "playwright";

/**
 * capture-theme-stylesheets.ts
 *
 * Phase A capture for project-level brand-grounding signals from the source
 * site's homepage. Two outputs are captured in a single Playwright session:
 *
 *   1. `themeStylesheets` — every `<link rel="stylesheet">` whose URL points
 *      at `/wp-content/themes/...`. Captured via `document.styleSheets` so
 *      the browser already resolved `@import` chains and the parsed
 *      `cssRules` are available as text. Cross-origin sheets (CDN-hosted
 *      plugin CSS, Google Fonts) throw `SecurityError` on `cssRules`
 *      access and are silently skipped — they're rarely theme CSS anyway.
 *
 *   2. `shellDom` — outerHTML of `<header>` and `<footer>` from the
 *      homepage. Phase C's shell LLM uses these alongside the captured
 *      stylesheets to produce brand-faithful Header / Footer components.
 *      Per-page DOM (block-by-block) is captured separately during the
 *      per-page Playwright pass in playwright-discovery.ts.
 *
 * Why classic-themed sites need both:
 *   /wp-json/wp/v2/global-styles is FSE-only and returns empty for classic
 *   PHP themes. Two Roads (Anton headings + #ffc72c yellow + custom theme
 *   markup) is the canonical example — their brand DNA lives in
 *   `/wp-content/themes/{slug}/*.css` and the rendered HTML, not theme.json.
 *
 * Output shape (persisted on projects.design_tokens under sibling keys
 *   `themeStylesheets` and `shellDom`):
 *
 *   themeStylesheets: Array<{ href, css }>
 *   shellDom:         { header: string | null, footer: string | null }
 *
 * Caps:
 *   - MAX_STYLESHEETS    = 10 (rare to have more theme sheets that matter)
 *   - MAX_BYTES_PER_SHEET = 100_000 (~20K tokens per sheet at LLM rates)
 *   - MAX_SHELL_BYTES    = 100_000 (per shell element)
 *
 * Fail-soft: any error returns empty stylesheets + null shell DOM.
 * Discovery proceeds without these signals; downstream LLMs degrade
 * to screenshot + ACF schema context only.
 */

export interface ThemeStylesheetCapture {
  href: string;
  css: string;
  /**
   * Tier classification — "theme" matched the strict /wp-content/themes/
   * path, "cache" matched a known optimization-plugin cache pattern
   * (Tier 2 fallback). Optional for back-compat with callers that
   * pre-date Fix J (2026-05-30). When absent, `fetchBlockedStylesheets`
   * treats the entry as Tier-2-or-unknown for tier-gate purposes (the
   * cache-kind fetch path becomes additive rather than gated).
   */
  kind?: "theme" | "cache";
}

export interface ShellDomCapture {
  header: string | null;
  footer: string | null;
}

export interface HomepageDesignCapture {
  stylesheets: ThemeStylesheetCapture[];
  shellDom: ShellDomCapture;
}

const MAX_STYLESHEETS = 10;
const MAX_BYTES_PER_SHEET = 100_000;
const MAX_SHELL_BYTES = 100_000;
const GOTO_TIMEOUT_MS = 30_000;

/**
 * Patterns identifying CSS-optimization-plugin-rewritten URLs (Autoptimize,
 * WP Rocket, ShortPixel, Swift Performance, NitroPack, etc.). These
 * plugins combine theme CSS into a fingerprinted cache URL that does not
 * include `/wp-content/themes/` — the strict theme-path filter silently
 * drops them and the generated app loses all source typography + colors.
 * Surfaced by the Two Roads pilot (build 982f0d57) — see
 * docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md.
 *
 * Used by the fallback pass only: theme-path sheets remain the strong
 * signal when present (an FSE block-theme site won't have any optimization
 * cache to fall through to). Order matters for matchers: longer / more
 * specific patterns first so a hit on `sp-ao.shortpixel.ai` doesn't get
 * masked by a later `/cache/`-only pattern.
 */
const CACHE_HREF_PATTERNS: ReadonlyArray<string> = [
  "sp-ao.shortpixel.ai",   // ShortPixel CDN-rewritten CSS
  "autoptimize",            // Autoptimize bundle filename token
  "wpr-config",             // WP Rocket
  "swift-perf",             // Swift Performance
  // NitroPack serves combined bundles from `cdn-{token}.nitrocdn.com`,
  // not from any `nitropack.*` host. The plugin's own path segments may
  // also include `/nitropack/` inside the cache directory — both forms
  // are covered by these two anchors.
  "nitrocdn.com",
  "/nitropack/",
  "/wp-content/cache/",     // Generic catch-all for plugin caches
  "/wp-content/uploads/cache/",
];

/**
 * Classify a stylesheet `href` for the tiered capture pass.
 * Exported for unit testing; mirrored inside the page.evaluate via the
 * `cacheHrefPatterns` arg.
 */
export function classifyStylesheetHref(href: string | null | undefined): "theme" | "cache" | "other" {
  if (typeof href !== "string" || href.length === 0) return "other";
  if (href.includes("/wp-content/themes/")) return "theme";
  for (const pat of CACHE_HREF_PATTERNS) {
    if (href.includes(pat)) return "cache";
  }
  return "other";
}

/**
 * Single Playwright session against the project's homepage. Returns both
 * stylesheets and shell DOM (header/footer outerHTML). Always returns a
 * value — on any error, returns empty stylesheets and null shell parts.
 */
export async function captureHomepageDesign(
  homepageUrl: string,
): Promise<HomepageDesignCapture> {
  let browser: Browser | null = null;
  const emptyResult: HomepageDesignCapture = {
    stylesheets: [],
    shellDom: { header: null, footer: null },
  };
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // `networkidle` to absorb late-loading theme CSS injected by performance
    // plugins; 30s ceiling absorbs CF bot challenges on protected sites.
    await page.goto(homepageUrl, { waitUntil: "networkidle", timeout: GOTO_TIMEOUT_MS });

    const result = await page.evaluate(
      ({ maxSheets, maxBytesPerSheet, maxShellBytes, cacheHrefPatterns }) => {
        // Two-tier stylesheet capture. Tier 1: any sheet matching the
        // canonical /wp-content/themes/ path (FSE + classic themes that
        // haven't been touched by an optimization plugin). Tier 2 fallback
        // when Tier 1 produces nothing: sheets whose href contains a known
        // optimization-plugin cache marker. Tier 1 is preferred when both
        // are present so plugin caches don't pollute pure theme captures.
        function classify(href: string | null): "theme" | "cache" | "other" {
          if (!href) return "other";
          if (href.includes("/wp-content/themes/")) return "theme";
          for (const pat of cacheHrefPatterns) if (href.includes(pat)) return "cache";
          return "other";
        }

        // CORS-blocked sheets we couldn't read via CSSOM. Caller fetches
        // them from Node where same-origin policy doesn't apply.
        const blockedUrls: Array<{ href: string; kind: "theme" | "cache" }> = [];

        function tryRead(
          sheet: CSSStyleSheet,
          href: string,
          kind: "theme" | "cache",
        ): { href: string; css: string; kind: "theme" | "cache" } | null {
          try {
            const rules = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
            if (rules.length === 0) return null;
            const css = rules.length > maxBytesPerSheet ? rules.slice(0, maxBytesPerSheet) : rules;
            return { href, css, kind };
          } catch {
            // CORS / SecurityError on cross-origin sheets — record the URL
            // for the Node-side fetch fallback (which is not subject to
            // browser same-origin policy). Pre-2026-05-29 this was a silent
            // drop, and Two Roads' ShortPixel-rewritten theme CSS at
            // sp-ao.shortpixel.ai never made it into the build.
            blockedUrls.push({ href, kind });
            return null;
          }
        }

        // --- Stylesheets ---
        const stylesheets: Array<{ href: string; css: string; kind: "theme" | "cache" }> = [];
        for (const sheet of Array.from(document.styleSheets)) {
          if (stylesheets.length >= maxSheets) break;
          const href = sheet.href;
          if (classify(href) !== "theme") continue;
          const entry = tryRead(sheet, href!, "theme");
          if (entry) stylesheets.push(entry);
        }
        if (stylesheets.length === 0) {
          for (const sheet of Array.from(document.styleSheets)) {
            if (stylesheets.length >= maxSheets) break;
            const href = sheet.href;
            if (classify(href) !== "cache") continue;
            const entry = tryRead(sheet, href!, "cache");
            if (entry) stylesheets.push(entry);
          }
        }

        // --- Shell DOM ---
        function clipShell(html: string | null): string | null {
          if (!html) return null;
          return html.length > maxShellBytes ? html.slice(0, maxShellBytes) : html;
        }

        /**
         * Theme-agnostic header lookup with three tiers:
         *   1. Semantic HTML5 (`<header>`, `[role=banner]`) — modern themes
         *   2. WP-conventional classes/ids — covers ~90% of classic themes
         *      that pre-date HTML5 semantics or strip them via filters
         *   3. Heuristic: walk top-level body children that come BEFORE
         *      the main content area; return the first one containing a
         *      <nav> or <img> (logo). Catches custom themes that use
         *      neither semantic tags nor conventional class names.
         * Two Roads is the canonical example needing tier 3.
         */
        function findHeader(): HTMLElement | null {
          const standard =
            document.querySelector<HTMLElement>("header") ??
            document.querySelector<HTMLElement>("[role='banner']");
          if (standard) return standard;
          const wpClassic = document.querySelector<HTMLElement>(
            ".site-header, #site-header, .masthead, #masthead, .main-header, .header-main, #header, .header, .main-navigation",
          );
          if (wpClassic) return wpClassic;
          // Heuristic — find content boundary, walk top-level children up to it.
          const main =
            document.querySelector<HTMLElement>("main") ??
            document.querySelector<HTMLElement>("[role='main']") ??
            document.querySelector<HTMLElement>("article, #main, #content, .site-main, .site-content");
          for (const child of Array.from(document.body.children) as HTMLElement[]) {
            if (main && (child === main || child.contains(main))) break;
            if (child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;
            if (child.querySelector("nav") || child.querySelector("img")) {
              return child;
            }
          }
          return null;
        }

        /**
         * Theme-agnostic footer lookup, mirror of findHeader. Tier-3
         * heuristic: last non-script/style top-level child of <body>.
         */
        function findFooter(): HTMLElement | null {
          const standard =
            document.querySelector<HTMLElement>("footer") ??
            document.querySelector<HTMLElement>("[role='contentinfo']");
          if (standard) return standard;
          const wpClassic = document.querySelector<HTMLElement>(
            ".site-footer, #site-footer, #colophon, .colophon, .main-footer, #footer, .footer",
          );
          if (wpClassic) return wpClassic;
          const children = Array.from(document.body.children).reverse() as HTMLElement[];
          for (const child of children) {
            if (child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;
            return child;
          }
          return null;
        }

        const headerEl = findHeader();
        const footerEl = findFooter();

        return {
          stylesheets,
          blockedUrls,
          shellDom: {
            header: clipShell(headerEl?.outerHTML ?? null),
            footer: clipShell(footerEl?.outerHTML ?? null),
          },
        };
      },
      {
        maxSheets: MAX_STYLESHEETS,
        maxBytesPerSheet: MAX_BYTES_PER_SHEET,
        maxShellBytes: MAX_SHELL_BYTES,
        cacheHrefPatterns: [...CACHE_HREF_PATTERNS],
      },
    );

    // Cross-origin fetch fallback. CSSOM's sheet.cssRules throws on
    // cross-origin sheets without CORS headers — that includes the
    // ShortPixel/CDN-rewritten paths the Tier-2 classifier flags. We
    // fetch them from Node where same-origin policy doesn't apply.
    // Tier semantics from the in-page pass are preserved: if no theme
    // sheets came through CSSOM AND only cache-kind blocked URLs exist,
    // those become the Tier-2 fallback content. If theme sheets came
    // through CSSOM, we still try theme-kind blocked URLs (same Tier 1)
    // up to the cap.
    const fetched = await fetchBlockedStylesheets(result.stylesheets, result.blockedUrls);

    return {
      stylesheets: fetched,
      shellDom: result.shellDom,
    };
  } catch (err) {
    console.warn(
      "[capture-homepage-design] capture failed:",
      err instanceof Error ? err.message : err,
    );
    return emptyResult;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Server-side fetch fallback for CSSOM-blocked cross-origin stylesheets.
 * Merges with the in-page-captured `existing` array, preserving the same
 * tier preference: theme-kind URLs always apply (additive); cache-kind
 * URLs only apply when `existing` is empty (Tier 2 fallback).
 *
 * Cap discipline matches the in-page pass — total sheets <= MAX_STYLESHEETS,
 * each capped at MAX_BYTES_PER_SHEET. Empty bodies and non-200 responses
 * are silently skipped (the original browser load may have failed too).
 *
 * Exported for unit testing — the production caller is
 * `captureHomepageDesign` only.
 */
export async function fetchBlockedStylesheets(
  existing: ThemeStylesheetCapture[],
  blockedUrls: Array<{ href: string; kind: "theme" | "cache" }>,
  // Indirection lets tests inject a deterministic fetch without touching
  // the global. Production passes `undefined` to use globalThis.fetch.
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ThemeStylesheetCapture[]> {
  const out: ThemeStylesheetCapture[] = [...existing];
  // Tier-aware filter (fixed 2026-05-30 / Fix J):
  //   - Theme-kind blocked URLs always apply (additive).
  //   - Cache-kind blocked URLs apply UNLESS `existing` already contains a
  //     Tier-1 (theme-kind) sheet. The earlier check `existing.length > 0`
  //     conflated tier states: if Tier 1 was empty but Tier 2 produced
  //     readable cache sheets via CSSOM, a separate CORS-blocked cache URL
  //     would be silently skipped even though the page is already in Tier
  //     2 fallback mode.
  //
  // ThemeStylesheetCapture.kind is optional for back-compat with callers
  // (test fixtures, the captureThemeStylesheets back-compat shim) that
  // don't carry tier info. When absent we treat the entry as "unknown"
  // and don't let it block cache-kind fetches — preferring loud
  // completion over a quiet skip.
  const haveTierOneTheme = existing.some((s) => s.kind === "theme");
  const candidates = blockedUrls.filter((b) => b.kind === "theme" || !haveTierOneTheme);
  if (candidates.length === 0) return out;

  for (const { href, kind } of candidates) {
    if (out.length >= MAX_STYLESHEETS) break;
    // Dedup: a sheet may be captured both via CSSOM and (separately) via
    // a CDN-rewritten URL pointing at the same logical asset. Skip if
    // any existing entry has the same href.
    if (out.some((s) => s.href === href)) continue;
    const css = await fetchStylesheetCss(href, fetchImpl);
    if (!css) continue;
    const capped = css.length > MAX_BYTES_PER_SHEET ? css.slice(0, MAX_BYTES_PER_SHEET) : css;
    out.push({ href, css: capped, kind });
  }
  return out;
}

/**
 * Fetch a stylesheet URL and return its text body, or null on any failure
 * (timeout, non-200, empty, network error). Exported for unit testing.
 * No throw — capture is fail-soft.
 */
export async function fetchStylesheetCss(
  href: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(href, {
      signal: controller.signal,
      // Mimic a browser request so CDNs that cloak based on UA still
      // return real CSS instead of an HTML challenge page.
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JAB-headless-capture/1.0)" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trim().length === 0) return null;
    return text;
  } catch {
    // Network error, abort, malformed URL — silently skip.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Backwards-compat shim — older imports use captureThemeStylesheets and
 * expect just the stylesheet array. Retained so the prior commit's
 * step-name stays bisectable. Phase C should consume captureHomepageDesign
 * directly.
 */
export async function captureThemeStylesheets(
  homepageUrl: string,
): Promise<ThemeStylesheetCapture[]> {
  const { stylesheets } = await captureHomepageDesign(homepageUrl);
  return stylesheets;
}
