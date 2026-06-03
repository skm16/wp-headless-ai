import { describe, it, expect } from "vitest";
import {
  pageKey,
  partitionPages,
  splitByTreeAvailability,
  type CurrentPageRef,
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
