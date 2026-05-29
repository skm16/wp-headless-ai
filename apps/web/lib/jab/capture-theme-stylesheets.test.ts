import { describe, it, expect } from "vitest";
import { classifyStylesheetHref } from "./capture-theme-stylesheets";

/**
 * Unit-test the pure classifier helper. The Playwright capture wrapper
 * (`captureHomepageDesign`) is integration-tested by the smoke runners
 * — it needs a real browser, so it stays out of the Vitest suite.
 * What CAN be locked down here is the URL-classification policy that
 * determines which stylesheets the capture even considers.
 */
describe("classifyStylesheetHref — tiered theme/cache filter", () => {
  it("classifies a canonical /wp-content/themes/ URL as 'theme'", () => {
    expect(classifyStylesheetHref("https://example.com/wp-content/themes/twentytwentyfour/style.css")).toBe("theme");
    expect(classifyStylesheetHref("https://example.com/wp-content/themes/tworoads/assets/public/main.css")).toBe("theme");
  });

  it("classifies ShortPixel CDN URLs as 'cache' when they don't embed the theme path", () => {
    // ShortPixel's RWAP / CSS-optimization output sometimes lives at a
    // pure CDN URL with no /wp-content/themes/ segment — e.g. a
    // fingerprinted combined bundle. This is the Tier-2 fallback path:
    // strict theme-path filter rejects it, but the cache pass catches it.
    expect(
      classifyStylesheetHref(
        "https://sp-ao.shortpixel.ai/client/to_auto,q_glossy,ret_img/combined-abc123.css",
      ),
    ).toBe("cache");
  });

  it("classifies ShortPixel URLs that embed the original theme path as 'theme' — primary tier still works", () => {
    // When ShortPixel keeps the original /wp-content/themes/ segment in
    // its rewritten URL, the classifier correctly catches it via the
    // theme-path check first. The fact that the URL ALSO matches the
    // cache pattern doesn't matter — Tier 1 capture is the desired
    // outcome either way (we just want the CSS).
    expect(
      classifyStylesheetHref(
        "https://sp-ao.shortpixel.ai/client/to_auto,q_glossy,ret_img/https://tworoadsbrewing.com/wp-content/themes/tworoads/style.css",
      ),
    ).toBe("theme");
  });

  it("classifies Autoptimize bundle URLs as 'cache'", () => {
    expect(
      classifyStylesheetHref(
        "https://example.com/wp-content/cache/autoptimize/css/autoptimize_abc123.css",
      ),
    ).toBe("cache");
    // Even without the /cache/ prefix — the "autoptimize" token in the path
    // is enough (some hosts move the cache root).
    expect(classifyStylesheetHref("https://example.com/foo/autoptimize_x.css")).toBe("cache");
  });

  it("classifies WP Rocket, Swift Performance, NitroPack patterns as 'cache'", () => {
    expect(classifyStylesheetHref("https://example.com/wp-content/cache/wpr-config/foo.css")).toBe("cache");
    expect(classifyStylesheetHref("https://example.com/foo/swift-perf/bundle.css")).toBe("cache");
    // NitroPack URLs in the wild — CDN host AND path segment.
    expect(
      classifyStylesheetHref(
        "https://cdn-abc123.nitrocdn.com/AbcXyz/assets/static/optimized/rev-abc/wp-content/styles.css",
      ),
    ).toBe("cache");
    expect(
      classifyStylesheetHref(
        "https://example.com/wp-content/cache/nitropack/abc/styles.css",
      ),
    ).toBe("cache");
  });

  it("classifies a generic /wp-content/cache/ URL as 'cache' even without a plugin token", () => {
    expect(classifyStylesheetHref("https://example.com/wp-content/cache/foo.css")).toBe("cache");
    expect(classifyStylesheetHref("https://example.com/wp-content/uploads/cache/foo.css")).toBe("cache");
  });

  it("classifies unrelated CDN / plugin URLs as 'other' so the capture stays focused on real theme CSS", () => {
    expect(classifyStylesheetHref("https://fonts.googleapis.com/css?family=Inter")).toBe("other");
    expect(classifyStylesheetHref("https://cdn.jsdelivr.net/npm/bootstrap/dist/css/bootstrap.min.css")).toBe("other");
    expect(classifyStylesheetHref("https://example.com/wp-content/plugins/jetpack/main.css")).toBe("other");
  });

  it("classifies empty / null / non-string inputs as 'other' without throwing", () => {
    expect(classifyStylesheetHref(null)).toBe("other");
    expect(classifyStylesheetHref(undefined)).toBe("other");
    expect(classifyStylesheetHref("")).toBe("other");
    expect(classifyStylesheetHref(123 as unknown as string)).toBe("other");
  });

  it("prefers 'theme' over 'cache' when both match — theme path takes priority", () => {
    // A theme stylesheet whose URL still includes a "cache" segment (rare —
    // e.g. a sub-themed path like /wp-content/themes/cache-friendly-child/)
    // should classify as theme. The check order in the implementation
    // guarantees this.
    expect(
      classifyStylesheetHref("https://example.com/wp-content/themes/my-cached-child/style.css"),
    ).toBe("theme");
  });
});
