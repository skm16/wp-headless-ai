import "server-only";
import { getAnthropicClient } from "./client";
import type { AllowedModel } from "./model";
import type { GenerateUsage, StopReason } from "./model-client";
import { classifyAiError, isRetryableAiFailure, type AiFailureKind } from "./errors";

/**
 * batch-client.ts — Anthropic Message Batches wrapper for the build pipeline.
 *
 * Used ONLY behind JAB_BATCH_GENERATE=1 (Phase B component generation and the
 * Phase C shells-ride-along on full builds). 50% off all tokens at the cost
 * of batch queue latency; the workers cap their wait and fall back to the
 * sync path. The chat-edit regen path NEVER routes through this module.
 *
 * All calls go through the shared SDK singleton (getAnthropicClient) — never
 * construct `new Anthropic()` here.
 */

export interface BatchRequestItem {
  customId: string;
  model: AllowedModel;
  maxTokens: number;
  /** Stable shared prefix — rendered as the FIRST system block with cache_control. */
  cachedSystemPrefix?: string;
  /** Per-build system content — second (uncached) system block. */
  system: string;
  user: string;
  screenshotBase64?: string;
}

export interface BatchResultItem {
  customId: string;
  ok: boolean;
  text: string;
  usage: GenerateUsage;
  stopReason: StopReason;
  model: string;
  errorKind?: AiFailureKind;
}

const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Map an arbitrary string (block names contain `/`) onto the Batches API
 * custom_id constraint: 1-64 chars of [a-zA-Z0-9_-], unique per batch.
 * Mutates `taken` so a sequence of calls over one batch never collides.
 * Base is truncated to 56 chars; collision candidates append `_<n>` and are
 * clamped to 64 chars. With a 56-char base the clamp keeps `_` + 7 digits of
 * n, so clipping can't start before n = 10^7 — far beyond the API's per-batch
 * request cap. If clipping ever did map two n values to the same string, the
 * while re-check just advances n; the candidate is never a fixed point.
 */
export function sanitizeBatchCustomId(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56) || "item";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${n}`.slice(0, 64);
    n++;
  }
  taken.add(candidate);
  return candidate;
}

type SystemBlockShape = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};
type UserBlockShape =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

export interface BatchCreateRequestShape {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: SystemBlockShape[];
    messages: Array<{ role: "user"; content: UserBlockShape[] }>;
  };
}

/**
 * One BatchRequestItem → one Batches API request. Mirrors the Phase 1
 * AnthropicModelClient request shape exactly: [cached prefix block?, per-call
 * system block] + user message of [image?, text]. Exported for shape tests.
 */
export function buildBatchRequest(item: BatchRequestItem): BatchCreateRequestShape {
  const system: SystemBlockShape[] = [];
  if (item.cachedSystemPrefix) {
    system.push({
      type: "text",
      text: item.cachedSystemPrefix,
      cache_control: { type: "ephemeral" },
    });
  }
  system.push({ type: "text", text: item.system });

  const content: UserBlockShape[] = [];
  if (item.screenshotBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: item.screenshotBase64 },
    });
  }
  content.push({ type: "text", text: item.user });

  return {
    custom_id: item.customId,
    params: {
      model: item.model,
      max_tokens: item.maxTokens,
      system,
      messages: [{ role: "user", content }],
    },
  };
}

/** Submit one Message Batch. Returns the batch id. Throws loudly on invalid input. */
export async function submitGenerationBatch(items: BatchRequestItem[]): Promise<string> {
  if (items.length === 0) {
    throw new Error("[batch-client] submitGenerationBatch called with an empty item list");
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!CUSTOM_ID_RE.test(item.customId)) {
      throw new Error(
        `[batch-client] invalid custom_id ${JSON.stringify(item.customId)} — must match ${CUSTOM_ID_RE}. Use sanitizeBatchCustomId.`,
      );
    }
    if (seen.has(item.customId)) {
      throw new Error(`[batch-client] duplicate custom_id "${item.customId}" in one batch`);
    }
    seen.add(item.customId);
  }
  const sdk = getAnthropicClient();
  const requests = items.map(buildBatchRequest);
  const batch = await sdk.messages.batches.create({
    // Structural shape matches MessageCreateParamsNonStreaming; cast once at
    // the SDK boundary (same pattern as model-client.ts's system/content casts).
    requests: requests as unknown as Parameters<
      typeof sdk.messages.batches.create
    >[0]["requests"],
  });
  return batch.id;
}
