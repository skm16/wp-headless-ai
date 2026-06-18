import { describe, it, expect } from "vitest";
import { resolveDraftRoute, type DraftPageRow } from "./route-resolve";
import type { ManifestShape } from "@/lib/jab/ability-meta";
import { BLOG_INDEX_POST_TYPE } from "@/lib/jab/homepage-emit";

const MANIFEST: ManifestShape = {
  abilities: [
    { name: "jab/get-page-by-slug" },
    { name: "jab/get-beer-by-slug" },
  ],
};

const PAGES: DraftPageRow[] = [
  { slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] },
  { slug: "visit-us", post_type: "page", route_path: "visit-us", paradigms: ["gutenberg"] },
  { slug: "rocket", post_type: "beer", route_path: "beer/rocket", paradigms: ["acf_template"] },
];

describe("resolveDraftRoute", () => {
  it("resolves '/' to the front-page row", () => {
    const r = resolveDraftRoute("/", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({
      kind: "page",
      target: { slug: "home", postType: "page", abilityName: "jab/get-page-by-slug" },
    });
  });

  it("resolves an exact mapped route (leading-slash tolerant both sides)", () => {
    const r = resolveDraftRoute("/visit-us", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({ kind: "page", target: { slug: "visit-us", postType: "page" } });
  });

  it("308s the front-page slug to '/' (single segment only — mirrors emitted catch-all)", () => {
    expect(resolveDraftRoute("/home", PAGES, MANIFEST, "home")).toEqual({ kind: "redirect", to: "/" });
  });

  it("falls back to the post-type registry for unmapped multi-segment paths (leaf slug)", () => {
    const r = resolveDraftRoute("/beer/lil-heaven", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({
      kind: "page",
      target: { slug: "lil-heaven", postType: "beer", abilityName: "jab/get-beer-by-slug" },
    });
  });

  it("falls back to the 'page' post type for unmapped single-segment paths", () => {
    const r = resolveDraftRoute("/totally-new-page", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({ kind: "page", target: { slug: "totally-new-page", postType: "page" } });
  });

  it("is not_found when no registry entry covers the path prefix", () => {
    expect(resolveDraftRoute("/gear/hat", PAGES, MANIFEST, "home")).toEqual({ kind: "not_found" });
  });

  it("is not_found for '/' when no front page exists at all", () => {
    const noFront = PAGES.filter((p) => p.route_path !== "/");
    expect(resolveDraftRoute("/", noFront, MANIFEST, null)).toEqual({ kind: "not_found" });
  });
});

describe("resolveDraftRoute — posts-front blog index", () => {
  // A manifest exposing the posts LIST ability (jab/get-posts) whose output
  // wraps the array under "posts".
  const POSTS_MANIFEST = {
    abilities: [
      { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
      { name: "jab/get-post-by-slug" },
    ],
  };

  it("resolves '/' to a blogIndex target when show_on_front is posts", () => {
    const r = resolveDraftRoute("/", [], POSTS_MANIFEST, null, "posts");
    expect(r).toEqual({
      kind: "blogIndex",
      listAbility: "jab/get-posts",
      wrapperKey: "posts",
      postType: BLOG_INDEX_POST_TYPE,
    });
  });

  it("still resolves a static front page when show_on_front is not posts", () => {
    const pages = [{ slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] }];
    const manifest = { abilities: [{ name: "jab/get-page-by-slug" }] };
    const r = resolveDraftRoute("/", pages, manifest, "home", "page");
    expect(r).toMatchObject({ kind: "page", target: { slug: "home", postType: "page" } });
  });

  it("is a LOUD typed error (not not_found) for posts-front '/' when no posts list ability is registered — mirrors the deployed throw", () => {
    const r = resolveDraftRoute("/", [], { abilities: [] }, null, "posts");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("posts list ability");
      // the published build FAILS — it must not be described as a 404
      expect(r.message).not.toContain("404");
    }
  });

  it("defaults to the existing behavior when showOnFront is omitted (back-compat)", () => {
    // No front row, null slug, no showOnFront → not_found (the encoded behavior).
    expect(resolveDraftRoute("/", [], { abilities: [] }, null)).toEqual({ kind: "not_found" });
  });
});
