import { describe, it, expect } from "vitest";
import { resolveDraftRoute, type DraftPageRow } from "./route-resolve";
import type { ManifestShape } from "@/lib/jab/ability-meta";

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
