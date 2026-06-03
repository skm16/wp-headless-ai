import { describe, it, expect } from "vitest";
import {
  pageKey,
  partitionPages,
  splitByTreeAvailability,
  carriedInventoryInput,
  blockNamesInTrees,
  fillCarriedSamples,
  carriedPageRow,
  type CurrentPageRef,
  type PriorBlockSample,
  type PriorPageRow,
} from "./carry-forward";
import type { BlockNode } from "./ability-client";

/** Build a complete BlockNode (the app's BlockNode requires all five fields). */
function blk(name: string | null, attrs: Record<string, unknown> = {}, inner: BlockNode[] = []): BlockNode {
  return { blockName: name, attrs, innerBlocks: inner, innerHTML: "", innerContent: [] };
}

const ref = (slug: string, postType: string, modifiedGmt: string | null): CurrentPageRef => ({
  slug,
  postType,
  modifiedGmt,
});

describe("pageKey", () => {
  it("composes a collision-safe key from post type + slug", () => {
    expect(pageKey("page", "about")).not.toBe(pageKey("event", "about"));
  });
});

describe("partitionPages", () => {
  it("with no window, everything is changed (first/full sync)", () => {
    const current = [ref("a", "page", "2026-01-01T00:00:00Z")];
    const { changed, unchanged } = partitionPages(current, [], {});
    expect(changed).toHaveLength(1);
    expect(unchanged).toHaveLength(0);
  });

  it("touched-since-window and brand-new pages are changed; the rest are unchanged", () => {
    const current = [
      ref("touched", "page", "2026-02-10T00:00:00Z"),
      ref("stale", "page", "2026-01-01T00:00:00Z"),
      ref("brand-new", "page", "2026-02-20T00:00:00Z"),
    ];
    const prior = [
      { slug: "touched", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" },
      { slug: "stale", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" },
    ];
    const { changed, unchanged } = partitionPages(current, prior, {
      modifiedAfter: "2026-02-01T00:00:00Z",
    });
    expect(changed.map((c) => c.slug).sort()).toEqual(["brand-new", "touched"]);
    expect(unchanged.map((c) => c.slug)).toEqual(["stale"]);
  });

  it("treats a missing modifiedGmt as changed (cannot prove unchanged)", () => {
    const current = [ref("unknown", "page", null)];
    const prior = [{ slug: "unknown", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" }];
    const { changed } = partitionPages(current, prior, { modifiedAfter: "2026-02-01T00:00:00Z" });
    expect(changed.map((c) => c.slug)).toEqual(["unknown"]);
  });

  it("keys by (post_type, slug) so two CPTs sharing a slug do not cross-wire", () => {
    const current = [ref("about", "page", "2026-01-01T00:00:00Z"), ref("about", "event", "2026-03-01T00:00:00Z")];
    const prior = [
      { slug: "about", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" },
      { slug: "about", postType: "event", modifiedGmt: "2026-01-01T00:00:00Z" },
    ];
    const { changed, unchanged } = partitionPages(current, prior, { modifiedAfter: "2026-02-01T00:00:00Z" });
    // page/about is stale (unchanged); event/about was touched after the window.
    expect(unchanged.map((c) => `${c.postType}:${c.slug}`)).toEqual(["page:about"]);
    expect(changed.map((c) => `${c.postType}:${c.slug}`)).toEqual(["event:about"]);
  });
});

describe("splitByTreeAvailability", () => {
  it("demotes unchanged pages with no stored tree to must-refetch", () => {
    const trees = new Map<string, BlockNode[]>([[pageKey("page", "has-tree"), [blk("core/heading")]]]);
    const unchanged = [ref("has-tree", "page", null), ref("no-tree", "page", null)];
    const { carriable, mustRefetch } = splitByTreeAvailability(unchanged, trees);
    expect(carriable.map((c) => c.slug)).toEqual(["has-tree"]);
    expect(mustRefetch.map((c) => c.slug)).toEqual(["no-tree"]);
  });
});

describe("carriedInventoryInput", () => {
  it("rebuilds PageBlocksInput from stored trees for carriable pages", () => {
    const tree = [blk("core/cover", { x: 1 })];
    const trees = new Map<string, BlockNode[]>([[pageKey("page", "home"), tree]]);
    const input = carriedInventoryInput([ref("home", "page", null)], trees);
    expect(input).toEqual([{ slug: "home", post_type: "page", blocks: tree }]);
  });

  it("skips pages whose tree is missing (defensive)", () => {
    const input = carriedInventoryInput([ref("ghost", "page", null)], new Map());
    expect(input).toEqual([]);
  });
});

describe("blockNamesInTrees", () => {
  it("collects names recursively, mapping null to __null__", () => {
    const pages = [
      {
        slug: "p",
        post_type: "page",
        blocks: [blk("core/group", {}, [blk("core/heading")]), blk(null)],
      },
    ];
    expect([...blockNamesInTrees(pages)].sort()).toEqual(["__null__", "core/group", "core/heading"]);
  });
});

describe("fillCarriedSamples", () => {
  const prior: PriorBlockSample[] = [
    { blockName: "core/cover", computedStyles: { viewports: {} }, sourceDomSample: "<div>cover</div>" },
    { blockName: "core/heading", computedStyles: { viewports: {} }, sourceDomSample: "<h2>h</h2>" },
  ];

  it("fills computed + dom for blocks absent from the fresh capture", () => {
    const { computed, dom } = fillCarriedSamples(
      {}, // fresh computed — nothing captured this run
      new Map<string, string | null>(),
      prior,
      new Set(["core/cover"]),
    );
    expect(computed["core/cover"]).toEqual({ viewports: {} });
    expect(dom.get("core/cover")).toBe("<div>cover</div>");
  });

  it("fresh values always win over carried", () => {
    const freshComputed = { "core/cover": { viewports: { "1280": { fontSize: ["40px"] } } } };
    const freshDom = new Map<string, string | null>([["core/cover", "<div>FRESH</div>"]]);
    const { computed, dom } = fillCarriedSamples(freshComputed, freshDom, prior, new Set(["core/cover"]));
    expect(computed["core/cover"]).toEqual(freshComputed["core/cover"]);
    expect(dom.get("core/cover")).toBe("<div>FRESH</div>");
  });

  it("does not overwrite a present-null fresh dom entry (keeps the deliberate omission)", () => {
    const freshDom = new Map<string, string | null>([["core/heading", null]]);
    const { dom } = fillCarriedSamples({}, freshDom, prior, new Set(["core/heading"]));
    expect(dom.get("core/heading")).toBeNull();
  });
});

describe("carriedPageRow", () => {
  it("maps a prior page_inventory row into a PersistPagesPage carrying screenshots forward", () => {
    const prior: PriorPageRow = {
      slug: "about",
      post_type: "page",
      title: "About",
      route_path: "/about",
      block_count: 4,
      paradigms: ["acf_flex"],
      source_screenshot_paths: { source: { desktop: "builds/old/about-desktop.png" } },
      source_modified_gmt: "2026-01-01T00:00:00Z",
      block_tree: [blk("core/heading")],
    };
    const page = carriedPageRow(prior);
    expect(page.slug).toBe("about");
    expect(page.route_path).toBe("/about");
    expect(page.block_count).toBe(4);
    expect(page.paradigms).toEqual(["acf_flex"]);
    expect(page.discovery.screenshotPaths).toEqual({ desktop: "builds/old/about-desktop.png" });
    expect(page.sourceModifiedGmt).toBe("2026-01-01T00:00:00Z");
    expect(page.blockTree).toEqual(prior.block_tree);
  });

  it("tolerates a null title and missing screenshot wrapper", () => {
    const prior: PriorPageRow = {
      slug: "x",
      post_type: "page",
      title: null,
      route_path: "/x",
      block_count: 0,
      paradigms: [],
      source_screenshot_paths: null,
      source_modified_gmt: null,
      block_tree: null,
    };
    const page = carriedPageRow(prior);
    expect(page.title).toBe("");
    expect(page.discovery.screenshotPaths).toEqual({});
    expect(page.blockTree).toBeNull();
  });
});
