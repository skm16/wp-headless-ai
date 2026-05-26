import { describe, it, expect, vi } from "vitest";

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
