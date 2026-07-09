import { describe, it, expect } from "vitest";
import { resolveBlockDataSource, categoryOf, type BlockInventoryLike } from "./resolve-block-data-source";

function entry(over: Partial<BlockInventoryLike> = {}): BlockInventoryLike {
  return { blockName: "acf/hero", attrSamples: [{}], ...over };
}

describe("resolveBlockDataSource", () => {
  it("classifies a cpt_template block (cptSlug parsed from block_name) as direct-cpt", () => {
    const src = resolveBlockDataSource(entry({ blockName: "cpt_template/beer", attrSamples: [{}] }));
    expect(src).toEqual({ kind: "direct-cpt", cptSlug: "beer" });
    expect(categoryOf(src)).toBe("direct-cpt");
  });

  it("classifies an acf/* block with its own attrs as direct-acf", () => {
    const sample = { heading: "Our Beers", subtitle: "On tap" };
    const src = resolveBlockDataSource(entry({ blockName: "acf/section", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "direct-acf", sample });
    expect(categoryOf(src)).toBe("direct-acf");
  });

  it("classifies a block carrying a post-relation array as relation", () => {
    const sample = { beers: [{ ID: 1, post_title: "Lil Heaven", post_name: "lil-heaven", post_type: "beer" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf/featured-beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "relation", fieldName: "beers", postType: "beer" });
    expect(categoryOf(src)).toBe("relation");
  });

  it("prefers a relation over direct-acf when a flex layout has both config attrs AND a post-relation array", () => {
    const sample = { headline: "On Tap", beers: [{ ID: 1, post_title: "X", post_name: "x", post_type: "beer" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf_flex/page/page_builder/featured_beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "relation", fieldName: "beers", postType: "beer" });
  });

  it("fail-softs to none when a relation ref lacks post_type", () => {
    // findPostRelationFieldsInSample flags the field, but no post_type on the ref → cannot resolve target.
    const sample = { beers: [{ ID: 1, post_title: "X", post_name: "x" }] };
    const src = resolveBlockDataSource(entry({ blockName: "acf/featured-beer", attrSamples: [sample] }));
    expect(src).toEqual({ kind: "none" });
  });

  it("returns none for a block with no attrs and no cpt", () => {
    expect(resolveBlockDataSource(entry({ blockName: "core/heading", attrSamples: [] }))).toEqual({ kind: "none" });
  });

  it("returns none when blockName is null", () => {
    expect(resolveBlockDataSource(entry({ blockName: null, attrSamples: [] }))).toEqual({ kind: "none" });
  });

  it("returns none when the first attr sample is an array (not a plain object)", () => {
    const src = resolveBlockDataSource(entry({
      blockName: "acf/weird",
      attrSamples: [[{ ID: 1, post_title: "x", post_name: "x", post_type: "beer" }] as unknown as Record<string, unknown>],
    }));
    expect(src).toEqual({ kind: "none" });
  });
});
