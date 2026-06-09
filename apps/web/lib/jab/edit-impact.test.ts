import { describe, it, expect } from "vitest";
import { computeChangedPages, type SourcePageForImpact } from "./edit-impact";
import type { BlockNode } from "./ability-client";

function node(blockName: string | null, inner: BlockNode[] = []): BlockNode {
  return { blockName, attrs: {}, innerBlocks: inner, innerHTML: "", innerContent: [] };
}
function page(slug: string, tree: BlockNode[] | null): SourcePageForImpact {
  return { slug, blockTree: tree };
}

describe("computeChangedPages — shell", () => {
  it("returns all slugs with reason shell_all", () => {
    const r = computeChangedPages({
      scope: "shell",
      target: "header",
      sourcePages: [page("home", []), page("about", [])],
    });
    expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
    expect(r.reason).toBe("shell_all");
  });
});

describe("computeChangedPages — component", () => {
  it("returns only the pages whose tree contains the target block (recursively)", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "core/cover",
      sourcePages: [
        page("home", [node("core/group", [node("core/cover")])]),
        page("about", [node("core/heading")]),
        page("menu", [node("core/cover")]),
      ],
    });
    expect(r.changedSlugs.sort()).toEqual(["home", "menu"]);
    expect(r.reason).toBe("component_pages");
  });

  it("FAIL-CLOSED: a page with a null block_tree forces all pages", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "core/cover",
      sourcePages: [page("home", [node("core/cover")]), page("about", null)],
    });
    expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
    expect(r.reason).toBeNull();
  });

  it("FAIL-CLOSED: more than 50 matching pages forces all pages", () => {
    const pages: SourcePageForImpact[] = [];
    for (let i = 0; i < 60; i++) pages.push(page(`p${i}`, [node("core/cover")]));
    const r = computeChangedPages({ scope: "component", target: "core/cover", sourcePages: pages });
    expect(r.changedSlugs.length).toBe(60);
    expect(r.reason).toBeNull();
  });

  it("FAIL-CLOSED: a non-array block_tree forces all pages", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "core/cover",
      // @ts-expect-error — exercise the defensive non-array branch
      sourcePages: [{ slug: "home", blockTree: { not: "an array" } }, page("about", [node("core/cover")])],
    });
    expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
    expect(r.reason).toBeNull();
  });

  it("finds an acf_flex target by its synthesized block name on innerBlocks", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "acf_flex/page/builder/hero",
      sourcePages: [page("home", [node("acf_flex/page/builder/hero")]), page("about", [node("core/heading")])],
    });
    expect(r.changedSlugs).toEqual(["home"]);
    expect(r.reason).toBe("component_pages");
  });

  it("FAIL-CLOSED: zero matches widens to all pages (diff source is blind to synthesized targets)", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "core/cover",
      sourcePages: [
        page("home", [node("core/heading")]),
        page("about", [node("core/paragraph")]),
      ],
    });
    expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
    expect(r.reason).toBeNull();
  });

  it("FAIL-CLOSED: an acf_flex target absent from the raw trees widens to all pages", () => {
    // acf_flex/* names are synthesized from page.acf at inventory/render time
    // (content-detection.ts) and NEVER appear in the persisted raw block_tree —
    // this is the exact Two Roads 'make the hero bolder' shape.
    const r = computeChangedPages({
      scope: "component",
      target: "acf_flex/page/builder/hero",
      sourcePages: [
        page("home", [node("core/group", [node("core/paragraph")])]),
        page("beers", [node("core/columns")]),
      ],
    });
    expect(r.changedSlugs.sort()).toEqual(["beers", "home"]);
    expect(r.reason).toBeNull();
  });
});
