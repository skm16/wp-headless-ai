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

  it("strips ```typescript fences (not just tsx|ts|jsx|js)", async () => {
    const client = makeMockClient("```typescript\n" + validHeaderTsx + "\n```");
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).not.toContain("```");
  });
});

describe("generateShell — use client injection", () => {
  it('prepends "use client" when the LLM output uses useState', async () => {
    const hookHeader = `import { useState } from "react";
export function Header() {
  const [open, setOpen] = useState(false);
  return <header onClick={() => setOpen(o => !o)}>Hi</header>;
}`;
    const client = makeMockClient(hookHeader);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toMatch(/^"use client";/);
  });
});

describe("generateShell — export name alignment", () => {
  it("appends alias export when LLM exports SiteHeader instead of Header", async () => {
    const wrongName = `export function SiteHeader() { return <header>Hi</header>; }`;
    const client = makeMockClient(wrongName);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain("export { SiteHeader as Header }");
  });

  it("appends alias export when LLM exports SiteFooter instead of Footer", async () => {
    const wrongName = `export function SiteFooter() { return <footer>bye</footer>; }`;
    const client = makeMockClient(wrongName);
    const out = await generateShell({ ...baseOpts, kind: "footer", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain("export { SiteFooter as Footer }");
  });
});

describe("generateShell — origin rewriting", () => {
  it("rewrites source-origin hrefs in generated shell TSX to relative paths", async () => {
    const tsx = `export function Header() {
  return (
    <nav>
      <a href="https://tworoadsbrewing.com/visit-us/">Visit</a>
      <img src="https://tworoadsbrewing.com/wp-content/uploads/logo.png" />
    </nav>
  );
}`;
    const client = makeMockClient(tsx);
    const out = await generateShell({
      ...baseOpts,
      kind: "header",
      client,
      sourceHosts: ["tworoadsbrewing.com"],
    });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain(`href="/visit-us"`);
    expect(out.tsx).not.toContain(`href="https://tworoadsbrewing.com`);
    // Asset URLs (wp-content) must NOT be rewritten — clone hotlinks WP media
    expect(out.tsx).toContain(`src="https://tworoadsbrewing.com/wp-content/uploads/logo.png"`);
  });

  it("rewrites menu URLs in the deterministic fallback when sourceHosts is set", async () => {
    const generateSpy = vi.fn();
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({
      ...baseOpts,
      shellDom: "",
      kind: "header",
      client,
      menu: {
        name: "Main",
        items: [{ title: "Beers", url: "https://tworoadsbrewing.com/beers/" }],
      },
      siteName: "Two Roads",
      sourceHosts: ["tworoadsbrewing.com"],
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(out.compileStatus).toBe("skipped");
    expect(out.tsx).toContain(`href="/beers"`);
    expect(out.tsx).not.toContain("tworoadsbrewing.com");
  });
});
