import { describe, it, expect } from "vitest";
import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "./ability-meta";

function manifestWith(names: string[]): ManifestShape {
  return { abilities: names.map((name) => ({ name })) };
}

describe("abilityMetaFor", () => {
  it("resolves the singular by-slug ability", () => {
    const meta = abilityMetaFor("beer", manifestWith(["jab/get-beer-by-slug"]));
    expect(meta?.abilityName).toBe("jab/get-beer-by-slug");
  });

  it("falls back to the pluralized form", () => {
    const meta = abilityMetaFor("event", manifestWith(["jab/get-events-by-slug"]));
    expect(meta?.abilityName).toBe("jab/get-events-by-slug");
  });

  it("returns null when no by-slug ability is registered", () => {
    expect(abilityMetaFor("popup_theme", manifestWith(["jab/get-pages"]))).toBeNull();
  });

  it("derives wrapperKey from post type when the ability has no schema hint", () => {
    const meta = abilityMetaFor("case-study", manifestWith(["jab/get-case-study-by-slug"]));
    expect(meta?.wrapperKey).toBe("case_study");
  });
});

const listManifest: ManifestShape = {
  abilities: [
    { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
    { name: "jab/get-post-by-slug", outputSchema: { required: ["post"] } },
    { name: "jab/get-food-truck-events", outputSchema: { required: ["food_truck_events"] } },
  ],
};

describe("listAbilityMetaFor", () => {
  it("resolves the built-in posts list ability + wrapper from the schema", () => {
    expect(listAbilityMetaFor("post", listManifest)).toEqual({
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
    });
  });

  it("resolves a kebab CPT by pluralizing the post type", () => {
    expect(listAbilityMetaFor("food-truck-event", listManifest)).toEqual({
      abilityName: "jab/get-food-truck-events",
      wrapperKey: "food_truck_events",
    });
  });

  it("falls back to the snake-cased plural wrapper when no output schema is present", () => {
    const m: ManifestShape = { abilities: [{ name: "jab/get-posts" }] };
    expect(listAbilityMetaFor("post", m)).toEqual({
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
    });
  });

  it("returns null when no matching list ability is registered", () => {
    expect(listAbilityMetaFor("post", { abilities: [] })).toBeNull();
  });

  it("does not match a by-slug ability as a list ability", () => {
    const m: ManifestShape = { abilities: [{ name: "jab/get-post-by-slug", outputSchema: { required: ["post"] } }] };
    expect(listAbilityMetaFor("post", m)).toBeNull();
  });
});
