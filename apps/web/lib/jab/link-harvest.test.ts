import { describe, expect, it } from "vitest";
import {
  normalizeHarvestedLinks,
  partitionUnvisited,
  selectBrokenLinks,
  attributeBrokenLinks,
  resolveBrokenLinkAttributions,
  isNonCloneRoutePath,
  MAX_INTERNAL_LINK_CHECKS,
} from "./link-harvest";
import type { RouteCheckResult } from "./smoke-routes";

const PREVIEW = "https://two-roads-abc.vercel.app";

describe("normalizeHarvestedLinks", () => {
  it("keeps same-origin internal links as normalized root-relative paths", () => {
    const out = normalizeHarvestedLinks(
      [`${PREVIEW}/about`, `${PREVIEW}/menu/`, `${PREVIEW}/`],
      { previewUrl: PREVIEW },
    );
    expect(out).toContain("/about");
    expect(out).toContain("/menu"); // trailing slash normalized
    expect(out).toContain("/");
  });

  it("drops query strings and hash fragments, keeping only the pathname", () => {
    expect(
      normalizeHarvestedLinks([`${PREVIEW}/search?q=ipa#results`], { previewUrl: PREVIEW }),
    ).toEqual(["/search"]);
  });

  it("drops external hosts, mailto:, tel:, and javascript: links", () => {
    const out = normalizeHarvestedLinks(
      [
        "https://twitter.com/tworoads",
        "mailto:hi@tworoads.com",
        "tel:+18605551234",
        "javascript:void(0)",
        `${PREVIEW}/contact`,
      ],
      { previewUrl: PREVIEW },
    );
    expect(out).toEqual(["/contact"]);
  });

  it("drops asset paths (wp-content/includes/json + media extensions)", () => {
    const out = normalizeHarvestedLinks(
      [
        `${PREVIEW}/wp-content/uploads/logo.png`,
        `${PREVIEW}/wp-includes/x.js`,
        `${PREVIEW}/brand/hero.svg`,
        `${PREVIEW}/docs/menu.pdf`,
        `${PREVIEW}/real-page`,
      ],
      { previewUrl: PREVIEW },
    );
    expect(out).toEqual(["/real-page"]);
  });

  it("dedupes repeated links", () => {
    const out = normalizeHarvestedLinks(
      [`${PREVIEW}/about`, `${PREVIEW}/about/`, `${PREVIEW}/about?x=1`],
      { previewUrl: PREVIEW },
    );
    expect(out).toEqual(["/about"]);
  });

  it("is fail-soft on malformed hrefs (skips, never throws)", () => {
    expect(
      normalizeHarvestedLinks(["", "not a url", `${PREVIEW}/ok`], { previewUrl: PREVIEW }),
    ).toEqual(["/ok"]);
  });

  it("drops WP archive/system routes the clone never implements (category/tag/author/date/feed/wp-admin)", () => {
    const out = normalizeHarvestedLinks(
      [
        `${PREVIEW}/category/news`,
        `${PREVIEW}/tag/hoppy`,
        `${PREVIEW}/author/jane`,
        `${PREVIEW}/2024/06`,
        `${PREVIEW}/2024/06/12`,
        `${PREVIEW}/feed`,
        `${PREVIEW}/wp-admin/`,
        `${PREVIEW}/wp-login.php`,
        `${PREVIEW}/beer/lil-heaven`, // a real content route — kept
      ],
      { previewUrl: PREVIEW },
    );
    expect(out).toEqual(["/beer/lil-heaven"]);
  });

  it("decodes percent-encoded non-ASCII slugs so they match the decoded route_path", () => {
    expect(
      normalizeHarvestedLinks([`${PREVIEW}/caf%C3%A9`], { previewUrl: PREVIEW }),
    ).toEqual(["/café"]);
  });
});

describe("isNonCloneRoutePath", () => {
  it("flags stock WP archive/system route families", () => {
    expect(isNonCloneRoutePath("/category/news")).toBe(true);
    expect(isNonCloneRoutePath("/tag/x")).toBe(true);
    expect(isNonCloneRoutePath("/author/jane")).toBe(true);
    expect(isNonCloneRoutePath("/wp-admin/options.php")).toBe(true);
    expect(isNonCloneRoutePath("/wp-login.php")).toBe(true);
    expect(isNonCloneRoutePath("/feed")).toBe(true);
    expect(isNonCloneRoutePath("/2024")).toBe(true);
    expect(isNonCloneRoutePath("/2024/06")).toBe(true);
    expect(isNonCloneRoutePath("/2024/06/12")).toBe(true);
  });
  it("does NOT flag normal content/page routes", () => {
    expect(isNonCloneRoutePath("/about")).toBe(false);
    expect(isNonCloneRoutePath("/beer/lil-heaven")).toBe(false);
    expect(isNonCloneRoutePath("/")).toBe(false);
    // a real page that merely starts with a digit-ish slug but isn't a date archive
    expect(isNonCloneRoutePath("/2024-recap")).toBe(false);
  });
});

