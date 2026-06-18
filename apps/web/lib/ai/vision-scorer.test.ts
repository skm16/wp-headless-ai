import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVisionScorerClient } from "./vision-scorer";

/** Fake SDK whose messages.create resolves a single tool_use response. */
function fakeSdk(input: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "tu_1", name: "report_fidelity", input }],
    stop_reason: "tool_use",
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...over,
  });
  return { sdk: { messages: { create } } as unknown as Anthropic, create };
}

const src = Buffer.from([1, 2, 3]);
const gen = Buffer.from([4, 5, 6]);

describe("AnthropicVisionScorerClient.score", () => {
  it("sends source-first then generated image blocks, forces the tool, and resolves the parsed score", async () => {
    const { sdk, create } = fakeSdk({ score: 0.91, issues: [] });
    const client = new AnthropicVisionScorerClient({ sdk });
    const res = await client.score({
      pixelDiffScore: 0.4,
      sourceBuffer: src,
      generatedBuffer: gen,
      routePath: "/about",
      blockNames: ["core/cover"],
    });
    expect(res.score).toBe(0.91);

    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.tool_choice).toEqual({ type: "tool", name: "report_fidelity" });
    const content = req.messages[0].content;
    expect(content[0].type).toBe("image");
    expect(content[0].source.data).toBe(src.toString("base64"));
    expect(content[1].type).toBe("image");
    expect(content[1].source.data).toBe(gen.toString("base64"));
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("/about");
  });

  it("parses issues and clamps the score from the tool input", async () => {
    const { sdk } = fakeSdk({
      score: 1.5,
      issues: [{ block_name: "core/cover", severity: "high", description: "broken hero" }],
    });
    const client = new AnthropicVisionScorerClient({ sdk });
    const res = await client.score({ pixelDiffScore: 0.2, sourceBuffer: src, generatedBuffer: gen });
    expect(res.score).toBe(1);
    expect(res.issues[0].description).toBe("broken hero");
  });

  it("throws when a screenshot buffer is missing (worker catches → fail-soft)", async () => {
    const { sdk } = fakeSdk({ score: 0.9, issues: [] });
    const client = new AnthropicVisionScorerClient({ sdk });
    await expect(
      client.score({ pixelDiffScore: 0.4, sourceBuffer: src, generatedBuffer: undefined }),
    ).rejects.toThrow(/buffer/i);
  });

  it("throws when the model returns no tool_use block", async () => {
    const { sdk } = fakeSdk(
      {},
      { content: [{ type: "text", text: "no tool" }], stop_reason: "end_turn" },
    );
    const client = new AnthropicVisionScorerClient({ sdk });
    await expect(
      client.score({ pixelDiffScore: 0.4, sourceBuffer: src, generatedBuffer: gen }),
    ).rejects.toThrow(/tool_use/i);
  });
});
