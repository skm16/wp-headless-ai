import { describe, it, expect } from "vitest";
import { isDataRelevantEdit } from "./patch-data-relevance";

describe("isDataRelevantEdit", () => {
  it("returns false for category=none regardless of guidance", () => {
    expect(isDataRelevantEdit("show the description", "none")).toBe(false);
    expect(isDataRelevantEdit("make it bigger", "none")).toBe(false);
  });

  // ── FALSE-NEGATIVE repros from the adversarial review — these MUST attach now ──
  it("attaches for a data edit that also contains a style verb", () => {
    // 'bigger'/'center'/'align' must NOT suppress a genuine data edit.
    expect(isDataRelevantEdit("make the ABV bigger", "relation")).toBe(true);
    expect(isDataRelevantEdit("center the tasting notes", "relation")).toBe(true);
    expect(isDataRelevantEdit("align the ABV to the right", "relation")).toBe(true);
    expect(isDataRelevantEdit("put the IBU in a rounded badge", "relation")).toBe(true);
  });

  it("attaches for a data edit whose field name collides with a style-word substring", () => {
    // 'color' is a real field on many CPTs; word-boundary must not treat it as cosmetic-only.
    expect(isDataRelevantEdit("show beer color", "relation")).toBe(true);
    expect(isDataRelevantEdit("render the beer's color and clarity", "relation")).toBe(true);
    expect(isDataRelevantEdit("surface the discoloration warning", "direct-cpt")).toBe(true);
  });

  it("attaches for neutral non-cosmetic edits on a data-bearing block", () => {
    expect(isDataRelevantEdit("make each card show more info", "relation")).toBe(true);
    expect(isDataRelevantEdit("add a bigger hover box with the rating", "relation")).toBe(true);
  });

  // ── Clear-cosmetic edits that should STILL skip (no field-ish token, pure styling) ──
  it("skips a clearly-cosmetic edit that names no field", () => {
    expect(isDataRelevantEdit("make the heading bigger", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("change the background to teal", "direct-acf")).toBe(false);
    expect(isDataRelevantEdit("bolder", "direct-cpt")).toBe(false);
    expect(isDataRelevantEdit("increase the padding", "relation")).toBe(false);
    expect(isDataRelevantEdit("round the corners", "relation")).toBe(false);
  });

  // ── Substring false-positives from the review — must NOT trip on these ──
  it("does not trip on style words that merely contain a data-keyword substring", () => {
    expect(isDataRelevantEdit("update the layout spacing", "direct-cpt")).toBe(false); // 'date' ∈ 'update'
    expect(isDataRelevantEdit("make the texture lighter", "direct-acf")).toBe(false);  // 'text' ∈ 'texture'
  });

  it("is case-insensitive", () => {
    expect(isDataRelevantEdit("Show The Description", "direct-acf")).toBe(true);
  });
});
