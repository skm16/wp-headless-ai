import { describe, it, expect, vi } from "vitest";
import { generateShell, type GenerateShellOptions } from "./generate-shell";
import type { ModelClient } from "./model-client";

function makeMockClient(text: string): ModelClient {
  return {
    generate: vi.fn().mockResolvedValue({
      text,
      usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  } as unknown as ModelClient;
}

const validHeaderTsx = `export function Header() { return <header>Hi</header>; }`;

const baseOpts: Omit<GenerateShellOptions, "kind" | "client"> = {
  shellDom: "<header><nav>x</nav></header>",
  themeTokens: null,
  menu: null,
  logoUrl: null,
  siteName: "Test Site",
  siteDescription: null,
};

describe("generateShell — header happy path", () => {
  it("returns LLM output when it compiles cleanly", async () => {
    const client = makeMockClient(validHeaderTsx);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain("function Header");
    expect(out.shellKind).toBe("header");
    expect(out.modelUsed).toBeTruthy();
  });
});

describe("generateShell — missing shellDom path", () => {
  it("skips LLM call and emits deterministic fallback when shellDom is empty", async () => {
    const generateSpy = vi.fn();
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, shellDom: "", kind: "header", client });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(out.compileStatus).toBe("skipped");
    expect(out.tsx).toContain("function Header");
    expect(out.modelUsed).toBeNull();
    expect(out.inputTokens).toBe(0);
  });

  it("same behavior for footer", async () => {
    const client = { generate: vi.fn() } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, shellDom: "", kind: "footer", client });
    expect(out.compileStatus).toBe("skipped");
    expect(out.tsx).toContain("function Footer");
  });
});

describe("generateShell — compile failure path", () => {
  it("retries once on invalid TSX, then falls back", async () => {
    const client = makeMockClient(`export function Header() { return <div>unclosed; }`);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect((client.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(out.compileStatus).toBe("failed");
    expect(out.compileAttemptCount).toBe(2);
    expect(out.tsx).toContain("Test Site");
  });
});

describe("generateShell — over-cap path", () => {
  it("accepts a 16KB shell (real footer with 7 inline social SVGs is ~15KB)", async () => {
    const sixteenK = `export function Header() { return <header>${"x".repeat(16000)}</header>; }`;
    const client = makeMockClient(sixteenK);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
  });
  it("treats output >24KB as compile failure (runaway-generation guard)", async () => {
    const huge = `export function Header() { return <header>${"x".repeat(25000)}</header>; }`;
    const client = makeMockClient(huge);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("failed");
  });
});

describe("generateShell — code fence stripping", () => {
  it("strips ```tsx fences before validating", async () => {
    const client = makeMockClient("```tsx\n" + validHeaderTsx + "\n```");
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).not.toContain("```");
  });
});
