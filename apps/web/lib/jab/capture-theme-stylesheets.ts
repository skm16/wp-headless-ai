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
      ({ maxSheets, maxBytesPerSheet, maxShellBytes }) => {
        // --- Stylesheets ---
        const stylesheets: Array<{ href: string; css: string }> = [];
        for (const sheet of Array.from(document.styleSheets)) {
          if (stylesheets.length >= maxSheets) break;
          const href = sheet.href;
          if (!href || !href.includes("/wp-content/themes/")) continue;
          try {
            const rules = Array.from(sheet.cssRules)
              .map((r) => r.cssText)
              .join("\n");
            if (rules.length === 0) continue;
            const css = rules.length > maxBytesPerSheet ? rules.slice(0, maxBytesPerSheet) : rules;
            stylesheets.push({ href, css });
          } catch {
            // CORS / SecurityError on cross-origin sheets — skip silently.
          }
        }

        // --- Shell DOM ---
        function clipShell(html: string | null): string | null {
          if (!html) return null;
          return html.length > maxShellBytes ? html.slice(0, maxShellBytes) : html;
        }
        const headerEl =
          document.querySelector<HTMLElement>("header") ??
          document.querySelector<HTMLElement>("[role='banner']") ??
          document.querySelector<HTMLElement>(".site-header, #site-header, .header");
        const footerEl =
          document.querySelector<HTMLElement>("footer") ??
          document.querySelector<HTMLElement>("[role='contentinfo']") ??
          document.querySelector<HTMLElement>(".site-footer, #site-footer, .footer");

        return {
          stylesheets,
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
      },
    );

    return result;
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
