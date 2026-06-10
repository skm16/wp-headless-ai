import { describe, it, expect } from "vitest";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  shouldCacheShellPrefix,
  SHELL_DOM_PROMPT_MAX_BYTES,
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

describe("shell-prompts — structured {system, user} shape", () => {
  it("header: stable sections (rules + tokens + theme classes + menu) live in system", () => {
    const p = headerPrompt({ ...baseInput, themeClassNames: ["tworoads-hero"] });
    expect(p.system).toMatch(/Output contract/);
    expect(p.system).toMatch(/brand \(#ffc72c\)/);
    expect(p.system).toMatch(/display \(Syne, sans-serif\)/);
    expect(p.system).toMatch(/tworoads-hero/);
    expect(p.system).toMatch(/Menu: Primary/);
    expect(p.system).toMatch(/Width contract/);
    expect(p.system).toMatch(/Do NOT.*next\/font/);
    // Per-call content must NOT leak into the stable half.
    expect(p.system).not.toContain("masthead");
    // Plain "Two Roads" can't be the leak marker: the stable Width-contract
    // rule legitimately cites a hard-coded Two Roads anecdote. Assert the
    // per-build rendered forms instead (the user half's "Name: ..." identity
    // line and the fixture siteDescription).
    expect(p.system).not.toContain("Name: Two Roads");
    expect(p.system).not.toContain("Craft beer");
  });

  it("header and footer produce a byte-identical system half (footer reads header's cache write)", () => {
    const input = { ...baseInput, themeClassNames: ["tworoads-hero"] };
    expect(headerPrompt(input).system).toBe(footerPrompt(input).system);
  });

  it("header user half carries identity + signature + DOM, with the DOM LAST", () => {
    const p = headerPrompt(baseInput);
    expect(p.user).toMatch(/Name: Two Roads/);
    expect(p.user).toMatch(/export function Header/);
    expect(p.user).toContain("masthead");
    // shellDom is the FINAL section: nothing but the closing fence follows it.
    const domIdx = p.user.indexOf("masthead");
    expect(domIdx).toBeGreaterThan(p.user.indexOf("Name: Two Roads"));
    expect(domIdx).toBeGreaterThan(p.user.indexOf("export function Header"));
    expect(p.user.slice(domIdx)).toMatch(/```\s*$/);
  });

  it("footer: signature + DOM in user, DOM last", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p.user).toMatch(/export function Footer/);
    const domIdx = p.user.indexOf("© 2025");
    expect(domIdx).toBeGreaterThan(p.user.indexOf("export function Footer"));
  });

  it("sanitizes the shellDom at prompt build (scripts/data-attrs never reach the prompt)", () => {
    const p = headerPrompt({
      ...baseInput,
      shellDom: `<header data-elementor-id="9"><script>track()</script><nav>Hi</nav></header>`,
    });
    expect(p.user).not.toContain("track()");
    expect(p.user).not.toContain("data-elementor-id");
    expect(p.user).toContain("<nav>Hi</nav>");
  });

  it("surfaces the captured computed chrome colors in the USER half (per-kind, not cacheable)", () => {
    const p = headerPrompt({ ...baseInput, shellColors: { backgroundColor: "rgb(255, 199, 44)", color: "rgb(0, 0, 0)" } });
    expect(p.user).toMatch(/root background-color: `rgb\(255, 199, 44\)`/);
    expect(p.user).toMatch(/Do NOT default the root to `bg-white`/);
    expect(p.system).not.toMatch(/Source chrome computed colors/);
  });

  it("omits the computed-colors section when no shellColors are captured", () => {
    const p = headerPrompt(baseInput);
    expect(p.user).not.toMatch(/Source chrome computed colors/);
  });
});

describe("shell-prompts — source-host internal-links rule", () => {
  it("system half declares source-host URLs internal; omitted without sourceHost", () => {
    const withHost = headerPrompt({ ...baseInput, sourceHost: "tworoadsbrewing.com" });
    expect(withHost.system).toContain("tworoadsbrewing.com are INTERNAL");
    expect(withHost.system).toContain("root-relative");
    expect(headerPrompt(baseInput).system).not.toContain("are INTERNAL");
  });
});

describe("shell-prompts — edit guidance placement (R7 cache-leak guard)", () => {
  const GUIDANCE = "Add the secondary menu and make the logo larger.";
  for (const [name, fn] of [["header", headerPrompt], ["footer", footerPrompt]] as const) {
    it(`${name}: guidance lands in the user half only`, () => {
      const p = fn({ ...baseInput, guidance: GUIDANCE });
      expect(p.user).toContain(GUIDANCE);
      expect(p.system).not.toContain(GUIDANCE);
    });
    it(`${name}: omitting guidance is byte-identical`, () => {
      expect(fn(baseInput)).toEqual(fn({ ...baseInput, guidance: undefined }));
    });
  }
});

describe("shouldCacheShellPrefix", () => {
  it("true at >= 10,000 chars, false below", () => {
    expect(shouldCacheShellPrefix("x".repeat(10_000))).toBe(true);
    expect(shouldCacheShellPrefix("x".repeat(9_999))).toBe(false);
  });
  it("SHELL_DOM_PROMPT_MAX_BYTES bounds the prompt DOM", () => {
    expect(SHELL_DOM_PROMPT_MAX_BYTES).toBe(60_000);
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
