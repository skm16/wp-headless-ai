import { describe, expect, it } from "vitest";
import { rewriteHtmlOriginLinks, sourceHostsFromEnv } from "./rewrite-links-runtime";

describe("rewriteHtmlOriginLinks", () => {
  const hosts = ["tworoadsbrewing.com"];

  it("rewrites source-host hrefs in HTML to relative paths", () => {
    const html = `<p><a href="https://www.tworoadsbrewing.com/visit-us/">Visit</a></p>`;
    expect(rewriteHtmlOriginLinks(html, hosts)).toBe(`<p><a href="/visit-us">Visit</a></p>`);
  });

  it("leaves foreign hosts and asset URLs alone", () => {
    const html =
      `<a href="https://instagram.com/x">IG</a>` +
      `<a href="https://tworoadsbrewing.com/wp-content/uploads/menu.pdf">Menu</a>`;
    expect(rewriteHtmlOriginLinks(html, hosts)).toBe(html);
  });

  it("rewrites the bare origin to / and preserves query+hash", () => {
    expect(rewriteHtmlOriginLinks(`<a href="https://tworoadsbrewing.com">Home</a>`, hosts)).toBe(
      `<a href="/">Home</a>`,
    );
    expect(
      rewriteHtmlOriginLinks(`<a href="https://tworoadsbrewing.com/events?cat=live#list">E</a>`, hosts),
    ).toBe(`<a href="/events?cat=live#list">E</a>`);
  });

  it("no-ops on empty hosts", () => {
    const html = `<a href="https://tworoadsbrewing.com/x">x</a>`;
    expect(rewriteHtmlOriginLinks(html, [])).toBe(html);
  });
});

describe("sourceHostsFromEnv", () => {
  it("derives bare + www variants from WP_URL", () => {
    expect(sourceHostsFromEnv("https://www.tworoadsbrewing.com")).toEqual(
      expect.arrayContaining(["tworoadsbrewing.com", "www.tworoadsbrewing.com"]),
    );
  });
  it("returns [] for missing/invalid input", () => {
    expect(sourceHostsFromEnv(undefined)).toEqual([]);
    expect(sourceHostsFromEnv("not a url")).toEqual([]);
  });
});
