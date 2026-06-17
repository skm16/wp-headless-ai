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
  it("synthesizes a single Classic body node under the __null__ sentinel from content.rendered", () => {
    const out = composeBlockTree({ content: { rendered: "<p>Body</p>" } }, "post", ["classic"]);
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("__null__");
    expect(out[0].innerHTML).toBe("<p>Body</p>");
    expect(out[0]._key).toBe("classic-0");
  });

  it("synthesizes the Classic body under the __null__ sentinel", () => {
    const record = { content: { rendered: "<p>hi</p>" }, blocks: [] } as BlockTreeRecord;
    const out = composeBlockTree(record, "page", ["classic"], { acfFlexFields: {} });
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("__null__");
    expect(out[0].innerHTML).toContain("<p>hi</p>");
  });

  it("returns empty when content.rendered is missing", () => {
    expect(composeBlockTree({}, "post", ["classic"])).toEqual([]);
  });
});

describe("composeBlockTree — combined paradigms", () => {
  it("concatenates non-suppressing paradigms (acf_template frame + gutenberg body) in order", () => {
    const record: BlockTreeRecord = {
      acf: { hero_headline: "Hi" },
      blocks: [{ blockName: "core/paragraph", attrs: {}, innerHTML: "", innerBlocks: [] }],
    };
    const out = composeBlockTree(record, "page", ["acf_template", "gutenberg"]);
    expect(out).toHaveLength(2);
    expect(out[0].blockName).toBe("cpt_template/page");
    expect(out[1].blockName).toBe("core/paragraph");
  });

  // Defense-in-depth for the front-page-boilerplate bug: an acf_flex page
  // builder IS the whole page, so the_content paradigms (gutenberg + classic)
  // must not also render — even if a stale persisted paradigms array (e.g. one
  // carried forward by an incremental skip-unchanged build, predating the
  // detectParadigms fix) still lists them. The runtime tree-walker enforces the
  // invariant as the last line of defense before the deployed site renders.
  it("acf_flex page builder suppresses gutenberg AND acf_template (page builder is the whole page)", () => {
    // acf_template alongside acf_flex synths a redundant cpt_template/<cpt>
    // wrapper that the LLM renders as a stray (often empty) block below the
    // real layout. A flex page builder is the complete page, so only its
    // layouts render.
    const record: BlockTreeRecord = {
      acf: { page_builder: [{ acf_fc_layout: "hero" }] },
      blocks: [{ blockName: "core/paragraph", attrs: {}, innerHTML: "<p>leftover sample page</p>", innerBlocks: [] }],
    };
    const out = composeBlockTree(record, "page", ["acf_flex", "acf_template", "gutenberg"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/hero");
  });

  it("acf_flex page builder suppresses classic in the paradigms array", () => {
    const record: BlockTreeRecord = {
      acf: { page_builder: [{ acf_fc_layout: "hero" }] },
      content: { rendered: "<p>leftover sample page</p>" },
    };
    const out = composeBlockTree(record, "page", ["acf_flex", "classic"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/hero");
  });
});

describe("composeBlockTree — unknown paradigm", () => {
  it("returns empty", () => {
    expect(composeBlockTree({}, "post", ["unknown"])).toEqual([]);
  });
});
