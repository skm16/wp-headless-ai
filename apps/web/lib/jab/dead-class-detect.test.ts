import { describe, it, expect } from "vitest";
import {
  extractClassNameTokens,
  extractThemeCssClassNames,
  classifyClasses,
} from "./dead-class-detect";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

const TOKENS: ThemeJsonTokens = {
  colorPalette: [{ slug: "primary", color: "#0a4f8a" }],
  fontFamilies: [{ slug: "heading", fontFamily: "Syne, sans-serif" }],
  fontSizes: [{ slug: "huge", size: "4rem" }],
};

describe("extractClassNameTokens", () => {
  it("extracts whole tokens from a static className string literal", () => {
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid bg-[#fff]">y</div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual(["text-4xl", "footer-v2-grid", "bg-[#fff]"]);
  });

  it("dedups repeated tokens in source order", () => {
    const tsx = `export function X() { return <div className="p-2"><span className="p-2 mt-1">y</span></div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual(["p-2", "mt-1"]);
  });

  it("ignores template-literal / clsx / ternary classNames (runtime-composed)", () => {
    const tsx = `export function X({ a }: { a: boolean }) {
      return <div className={\`base \${a ? "on" : "off"}\`} data-x="ignored" aria-label="nope">y</div>;
    }`;
    expect(extractClassNameTokens(tsx)).toEqual([]);
  });

  it("ignores non-className static attributes", () => {
    const tsx = `export function X() { return <div id="header" data-role="banner">y</div>; }`;
    expect(extractClassNameTokens(tsx)).toEqual([]);
  });
});

describe("extractThemeCssClassNames", () => {
  it("parses class selectors from captured theme CSS", () => {
    const css = `.jab-theme .footer-v2-grid { display: grid; } .jab-theme .site-header{padding:0}`;
    const set = extractThemeCssClassNames(css);
    expect(set.has("footer-v2-grid")).toBe(true);
    expect(set.has("site-header")).toBe(true);
  });

  it("returns an empty set for null", () => {
    expect(extractThemeCssClassNames(null).size).toBe(0);
  });
});

describe("classifyClasses", () => {
  it("marks a hallucinated class with no Tailwind rule and no theme CSS as DEAD", async () => {
    const r = await classifyClasses({ tokens: ["footer-v2-grid"], tokens_tw: TOKENS, themeCss: null });
    expect(r.dead).toEqual(["footer-v2-grid"]);
    expect(r.resolvable).toEqual([]);
  });

  it("marks a standard Tailwind utility as RESOLVABLE", async () => {
    const r = await classifyClasses({ tokens: ["text-4xl"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["text-4xl"]);
    expect(r.dead).toEqual([]);
  });

  it("marks a token-derived utility (bg-primary) as RESOLVABLE", async () => {
    const r = await classifyClasses({ tokens: ["bg-primary"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["bg-primary"]);
  });

  it("marks an arbitrary-value class (bg-[#fff]) as RESOLVABLE (no substring false-positive)", async () => {
    const r = await classifyClasses({ tokens: ["bg-[#fff]"], tokens_tw: TOKENS, themeCss: null });
    expect(r.resolvable).toEqual(["bg-[#fff]"]);
  });

  it("marks a class present only in captured theme CSS as RESOLVABLE", async () => {
    const r = await classifyClasses({
      tokens: ["footer-v2-grid"],
      tokens_tw: TOKENS,
      themeCss: ".jab-theme .footer-v2-grid { display: grid; }",
    });
    expect(r.resolvable).toEqual(["footer-v2-grid"]);
    expect(r.dead).toEqual([]);
  });

  it("dedups before probing (one classification per unique token)", async () => {
    const r = await classifyClasses({
      tokens: ["text-4xl", "text-4xl", "footer-v2-grid"],
      tokens_tw: TOKENS,
      themeCss: null,
    });
    expect(r.resolvable).toEqual(["text-4xl"]);
    expect(r.dead).toEqual(["footer-v2-grid"]);
  });

  it("NEVER marks variant-marker classes dead (group/peer + named) — they emit no CSS alone but drive group-hover/peer-* on descendants", async () => {
    const r = await classifyClasses({
      tokens: ["group", "peer", "group/card", "peer/email"],
      tokens_tw: TOKENS,
      themeCss: null,
    });
    expect(r.dead).toEqual([]);
    expect(r.resolvable).toEqual(["group", "peer", "group/card", "peer/email"]);
  });
});

import { rankThemeClassesForUnit } from "./dead-class-detect";

describe("rankThemeClassesForUnit", () => {
  it("ranks classes used in THIS unit's source DOM ahead of the rest, by frequency", () => {
    const ranked = rankThemeClassesForUnit({
      themeClassNames: ["unused-a", "card-grid", "unused-b", "hero-banner"],
      sourceDom: `<section class="hero-banner"><div class="card-grid card-grid">x</div></section>`,
      cap: 10,
    });
    expect(ranked.slice(0, 2)).toEqual(["card-grid", "hero-banner"]); // 2 hits before 1 hit, both before unused
    expect(ranked).toContain("unused-a");
  });

  it("respects the explicit cap", () => {
    expect(rankThemeClassesForUnit({ themeClassNames: ["a-aa", "b-bb", "c-cc", "d-dd"], sourceDom: null, cap: 2 }).length).toBe(2);
  });
});
