import { describe, it, expect } from "vitest";
import { reduceSiteMap, humanLabelForBlock, decideShellPresence, shellFileName, type SiteMap } from "./site-map";

describe("humanLabelForBlock", () => {
  it("titlecases the leaf of a core block name", () => {
    expect(humanLabelForBlock("core/cover")).toBe("Cover");
    expect(humanLabelForBlock("core/media-text")).toBe("Media Text");
  });
  it("labels an acf_flex layout by its layout leaf", () => {
    expect(humanLabelForBlock("acf_flex/page/page_builder/featured_beer")).toBe("Featured Beer");
  });
  it("labels a cpt_template by its cpt slug", () => {
    expect(humanLabelForBlock("cpt_template/beer")).toBe("Beer template");
  });
  it("returns 'Classic content' for the __null__ sentinel", () => {
    expect(humanLabelForBlock("__null__")).toBe("Classic content");
  });
});

describe("reduceSiteMap", () => {
  it("builds the block catalog (excluding __null__), page slugs, and shell presence", () => {
    const map: SiteMap = reduceSiteMap({
      blockRows: [
        { block_name: "core/cover", tier: "visual", occurrence_count: 4 },
        { block_name: "core/heading", tier: "trivial", occurrence_count: 12 },
        { block_name: "__null__", tier: "passthrough", occurrence_count: 1 },
      ],
      pageRows: [
        { slug: "home", route_path: "/", post_type: "page" },
        { slug: "about", route_path: "/about", post_type: "page" },
      ],
      hasHeader: true,
      hasFooter: false,
    });
    expect(map.blockTypes).toEqual([
      { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 12 },
      { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 },
    ]);
    expect(map.pageSlugs).toEqual(["home", "about"]);
    expect(map.shell).toEqual({ header: true, footer: false });
  });

  it("sorts block types by occurrence desc then name asc", () => {
    const map = reduceSiteMap({
      blockRows: [
        { block_name: "core/b", tier: "standard", occurrence_count: 2 },
        { block_name: "core/a", tier: "standard", occurrence_count: 2 },
        { block_name: "core/z", tier: "visual", occurrence_count: 9 },
      ],
      pageRows: [],
      hasHeader: false,
      hasFooter: false,
    });
    expect(map.blockTypes.map((b) => b.blockName)).toEqual(["core/z", "core/a", "core/b"]);
  });
});

describe("shell presence (artifact-derived, fail-closed)", () => {
  it("maps kind → emitted filename", () => {
    expect(shellFileName("header")).toBe("Header.tsx");
    expect(shellFileName("footer")).toBe("Footer.tsx");
  });

  it("is present when the file is in the listing", () => {
    expect(decideShellPresence("footer", { ok: true, names: ["Header.tsx", "Footer.tsx", "layout.tsx"] })).toBe(true);
  });

  it("is absent when the listing succeeded but the file is missing", () => {
    expect(decideShellPresence("footer", { ok: true, names: ["Header.tsx", "layout.tsx"] })).toBe(false);
  });

  it("FAILS CLOSED to present when the Storage listing itself failed", () => {
    // A transient Storage error must NOT hide a real shell — compose always
    // emits both Header.tsx and Footer.tsx, so "present" is the safe prior.
    expect(decideShellPresence("footer", { ok: false })).toBe(true);
    expect(decideShellPresence("header", { ok: false })).toBe(true);
  });
});
