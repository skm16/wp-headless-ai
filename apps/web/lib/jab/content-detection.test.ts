import { describe, it, expect } from "vitest";
import type { InventoryEntry } from "./inventory";
import { detectContentKinds } from "./content-detection";

const baseEntry = (blockName: string, overrides?: Partial<InventoryEntry>): InventoryEntry => ({
  blockName,
  occurrenceCount: 5,
  pageSlugs: ["home", "about"],
  attrSamples: [],
  tier: "visual",
  ...overrides,
});

describe("detectContentKinds", () => {
  it("passes through core/* entries unchanged", () => {
    const entries = [baseEntry("core/heading", { tier: "trivial" })];
    const result = detectContentKinds(entries, []);
    expect(result[0].kind).toBe("block");
    expect(result[0].spec).toBeUndefined();
  });

  it("marks acf/* entries as block kind", () => {
    const entries = [baseEntry("acf/hero")];
    const result = detectContentKinds(entries, []);
    expect(result[0].kind).toBe("block");
  });

  it("detects acf_flex entries from raw flex data", () => {
    const flexData = [
      {
        cptSlug: "page",
        fieldPath: "sections",
        layoutName: "hero_section",
        attrSample: { layout: "hero_section", image: { url: "..." } },
        pageSlugs: ["home"],
      },
    ];
    const result = detectContentKinds([], flexData);
    expect(result).toHaveLength(1);
    expect(result[0].blockName).toBe("acf_flex/page/sections/hero_section");
    expect(result[0].kind).toBe("acf_flex");
    expect(result[0].tier).toBe("visual");
  });

  it("detects cpt_template entries for non-page CPTs", () => {
    const cptData = [
      { cptSlug: "beer", blockNameUnion: ["acf/beer-card", "core/heading"], pageSlugs: ["ipa-classic"] },
    ];
    const result = detectContentKinds([], [], cptData);
    expect(result).toHaveLength(1);
    expect(result[0].blockName).toBe("cpt_template/beer");
    expect(result[0].kind).toBe("cpt_template");
  });

  it("hard-excludes page CPT from cpt_template", () => {
    const cptData = [
      { cptSlug: "page", blockNameUnion: ["core/heading"], pageSlugs: ["about"] },
    ];
    const result = detectContentKinds([], [], cptData);
    expect(result).toHaveLength(0);
  });
});
