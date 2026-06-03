import { describe, it, expect } from "vitest";
import { toPriorPages } from "./load-prior-build";

describe("toPriorPages", () => {
  it("maps page_inventory rows to PriorPage", () => {
    expect(
      toPriorPages([{ slug: "home", post_type: "page", source_modified_gmt: "2026-06-01T00:00:00Z" }]),
    ).toEqual([{ slug: "home", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" }]);
  });
  it("preserves nulls", () => {
    expect(toPriorPages([{ slug: "a", post_type: "page", source_modified_gmt: null }])).toEqual([
      { slug: "a", postType: "page", modifiedGmt: null },
    ]);
  });
});
