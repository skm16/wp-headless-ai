import { describe, it, expect } from "vitest";
import { isDataRelevantEdit } from "./patch-data-relevance";

describe("isDataRelevantEdit", () => {
  it("returns true when the guidance names a data verb/noun", () => {
    expect(isDataRelevantEdit("show the beer description on hover", "relation")).toBe(true);
    expect(isDataRelevantEdit("add the ABV field", "direct-acf")).toBe(true);
    expect(isDataRelevantEdit("pull the event date", "direct-cpt")).toBe(true);
  });

  it("returns false for a pure cosmetic edit even on a data-bearing block", () => {
    expect(isDataRelevantEdit("make the heading bigger", "relation")).toBe(false);
    expect(isDataRelevantEdit("change the background to teal", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("bolder", "direct-cpt")).toBe(false);
  });

  it("returns false for any edit on a category='none' block", () => {
    expect(isDataRelevantEdit("show the description", "none")).toBe(false);
  });

  it("returns true for a non-trivial edit on a data-bearing block even without a data keyword", () => {
    // A data-bearing block + a non-style instruction → attach (bias to false-positive).
    expect(isDataRelevantEdit("make each card show more info", "relation")).toBe(true);
  });

  it("is case-insensitive on keywords", () => {
    expect(isDataRelevantEdit("Show The Description", "direct-acf")).toBe(true);
  });
});
