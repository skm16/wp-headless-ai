import { describe, it, expect } from "vitest";
import { aggregateComputedStyles } from "./aggregate-computed-styles";
import type { PageDiscoveryResult } from "./discovery-types";

describe("aggregateComputedStyles", () => {
  it("aggregates per-block-name per-viewport medians", () => {
    const pages: PageDiscoveryResult[] = [
      {
        slug: "home",
        post_type: "page",
        screenshotPaths: {},
        blockCapturesByViewport: {
          "1280": [
            { blockName: "core/heading", boundingRect: { x: 0, y: 0, width: 100, height: 50 }, computedStyles: { fontSize: "32px", color: "rgb(0,0,0)" } },
            { blockName: "core/heading", boundingRect: { x: 0, y: 80, width: 100, height: 60 }, computedStyles: { fontSize: "28px", color: "rgb(0,0,0)" } },
          ],
        },
      },
    ];
    const out = aggregateComputedStyles(pages);
    const heading = out["core/heading"];
    expect(heading).toBeDefined();
    expect(heading.viewports["1280"].fontSize).toEqual(expect.arrayContaining(["32px", "28px"]));
    expect(heading.viewports["1280"].color).toEqual(["rgb(0,0,0)"]);
  });

  it("returns empty object when no instances captured", () => {
    expect(aggregateComputedStyles([])).toEqual({});
  });
});
