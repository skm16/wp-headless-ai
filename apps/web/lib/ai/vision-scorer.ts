import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./client";
import { getModelFor } from "./model";
import {
  VISION_SCORE_TOOL_SCHEMA,
  VISION_MAX_OUTPUT_TOKENS,
  buildVisionSystemPrompt,
  buildVisionUserText,
  parseVisionToolUse,
} from "./vision-prompt";
import type { VisionScoreInput, VisionScoreResult } from "./fidelity-score";

/**
 * vision-scorer — the real Anthropic-backed vision fidelity scorer (Phase 7.1).
 *
 * Forces report_fidelity tool-use so the only output channel is a structured
 * { score, issues }. Mirrors AnthropicPlannerClient: SDK singleton, injectable
 * `sdk` for tests, model resolved per-call via getModelFor("fidelity-vision").
 *
 * The SDK retries transient failures (rate_limit / overloaded / 5xx / network)
 * with its built-in backoff; we add none. Any error that survives that — or a
 * missing buffer / no tool block — throws, and the verify-fidelity worker's
 * existing per-page try/catch converts it to a pixel-score + vision_unavailable
 * fallback. Vision must never fail a build.
 */
export interface VisionScorerClient {
  score(input: VisionScoreInput): Promise<VisionScoreResult>;
}

export class AnthropicVisionScorerClient implements VisionScorerClient {
  private readonly sdk: Anthropic;

  constructor(opts?: { sdk?: Anthropic }) {
    this.sdk = opts?.sdk ?? getAnthropicClient();
  }

  async score(input: VisionScoreInput): Promise<VisionScoreResult> {
    if (!input.sourceBuffer || !input.generatedBuffer) {
      throw new Error(
        "vision-scorer: missing source/generated screenshot buffer — cannot run the vision pass",
      );
    }

    const userContent: Anthropic.Messages.ContentBlockParam[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: input.sourceBuffer.toString("base64") },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: input.generatedBuffer.toString("base64") },
      },
      {
        type: "text",
        text: buildVisionUserText({
          routePath: input.routePath,
          blockNames: input.blockNames,
          pixelDiffScore: input.pixelDiffScore,
        }),
      },
    ];

    const response = await this.sdk.messages.create({
      model: getModelFor("fidelity-vision"),
      max_tokens: VISION_MAX_OUTPUT_TOKENS,
      system: buildVisionSystemPrompt(),
      tools: [VISION_SCORE_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: VISION_SCORE_TOOL_SCHEMA.name },
      messages: [{ role: "user", content: userContent }],
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput =
      toolBlock && toolBlock.type === "tool_use"
        ? (toolBlock.input as Record<string, unknown>)
        : null;
    if (!rawInput) {
      throw new Error(
        `vision-scorer: model returned no tool_use block (stop_reason=${response.stop_reason})`,
      );
    }

    const u = response.usage;
    console.log(
      `[vision-scorer] ${input.routePath ?? "?"} model=${response.model} in=${u.input_tokens} out=${u.output_tokens}`,
    );

    return parseVisionToolUse(rawInput, input.pixelDiffScore);
  }
}
