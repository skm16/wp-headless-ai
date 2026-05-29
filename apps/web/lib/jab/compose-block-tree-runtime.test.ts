import { describe, it, expect } from "vitest";
import { composeBlockTree, type BlockTreeRecord } from "./compose-block-tree-runtime";

describe("composeBlockTree — gutenberg paradigm", () => {
  it("returns record.blocks tagged with index-path _key", () => {
    const record: BlockTreeRecord = {
      blocks: [
        { blockName: "core/heading", attrs: { level: 1 }, innerBlocks: [], innerHTML: "" },
        { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "" },
      ],
    };
    const out = composeBlockTree(record, "page", ["gutenberg"]);
    expect(out).toHaveLength(2);
    expect(out[0]._key).toBe("0");
    expect(out[1]._key).toBe("1");
  });

  it("tags nested innerBlocks with dot-path _keys", () => {
    const record: BlockTreeRecord = {
      blocks: [
        {
          blockName: "core/group",
          attrs: {},
          innerHTML: "",
          innerBlocks: [
            { blockName: "core/heading", attrs: {}, innerHTML: "", innerBlocks: [] },
            { blockName: "core/paragraph", attrs: {}, innerHTML: "", innerBlocks: [] },
          ],
        },
      ],
    };
    const out = composeBlockTree(record, "page", ["gutenberg"]);
    expect(out[0].innerBlocks?.[0]._key).toBe("0.0");
    expect(out[0].innerBlocks?.[1]._key).toBe("0.1");
  });
});

describe("composeBlockTree — acf_flex paradigm", () => {
  it("synthesizes one node per flex item with block_name acf_flex/<cpt>/<field>/<layout>", () => {
    const record: BlockTreeRecord = {
      acf: {
        page_builder: [
          { acf_fc_layout: "large_hero", title: "Welcome" },
          { acf_fc_layout: "newsletter" },
        ],
      },
    };
    const out = composeBlockTree(record, "page", ["acf_flex"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(2);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/large_hero");
    expect(out[0]._key).toBe("flex-0");
  });

  it("returns empty when acf field is absent or empty", () => {
    const out = composeBlockTree({ acf: { page_builder: [] } }, "page", ["acf_flex"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toEqual([]);
  });
});

describe("composeBlockTree — acf_template paradigm", () => {
  it("synthesizes a single cpt_template wrapper", () => {
    const record: BlockTreeRecord = { id: 123 };
    const out = composeBlockTree(record, "page", ["acf_template"]);
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("cpt_template/page");
    expect(out[0]._key).toBe("template-0");
  });

  it("flattens ACF fields into attrs for generated template components", () => {
    const record: BlockTreeRecord = {
      id: 123,
      slug: "home",
      title: { rendered: "Home" },
      content: { rendered: "<p>Fallback body</p>" },
      acf: {
        hero_headline: "Take the road less traveled",
        hero_background_image: "https://example.com/hero.jpg",
      },
    };
    const [template] = composeBlockTree(record, "page", ["acf_template"]);

    expect(template.attrs.hero_headline).toBe("Take the road less traveled");
    expect(template.attrs.hero_background_image).toBe("https://example.com/hero.jpg");
    expect(template.attrs.title).toBe("Home");
    expect(template.attrs.id).toBe(123);
    expect(template.attrs.rawRecord).toBe(record);
  });
});

describe("composeBlockTree — classic paradigm", () => {
  it("synthesizes a single null-blockName node from content.rendered", () => {
    const out = composeBlockTree({ content: { rendered: "<p>Body</p>" } }, "post", ["classic"]);
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBeNull();
    expect(out[0].innerHTML).toBe("<p>Body</p>");
    expect(out[0]._key).toBe("classic-0");
  });

  it("returns empty when content.rendered is missing", () => {
    expect(composeBlockTree({}, "post", ["classic"])).toEqual([]);
  });
});

describe("composeBlockTree — combined paradigms", () => {
  it("concatenates outputs in paradigm-order", () => {
    const record: BlockTreeRecord = {
      acf: { page_builder: [{ acf_fc_layout: "hero" }] },
      blocks: [{ blockName: "core/paragraph", attrs: {}, innerHTML: "", innerBlocks: [] }],
    };
    const out = composeBlockTree(record, "page", ["acf_flex", "acf_template", "gutenberg"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(3);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/hero");
    expect(out[1].blockName).toBe("cpt_template/page");
    expect(out[2].blockName).toBe("core/paragraph");
  });
});

describe("composeBlockTree — unknown paradigm", () => {
  it("returns empty", () => {
    expect(composeBlockTree({}, "post", ["unknown"])).toEqual([]);
  });
});
