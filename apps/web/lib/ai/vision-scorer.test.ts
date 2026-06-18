import { describe, it, expect, vi, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVisionScorerClient } from "./vision-scorer";
import { VISION_SCORE_TOOL_SCHEMA, VISION_MAX_OUTPUT_TOKENS } from "./vision-prompt";

afterEach(() => vi.unstubAllEnvs());

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
    expect(req.max_tokens).toBe(VISION_MAX_OUTPUT_TOKENS);
    expect(typeof req.system).toBe("string");
    expect(req.system.length).toBeGreaterThan(0);
    // A forced tool_choice with no matching `tools` entry 400s in production —
    // pin the tool and its declaration TOGETHER so a dropped/renamed schema fails here.
    expect(req.tool_choice).toEqual({ type: "tool", name: "report_fidelity" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toBe(VISION_SCORE_TOOL_SCHEMA);
    expect(req.tools[0].name).toBe(req.tool_choice.name);

    const content = req.messages[0].content;
    // Image envelope (source.type/media_type), not just .data — a base64 or
    // media-type regression would otherwise pass.
    expect(content[0].type).toBe("image");
    expect(content[0].source.type).toBe("base64");
    expect(content[0].source.media_type).toBe("image/png");
    expect(content[0].source.data).toBe(src.toString("base64"));
    expect(content[1].type).toBe("image");
    expect(content[1].source.type).toBe("base64");
    expect(content[1].source.media_type).toBe("image/png");
    expect(content[1].source.data).toBe(gen.toString("base64"));
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("/about");
    // Cross-module invariant: the trailing text's "FIRST = ORIGINAL" wording
    // must stay consistent with content[0] being the SOURCE buffer. Catches a
    // swap of either the image order or the prompt wording without the other.
    expect(content[2].text).toContain("FIRST image is the ORIGINAL");
    expect(content[0].source.data).toBe(src.toString("base64"));
  });

  it("resolves the model per-call (honors JAB_AI_MODEL_FIDELITY_VISION override)", async () => {
    vi.stubEnv("JAB_AI_MODEL_FIDELITY_VISION", "claude-opus-4-8");
    const { sdk, create } = fakeSdk({ score: 0.9, issues: [] });
    const client = new AnthropicVisionScorerClient({ sdk });
    await client.score({ pixelDiffScore: 0.4, sourceBuffer: src, generatedBuffer: gen });
    expect(create.mock.calls[0][0].model).toBe("claude-opus-4-8");
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
