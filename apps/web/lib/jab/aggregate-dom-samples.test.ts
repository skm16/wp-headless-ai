import { describe, it, expect } from "vitest";
import { aggregateDomSamples, type PageAcfData } from "./aggregate-dom-samples";
import type { EnrichedInventoryEntry } from "./content-detection";
import type { PageDiscoveryResult, PageDomSnapshot } from "./discovery-types";

/**
 * Helper — build a PageDiscoveryResult with a populated domSnapshot.
 * Reduces test noise; the un-tested fields stay defaulted.
 */
function makeResult(slug: string, post_type: string, snapshot: PageDomSnapshot): PageDiscoveryResult {
  return {
    slug,
    post_type,
    screenshotPaths: {},
    blockCapturesByViewport: {},
    domSnapshot: snapshot,
  };
}

function makeBlockEntry(blockName: string | null, pageSlugs: string[]): EnrichedInventoryEntry {
  return {
    blockName,
    occurrenceCount: pageSlugs.length,
    pageSlugs,
    attrSamples: [],
    tier: "trivial",
    kind: "block",
  };
}

function makeAcfFlexEntry(blockName: string, pageSlugs: string[]): EnrichedInventoryEntry {
  return {
    blockName,
    occurrenceCount: pageSlugs.length,
    pageSlugs,
    attrSamples: [],
    tier: "visual",
    kind: "acf_flex",
    spec: {},
  };
}

function makeCptTemplateEntry(blockName: string, pageSlugs: string[]): EnrichedInventoryEntry {
  return {
    blockName,
    occurrenceCount: pageSlugs.length,
    pageSlugs,
    attrSamples: [],
    tier: "standard",
    kind: "cpt_template",
    spec: { blockNames: [], acfSchema: null },
  };
}

describe("aggregateDomSamples — block (Gutenberg) correlation", () => {
  it("finds a sample via wpBlockSamples by parsed block name", () => {
    const inventory = [makeBlockEntry("core/paragraph", ["home"])];
    const pageAcfData: PageAcfData[] = [{ slug: "home", post_type: "page" }];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [{ blockName: "core/paragraph", outerHTML: "<p>Hello</p>" }],
        mainSections: [],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("core/paragraph")).toBe("<p>Hello</p>");
  });

  it("returns null when no page contains the block in wpBlockSamples", () => {
    const inventory = [makeBlockEntry("core/heading", ["home"])];
    const pageAcfData: PageAcfData[] = [{ slug: "home", post_type: "page" }];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [{ blockName: "core/paragraph", outerHTML: "<p>Hello</p>" }],
        mainSections: [],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("core/heading")).toBeNull();
  });

  it("returns null for the null-blockName sentinel (classic-editor content)", () => {
    const inventory = [makeBlockEntry(null, ["home"])];
    const pageAcfData: PageAcfData[] = [{ slug: "home", post_type: "page" }];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [{ blockName: "core/paragraph", outerHTML: "<p>x</p>" }],
        mainSections: [],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("__null__")).toBeNull();
  });

  it("falls back to second page when first page has no sample", () => {
    const inventory = [makeBlockEntry("core/heading", ["page-a", "page-b"])];
    const pageAcfData: PageAcfData[] = [
      { slug: "page-a", post_type: "page" },
      { slug: "page-b", post_type: "page" },
    ];
    const results = [
      makeResult("page-a", "page", { wpBlockSamples: [], mainSections: [], articleOuterHtml: null }),
      makeResult("page-b", "page", {
        wpBlockSamples: [{ blockName: "core/heading", outerHTML: "<h1>Found</h1>" }],
        mainSections: [],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("core/heading")).toBe("<h1>Found</h1>");
  });
});

