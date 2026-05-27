import { describe, it, expect } from "vitest";
import type { InventoryEntry } from "./inventory";
import { detectContentKinds } from "./content-detection";
import { collectAcfFlexLayouts, type CollectablePage } from "./content-detection";

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

const makeAcfFlexPage = (
  slug: string,
  postType: string,
  fieldName: string,
  layouts: Array<Record<string, unknown>>,
): CollectablePage => ({
  slug,
  post_type: postType,
  blocks: [],
  acf: { [fieldName]: layouts },
  paradigms: ["acf_flex"],
});

describe("collectAcfFlexLayouts", () => {
  it("returns [] when no pages have ACF flex content", () => {
    const result = collectAcfFlexLayouts([], new Map());
    expect(result).toEqual([]);
  });

  it("groups same (cpt,field,layout) across multiple pages", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      makeAcfFlexPage("home", "page", "sections", [{ acf_fc_layout: "hero", heading: "A" }]),
      makeAcfFlexPage("about", "page", "sections", [{ acf_fc_layout: "hero", heading: "B" }]),
    ];

    const result = collectAcfFlexLayouts(pages, cptAcfSchemas);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      cptSlug: "page",
      fieldPath: "sections",
      layoutName: "hero",
      attrSample: { acf_fc_layout: "hero", heading: "A" },
      pageSlugs: ["home", "about"],
    });
  });

  it("separates distinct layout names within the same field", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            oneOf: [
              { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
              { type: "object", properties: { acf_fc_layout: { enum: ["cta"] } } },
            ],
          },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      {
        slug: "home",
        post_type: "page",
        blocks: [],
        acf: {
          sections: [
            { acf_fc_layout: "hero", heading: "Welcome" },
            { acf_fc_layout: "cta", label: "Buy" },
          ],
        },
        paradigms: ["acf_flex"],
      },
    ];

    const result = collectAcfFlexLayouts(pages, cptAcfSchemas);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.layoutName).sort()).toEqual(["cta", "hero"]);
  });

  it("ignores layouts not declared in the manifest schema", () => {
    const flexSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    const cptAcfSchemas = new Map<string, Record<string, unknown>>([["page", flexSchema]]);

    const pages: CollectablePage[] = [
      {
        slug: "home",
        post_type: "page",
        blocks: [],
        acf: { sections: [{ acf_fc_layout: "spooky_unknown_layout" }] },
        paradigms: ["acf_flex"],
      },
    ];

    expect(collectAcfFlexLayouts(pages, cptAcfSchemas)).toEqual([]);
  });

  it("ignores pages whose CPT has no ACF schema in the manifest", () => {
    const pages: CollectablePage[] = [
      makeAcfFlexPage("ipa", "beer", "sections", [{ acf_fc_layout: "hero" }]),
    ];
    expect(collectAcfFlexLayouts(pages, new Map())).toEqual([]);
  });
});
