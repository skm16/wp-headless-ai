import { describe, it, expect, vi } from "vitest";
import { loadDraftPageData, type DraftPageDeps } from "./page-data";

const PAGES = [
  { slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] },
  { slug: "visit-us", post_type: "page", route_path: "visit-us", paradigms: ["gutenberg"] },
];

function deps(over: Partial<DraftPageDeps> = {}): DraftPageDeps {
  return {
    loadPages: vi.fn(async () => PAGES),
    loadManifest: vi.fn(async () => ({ abilities: [{ name: "jab/get-page-by-slug" }] })),
    loadFrontPageSlug: vi.fn(async () => "home"),
    loadAcfFlexFields: vi.fn(async () => ({})),
    loadDynamicListSpecs: vi.fn(async () => ({})),
    callAbility: vi.fn(async () => ({
      page: {
        id: 1,
        title: "Visit",
        slug: "visit-us",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "<h2>Visit</h2>", innerContent: [] }],
      },
    })),
    resolveMedia: undefined,
    ...over,
  };
}

describe("loadDraftPageData", () => {
  it("returns composed renderable blocks for a mapped page", async () => {
    const d = deps();
    const result = await loadDraftPageData({ buildId: "b1", path: "/visit-us" }, d);
    expect(result.kind).toBe("page");
    if (result.kind === "page") {
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks[0]._key).toBeDefined();
    }
    expect(d.callAbility).toHaveBeenCalledWith("jab/get-page-by-slug", {
      slug: "visit-us",
      include: { blocks: true },
    });
  });

  it("propagates redirects (front-page slug)", async () => {
    const result = await loadDraftPageData({ buildId: "b1", path: "/home" }, deps());
    expect(result).toEqual({ kind: "redirect", to: "/" });
  });

  it("is not_found when WP returns no record under the wrapper key", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/visit-us" },
      deps({ callAbility: vi.fn(async () => ({ page: null })) }),
    );
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns a typed error (never throws) when the ability call fails", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/visit-us" },
      deps({ callAbility: vi.fn(async () => { throw new Error("WP unreachable"); }) }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("WP unreachable");
  });
});
