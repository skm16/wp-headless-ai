import { describe, it, expect } from "vitest";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  type ShellPromptInput,
} from "./shell-prompts";

const baseInput: ShellPromptInput = {
  shellDom: "<header id='masthead'><nav><a href='/'>Home</a></nav></header>",
  themeTokens: {
    colorPalette: [{ slug: "brand", color: "#ffc72c" }],
    fontFamilies: [{ slug: "display", fontFamily: "Syne, sans-serif" }],
    raw: {} as never,
  },
  menu: { name: "Primary", items: [{ title: "Home", url: "/" }, { title: "About", url: "/about" }] },
  logoUrl: "https://x.test/logo.svg",
  siteName: "Two Roads",
  siteDescription: "Craft beer",
};

describe("shell-prompts — header", () => {
  it("includes shellDom + menu + tokens + required signature", () => {
    const p = headerPrompt(baseInput);
    expect(p).toMatch(/<header id='masthead'>/);
    expect(p).toMatch(/Home/);
    expect(p).toMatch(/About/);
    expect(p).toMatch(/brand/);
    expect(p).toMatch(/display/);
    expect(p).toMatch(/Tailwind/);
    expect(p).toMatch(/Do NOT.*next\/font/);
    expect(p).toMatch(/export function Header/);
  });

  it("emits each color token as slug + hex pair so the LLM can map source DOM hex values to token classes", () => {
    const p = headerPrompt(baseInput);
    // The pre-2026-05-29 emit was just "Colors: brand" — the LLM had no
    // way to match a captured #ffc72c in the source DOM to `bg-brand`.
    expect(p).toMatch(/brand \(#ffc72c\)/);
    expect(p).toMatch(/display \(Syne, sans-serif\)/);
  });

  it("includes a system-prompt instruction directing the LLM to match source hex values to token classes", () => {
    const p = headerPrompt(baseInput);
    expect(p).toMatch(/literal color value/);
    expect(p).toMatch(/Match by hex value/);
  });
});

describe("shell-prompts — footer", () => {
  it("includes footer DOM + signature", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p).toMatch(/<footer>/);
    expect(p).toMatch(/Two Roads/);
    expect(p).toMatch(/export function Footer/);
  });

  it("includes the width-contract instruction directing full-bleed rendering when source is full-bleed", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p).toMatch(/Width contract/);
    expect(p).toMatch(/full-bleed/);
    expect(p).toMatch(/do NOT wrap the root in a `max-w-/);
  });

  it("the width-contract instruction scopes the rule to the OUTER element so inner max-w sub-sections stay legal", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p).toMatch(/OUTER element only/);
    expect(p).toMatch(/inner sub-sections.*may still use `max-w-/);
  });

  it("the same width-contract instruction is shared with the header prompt", () => {
    const p = headerPrompt(baseInput);
    expect(p).toMatch(/Width contract/);
  });
});

describe("shellDeterministicFallback", () => {
  it("emits a header with site name + flat nav from menu", () => {
    const src = shellDeterministicFallback("header", { name: "Primary", items: [{ title: "Home", url: "/" }] }, "Two Roads");
    expect(src).toMatch(/export function Header/);
    expect(src).toMatch(/Two Roads/);
    expect(src).toMatch(/Home/);
  });

  it("emits a header even with no menu data", () => {
    const src = shellDeterministicFallback("header", null, "My Site");
    expect(src).toMatch(/My Site/);
  });

  it("emits a footer with site name + copyright", () => {
    const src = shellDeterministicFallback("footer", null, "Two Roads");
    expect(src).toMatch(/export function Footer/);
    expect(src).toMatch(/©/);
  });

  it("emitted TSX parses", async () => {
    const ts = await import("typescript");
    const src = shellDeterministicFallback("header", null, "Test");
    const sf = ts.createSourceFile("Header.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});

describe("shell-prompts — edit guidance placement (R7 cache-leak guard)", () => {
  const GUIDANCE = "Add the secondary menu and make the logo larger.";
  const MARKER = "\n\nUSER:\n";

  for (const [name, fn] of [["header", headerPrompt], ["footer", footerPrompt]] as const) {
    it(`${name}: guidance lands strictly AFTER the USER: marker`, () => {
      const p = fn({ ...baseInput, guidance: GUIDANCE });
      expect(p).toContain(GUIDANCE);
      const markerIdx = p.indexOf(MARKER);
      expect(markerIdx).toBeGreaterThan(-1);
      expect(p.indexOf(GUIDANCE)).toBeGreaterThan(markerIdx + MARKER.length);
      expect(p.slice(0, markerIdx)).not.toContain(GUIDANCE);
    });
    it(`${name}: omitting guidance is byte-identical`, () => {
      expect(fn(baseInput)).toBe(fn({ ...baseInput, guidance: undefined }));
    });
  }
});
