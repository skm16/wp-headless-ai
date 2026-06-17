import { describe, it, expect, vi } from "vitest";
import { patchUnitSource, buildPatchPrompt } from "./patch-component";
import type { ModelClient } from "./model-client";

const CURRENT = `export function AcfHero({ block }: { block: { attrs: Record<string, unknown> } }) {
  return <h1 className="text-6xl">{String(block.attrs.title ?? "")}</h1>;
}
`;

function fakeClient(responses: string[]): ModelClient {
  const generate = vi.fn();
  for (const r of responses) generate.mockResolvedValueOnce({ text: r, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } });
  return { generate } as unknown as ModelClient;
}

describe("buildPatchPrompt", () => {
  it("contains the current source, the instruction, and the keep-contract rules", () => {
    const p = buildPatchPrompt({ currentTsx: CURRENT, guidance: "make the headline smaller", exportName: "AcfHero" });
    expect(p.user).toContain(CURRENT.trim());
    expect(p.user).toContain("make the headline smaller");
    expect(p.system).toContain("AcfHero");
    expect(p.system).toMatch(/minimal/i);
  });
});

describe("patchUnitSource", () => {
  it("returns the patched TSX when the model output validates", async () => {
    const patched = CURRENT.replace("text-6xl", "text-4xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "make the headline smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([patched]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tsx).toContain("text-4xl");
  });

  it("retries once on invalid TSX, then succeeds", async () => {
    const patched = CURRENT.replace("text-6xl", "text-5xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["export function AcfHero({ <<<garbage", patched]),
    });
    expect(result.ok).toBe(true);
  });

  it("fails after two invalid attempts with the validation errors attached", async () => {
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["<<<garbage", "<<<garbage again"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("fails when the output exceeds maxBytes", async () => {
    const huge = CURRENT + "\n// " + "x".repeat(20_000);
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([huge, huge]),
    });
    expect(result.ok).toBe(false);
  });
});

import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

describe("buildPatchPrompt — theme-class inventory + token hex hints", () => {
  const tokens: ThemeJsonTokens = { colorPalette: [{ slug: "primary", color: "#ffc72c" }] };

  it("renders a SOFT prefer-inventory section when themeClassNames is provided", () => {
    const p = buildPatchPrompt({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      themeClassNames: ["site-header", "footer-v2-grid"],
    });
    expect(p.system).toMatch(/site-header/);
    expect(p.system).toMatch(/footer-v2-grid/);
    expect(p.system).toMatch(/PREFER/);
    // It is a SOFT hint — Tailwind utilities are still allowed, and inventing
    // is NOT declared a hard error (unlike the shell prompt).
    expect(p.system).toMatch(/standard Tailwind utilities/);
    expect(p.system).not.toMatch(/is an error/);
  });

  it("renders token slug+hex pairs with the hex-match rule when tokens are provided", () => {
    const p = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero", tokens });
    expect(p.system).toMatch(/primary \(#ffc72c\)/);
    expect(p.system).toMatch(/Match by hex value, not by semantic name/);
  });

  it("is byte-identical to the no-inventory prompt when neither is provided", () => {
    const a = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero" });
    const b = buildPatchPrompt({ currentTsx: CURRENT, guidance: "smaller", exportName: "AcfHero", themeClassNames: [], tokens: null });
    expect(b.system).toBe(a.system);
  });
});

const USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Single-shot stub: returns `text` once, with zero usage. */
function stubClient(text: string): ModelClient {
  return {
    async generate() {
      return { text, usage: USAGE };
    },
  } as unknown as ModelClient;
}

describe("patchUnitSource sourceHosts rewrite (draft ↔ deployed origin parity)", () => {
  it("rewrites an absolute source-origin href to a root-relative path", async () => {
    const tsx = `export function Foo() {\n  return <a href="https://wp.example/events">Events</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to our events page",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
      sourceHosts: ["wp.example", "www.wp.example"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tsx).toContain(`href="/events"`);
      expect(res.tsx).not.toContain("wp.example");
    }
  });

  it("maps a diverged permalink to its clone route via routePathMap (not just origin-stripped)", async () => {
    const tsx = `export function Foo() {\n  return <a href="https://wp.example/about-us/">About</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to about",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
      sourceHosts: ["wp.example"],
      routePathMap: { "/about-us": "/about" }, // WP permalink /about-us/ → JAB route /about
    });
    expect(res.ok).toBe(true);
    // Without routePathMap this would be the WRONG /about-us; the map yields /about.
    if (res.ok) expect(res.tsx).toContain(`href="/about"`);
  });

  it("is byte-identical when the edit introduces no source-origin URL", async () => {
    const tsx = `export function Foo() {\n  return <a href="/about">About</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to about",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
      sourceHosts: ["wp.example", "www.wp.example"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tsx).toContain(`href="/about"`);
  });

  it("leaves source-origin URLs alone when sourceHosts is absent (safe default)", async () => {
    const tsx = `export function Foo() {\n  return <a href="https://wp.example/events">Events</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to events",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tsx).toContain("https://wp.example/events");
  });

  it("prompt declares source-host links internal (belt-and-suspenders, secondary)", () => {
    const { system } = buildPatchPrompt({
      currentTsx: "x",
      guidance: "y",
      exportName: "Foo",
      sourceHosts: ["wp.example"],
    });
    expect(system).toMatch(/wp\.example/);
  });
});