describe("resolveBrokenLinkAttributions (fan-out collapse)", () => {
  it("attributes a content link referenced by few pages to each referencing page", () => {
    const pages = [
      { pageInventoryId: "beers", routePath: "/beers", links: ["/beer/x"] },
      { pageInventoryId: "home", routePath: "/", links: ["/about"] },
    ];
    const out = resolveBrokenLinkAttributions(pages, ["/beer/x"], 2);
    expect(out).toEqual([
      { pageInventoryId: "beers", routePath: "/beers", brokenPath: "/beer/x", siteWide: false },
    ]);
  });

  it("collapses a shell-wide link (referenced by ~every page) to ONE representative, preferring '/'", () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      pageInventoryId: i === 0 ? "home" : `p${i}`,
      routePath: i === 0 ? "/" : `/p${i}`,
      links: ["/category/news"], // a dead nav link on every page
    }));
    const out = resolveBrokenLinkAttributions(pages, ["/category/news"], 10);
    expect(out).toEqual([
      { pageInventoryId: "home", routePath: "/", brokenPath: "/category/news", siteWide: true },
    ]);
  });

  it("returns nothing when there are no broken paths", () => {
    expect(resolveBrokenLinkAttributions([{ pageInventoryId: "a", routePath: "/", links: [] }], [], 1)).toEqual([]);
  });
});

describe("partitionUnvisited", () => {
  it("returns harvested paths not already in the known set, deduped", () => {
    expect(
      partitionUnvisited(["/about", "/beer/x", "/about", "/beer/y"], ["/about"]),
    ).toEqual(["/beer/x", "/beer/y"]);
  });

  it("normalizes both sides so a trailing-slash known path still excludes", () => {
    expect(partitionUnvisited(["/about"], ["/about/"])).toEqual([]);
  });

  it("caps the number of unvisited paths returned", () => {
    const many = Array.from({ length: MAX_INTERNAL_LINK_CHECKS + 10 }, (_, i) => `/p${i}`);
    expect(partitionUnvisited(many, []).length).toBe(MAX_INTERNAL_LINK_CHECKS);
  });
});

describe("selectBrokenLinks", () => {
  const r = (path: string, status: number | null, ok: boolean, error?: string): RouteCheckResult => ({
    path,
    status,
    ok,
    ...(error ? { error } : {}),
  });

  it("flags 404, 410, and 5xx as broken", () => {
    const results = [
      r("/gone", 404, false),
      r("/410", 410, false),
      r("/boom", 500, false),
      r("/bad-gateway", 502, false),
    ];
    expect(selectBrokenLinks(results)).toEqual(["/gone", "/410", "/boom", "/bad-gateway"]);
  });

  it("does NOT flag 2xx/3xx as broken", () => {
    expect(selectBrokenLinks([r("/ok", 200, true), r("/redir", 308, true)])).toEqual([]);
  });

  it("does NOT flag 401/403/429 or network errors as broken (avoids Vercel-challenge / blip false positives)", () => {
    const results = [
      r("/auth", 401, false),
      r("/challenge", 403, false),
      r("/rate", 429, false),
      r("/timeout", null, false, "TimeoutError"),
    ];
    expect(selectBrokenLinks(results)).toEqual([]);
  });
});

describe("attributeBrokenLinks", () => {
  const pages = [
    { pageInventoryId: "A", routePath: "/beers", links: ["/beer/x", "/beer/y"] },
    { pageInventoryId: "B", routePath: "/", links: ["/beer/x"] },
    { pageInventoryId: "C", routePath: "/about", links: ["/contact"] },
  ];

  it("attributes a broken target to every page that references it", () => {
    expect(attributeBrokenLinks(pages, ["/beer/x"])).toEqual([
      { pageInventoryId: "A", routePath: "/beers", brokenPath: "/beer/x" },
      { pageInventoryId: "B", routePath: "/", brokenPath: "/beer/x" },
    ]);
  });

  it("returns nothing for a broken path no page references", () => {
    expect(attributeBrokenLinks(pages, ["/ghost"])).toEqual([]);
  });

  it("returns nothing when there are no broken paths", () => {
    expect(attributeBrokenLinks(pages, [])).toEqual([]);
  });
});
