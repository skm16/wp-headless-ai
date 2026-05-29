// apps/web/lib/jab/global-styles.test.ts
import { describe, it, expect } from "vitest";
import {
  extractThemeJsonTokens,
  brandTokensFromDesignAnalysis,
  resolveThemeTokens,
} from "./global-styles";

describe("extractThemeJsonTokens", () => {
  it("flattens settings + styles into the persistence shape", () => {
    const result = extractThemeJsonTokens({
      settings: {
        color: { palette: [{ slug: "primary", color: "#1a4d2e" }] },
        typography: { fontSizes: [{ slug: "large", size: "32px" }] },
        spacing: { blockGap: "24px" },
      },
      styles: { color: { background: "#fff" } },
    });
    expect(result).not.toBeNull();
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#1a4d2e" }]);
    expect(result!.fontSizes).toEqual([{ slug: "large", size: "32px" }]);
    expect(result!.blockGap).toBe("24px");
  });

  it("returns null when no usable tokens present", () => {
    expect(extractThemeJsonTokens(null)).toBeNull();
    expect(extractThemeJsonTokens({})).toBeNull();
  });
});

describe("brandTokensFromDesignAnalysis — classic-theme adapter", () => {
  it("maps the Two Roads scrape-agent output to ThemeJsonTokens shape", () => {
    const result = brandTokensFromDesignAnalysis({
      colors: {
        primary: { value: "#ffc72c" },
        secondary: { value: "#ff6900" },
        accent: { value: "#cf2e2e" },
      },
      typography: {
        heading: { value: "Anton" },
        body: { value: "Source Sans Pro" },
      },
    });
    expect(result).not.toBeNull();
    expect(result!.colorPalette).toEqual([
      { slug: "primary", color: "#ffc72c" },
      { slug: "secondary", color: "#ff6900" },
      { slug: "accent", color: "#cf2e2e" },
    ]);
    expect(result!.fontFamilies).toEqual([
      { slug: "heading", fontFamily: "Anton" },
      { slug: "body", fontFamily: "Source Sans Pro" },
    ]);
  });

  it("drops null secondary / accent without poisoning the palette", () => {
    const result = brandTokensFromDesignAnalysis({
      colors: {
        primary: { value: "#ffc72c" },
        secondary: { value: null },
        accent: null,
      },
      typography: {
        heading: { value: "Anton" },
        body: { value: null },
      },
    });
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#ffc72c" }]);
    expect(result!.fontFamilies).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
  });

  it("rejects malformed hex values without throwing", () => {
    const result = brandTokensFromDesignAnalysis({
      colors: {
        primary: { value: "yellow" },
        secondary: { value: "#fc2" },
        accent: { value: "#ffc72c" },
      },
    });
    expect(result!.colorPalette).toEqual([{ slug: "accent", color: "#ffc72c" }]);
  });

  it("returns null when no colors AND no fonts are usable", () => {
    expect(brandTokensFromDesignAnalysis(null)).toBeNull();
    expect(brandTokensFromDesignAnalysis(undefined)).toBeNull();
    expect(brandTokensFromDesignAnalysis({})).toBeNull();
    expect(
      brandTokensFromDesignAnalysis({
        colors: { primary: { value: null }, secondary: { value: null }, accent: { value: null } },
        typography: { heading: { value: null }, body: { value: null } },
      }),
    ).toBeNull();
  });

  it("omits the colorPalette / fontFamilies keys when their array is empty", () => {
    const onlyColors = brandTokensFromDesignAnalysis({
      colors: { primary: { value: "#ffc72c" } },
    });
    expect(onlyColors!.colorPalette).toBeDefined();
    expect(onlyColors!.fontFamilies).toBeUndefined();

    const onlyFonts = brandTokensFromDesignAnalysis({
      typography: { heading: { value: "Anton" } },
    });
    expect(onlyFonts!.fontFamilies).toBeDefined();
    expect(onlyFonts!.colorPalette).toBeUndefined();
  });
});

describe("resolveThemeTokens — composite resolver", () => {
  it("prefers themeJson when both are present", () => {
    const themeJson = {
      colorPalette: [{ slug: "primary", color: "#000000" }],
    };
    const result = resolveThemeTokens(themeJson, {
      colors: { primary: { value: "#ffc72c" } },
    });
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#000000" }]);
  });

  it("falls back to the scrape-agent inference when themeJson is null", () => {
    const result = resolveThemeTokens(null, {
      colors: { primary: { value: "#ffc72c" } },
    });
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#ffc72c" }]);
  });

  it("returns null when neither source produced anything", () => {
    expect(resolveThemeTokens(null, null)).toBeNull();
    expect(resolveThemeTokens(undefined, undefined)).toBeNull();
  });
});