describe("aggregateDomSamples — acf_flex positional correlation", () => {
  it("matches a flex layout to the Nth main section via index in record.acf.{field}", () => {
    const inventory = [makeAcfFlexEntry("acf_flex/page/page_builder/large_hero", ["home"])];
    const pageAcfData: PageAcfData[] = [
      {
        slug: "home",
        post_type: "page",
        acf: {
          page_builder: [
            { acf_fc_layout: "hero_strip" },
            { acf_fc_layout: "large_hero", title: "Welcome" }, // index 1
            { acf_fc_layout: "newsletter" },
          ],
        },
      },
    ];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [],
        mainSections: [
          { index: 0, outerHTML: "<section>0</section>", classNames: [] },
          { index: 1, outerHTML: "<section class='hero'>Welcome</section>", classNames: ["hero"] },
          { index: 2, outerHTML: "<section>2</section>", classNames: [] },
        ],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("acf_flex/page/page_builder/large_hero")).toBe(
      "<section class='hero'>Welcome</section>",
    );
  });

  it("returns null when the layout's index falls outside captured mainSections", () => {
    const inventory = [makeAcfFlexEntry("acf_flex/page/page_builder/footer_cta", ["home"])];
    const pageAcfData: PageAcfData[] = [
      {
        slug: "home",
        post_type: "page",
        acf: {
          page_builder: [
            { acf_fc_layout: "hero" },
            { acf_fc_layout: "hero" },
            { acf_fc_layout: "hero" },
            { acf_fc_layout: "footer_cta" }, // index 3
          ],
        },
      },
    ];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [],
        mainSections: [
          { index: 0, outerHTML: "<section>0</section>", classNames: [] },
          { index: 1, outerHTML: "<section>1</section>", classNames: [] },
        ], // only 2 sections captured — footer_cta at index 3 is out of range
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("acf_flex/page/page_builder/footer_cta")).toBeNull();
  });

  it("tries the next page of the same CPT when first page lacks the layout", () => {
    const inventory = [makeAcfFlexEntry("acf_flex/page/page_builder/large_hero", ["a", "b"])];
    const pageAcfData: PageAcfData[] = [
      { slug: "a", post_type: "page", acf: { page_builder: [{ acf_fc_layout: "other" }] } },
      {
        slug: "b",
        post_type: "page",
        acf: { page_builder: [{ acf_fc_layout: "large_hero", x: 1 }] },
      },
    ];
    const results = [
      makeResult("a", "page", {
        wpBlockSamples: [],
        mainSections: [{ index: 0, outerHTML: "<section>other</section>", classNames: [] }],
        articleOuterHtml: null,
      }),
      makeResult("b", "page", {
        wpBlockSamples: [],
        mainSections: [{ index: 0, outerHTML: "<section>hero</section>", classNames: [] }],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("acf_flex/page/page_builder/large_hero")).toBe("<section>hero</section>");
  });

  it("returns null when no page has the layout at all", () => {
    const inventory = [makeAcfFlexEntry("acf_flex/page/page_builder/missing", ["home"])];
    const pageAcfData: PageAcfData[] = [
      { slug: "home", post_type: "page", acf: { page_builder: [{ acf_fc_layout: "other" }] } },
    ];
    const results = [
      makeResult("home", "page", {
        wpBlockSamples: [],
        mainSections: [{ index: 0, outerHTML: "<section>other</section>", classNames: [] }],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("acf_flex/page/page_builder/missing")).toBeNull();
  });
});

describe("aggregateDomSamples — cpt_template correlation", () => {
  it("prefers articleOuterHtml when available", () => {
    const inventory = [makeCptTemplateEntry("cpt_template/beer", ["ipa"])];
    const pageAcfData: PageAcfData[] = [{ slug: "ipa", post_type: "beer" }];
    const results = [
      makeResult("ipa", "beer", {
        wpBlockSamples: [],
        mainSections: [{ index: 0, outerHTML: "<section>section</section>", classNames: [] }],
        articleOuterHtml: "<article>Beer page</article>",
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("cpt_template/beer")).toBe("<article>Beer page</article>");
  });

  it("falls back to joined mainSections when articleOuterHtml is null", () => {
    const inventory = [makeCptTemplateEntry("cpt_template/beer", ["ipa"])];
    const pageAcfData: PageAcfData[] = [{ slug: "ipa", post_type: "beer" }];
    const results = [
      makeResult("ipa", "beer", {
        wpBlockSamples: [],
        mainSections: [
          { index: 0, outerHTML: "<section>A</section>", classNames: [] },
          { index: 1, outerHTML: "<section>B</section>", classNames: [] },
        ],
        articleOuterHtml: null,
      }),
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("cpt_template/beer")).toBe("<section>A</section>\n<section>B</section>");
  });

  it("returns null when no page of that CPT has a snapshot", () => {
    const inventory = [makeCptTemplateEntry("cpt_template/beer", ["ipa"])];
    const pageAcfData: PageAcfData[] = [{ slug: "ipa", post_type: "beer" }];
    const results: PageDiscoveryResult[] = [
      {
        slug: "ipa",
        post_type: "beer",
        screenshotPaths: {},
        blockCapturesByViewport: {},
        // no domSnapshot
      },
    ];

    const out = aggregateDomSamples(inventory, pageAcfData, results);
    expect(out.get("cpt_template/beer")).toBeNull();
  });
});
