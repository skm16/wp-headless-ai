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
  // The deployed site forces brand fonts onto semantic elements via
  // emitGlobalsCss → brandTypographyCss (`.jab-theme h1..h6 { font-family: Anton }`).
  // The draft CSS pipeline omitted that layer, so generated headings (which use
  // bare <h4> etc., no font class) fell back to the theme's system base font —
  // the footer "Explore" heading rendered in -apple-system instead of Anton.
  // buildDraftCss must derive brandFonts from the same `heading`/`body`
  // fontFamilies slugs and append the override.
  it("emits brand-typography heading override from heading/body font tokens", async () => {
    const css = await buildDraftCss({
      sources: [`<h4 className="text-sm">x</h4>`],
      tokens: {
        fontFamilies: [
          { slug: "heading", fontFamily: "Anton" },
          { slug: "body", fontFamily: "Source Sans Pro" },
        ],
      },
      themeCss: null,
    });
    expect(css).toMatch(/\.jab-theme\s+h4[^{]*\{[^}]*font-family:[^}]*Anton/);
  }, 30_000);

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

  // Tailwind preflight is disabled in the draft build (it reads ./css/preflight.css
  // via __dirname, which Next production bundling can't resolve → ENOENT). Preflight
  // normally provides the base resets the generated components assume: lists with no
  // bullets/padding and links that inherit color + font. Without them, footer nav
  // <ul>s render UA `disc` bullets and <a>s fall back to the UA blue + system font
  // instead of inheriting the container's `text-white` / brand font. We re-inject
  // those specific resets, `.jab-theme`-scoped, AFTER the captured theme CSS so a
  // theme rule like `.jab-theme a { color: #0275d8 }` (equal specificity) is beaten
  // on source order — letting footer links inherit white.
  it("injects scoped base resets for lists and links (preflight replacement)", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: null,
    });
    expect(css).toMatch(/\.jab-theme\s+(?:ul|ol|menu)[^{]*\{[^}]*list-style:\s*none/);
    expect(css).toMatch(/\.jab-theme\s+a\b[^{]*\{[^}]*color:\s*inherit/);
  }, 30_000);

  it("orders base resets AFTER the captured theme css so they win on source order", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: ".jab-theme a { color: #0275d8; }",
    });
    // The injected `.jab-theme a { color: inherit }` reset must come after the
    // theme's `.jab-theme a { color: #0275d8 }` so footer links inherit (white),
    // not Bootstrap blue.
    const themeIdx = css.indexOf("#0275d8");
    const resetIdx = css.search(/\.jab-theme\s+a\b[^{]*\{[^}]*color:\s*inherit/);
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(themeIdx);
  }, 30_000);

  // The deployed site ships `@tailwind base;` → full Tailwind preflight, which
  // gives every element `box-sizing: border-box`, `body{margin:0}`, and
  // constrained media. The draft disables preflight (it reads ./css/preflight.css
  // via __dirname, unresolvable under Next bundling), so generated components —
  // all authored against border-box-assuming utilities (w-*/p-*/border/max-w-*) —
  // overflow in the draft but not in production. buildDraftCss must re-inject a
  // GLOBAL (not .jab-theme-scoped) static preflight base, placed BEFORE the
  // captured theme CSS so theme + scoped resets still win on source order —
  // mirroring @tailwind base sitting beneath utilities/theme on the deployed site.
  it("injects a GLOBAL preflight base with box-sizing:border-box", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: null,
    });
    expect(css).toMatch(/\*\s*,\s*::before\s*,\s*::after\s*\{[^}]*box-sizing:\s*border-box/);
    // GLOBAL, not scoped — must NOT be qualified by .jab-theme.
    expect(css).not.toMatch(/\.jab-theme[^{]*\{[^}]*box-sizing:\s*border-box/);
  }, 30_000);

  it("orders the preflight base BEFORE the captured theme css", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: ".jab-theme .legacy { color: red; }",
    });
    const preflightIdx = css.search(/box-sizing:\s*border-box/);
    const themeIdx = css.indexOf(".jab-theme .legacy");
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(themeIdx).toBeGreaterThan(preflightIdx);
  }, 30_000);
});
