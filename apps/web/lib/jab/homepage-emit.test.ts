import { describe, it, expect } from "vitest";
import { resolveHomepageEmit, type HomepagePageRow } from "@/lib/jab/homepage-emit";
import type { ManifestShape } from "@/lib/jab/ability-meta";

const manifest: ManifestShape = {
  abilities: [
    { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
    { name: "jab/get-page-by-slug", outputSchema: { required: ["page"] } },
  ],
};
const homeRow: HomepagePageRow = { slug: "home", post_type: "page", route_path: "/home", paradigms: ["gutenberg"] };

describe("resolveHomepageEmit", () => {
  it("returns a blogIndex decision for show_on_front='posts'", () => {
    const d = resolveHomepageEmit({ mode: "full", show_on_front: "posts" }, [], manifest);
    expect(d).toEqual({
      kind: "blogIndex",
      listAbility: "jab/get-posts",
      wrapperKey: "posts",
      postType: "post",
      frontPageSlug: null,
      sitemapExtraRoutes: ["/"],
    });
  });

  it("hard-fails when the posts list ability is missing", () => {
    expect(() => resolveHomepageEmit({ mode: "full", show_on_front: "posts" }, [], { abilities: [] })).toThrow(
      /requires a posts list ability/,
    );
  });

  it("returns a static decision when front_page_slug matches a page row", () => {
    const d = resolveHomepageEmit({ mode: "full", show_on_front: "page", front_page_slug: "home" }, [homeRow], manifest);
    expect(d).toEqual({
      kind: "static",
      frontPageSlug: "home",
      postType: "page",
      paradigms: ["gutenberg"],
      ability: { abilityName: "jab/get-page-by-slug", wrapperKey: "page" },
      sitemapExtraRoutes: [],
    });
  });

  it("treats missing show_on_front as the static path (back-compat)", () => {
    const d = resolveHomepageEmit({ front_page_slug: "home" }, [homeRow], manifest);
    expect(d.kind).toBe("static");
  });

  it("hard-fails with the configured-but-missing message", () => {
    expect(() => resolveHomepageEmit({ front_page_slug: "nope" }, [homeRow], manifest)).toThrow(
      /no matching page in page_inventory/,
    );
  });

  it("hard-fails with the no-front-page message when nothing resolves", () => {
    expect(() => resolveHomepageEmit({}, [], manifest)).toThrow(/no static front-page configured/);
  });
});
