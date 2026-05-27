import { describe, it, expect } from "vitest";
import type { InventoryEntry } from "./inventory";
import { MAX_PAGE_SLUGS_PER_BLOCK } from "./inventory";
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

  it("emits cpt_template entries for any CPT in the input (gating moved to collectCptTemplates)", () => {
    const cptData = [
      { cptSlug: "page", blockNameUnion: ["core/heading"], pageSlugs: ["about"] },
    ];
    const result = detectContentKinds([], [], cptData);
    expect(result).toHaveLength(1);
    expect(result[0].blockName).toBe("cpt_template/page");
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

  it("caps pageSlugs at MAX_PAGE_SLUGS_PER_BLOCK across many pages", () => {
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
    const pages: CollectablePage[] = Array.from({ length: 60 }, (_, i) => ({
      slug: `page-${i}`,
      post_type: "page",
      blocks: [],
      acf: { sections: [{ acf_fc_layout: "hero" }] },
      paradigms: ["acf_flex"],
    }));
    const result = collectAcfFlexLayouts(pages, cptAcfSchemas);
    expect(result).toHaveLength(1);
    expect(result[0].pageSlugs).toHaveLength(MAX_PAGE_SLUGS_PER_BLOCK);
  });
});

import { collectCptTemplates } from "./content-detection";

describe("collectCptTemplates", () => {
  it("returns [] when no pages have acf_template paradigm", () => {
    const pages: CollectablePage[] = [
      { slug: "ipa", post_type: "beer", blocks: [], paradigms: ["unknown"] as never[] },
    ];
    expect(collectCptTemplates(pages, new Map())).toEqual([]);
  });

  it("emits one entry per CPT with acf_template-bearing pages", () => {
    const pages: CollectablePage[] = [
      {
        slug: "ipa",
        post_type: "beer",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }],
        paradigms: ["acf_template", "gutenberg"],
      },
      {
        slug: "stout",
        post_type: "beer",
        blocks: [],
        paradigms: ["acf_template"],
      },
      {
        slug: "event-1",
        post_type: "event",
        blocks: [],
        paradigms: ["acf_template"],
      },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.cptSlug === "beer")?.pageSlugs.sort()).toEqual(["ipa", "stout"]);
    expect(result.find((r) => r.cptSlug === "event")?.pageSlugs).toEqual(["event-1"]);
  });

  it("INCLUDES page CPT when at least one page has acf_template paradigm", () => {
    const pages: CollectablePage[] = [
      { slug: "about", post_type: "page", blocks: [], paradigms: ["acf_template"] },
      { slug: "contact", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
    ];
    const result = collectCptTemplates(pages, new Map());
    const pageEntry = result.find((r) => r.cptSlug === "page");
    expect(pageEntry).toBeDefined();
    expect(pageEntry?.pageSlugs).toEqual(["about"]); // contact excluded — pure gutenberg
  });

  it("EXCLUDES page CPT when no page has acf_template", () => {
    const pages: CollectablePage[] = [
      { slug: "about", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
      { slug: "contact", post_type: "page", blocks: [], paradigms: ["gutenberg"] },
    ];
    expect(collectCptTemplates(pages, new Map())).toEqual([]);
  });

  it("blockNameUnion aggregates block names across acf_template pages of the same CPT", () => {
    const pages: CollectablePage[] = [
      {
        slug: "ipa",
        post_type: "beer",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }],
        paradigms: ["acf_template", "gutenberg"],
      },
      {
        slug: "stout",
        post_type: "beer",
        blocks: [
          { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
        ],
        paradigms: ["acf_template", "gutenberg"],
      },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result).toHaveLength(1);
    const beer = result[0];
    expect(beer.cptSlug).toBe("beer");
    expect(beer.blockNameUnion.sort()).toEqual(["core/heading", "core/paragraph"]);
  });

  it("blockNameUnion is empty for CPTs whose acf_template pages have no blocks", () => {
    const pages: CollectablePage[] = [
      { slug: "ipa", post_type: "beer", blocks: [], paradigms: ["acf_template"] },
    ];
    const result = collectCptTemplates(pages, new Map());
    expect(result[0].blockNameUnion).toEqual([]);
  });

  it("caps pageSlugs at MAX_PAGE_SLUGS_PER_BLOCK across many pages", () => {
    const pages: CollectablePage[] = Array.from({ length: 60 }, (_, i) => ({
      slug: `beer-${i}`,
      post_type: "beer",
      blocks: [],
      paradigms: ["acf_template"],
    }));
    const result = collectCptTemplates(pages, new Map());
    expect(result).toHaveLength(1);
    expect(result[0].pageSlugs).toHaveLength(MAX_PAGE_SLUGS_PER_BLOCK);
  });
});
