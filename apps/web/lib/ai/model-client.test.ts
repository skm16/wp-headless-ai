import { describe, it, expect, vi, afterEach } from "vitest";
import { validateTsx } from "./component-generator";

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "export function Heading() { return <h1>Hi</h1>; }" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    },
  })),
}));

describe("AnthropicModelClient", () => {
  it("returns generated text and usage stats (Sonnet)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { AnthropicModelClient } = await import("./model-client");
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096 });
    const result = await client.generate({
      systemPrompt: "You are a React component generator.",
      userPrompt: "Generate a heading component.",
      cacheSystemPrompt: false,
    });
    expect(result.text).toContain("Heading");
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });

  it("returns generated text and usage stats (Haiku)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { AnthropicModelClient } = await import("./model-client");
    const client = new AnthropicModelClient({ model: "claude-haiku-4-5-20251001", maxTokens: 2048 });
    const result = await client.generate({
      systemPrompt: "Generate React.",
      userPrompt: "Paragraph component.",
      cacheSystemPrompt: false,
    });
    expect(result.text).toContain("Heading");
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });
});

describe("MockModelClient", () => {
  afterEach(() => {
    delete process.env.JAB_GENERATE_MOCK;
  });

  it("returns valid TSX that passes validateTsx", async () => {
    const { MockModelClient } = await import("./model-client");
    const client = new MockModelClient("claude-sonnet-4-6");
    const result = await client.generate({
      systemPrompt: "ignored in mock",
      userPrompt: "ignored in mock",
      cacheSystemPrompt: false,
    });

    // TSX must be parseable — this is the gate component-generator enforces
    // after every real LLM call. If the mock fails this, the dry run is
    // useless because every component would fall through to passthrough.
    const errors = validateTsx(result.text, "MockBlock.tsx");
    expect(errors).toEqual([]);

    // Must look like a real component, not just any parseable code.
    expect(result.text).toContain('import type { BlockNode } from "@/lib/jab/ability-client"');
    expect(result.text).toContain("export function MockBlock(");
    expect(result.text).toContain("claude-sonnet-4-6");
  });

  it("reports zero usage so cost telemetry records 0", async () => {
    const { MockModelClient } = await import("./model-client");
    const client = new MockModelClient("claude-haiku-4-5-20251001");
    const result = await client.generate({
      systemPrompt: "ignored",
      userPrompt: "ignored",
      cacheSystemPrompt: false,
    });

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheCreationTokens).toBe(0);
  });
});

describe("modelClientForTier (mock-mode branching)", () => {
  afterEach(() => {
    delete process.env.JAB_GENERATE_MOCK;
  });

  it("returns MockModelClient for every non-passthrough tier when JAB_GENERATE_MOCK=1", async () => {
    process.env.JAB_GENERATE_MOCK = "1";
    const { modelClientForTier, MockModelClient } = await import("./model-client");

    expect(modelClientForTier("visual")).toBeInstanceOf(MockModelClient);
    expect(modelClientForTier("standard")).toBeInstanceOf(MockModelClient);
    expect(modelClientForTier("trivial")).toBeInstanceOf(MockModelClient);
  });

  it("returns AnthropicModelClient when JAB_GENERATE_MOCK is unset", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.JAB_GENERATE_MOCK;
    const { modelClientForTier, AnthropicModelClient } = await import("./model-client");

    expect(modelClientForTier("visual")).toBeInstanceOf(AnthropicModelClient);
    expect(modelClientForTier("standard")).toBeInstanceOf(AnthropicModelClient);
    expect(modelClientForTier("trivial")).toBeInstanceOf(AnthropicModelClient);
  });

  it("still throws for tier=passthrough even in mock mode (passthrough must skip the LLM path entirely)", async () => {
    process.env.JAB_GENERATE_MOCK = "1";
    const { modelClientForTier } = await import("./model-client");
    expect(() => modelClientForTier("passthrough")).toThrow(/passthrough/);
  });
});
