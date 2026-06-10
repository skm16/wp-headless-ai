import { describe, expect, it } from "vitest";
import {
  rewriteWpOriginUrls,
  hostVariants,
  isAssetPath,
  normalizePathname,
  buildRoutePathMap,
} from "./rewrite-origin-links";

const HOSTS = ["tworoadsbrewing.com"];

describe("rewriteWpOriginUrls", () => {
  it("rewrites source-host hrefs in TSX string literals to root-relative paths", () => {
    const src = `const nav = [{ href: "https://tworoadsbrewing.com/visit-us/", label: "Visit" }];`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(
      `const nav = [{ href: "/visit-us", label: "Visit" }];`,
    );
  });

  it("is www- and case-insensitive on host match", () => {
    const src = `<a href="https://WWW.TwoRoadsBrewing.com/beers">Beers</a>`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toContain(`href="/beers"`);
  });

  it("leaves foreign-host URLs untouched", () => {
    const src = `<a href="https://instagram.com/tworoads">IG</a>`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(src);
  });

  it("preserves asset URLs on the source host (wp-content + extensions)", () => {
    const a = `src="https://tworoadsbrewing.com/wp-content/uploads/logo.png"`;
    const b = `url("https://tworoadsbrewing.com/some/path/font.woff2")`;
    expect(rewriteWpOriginUrls(a, { sourceHosts: HOSTS })).toBe(a);
    expect(rewriteWpOriginUrls(b, { sourceHosts: HOSTS })).toBe(b);
  });

  it("rewrites the bare origin to /", () => {
    const src = `href="https://tworoadsbrewing.com"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(`href="/"`);
  });

  it("preserves query + hash", () => {
    const src = `href="https://tworoadsbrewing.com/events?cat=live#list"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(`href="/events?cat=live#list"`);
  });

  it("maps source pathnames through routePathMap when provided", () => {
    const src = `href="https://tworoadsbrewing.com/beers/lil-heaven/"`;
    const out = rewriteWpOriginUrls(src, {
      sourceHosts: HOSTS,
      routePathMap: { "/beers/lil-heaven": "/beer/lil-heaven" },
    });
    expect(out).toBe(`href="/beer/lil-heaven"`);
  });

  it("no-ops on empty sourceHosts", () => {
    const src = `href="https://tworoadsbrewing.com/x"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: [] })).toBe(src);
  });

  it("leaves URLs embedded in JSX prose text untouched", () => {
    const src = `<p>Visit https://tworoadsbrewing.com today for great beer.</p>`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(src);
  });

  it("leaves URLs embedded inside a longer string untouched", () => {
    const src = `const copy = "Find us at https://tworoadsbrewing.com/visit-us. Cheers!";`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(src);
  });

  it("keeps media-library document links absolute (extension exempt)", () => {
    const src = `href="https://tworoadsbrewing.com/files/menu.docx"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(src);
  });
});

describe("helpers", () => {
  it("hostVariants returns bare + www variants", () => {
    expect(hostVariants("https://www.tworoadsbrewing.com/")).toEqual(
      expect.arrayContaining(["tworoadsbrewing.com", "www.tworoadsbrewing.com"]),
    );
  });

  it("isAssetPath catches wp paths and asset extensions", () => {
    expect(isAssetPath("/wp-content/uploads/x.pdf")).toBe(true);
    expect(isAssetPath("/wp-json/jab/v1/manifest")).toBe(true);
    expect(isAssetPath("/images/photo.jpeg")).toBe(true);
    expect(isAssetPath("/visit-us")).toBe(false);
  });

  it("normalizePathname strips a trailing slash except for root", () => {
    expect(normalizePathname("/about/")).toBe("/about");
    expect(normalizePathname("/")).toBe("/");
    expect(normalizePathname("")).toBe("/");
  });

  it("buildRoutePathMap maps source permalink paths to clone routes, skipping null/invalid", () => {
    expect(
      buildRoutePathMap([
        { link: "https://tworoadsbrewing.com/beers/lil-heaven/", route_path: "/beer/lil-heaven" },
        { link: null, route_path: "/about" },
        { link: "not a url", route_path: "/x" },
      ]),
    ).toEqual({ "/beers/lil-heaven": "/beer/lil-heaven" });
  });

  it("buildRoutePathMap skips malformed route_path values", () => {
    expect(
      buildRoutePathMap([{ link: "https://tworoadsbrewing.com/a/", route_path: "no-slash" }]),
    ).toEqual({});
  });
});
