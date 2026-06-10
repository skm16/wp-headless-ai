import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { validateTsx } from "./component-generator";
import {
  AnthropicModelClient,
  MockModelClient,
  modelClientForTier,
  modelConfigForTier,
  COMPONENT_TASK_BY_TIER,
  MAX_TOKENS_BY_TIER,
  __resetModelClientCacheForTests,
} from "./model-client";

// ---------------------------------------------------------------------------
// Fake SDK — captures messages.create args so tests assert REQUEST
// CONSTRUCTION (the cost-relevant behavior), not just response plumbing.
// ---------------------------------------------------------------------------

interface FakeResponseOverrides {
  stop_reason?: string | null;
  usage?: Record<string, number | null | undefined>;
  model?: string;
}

function makeFakeSdk(overrides: FakeResponseOverrides = {}) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "GENERATED_TSX" }],
    stop_reason: overrides.stop_reason === undefined ? "end_turn" : overrides.stop_reason,
    model: overrides.model ?? "claude-sonnet-4-6-echoed-by-api",
    usage: overrides.usage ?? {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 9,
    },
  });
  const sdk = { messages: { create } } as unknown as Anthropic;
  return { sdk, create };
}

function lastCreateArgs(create: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return create.mock.calls[create.mock.calls.length - 1][0] as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.JAB_GENERATE_MOCK;
  delete process.env.JAB_AI_MODEL_COMPONENT_VISUAL;
  __resetModelClientCacheForTests();
  vi.restoreAllMocks();
});

describe("AnthropicModelClient — request construction", () => {
  it("renders cachedSystemPrefix as the FIRST system block with cache_control, systemPrompt second (uncached)", async () => {
    const { sdk, create } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
    await client.generate({
      cachedSystemPrefix: "STABLE SHARED PREFIX",
      systemPrompt: "PER-BUILD SYSTEM",
      userPrompt: "go",
    });
    const args = lastCreateArgs(create);
    expect(args.system).toEqual([
      { type: "text", text: "STABLE SHARED PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "PER-BUILD SYSTEM" },
    ]);
  });

  it("emits NO cache_control anywhere when cachedSystemPrefix is absent", async () => {
    const { sdk, create } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
    await client.generate({ systemPrompt: "PER-BUILD SYSTEM", userPrompt: "go" });
    const args = lastCreateArgs(create);
    expect(args.system).toEqual([{ type: "text", text: "PER-BUILD SYSTEM" }]);
    expect(JSON.stringify(args)).not.toContain("cache_control");
  });

  it("passes the configured model and max_tokens through to messages.create", async () => {
    const { sdk, create } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-haiku-4-5-20251001", maxTokens: 2048, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "u" });
    const args = lastCreateArgs(create);
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(2048);
  });

  it("places the screenshot image block BEFORE the user text block", async () => {
    const { sdk, create } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "USER TEXT", screenshotBase64: "QkFTRTY0" });
    const args = lastCreateArgs(create);
    const messages = args.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QkFTRTY0" },
    });
    expect(messages[0].content[1]).toEqual({ type: "text", text: "USER TEXT" });
  });

  it("sends no image block when screenshotBase64 is absent", async () => {
    const { sdk, create } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "USER TEXT" });
    const args = lastCreateArgs(create);
    const messages = args.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0].content).toEqual([{ type: "text", text: "USER TEXT" }]);
  });
});

describe("AnthropicModelClient — response mapping", () => {
  it("maps usage, stopReason, and the API-echoed model into GenerateResult", async () => {
    const { sdk } = makeFakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
    const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(result.text).toBe("GENERATED_TSX");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheCreationTokens: 9,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("claude-sonnet-4-6-echoed-by-api");
  });

  it("defaults cache token fields to 0 when the API omits them", async () => {
    const { sdk } = makeFakeSdk({ usage: { input_tokens: 10, output_tokens: 5 } });
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
    const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheCreationTokens).toBe(0);
  });

  it("surfaces max_tokens as stopReason and normalizes unknown values to null", async () => {
    {
      const { sdk } = makeFakeSdk({ stop_reason: "max_tokens" });
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
      expect(result.stopReason).toBe("max_tokens");
    }
    {
      const { sdk } = makeFakeSdk({ stop_reason: "model_context_window_exceeded" });
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
      expect(result.stopReason).toBeNull();
    }
    {
      const { sdk } = makeFakeSdk({ stop_reason: null });
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
      expect(result.stopReason).toBeNull();
    }
  });
});

