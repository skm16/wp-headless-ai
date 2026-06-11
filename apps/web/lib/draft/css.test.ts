import { describe, it, expect } from "vitest";
import { buildDraftCss } from "./css";
import { tailwindExtendFromTokens } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

const TOKENS: ThemeJsonTokens = {
  colorPalette: [{ slug: "primary", color: "#0a4f8a" }],
  fontFamilies: [{ slug: "heading", fontFamily: "Syne, sans-serif" }],
  fontSizes: [{ slug: "huge", size: "4rem" }],
};

describe("tailwindExtendFromTokens", () => {
  it("maps tokens to Tailwind extend shape (same mapping emitTailwindConfigTs serializes)", () => {
    expect(tailwindExtendFromTokens(TOKENS)).toEqual({
      colors: { primary: "#0a4f8a" },
      fontFamily: { heading: ["Syne, sans-serif"] },
      fontSize: { huge: "4rem" },
    });
  });

  it("returns empty maps for null tokens", () => {
    expect(tailwindExtendFromTokens(null)).toEqual({ colors: {}, fontFamily: {}, fontSize: {} });
  });
});

describe("buildDraftCss", () => {
  it("JITs utilities found in raw component sources, including token-derived ones", async () => {
    const css = await buildDraftCss({
      sources: [`<section className="bg-primary px-4 text-4xl font-bold">x</section>`],
      tokens: TOKENS,
      themeCss: null,
    });
    expect(css).toContain(".bg-primary");
    // Tailwind 3 converts hex to rgb() — the token color is encoded as rgb(10 79 138 ...)
    expect(css).toMatch(/bg-primary[\s\S]*?10 79 138/);
    expect(css).toContain(".text-4xl");
  }, 30_000);

  it("appends the scoped theme css verbatim after the Tailwind output", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: ".jab-theme .legacy { color: red; }",
    });
    expect(css.indexOf(".jab-theme .legacy")).toBeGreaterThan(css.indexOf(".p-2"));
  }, 30_000);
});
