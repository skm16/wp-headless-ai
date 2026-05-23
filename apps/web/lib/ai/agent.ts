import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemBlocks, buildUserPrompt, type PromptContext } from "./prompts";

/**
 * AI page-generation call.
 *
 * One-shot Messages API call (not Agent SDK iterative tool use — see
 * scripts/validate-ai/README.md for the rationale: simpler to reason about
 * for first version, faster to iterate, sufficient quality for v0).
 *
 * Returns the extracted code block + token usage so the worker can persist
 * billing baselines.
 */

const MODEL = "claude-sonnet-4-6" as const;
const MAX_OUTPUT_TOKENS = 8192;

export interface GenerationResult {
  code: string;
  rawResponse: string;
  model: typeof MODEL;
  usage: Anthropic.Messages.Usage;
  stopReason: Anthropic.Messages.Message["stop_reason"];
}

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AgentError(
      "ANTHROPIC_API_KEY not set. Generate at console.anthropic.com → API Keys.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function generatePageCode(
  ctx: PromptContext,
): Promise<GenerationResult> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildSystemBlocks(ctx.sdkSource),
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    });
  } catch (err) {
    throw new AgentError(
      err instanceof Error ? `Anthropic API call failed: ${err.message}` : `Anthropic API call failed: ${String(err)}`,
      err,
    );
  }

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const code = extractCodeBlock(fullText);
  if (!code) {
    throw new AgentError(
      `Model response did not include a tsx code block (stop_reason=${response.stop_reason}). First 200 chars: ${fullText.slice(0, 200)}`,
    );
  }

  return {
    code,
    rawResponse: fullText,
    model: MODEL,
    usage: response.usage,
    stopReason: response.stop_reason,
  };
}

/**
 * Extracts the first ```tsx (or ```ts / ```typescript) code block. Tolerates
 * trailing whitespace before the closing fence, since some Anthropic
 * responses include a final newline + trailing spaces.
 */
function extractCodeBlock(text: string): string | null {
  const re = /```(?:tsx|ts|typescript)?\s*\n([\s\S]*?)\n\s*```/i;
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}