describe("MockModelClient", () => {
  it("returns valid TSX that passes validateTsx, with end_turn + its label as model", async () => {
    const client = new MockModelClient("claude-sonnet-4-6");
    const result = await client.generate({ systemPrompt: "ignored", userPrompt: "ignored" });
    expect(validateTsx(result.text, "MockBlock.tsx")).toEqual([]);
    expect(result.text).toContain('import type { BlockNode } from "@/lib/jab/ability-client"');
    expect(result.text).toContain("export function MockBlock(");
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("reports zero usage so cost telemetry records 0", async () => {
    const client = new MockModelClient("claude-haiku-4-5-20251001");
    const result = await client.generate({ systemPrompt: "ignored", userPrompt: "ignored" });
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("modelClientForTier", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("maps tiers to the component-* tasks", () => {
    expect(COMPONENT_TASK_BY_TIER).toEqual({
      visual: "component-visual",
      standard: "component-standard",
      trivial: "component-trivial",
    });
  });

  it("returns MockModelClient for every non-passthrough tier when JAB_GENERATE_MOCK=1", () => {
    process.env.JAB_GENERATE_MOCK = "1";
    expect(modelClientForTier("visual")).toBeInstanceOf(MockModelClient);
    expect(modelClientForTier("standard")).toBeInstanceOf(MockModelClient);
    expect(modelClientForTier("trivial")).toBeInstanceOf(MockModelClient);
  });

  it("returns AnthropicModelClient when JAB_GENERATE_MOCK is unset", () => {
    delete process.env.JAB_GENERATE_MOCK;
    expect(modelClientForTier("visual")).toBeInstanceOf(AnthropicModelClient);
    expect(modelClientForTier("standard")).toBeInstanceOf(AnthropicModelClient);
    expect(modelClientForTier("trivial")).toBeInstanceOf(AnthropicModelClient);
  });

  it("memoizes per model+maxTokens — repeated calls return the SAME instance", () => {
    const a = modelClientForTier("visual");
    const b = modelClientForTier("visual");
    expect(a).toBe(b);
    // standard differs by maxTokens → distinct instance
    expect(modelClientForTier("standard")).not.toBe(a);
  });

  it("__resetModelClientCacheForTests clears the memo", () => {
    const a = modelClientForTier("visual");
    __resetModelClientCacheForTests();
    const b = modelClientForTier("visual");
    expect(b).not.toBe(a);
  });

  it("resolves the model through getModelFor — JAB_AI_MODEL_COMPONENT_VISUAL reaches the client", () => {
    process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
    __resetModelClientCacheForTests();
    const client = modelClientForTier("visual") as AnthropicModelClient;
    expect(client.model).toBe("claude-haiku-4-5-20251001");
  });

  it("does NOT memoize mock clients (fresh instance per call)", () => {
    process.env.JAB_GENERATE_MOCK = "1";
    expect(modelClientForTier("visual")).not.toBe(modelClientForTier("visual"));
  });

  it("still throws for tier=passthrough even in mock mode", () => {
    process.env.JAB_GENERATE_MOCK = "1";
    expect(() => modelClientForTier("passthrough")).toThrow(/passthrough/);
  });
});

describe("modelConfigForTier", () => {
  afterEach(() => {
    delete process.env.JAB_AI_MODEL_COMPONENT_VISUAL;
    delete process.env.JAB_AI_MODEL;
  });

  it("returns the per-tier defaults (Sonnet visual/standard, Haiku trivial) with tier max_tokens", async () => {
    const { modelConfigForTier } = await import("./model-client");
    expect(modelConfigForTier("visual")).toEqual({ model: "claude-sonnet-4-6", maxTokens: 8192 });
    expect(modelConfigForTier("standard")).toEqual({ model: "claude-sonnet-4-6", maxTokens: 4096 });
    expect(modelConfigForTier("trivial")).toEqual({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 2048,
    });
  });

  it("honors the JAB_AI_MODEL_COMPONENT_VISUAL env override (Phase 1 hyphen-fixed key)", async () => {
    process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
    const { modelConfigForTier } = await import("./model-client");
    expect(modelConfigForTier("visual").model).toBe("claude-haiku-4-5-20251001");
  });

  it("modelClientForTier derives model and maxTokens from modelConfigForTier (single source)", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"; // real-client construction path (mirrors the modelClientForTier suite)
    for (const tier of ["visual", "standard", "trivial"] as const) {
      const client = modelClientForTier(tier) as AnthropicModelClient;
      expect(client).toBeInstanceOf(AnthropicModelClient);
      const config = modelConfigForTier(tier);
      expect(client.model).toBe(config.model);
      expect(client.maxTokens).toBe(config.maxTokens);
    }
  });
});

describe("per-call maxTokens override (Phase 2)", () => {
  function fakeSdk() {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "export function X() { return null; }" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
    });
    return { createSpy, sdk: { messages: { create: createSpy } } as unknown as Anthropic };
  }

  it("MAX_TOKENS_BY_TIER is the single tier→cap source", () => {
    expect(MAX_TOKENS_BY_TIER).toEqual({ visual: 8192, standard: 4096, trivial: 2048 });
  });

  it("uses the constructor maxTokens by default", async () => {
    const { createSpy, sdk } = fakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(createSpy.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it("a per-call maxTokens overrides the constructor default for that call only", async () => {
    const { createSpy, sdk } = fakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 12288 });
    await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(createSpy.mock.calls[0][0].max_tokens).toBe(12288);
    expect(createSpy.mock.calls[1][0].max_tokens).toBe(8192);
  });
});
