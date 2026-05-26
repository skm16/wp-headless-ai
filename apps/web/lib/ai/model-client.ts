import "server-only";

/**
 * model-client.ts — provider-agnostic LLM interface for Phase B component generation.
 *
 * Motivation: Phase B routes blocks to different models by tier (design doc §6.4):
 *   visual:    Anthropic Sonnet 4.6 (vision capable, top React code-gen quality)
 *   standard:  Anthropic Sonnet 4.6 (text only, same quality, no vision overhead)
 *   trivial:   Anthropic Haiku 4.5 (fast + cheap, fine for heading/para scaffolds)
 *
 * The ModelClient interface decouples the generation worker from a specific SDK.
 * Provider swaps (GPT-5, Gemini 2.0, Grok 4) are a seam-only change: implement the
 * interface, swap the factory config table. Keeping everything on Anthropic for v1
 * means one SDK, one set of API keys, one cache+observability surface.
 *
 * Prompt caching: applied in component-generator.ts via the cache_control marker —
 * this client just passes the structured content through unchanged.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tier } from "@/lib/jab/inventory";

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: GenerateUsage;
}

export interface GenerateOptions {
  systemPrompt: string;
  userPrompt: string;
  /** When true, wraps the systemPrompt text block with cache_control: {type:"ephemeral"}. */
  cacheSystemPrompt: boolean;
  /** Optional base64-encoded PNG screenshot bytes (visual tier only). */
  screenshotBase64?: string;
}

export interface ModelClient {
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface AnthropicModelClientOptions {
  model: "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";
  maxTokens: number;
}

export class AnthropicModelClient implements ModelClient {
  private readonly sdk: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicModelClientOptions) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set.");
    }
    this.sdk = new Anthropic({ apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    type ContentBlock =
      | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
      | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

    const systemContent: ContentBlock[] = [
      {
        type: "text",
        text: opts.systemPrompt,
        ...(opts.cacheSystemPrompt ? { cache_control: { type: "ephemeral" } } : {}),
      },
    ];

    const userContent: ContentBlock[] = [];
    if (opts.screenshotBase64) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: opts.screenshotBase64 },
      });
    }
    userContent.push({ type: "text", text: opts.userPrompt });

    const response = await this.sdk.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemContent as Parameters<typeof this.sdk.messages.create>[0]["system"],
      messages: [{ role: "user", content: userContent as Parameters<typeof this.sdk.messages.create>[0]["messages"][number]["content"] }],
    });

    const text =
      response.content.find((b) => b.type === "text")?.text ?? "";
    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    return {
      text,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/**
 * Returns the appropriate ModelClient for a given block tier.
 * Per design doc §6.4 model table (Anthropic-only for v1).
 */
export function modelClientForTier(tier: Tier): ModelClient {
  switch (tier) {
    case "visual":
      return new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192 });
    case "standard":
      return new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096 });
    case "trivial":
      return new AnthropicModelClient({ model: "claude-haiku-4-5-20251001", maxTokens: 2048 });
    case "passthrough":
      throw new Error("modelClientForTier called with tier=passthrough — caller should skip LLM for passthrough blocks");
  }
}
