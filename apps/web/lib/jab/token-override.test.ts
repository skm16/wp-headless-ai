import { describe, it, expect } from "vitest";
import {
  mergeTokenDeltas,
  applyTokenOverride,
  isEmptyTokenDelta,
  validateTokenDelta,
  type TokenDelta,
} from "./token-override";
import type { ThemeJsonTokens } from "./global-styles";

describe("mergeTokenDeltas", () => {
  it("upserts by slug per category, last delta wins", () => {
    const merged = mergeTokenDeltas([
      { colors: [{ slug: "primary", color: "#000" }] },
      { colors: [{ slug: "primary", color: "#c00" }, { slug: "secondary", color: "#0c0" }] },
      { fontFamilies: [{ slug: "heading", fontFamily: "Anton" }] },
    ]);
    expect(merged.colors).toEqual([
      { slug: "primary", color: "#c00" },
      { slug: "secondary", color: "#0c0" },
    ]);
    expect(merged.fontFamilies).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
  });
  it("returns an empty delta for no input", () => {
    expect(isEmptyTokenDelta(mergeTokenDeltas([]))).toBe(true);
  });
});

describe("applyTokenOverride", () => {
  const base: ThemeJsonTokens = {
    colorPalette: [{ slug: "primary", color: "#000" }, { slug: "bg", color: "#fff" }],
    fontFamilies: [{ slug: "heading", fontFamily: "Georgia" }],
    fontSizes: [{ slug: "xl", size: "2rem" }],
  };
  it("overrides an existing color slug and keeps the rest", () => {
    const out = applyTokenOverride(base, { colors: [{ slug: "primary", color: "#c00" }] });
    expect(out.colorPalette).toEqual([{ slug: "primary", color: "#c00" }, { slug: "bg", color: "#fff" }]);
    expect(out.fontFamilies).toEqual(base.fontFamilies);
  });
  it("adds a new slug when absent", () => {
    const out = applyTokenOverride(base, { colors: [{ slug: "accent", color: "#0c0" }] });
    expect(out.colorPalette).toContainEqual({ slug: "accent", color: "#0c0" });
  });
  it("overrides fonts and sizes", () => {
    const out = applyTokenOverride(base, {
      fontFamilies: [{ slug: "heading", fontFamily: "Anton" }],
      fontSizes: [{ slug: "xl", size: "3rem" }],
    });
    expect(out.fontFamilies).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
    expect(out.fontSizes).toEqual([{ slug: "xl", size: "3rem" }]);
  });
  it("starts from empty when base is null", () => {
    const out = applyTokenOverride(null, { colors: [{ slug: "primary", color: "#c00" }] });
    expect(out.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });
});

describe("validateTokenDelta", () => {
  it("accepts valid hex / rgb / hsl colors", () => {
    expect(validateTokenDelta({ colors: [{ slug: "primary", color: "#c00" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "#cc0000" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "rgb(204,0,0)" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "hsl(0,100%,40%)" }] }).ok).toBe(true);
  });
  it("rejects a color that could break out of CSS", () => {
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "red; } body{display:none}" }] }).ok).toBe(false);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "url(x)" }] }).ok).toBe(false);
  });
  it("rejects font family / size with braces, semicolons, or angle brackets", () => {
    expect(validateTokenDelta({ fontFamilies: [{ slug: "h", fontFamily: "Anton; }" }] }).ok).toBe(false);
    expect(validateTokenDelta({ fontSizes: [{ slug: "xl", size: "3rem; }<x>" }] }).ok).toBe(false);
  });
  it("accepts a plain font family and a CSS length / clamp size", () => {
    expect(validateTokenDelta({ fontFamilies: [{ slug: "h", fontFamily: "DM Sans" }] }).ok).toBe(true);
    expect(validateTokenDelta({ fontSizes: [{ slug: "xl", size: "clamp(2rem, 5vw, 3rem)" }] }).ok).toBe(true);
  });
  it("rejects an empty delta and a non-object", () => {
    expect(validateTokenDelta({}).ok).toBe(false);
    expect(validateTokenDelta(null).ok).toBe(false);
    expect(validateTokenDelta("x").ok).toBe(false);
  });
  it("rejects a missing/blank slug", () => {
    expect(validateTokenDelta({ colors: [{ slug: "", color: "#c00" }] }).ok).toBe(false);
  });
});
