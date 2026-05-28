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
});

describe("shell-prompts — footer", () => {
  it("includes footer DOM + signature", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p).toMatch(/<footer>/);
    expect(p).toMatch(/Two Roads/);
    expect(p).toMatch(/export function Footer/);
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
