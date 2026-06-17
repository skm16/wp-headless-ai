import { describe, it, expect } from "vitest";
import { reduceSiteMap, humanLabelForBlock, decideShellPresence, shellFileName, type SiteMap } from "./site-map";
import { MAX_PAGE_SLUGS_PER_BLOCK } from "@/lib/jab/inventory";

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
  it("builds the block catalog (excluding passthrough/non-ok blocks), page slugs, and shell presence", () => {
    const map: SiteMap = reduceSiteMap({
      blockRows: [
        { block_name: "core/cover", tier: "visual", occurrence_count: 4, compile_status: "ok", page_slugs: [] },
        { block_name: "core/heading", tier: "trivial", occurrence_count: 12, compile_status: "ok", page_slugs: [] },
        { block_name: "__null__", tier: "passthrough", occurrence_count: 1, compile_status: "skipped", page_slugs: [] },
      ],
      pageRows: [
        { slug: "home", route_path: "/", post_type: "page" },
        { slug: "about", route_path: "/about", post_type: "page" },
      ],
      hasHeader: true,
      hasFooter: false,
    });
    expect(map.blockTypes).toEqual([
      { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 12, pageCount: 0, pageCountIsFloor: false },
      { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4, pageCount: 0, pageCountIsFloor: false },
    ]);
    expect(map.pageSlugs).toEqual(["home", "about"]);
    expect(map.shell).toEqual({ header: true, footer: false });
  });

  it("sorts block types by occurrence desc then name asc", () => {
    const map = reduceSiteMap({
      blockRows: [
        { block_name: "core/b", tier: "standard", occurrence_count: 2, compile_status: "ok", page_slugs: [] },
        { block_name: "core/a", tier: "standard", occurrence_count: 2, compile_status: "ok", page_slugs: [] },
        { block_name: "core/z", tier: "visual", occurrence_count: 9, compile_status: "ok", page_slugs: [] },
      ],
      pageRows: [],
      hasHeader: false,
      hasFooter: false,
    });
    expect(map.blockTypes.map((b) => b.blockName)).toEqual(["core/z", "core/a", "core/b"]);
  });

  it("excludes passthrough/non-ok blocks AND core/image (only individually-renderable units are editable)", () => {
    const map = reduceSiteMap({
      blockRows: [
        { block_name: "core/cover", tier: "visual", occurrence_count: 3, compile_status: "ok", page_slugs: ["a", "b"] },
        { block_name: "kadence/rowlayout", tier: "passthrough", occurrence_count: 5, compile_status: "skipped", page_slugs: ["a"] },
        { block_name: "core/table", tier: "standard", occurrence_count: 2, compile_status: "failed", page_slugs: ["c"] },
        // core/image passes tier/compile but the dispatcher always routes it to the
        // MediaImage shim (the generated CoreImage is suppressed), so patching it
        // is a no-op — it MUST be excluded too.
        { block_name: "core/image", tier: "visual", occurrence_count: 9, compile_status: "ok", page_slugs: ["a", "b", "c"] },
        { block_name: "__null__", tier: "passthrough", occurrence_count: 1, compile_status: "skipped", page_slugs: ["a"] },
      ],
      pageRows: [],
      hasHeader: true,
      hasFooter: true,
    });
    expect(map.blockTypes.map((b) => b.blockName)).toEqual(["core/cover"]);
  });

  it("includes the Classic block as an editable unit", () => {
    const map = reduceSiteMap({
      blockRows: [{ block_name: "__null__", tier: "classic", occurrence_count: 4, compile_status: "ok", page_slugs: ["about", "team"] }],
      pageRows: [{ slug: "about", route_path: "/about", post_type: "page" }],
      hasHeader: false,
      hasFooter: false,
    });
    const classic = map.blockTypes.find((b) => b.blockName === "__null__");
    expect(classic).toBeDefined();
    expect(classic!.label).toBe("Classic content");
  });

  it("derives pageCount from distinct page_slugs (not occurrence_count) and flags non-floor counts", () => {
    const map = reduceSiteMap({
      blockRows: [
        // appears twice on ONE page → occurrenceCount 2 but pageCount 1
        { block_name: "core/cover", tier: "visual", occurrence_count: 2, compile_status: "ok", page_slugs: ["home"] },
        { block_name: "core/heading", tier: "trivial", occurrence_count: 4, compile_status: "ok", page_slugs: ["home", "about", "contact"] },
      ],
      pageRows: [],
      hasHeader: true,
      hasFooter: true,
    });
    const cover = map.blockTypes.find((b) => b.blockName === "core/cover")!;
    const heading = map.blockTypes.find((b) => b.blockName === "core/heading")!;
    expect(cover.occurrenceCount).toBe(2);
    expect(cover.pageCount).toBe(1);
    expect(cover.pageCountIsFloor).toBe(false);
    expect(heading.pageCount).toBe(3);
    expect(heading.pageCountIsFloor).toBe(false);
  });

  it("marks pageCount as a FLOOR when page_slugs hit the inventory cap (50+)", () => {
    // The inventory builder caps page_slugs at MAX_PAGE_SLUGS_PER_BLOCK (50), so a
    // block on 80 pages persists exactly 50 slugs. pageCount must be flagged as a
    // floor so the planner says "at least 50 pages", never a fabricated "50 pages".
    const slugs = Array.from({ length: MAX_PAGE_SLUGS_PER_BLOCK }, (_, i) => `p${i}`);
    const map = reduceSiteMap({
      blockRows: [{ block_name: "core/cover", tier: "visual", occurrence_count: 90, compile_status: "ok", page_slugs: slugs }],
      pageRows: [],
      hasHeader: true,
      hasFooter: true,
    });
    const cover = map.blockTypes[0];
    expect(cover.pageCount).toBe(MAX_PAGE_SLUGS_PER_BLOCK);
    expect(cover.pageCountIsFloor).toBe(true);
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
