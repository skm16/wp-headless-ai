import "server-only";
import { chromium, type Browser } from "playwright";

/**
 * capture-theme-stylesheets.ts
 *
 * Phase A signal capture for classic-themed WP sites where `/wp-json/wp/v2/
 * global-styles` returns nothing (FSE/block-theme only endpoint). For
 * classic themes, the brand-grounding signal lives in the theme's own
 * stylesheets at `/wp-content/themes/{slug}/...`. We enumerate
 * `document.styleSheets` via Playwright and capture rule text for any
 * sheet whose URL points at the theme directory.
 *
 * Why Playwright (not direct fetch):
 *   - `document.styleSheets` gives us the BROWSER-PARSED CSSRuleList,
 *     which already follows `@import` chains and skips broken sheets.
 *   - Same-origin sheets expose `.cssRules` directly — no CSS parser
 *     needed in worker code.
 *   - Cross-origin sheets (CDN-hosted plugin CSS, Google Fonts) throw
 *     `SecurityError` on `.cssRules` access; we silently skip those.
 *     They're rarely theme stylesheets anyway.
 *
 * Output shape (persisted on projects.design_tokens.themeStylesheets):
 *   Array<{ href: string; css: string }>
 *
 * Caps:
 *   - MAX_STYLESHEETS = 10 (rare to have more theme sheets that matter)
 *   - MAX_BYTES_PER_SHEET = 100_000 (~20K tokens per sheet at LLM rates)
 *   The cap prevents a pathological theme from blowing the prompt budget
 *   when downstream LLM consumers serialize the array. Phase C's shell
 *   prompt will further digest these into a structured token table.
 *
 * Fail-soft: every error path returns an empty array. Discovery proceeds
 * without theme stylesheets — Phase B/C have other signals (scraped
 * DesignAnalysis, screenshots, ACF schemas) and degrade gracefully.
 */

export interface ThemeStylesheetCapture {
  href: string;
  css: string;
}

const MAX_STYLESHEETS = 10;
const MAX_BYTES_PER_SHEET = 100_000;
const GOTO_TIMEOUT_MS = 30_000;

export async function captureThemeStylesheets(
  homepageUrl: string,
): Promise<ThemeStylesheetCapture[]> {
  let browser: Browser | null = null;
  try {
    // Same flags as playwright-discovery.ts — required for Cloudflare/WAF-
    // protected sites under headless Chromium.
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

    // `networkidle` (not `load`) so we don't race the late-loading theme
    // stylesheet that some performance plugins inject. 30s ceiling is a
    // generous timeout to absorb Cloudflare's bot challenge if it fires
    // (some sites add 5–15s before serving the real page).
    await page.goto(homepageUrl, { waitUntil: "networkidle", timeout: GOTO_TIMEOUT_MS });

    const sheets = await page.evaluate(
      ({ maxSheets, maxBytesPerSheet }) => {
        const result: Array<{ href: string; css: string }> = [];
        for (const sheet of Array.from(document.styleSheets)) {
          if (result.length >= maxSheets) break;
          const href = sheet.href;
          if (!href || !href.includes("/wp-content/themes/")) continue;
          try {
            const rules = Array.from(sheet.cssRules)
              .map((r) => r.cssText)
              .join("\n");
            if (rules.length === 0) continue;
            // Cap per-sheet size to bound prompt cost. Front-load the
            // capture: most theme stylesheets put :root variables and
            // global typography rules near the top, so truncating the
            // tail loses less brand-grounding signal than truncating
            // the head would.
            const css = rules.length > maxBytesPerSheet ? rules.slice(0, maxBytesPerSheet) : rules;
            result.push({ href, css });
          } catch {
            // CORS / SecurityError on cross-origin sheets — skip silently.
            // These are virtually never theme stylesheets in practice.
          }
        }
        return result;
      },
      { maxSheets: MAX_STYLESHEETS, maxBytesPerSheet: MAX_BYTES_PER_SHEET },
    );

    return sheets;
  } catch (err) {
    console.warn("[capture-theme-stylesheets] capture failed:", err instanceof Error ? err.message : err);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
