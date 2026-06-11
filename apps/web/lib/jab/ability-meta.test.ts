import { describe, it, expect } from "vitest";
import { abilityMetaFor, type ManifestShape } from "./ability-meta";

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
