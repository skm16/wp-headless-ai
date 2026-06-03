import { describe, it, expect } from "vitest";
import { toPriorPages, toPriorTreesByKey, toPriorBlockSamples } from "./load-prior-build";
import { pageKey } from "./carry-forward";

describe("toPriorPages", () => {
  it("maps page_inventory rows to PriorPage", () => {
    expect(
      toPriorPages([{ slug: "home", post_type: "page", source_modified_gmt: "2026-06-01T00:00:00Z" }]),
    ).toEqual([{ slug: "home", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" }]);
  });
  it("preserves nulls", () => {
    expect(toPriorPages([{ slug: "a", post_type: "page", source_modified_gmt: null }])).toEqual([
      { slug: "a", postType: "page", modifiedGmt: null },
    ]);
  });
});

describe("toPriorTreesByKey", () => {
  it("keys stored trees by (post_type, slug), skipping null trees", () => {
    const rows = [
      { slug: "home", post_type: "page", block_tree: [{ blockName: "core/cover", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }] },
      { slug: "empty", post_type: "page", block_tree: null },
    ];
    const map = toPriorTreesByKey(rows);
    expect(map.has(pageKey("page", "home"))).toBe(true);
    expect(map.has(pageKey("page", "empty"))).toBe(false);
  });

  it("includes a present-but-empty tree (page with genuinely zero blocks)", () => {
    const map = toPriorTreesByKey([{ slug: "blank", post_type: "page", block_tree: [] }]);
    expect(map.has(pageKey("page", "blank"))).toBe(true);
    expect(map.get(pageKey("page", "blank"))).toEqual([]);
  });
});

describe("toPriorBlockSamples", () => {
  it("de-keys block_name and carries computed + dom (preserving the __null__ sentinel)", () => {
    const rows = [
      { block_name: "core/cover", computed_styles: { viewports: {} }, source_dom_sample: "<div/>" },
      { block_name: "__null__", computed_styles: null, source_dom_sample: null },
    ];
    const samples = toPriorBlockSamples(rows);
    expect(samples.find((s) => s.blockName === "core/cover")?.sourceDomSample).toBe("<div/>");
    // __null__ is preserved as the literal key — buildInventory uses the same
    // sentinel, so the fill lookup matches on "__null__".
    expect(samples.some((s) => s.blockName === "__null__")).toBe(true);
  });
});
