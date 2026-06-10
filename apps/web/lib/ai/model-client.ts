import "server-only";

/**
 * model-client.ts — provider-agnostic LLM interface for Phase B component
 * generation and the Phase C shell calls.
 *
 * Motivation: blocks route to different models by tier (design doc §6.4):
 *   visual:    component-visual task   (default Sonnet 4.6 — vision capable)
 *   standard:  component-standard task (default Sonnet 4.6 — text only)
 *   trivial:   component-trivial task  (default Haiku 4.5 — cheap scaffolds)
 * Defaults + JAB_AI_MODEL_* env overrides live in lib/ai/model.ts —
 * modelClientForTier resolves through getModelFor, so the documented
 * override surface actually governs these calls (it was dead before
 * the 2026-06-10 AI-call-optimization campaign).
 *
 * Prompt caching: callers pass `cachedSystemPrefix` ONLY when the prefix
 * clears the model's minimum cacheable size (2048 tokens on Sonnet 4.6,
 * 4096 on Haiku 4.5 — shorter prefixes silently never cache). The prefix is
 * rendered as the FIRST system text block with cache_control and must be
 * sent on EVERY attempt including retries (a request without the marker
 * performs no cache lookup, so dropping it on retry forfeits the
 * guaranteed-hit read).
 *
 * SDK instance: the process-wide singleton from lib/ai/client.ts (one
 * keep-alive pool, one shared rate-limit backoff state — see that file's
 * docblock). NEVER `new Anthropic()` outside client.ts; tests inject a
 * fake via the `sdk` option.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./client";
import { getModelFor, type AiTask, type AllowedModel } from "./model";
import type { Tier } from "@/lib/jab/inventory";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | null;

const KNOWN_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
] as const;

/** Map the SDK's stop_reason onto our union; unknown/new values become null. */
function normalizeStopReason(raw: string | null | undefined): StopReason {
  return raw != null && (KNOWN_STOP_REASONS as readonly string[]).includes(raw)
    ? (raw as StopReason)
    : null;
}

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: GenerateUsage;
  stopReason: StopReason;
  /** Model ID actually used — ground truth for telemetry; callers must persist THIS, never a re-hardcoded constant. */
  model: string;
}

export interface GenerateOptions {
  /** Optional stable shared prefix. Rendered as the FIRST system text block with cache_control {type:"ephemeral"} on EVERY call (including retries — never drop the marker on retry). Only pass when the prefix clears the model's minimum cacheable size (2048 tokens Sonnet 4.6 / 4096 Haiku 4.5); for Haiku-tier calls pass undefined. */
  cachedSystemPrefix?: string;
  /** Per-build/per-call system content; rendered as the second (uncached) system text block. */
  systemPrompt: string;
  userPrompt: string;
  screenshotBase64?: string;
}

export interface ModelClient {
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface AnthropicModelClientOptions {
  model: AllowedModel;
  maxTokens: number;
  /** Injectable for tests. Defaults to the shared singleton from client.ts. */
  sdk?: Anthropic;
}

export class AnthropicModelClient implements ModelClient {
  private readonly sdk: Anthropic;
  /** Resolved model ID this client dispatches to (readable for tests/telemetry). */
  readonly model: AllowedModel;
  readonly maxTokens: number;

  constructor(opts: AnthropicModelClientOptions) {
    this.sdk = opts.sdk ?? getAnthropicClient();
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];
    if (opts.cachedSystemPrefix) {
      systemBlocks.push({
        type: "text",
        text: opts.cachedSystemPrefix,
        cache_control: { type: "ephemeral" },
      });
    }
    systemBlocks.push({ type: "text", text: opts.systemPrompt });

    const userContent: Anthropic.Messages.ContentBlockParam[] = [];
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
      system: systemBlocks,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: normalizeStopReason(response.stop_reason),
      model: response.model,
    };
  }
}

