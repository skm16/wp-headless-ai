import { describe, it, expect, vi } from "vitest";
import {
  classifyStylesheetHref,
  fetchBlockedStylesheets,
  fetchStylesheetCss,
} from "./capture-theme-stylesheets";

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

/**
 * Mock fetch helper — returns a `Response`-shape with `.text()` for a
 * single mapped URL, 404 for anything else.
 */
function mockFetch(map: Record<string, string | { status: number; body?: string }>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const hit = map[url];
    if (typeof hit === "string") {
      return new Response(hit, { status: 200 });
    }
    if (hit && typeof hit === "object") {
      return new Response(hit.body ?? "", { status: hit.status });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("fetchStylesheetCss — server-side CORS fallback", () => {
  it("returns the response body when fetch succeeds", async () => {
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/foo.css": "body { color: red }",
    });
    const css = await fetchStylesheetCss("https://sp-ao.shortpixel.ai/foo.css", fetchImpl);
    expect(css).toBe("body { color: red }");
  });

  it("returns null on non-200 responses (no throw — capture is fail-soft)", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/missing.css": { status: 404 },
    });
    expect(await fetchStylesheetCss("https://example.com/missing.css", fetchImpl)).toBeNull();
  });

  it("returns null on empty / whitespace-only bodies", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/empty.css": "",
      "https://example.com/whitespace.css": "   \n\n",
    });
    expect(await fetchStylesheetCss("https://example.com/empty.css", fetchImpl)).toBeNull();
    expect(await fetchStylesheetCss("https://example.com/whitespace.css", fetchImpl)).toBeNull();
  });

  it("returns null on fetch throwing (network error, malformed URL) without surfacing the throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchStylesheetCss("https://x.test/foo.css", fetchImpl)).toBeNull();
  });
});

describe("fetchBlockedStylesheets — tier policy + caps", () => {
  it("Tier 1 add: a theme-kind blocked URL is fetched and appended alongside existing CSSOM sheets", async () => {
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/themes/style.css": "body { font-family: Anton }",
    });
    const out = await fetchBlockedStylesheets(
      [{ href: "https://example.com/wp-content/themes/foo/main.css", css: ".foo { color: red }" }],
      [{ href: "https://sp-ao.shortpixel.ai/themes/style.css", kind: "theme" }],
      fetchImpl,
    );
    expect(out).toHaveLength(2);
    expect(out[1].css).toMatch(/Anton/);
  });

  it("Tier 2 gate: cache-kind blocked URL is skipped only when a Tier-1 (theme-kind) sheet is already present in existing", async () => {
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/bundle.css": "body { color: blue }",
    });
    // Tier 1 theme sheet already captured via CSSOM — cache-kind blocked
    // URL is skipped (gate active).
    const withTier1 = await fetchBlockedStylesheets(
      [{ href: "https://example.com/wp-content/themes/foo/main.css", css: ".x{}", kind: "theme" }],
      [{ href: "https://sp-ao.shortpixel.ai/bundle.css", kind: "cache" }],
      fetchImpl,
    );
    expect(withTier1).toHaveLength(1);
    expect(withTier1[0].href).toMatch(/themes/);

    // No theme sheets captured: cache-kind blocked URL is the Tier 2 fallback.
    const withoutExisting = await fetchBlockedStylesheets(
      [],
      [{ href: "https://sp-ao.shortpixel.ai/bundle.css", kind: "cache" }],
      fetchImpl,
    );
    expect(withoutExisting).toHaveLength(1);
    expect(withoutExisting[0].href).toMatch(/shortpixel/);
  });

  it("Tier 2 follow-on: cache-kind blocked URL IS fetched even when existing contains other Tier-2 cache sheets (the Fix-J semantic)", async () => {
    // Real-world scenario: page has 2 optimization-cache bundles. The
    // in-page CSSOM read got one (same-origin, no SecurityError); the
    // other was on a CDN host and got SecurityError → recorded as
    // blocked. Pre-Fix-J the second one was dropped because
    // existing.length > 0. Post-Fix-J, the kind-aware gate sees only
    // cache-kind in existing (no theme-kind) and lets the second one
    // through.
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/bundle-cors-blocked.css": "body { font-family: Anton }",
    });
    const out = await fetchBlockedStylesheets(
      [{ href: "https://example.com/wp-content/cache/autoptimize/foo.css", css: ".tier2{}", kind: "cache" }],
      [{ href: "https://sp-ao.shortpixel.ai/bundle-cors-blocked.css", kind: "cache" }],
      fetchImpl,
    );
    expect(out).toHaveLength(2);
    expect(out[1].href).toMatch(/shortpixel/);
    expect(out[1].css).toMatch(/Anton/);
  });

  it("preserves the kind tag on newly-fetched entries so downstream tier logic stays correct", async () => {
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/foo.css": "body { color: red }",
    });
    const out = await fetchBlockedStylesheets(
      [],
      [{ href: "https://sp-ao.shortpixel.ai/foo.css", kind: "cache" }],
      fetchImpl,
    );
    expect(out[0].kind).toBe("cache");
  });

  it("unknown-kind existing entries (back-compat fixtures with no kind set) do NOT gate cache-kind fetches", async () => {
    // A pre-Fix-J test fixture or callsite passes ThemeStylesheetCapture
    // without `kind`. The gate must not treat that as Tier-1 evidence —
    // it should let cache-kind blocked URLs proceed.
    const fetchImpl = mockFetch({
      "https://sp-ao.shortpixel.ai/blocked.css": "body { color: green }",
    });
    const out = await fetchBlockedStylesheets(
      [{ href: "https://example.com/legacy.css", css: ".legacy{}" }], // no kind
      [{ href: "https://sp-ao.shortpixel.ai/blocked.css", kind: "cache" }],
      fetchImpl,
    );
    expect(out).toHaveLength(2);
    expect(out[1].href).toMatch(/shortpixel/);
  });

  it("dedups against existing entries — a sheet captured via CSSOM is not re-fetched", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("body{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await fetchBlockedStylesheets(
      [{ href: "https://x.test/a.css", css: "captured" }],
      [{ href: "https://x.test/a.css", kind: "theme" }],
      fetchImpl,
    );
    expect(out).toHaveLength(1);
    expect(out[0].css).toBe("captured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps at MAX_STYLESHEETS — does not fetch past the in-page cap (10) even when many URLs are blocked", async () => {
    const blocked = Array.from({ length: 15 }, (_, i) => ({
      href: `https://x.test/${i}.css`,
      kind: "cache" as const,
    }));
    const fetchImpl = vi.fn(async () =>
      new Response("body{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await fetchBlockedStylesheets([], blocked, fetchImpl);
    expect(out.length).toBeLessThanOrEqual(10);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("returns existing unchanged when blockedUrls is empty", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const existing = [{ href: "https://a.test/a.css", css: "x" }];
    expect(await fetchBlockedStylesheets(existing, [], fetchImpl)).toEqual(existing);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
