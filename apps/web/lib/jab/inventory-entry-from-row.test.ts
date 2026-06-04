import { describe, it, expect } from "vitest";
import {
  blockRowToEnrichedEntry,
  slugToScreenshotPathMap,
  type BlockInventoryRowForEntry,
} from "./inventory-entry-from-row";

function row(over: Partial<BlockInventoryRowForEntry> = {}): BlockInventoryRowForEntry {
  return {
    block_name: "core/cover",
    tier: "visual",
    kind: "block",
    spec: null,
    attr_samples: [{ url: "x" }],
    page_slugs: ["home", "about"],
    occurrence_count: 4,
    source_dom_sample: "<div>hi</div>",
    computed_styles: { viewports: { "1280": { fontSize: ["32px"] } } },
    ...over,
  };
}

describe("blockRowToEnrichedEntry", () => {
  it("maps a block row to the visual entry shape", () => {
    const e = blockRowToEnrichedEntry(row());
    expect(e).toMatchObject({
      blockName: "core/cover",
      tier: "visual",
      kind: "block",
      occurrenceCount: 4,
      pageSlugs: ["home", "about"],
      sourceDomSample: "<div>hi</div>",
    });
    expect(e.kind).toBe("block");
    if (e.kind === "block") expect(e.spec).toBeUndefined();
    expect(e.computedStyles).toEqual({ viewports: { "1280": { fontSize: ["32px"] } } });
  });

  it("converts the __null__ sentinel to a null blockName + passthrough defaults", () => {
    const e = blockRowToEnrichedEntry(row({ block_name: "__null__", tier: null, kind: null }));
    expect(e.blockName).toBeNull();
    expect(e.tier).toBe("passthrough");
    expect(e.kind).toBe("block");
  });

  it("normalizes a legacy array cpt_template spec to { blockNames, acfSchema }", () => {
    const e = blockRowToEnrichedEntry(
      row({ block_name: "cpt_template/beer", kind: "cpt_template", spec: ["core/paragraph", null] }),
    );
    expect(e.kind).toBe("cpt_template");
    if (e.kind === "cpt_template") {
      expect(e.spec).toEqual({ blockNames: ["core/paragraph", null], acfSchema: null });
    }
  });

  it("passes through an acf_flex spec object", () => {
    const e = blockRowToEnrichedEntry(
      row({ block_name: "acf_flex/p/b/hero", kind: "acf_flex", spec: { heading: "Hi" } }),
    );
    expect(e.kind).toBe("acf_flex");
    if (e.kind === "acf_flex") expect(e.spec).toEqual({ heading: "Hi" });
  });

  it("drops a malformed computed_styles blob to null", () => {
    const e = blockRowToEnrichedEntry(row({ computed_styles: { nope: 1 } }));
    expect(e.computedStyles).toBeNull();
  });

  it("passes through a current-format cpt_template spec { blockNames, acfSchema }", () => {
    const e = blockRowToEnrichedEntry(
      row({
        block_name: "cpt_template/beer",
        kind: "cpt_template",
        spec: { blockNames: ["core/paragraph", null], acfSchema: { properties: {} } },
      }),
    );
    expect(e.kind).toBe("cpt_template");
    if (e.kind === "cpt_template") {
      expect(e.spec).toEqual({ blockNames: ["core/paragraph", null], acfSchema: { properties: {} } });
    }
  });
});

describe("slugToScreenshotPathMap", () => {
  it("maps slug → 1280 source path, omitting pages without a 1280 capture", () => {
    const map = slugToScreenshotPathMap([
      { slug: "home", source_screenshot_paths: { source: { "1280": "p/home.png", "768": "p/home-m.png" } } },
      { slug: "about", source_screenshot_paths: { source: { "768": "p/about-m.png" } } },
      { slug: "contact", source_screenshot_paths: null },
    ]);
    expect(map).toEqual({ home: "p/home.png" });
  });

  it("omits a page whose source object exists but has no 1280 key", () => {
    const map = slugToScreenshotPathMap([
      { slug: "home", source_screenshot_paths: { source: { "768": "p/home-m.png" } } },
    ]);
    expect(map).toEqual({});
  });

  it("omits a page whose source_screenshot_paths has no source key", () => {
    const map = slugToScreenshotPathMap([
      { slug: "home", source_screenshot_paths: {} as { source?: Record<string, string> } },
    ]);
    expect(map).toEqual({});
  });
});
