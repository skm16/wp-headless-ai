import { describe, it, expect, vi } from "vitest";
import { loadDraftPageData, type DraftPageDeps } from "./page-data";
import { BLOG_INDEX_HEADING } from "@/lib/jab/homepage-emit";

const PAGES = [
  { slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] },
  { slug: "visit-us", post_type: "page", route_path: "visit-us", paradigms: ["gutenberg"] },
];

function deps(over: Partial<DraftPageDeps> = {}): DraftPageDeps {
  return {
    loadPages: vi.fn(async () => PAGES),
    loadManifest: vi.fn(async () => ({ abilities: [{ name: "jab/get-page-by-slug" }] })),
    loadFrontPageSlug: vi.fn(async () => "home"),
    loadShowOnFront: vi.fn(async () => null),
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

describe("loadDraftPageData — posts-front blog index", () => {
  const POSTS_MANIFEST = {
    abilities: [
      { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
      { name: "jab/get-post-by-slug" },
    ],
  };
  function postsDeps(over: Partial<DraftPageDeps> = {}): DraftPageDeps {
    return deps({
      loadManifest: vi.fn(async () => POSTS_MANIFEST),
      loadShowOnFront: vi.fn(async () => "posts" as const),
      loadFrontPageSlug: vi.fn(async () => null),
      callAbility: vi.fn(async () => ({
        posts: [
          { id: 7, title: "First", slug: "first", excerpt: "x", date: "2026-06-01", acf: {} },
          { id: 8, title: "Second", slug: "second", excerpt: "y", date: "2026-06-02", acf: {} },
        ],
      })),
      ...over,
    });
  }

  it("returns a blogIndex result with normalized items for '/' on a posts-front site", async () => {
    const d = postsDeps();
    const result = await loadDraftPageData({ buildId: "b1", path: "/" }, d);
    expect(result.kind).toBe("blogIndex");
    if (result.kind === "blogIndex") {
      expect(result.heading).toBe(BLOG_INDEX_HEADING);
      expect(result.items.map((i) => i.title)).toEqual(["First", "Second"]);
      // local card URLs, mirroring normalizeRecord(postType:"post")
      expect(result.items[0].url).toBe("/post/first");
    }
    expect(d.callAbility).toHaveBeenCalledWith("jab/get-posts", { numberposts: 12, orderby: "date", order: "desc" });
  });

  it("is a loud error (never throws) when the list ability call fails", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/" },
      postsDeps({ callAbility: vi.fn(async () => { throw new Error("WP unreachable"); }) }),
    );
    expect(result.kind).toBe("error");
  });

  it("leaves a static front page unaffected when show_on_front is not posts", async () => {
    const result = await loadDraftPageData({ buildId: "b1", path: "/visit-us" }, deps());
    expect(result.kind).toBe("page");
  });
});