/**
 * MockModelClient — dry-run client used when JAB_GENERATE_MOCK=1.
 *
 * Returns a fixed, valid TSX component without making any API calls. Used by
 * the Phase B smoke runner to verify the full orchestration (worker batching,
 * status transitions, Storage writes, DB updates, event dispatch) without
 * incurring Anthropic API cost.
 *
 * The emitted TSX:
 *   - Imports BlockNode (matches the real prompt's output contract)
 *   - Is a named export (matches `validateTsx` + composer expectations)
 *   - Parses cleanly under `ts.createSourceFile(..., ScriptKind.TSX)`
 *   - Contains a visible MOCK badge so a dry-run build can't be confused
 *     with a real one if it accidentally reaches a preview surface.
 *
 * Usage returns all zeros so `block_inventory` cost columns record 0 — a
 * clear signal in the DB that no LLM call fired. `model` echoes the label
 * (the resolved model id) and stopReason is always "end_turn".
 */
export class MockModelClient implements ModelClient {
  private readonly modelLabel: string;

  constructor(modelLabel: string) {
    this.modelLabel = modelLabel;
  }

  async generate(_opts: GenerateOptions): Promise<GenerateResult> {
    const tsx = `import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * MOCK component — generated with JAB_GENERATE_MOCK=1 (no API call made).
 * Used for verifying the Phase B orchestration end-to-end at zero cost.
 */
export function MockBlock({ block }: { block: BlockNode }) {
  return (
    <div className="p-4 border-2 border-dashed border-amber-500 bg-amber-50 dark:bg-amber-950">
      <div className="text-xs font-mono text-amber-700 dark:text-amber-400">MOCK · ${this.modelLabel} · dry-run</div>
      <pre className="text-xs mt-2 overflow-x-auto">{JSON.stringify(block.attrs ?? {}, null, 2)}</pre>
    </div>
  );
}
`;
    return {
      text: tsx,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      stopReason: "end_turn",
      model: this.modelLabel,
    };
  }
}

let mockNoticeShown = false;
function noteMockMode(): void {
  if (mockNoticeShown) return;
  mockNoticeShown = true;
  console.warn(
    "[model-client] JAB_GENERATE_MOCK=1 detected — MockModelClient active. No Anthropic API calls will be made; cost telemetry will report 0 for this run.",
  );
}

/** Tier → model.ts task. Exported so workers/scripts resolve the same way. */
export const COMPONENT_TASK_BY_TIER: Record<"visual" | "standard" | "trivial", AiTask> = {
  visual: "component-visual",
  standard: "component-standard",
  trivial: "component-trivial",
};

/** Per-tier output budgets (unchanged from the pre-campaign table). */
const MAX_TOKENS_BY_TIER: Record<"visual" | "standard" | "trivial", number> = {
  visual: 8192,
  standard: 4096,
  trivial: 2048,
};

/**
 * Memoized real clients, keyed model:maxTokens. One AnthropicModelClient per
 * configuration per process — they all share the client.ts SDK singleton, so
 * this only avoids object churn and keeps `client === client` stable for the
 * lifetime of a worker. Mock clients are NEVER memoized (cheap, stateless,
 * and tests toggle JAB_GENERATE_MOCK between cases).
 */
const clientCache = new Map<string, AnthropicModelClient>();

export function __resetModelClientCacheForTests(): void {
  clientCache.clear();
}

/**
 * Returns the appropriate ModelClient for a given block tier.
 *
 * Model resolution goes through getModelFor(COMPONENT_TASK_BY_TIER[tier]) —
 * defaults match the old hardcoded table (Sonnet 4.6 for visual/standard,
 * Haiku 4.5 pinned snapshot for trivial), and the JAB_AI_MODEL_* env
 * overrides now actually reach this path.
 *
 * If JAB_GENERATE_MOCK=1 is set in the environment, returns a MockModelClient
 * instead — used by the smoke runner's dry-run mode to verify orchestration
 * without API cost. The env var must be set in the Inngest dev server's
 * process (which reads .env.local at boot), not just the smoke script.
 */
export function modelClientForTier(tier: Tier): ModelClient {
  if (tier === "passthrough") {
    throw new Error(
      "modelClientForTier called with tier=passthrough — caller should skip LLM for passthrough blocks",
    );
  }

  const mockEnabled = process.env.JAB_GENERATE_MOCK === "1";
  if (mockEnabled) noteMockMode();

  const model = getModelFor(COMPONENT_TASK_BY_TIER[tier]);
  const maxTokens = MAX_TOKENS_BY_TIER[tier];

  if (mockEnabled) return new MockModelClient(model);

  const key = `${model}:${maxTokens}`;
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = new AnthropicModelClient({ model, maxTokens });
  clientCache.set(key, client);
  return client;
}
