import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateShell,
  buildShellRequestParts,
  buildShellBatchItem,
  finalizeShellBatchResult,
  mergeShellUsage,
  type GenerateShellOptions,
} from "./generate-shell";
import type { ModelClient } from "./model-client";
import type { BatchResultItem } from "./batch-client";

vi.mock("./errors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./errors")>();
  return {
    ...orig,
    classifyAiError: vi.fn(orig.classifyAiError),
    isRetryableAiFailure: vi.fn(orig.isRetryableAiFailure),
  };
});

type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;

function shellRes(text: string, stopReason: StopReason = "end_turn") {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason,
    model: "mock-model",
  };
}

function makeMockClient(text: string): ModelClient {
  return { generate: vi.fn().mockResolvedValue(shellRes(text)) } as unknown as ModelClient;
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
    expect(out.modelUsed).toBe("mock-model");
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

describe("generateShell — ground-truth model telemetry", () => {
  it("records modelUsed=null when every attempt threw before a response arrived", async () => {
    const client = {
      generate: vi.fn().mockRejectedValue(new Error("simulated 529")),
    } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("failed");
    expect(out.modelUsed).toBeNull();
    expect(out.providerUsed).toBeNull();
  });

  it("failure after a successful-but-invalid response still records the responding model", async () => {
    const client = makeMockClient(`export function Header() { return <div>unclosed; }`);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("failed");
    expect(out.modelUsed).toBe("mock-model");
    expect(out.providerUsed).toBe("anthropic");
  });
});

describe("generateShell — Phase 2 loop behavior", () => {
  const validHeader = `export function Header() { return <header>Hi</header>; }`;

  // Mock hygiene (campaign precedent: component-generator.test.ts) — the
  // bad_request case overrides the delegating ./errors mocks; restore so the
  // override never leaks into later tests.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the ground-truth model and failureKind null on success", async () => {
    const client = makeMockClient(validHeader);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.modelUsed).toBe("mock-model");
    expect(out.failureKind).toBeNull();
  });

  it("appends corrective feedback to the retry's user prompt after a validation failure", async () => {
    const generateSpy = vi
      .fn()
      .mockResolvedValueOnce(shellRes(`export function Header() { return <div>unclosed; }`))
      .mockResolvedValueOnce(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].userPrompt).not.toContain("## Previous attempt failed validation");
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("## Previous attempt failed validation");
    expect(out.compileStatus).toBe("ok");
  });

  it("max_tokens truncation retries once with the cap raised to 12288, twice → fallback with failureKind", async () => {
    const generateSpy = vi.fn().mockResolvedValue(shellRes("export function Header() { return <header", "max_tokens"));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].maxTokens).toBeUndefined();
    expect(generateSpy.mock.calls[1][0].maxTokens).toBe(12288);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("max_tokens");
    expect(out.tsx).toContain("Test Site"); // deterministic fallback shipped
  });

  it("bad_request fails fast: ONE call, fallback, no fictional model attribution", async () => {
    const errorsMod = await import("./errors");
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("bad_request");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(false);
    const generateSpy = vi.fn().mockRejectedValue(new Error("400"));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("bad_request");
    expect(out.modelUsed).toBeNull();
    expect(out.providerUsed).toBeNull();
  });

  it("passes the stable system half as cachedSystemPrefix on EVERY attempt when it clears 10k chars", async () => {
    // 300 long theme-class names push the stable half well past 10,000 chars.
    const themeClassNames = Array.from({ length: 300 }, (_, i) => `very-long-theme-class-name-number-${i}-padding-padding`);
    const generateSpy = vi
      .fn()
      .mockResolvedValueOnce(shellRes(`export function Header() { return <div>unclosed; }`))
      .mockResolvedValueOnce(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    await generateShell({ ...baseOpts, kind: "header", client, themeClassNames });
    const first = generateSpy.mock.calls[0][0];
    const second = generateSpy.mock.calls[1][0];
    expect(first.cachedSystemPrefix).toBeDefined();
    expect(first.cachedSystemPrefix.length).toBeGreaterThanOrEqual(10_000);
    expect(second.cachedSystemPrefix).toBe(first.cachedSystemPrefix);
    expect(first.systemPrompt.length).toBeGreaterThan(0); // uncached block never empty
  });

  it("below the 10k floor the stable text stays in systemPrompt with NO cachedSystemPrefix", async () => {
    const generateSpy = vi.fn().mockResolvedValue(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    await generateShell({ ...baseOpts, kind: "header", client });
    const call = generateSpy.mock.calls[0][0];
    expect(call.cachedSystemPrefix).toBeUndefined();
    expect(call.systemPrompt).toContain("Output contract");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 batch helpers (Task 9): buildShellRequestParts / buildShellBatchItem
// / finalizeShellBatchResult / mergeShellUsage
// ---------------------------------------------------------------------------

const VALID_HEADER_TSX = `export function Header() {
  return <header className="p-4">site</header>;
}
`;

function makeShellOpts(over: Partial<GenerateShellOptions> = {}): GenerateShellOptions {
  return {
    kind: "header",
    shellDom: "<header><nav><a href='/'>Home</a></nav></header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Two Roads",
    siteDescription: null,
    client: {
      async generate(): Promise<never> {
        throw new Error("client must not be called by batch helpers");
      },
    },
    ...over,
  };
}

describe("buildShellRequestParts — responsive flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("omits the responsive section when JAB_RESPONSIVE_GEN is unset", () => {
    const parts = buildShellRequestParts(makeShellOpts())!;
    expect(parts.userPrompt).not.toContain("Responsive");
  });

  it("includes the responsive section when JAB_RESPONSIVE_GEN=1", () => {
    vi.stubEnv("JAB_RESPONSIVE_GEN", "1");
    const parts = buildShellRequestParts(makeShellOpts())!;
    expect(parts.userPrompt).toContain("Responsive");
  });
});

describe("buildShellRequestParts / buildShellBatchItem", () => {
  it("returns null for empty shellDom (sync short-circuit owns that case)", () => {
    expect(buildShellRequestParts(makeShellOpts({ shellDom: "" }))).toBeNull();
    expect(buildShellBatchItem(makeShellOpts({ shellDom: "   " }), "shell_header")).toBeNull();
  });

  it("builds a batch item with the visual-tier model config and the shell prompt parts", () => {
    const item = buildShellBatchItem(makeShellOpts(), "shell_header");
    expect(item).not.toBeNull();
    expect(item!.customId).toBe("shell_header");
    expect(item!.model).toBe("claude-sonnet-4-6");
    expect(item!.maxTokens).toBe(8192);
    expect(item!.user.length).toBeGreaterThan(0);
    expect(item!.system.length).toBeGreaterThan(0);
    expect(item!.screenshotBase64).toBeUndefined();
  });
});

describe("finalizeShellBatchResult", () => {
  const okResult: BatchResultItem = {
    customId: "shell_header",
    ok: true,
    text: VALID_HEADER_TSX,
    usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason: "end_turn",
    model: "claude-sonnet-4-6",
  };

  it("returns a persisted-shape GeneratedShell on a valid result", () => {
    const shell = finalizeShellBatchResult(makeShellOpts(), okResult);
    expect(shell).not.toBeNull();
    expect(shell!).toMatchObject({
      shellKind: "header",
      compileStatus: "ok",
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
      inputTokens: 900,
      outputTokens: 400,
    });
    expect(shell!.tsx).toContain("export function Header");
  });

  it("returns null (→ sync fallback) for API failures, truncation, and invalid TSX", () => {
    expect(
      finalizeShellBatchResult(makeShellOpts(), { ...okResult, ok: false, text: "", errorKind: "rate_limit" }),
    ).toBeNull();
    expect(
      finalizeShellBatchResult(makeShellOpts(), { ...okResult, stopReason: "max_tokens" }),
    ).toBeNull();
    expect(
      finalizeShellBatchResult(makeShellOpts(), {
        ...okResult,
        text: "export function Header() { return <header>broken; }",
      }),
    ).toBeNull();
  });

  it("returns null (→ sync fallback) when the result exceeds MAX_SHELL_BYTES (over_cap)", () => {
    const hugeText = `export function Header() { return <header>${"x".repeat(30_000)}</header>; }`;
    expect(finalizeShellBatchResult(makeShellOpts(), { ...okResult, text: hugeText })).toBeNull();
  });
});

describe("mergeShellUsage", () => {
  it("adds prior batch spend + attempts onto a sync-fallback GeneratedShell", () => {
    const base = {
      shellKind: "header" as const,
      tsx: VALID_HEADER_TSX,
      compileStatus: "ok" as const,
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic" as const,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failureKind: null,
    };
    const merged = mergeShellUsage(
      base,
      { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 },
      1,
    );
    expect(merged.inputTokens).toBe(1000);
    expect(merged.outputTokens).toBe(450);
    expect(merged.compileAttemptCount).toBe(2);
    // The merge must only touch token fields + attempt count — everything
    // else (incl. a non-null failureKind on a failed fallback) survives.
    expect(merged.shellKind).toBe("header");
    expect(merged.compileStatus).toBe("ok");
    expect(merged.tsx).toBe(VALID_HEADER_TSX);
    expect(merged.modelUsed).toBe("claude-sonnet-4-6");
    expect(merged.failureKind).toBeNull();

    const failedMerged = mergeShellUsage(
      { ...base, compileStatus: "failed" as const, failureKind: "invalid_tsx" as const },
      { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      1,
    );
    expect(failedMerged.failureKind).toBe("invalid_tsx");
    expect(failedMerged.compileStatus).toBe("failed");
  });
});
