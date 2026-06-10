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

/**
 * Poll a batch. "errored" is returned (NOT thrown) for retryable transport
 * failures so the worker's poll loop just counts the poll and sleeps again
 * (batches.retrieve is idempotent). Non-retryable failures (auth,
 * bad_request) rethrow — polling cannot fix a revoked key.
 */
export async function getBatchStatus(
  batchId: string,
): Promise<"in_progress" | "ended" | "canceling" | "errored"> {
  try {
    const batch = await getAnthropicClient().messages.batches.retrieve(batchId);
    return batch.processing_status;
  } catch (err) {
    const kind = classifyAiError(err);
    if (isRetryableAiFailure(kind)) {
      console.warn(`[batch-client] retrieve(${batchId}) transient failure (${kind})`, err);
      return "errored";
    }
    throw err;
  }
}

/** Wire error.type values from a batch's errored rows → AiFailureKind. */
export function errorKindFromBatchError(errorType: string): AiFailureKind {
  switch (errorType) {
    case "rate_limit_error":
      return "rate_limit";
    case "overloaded_error":
      return "overloaded";
    case "api_error":
      return "server_error";
    case "timeout_error":
      return "connection";
    case "invalid_request_error":
    case "not_found_error":
      return "bad_request";
    case "authentication_error":
    case "permission_error":
    case "billing_error":
      return "auth";
    default:
      return "unknown";
  }
}

const ZERO_BATCH_USAGE: GenerateUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Structural row shape (mirrors MessageBatchIndividualResponse) so tests feed plain objects. */
export interface BatchRowShape {
  custom_id: string;
  result:
    | {
        type: "succeeded";
        message: {
          model: string;
          stop_reason: string | null;
          content: Array<{ type: string; text?: string }>;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
          };
        };
      }
    | { type: "errored"; error: { type: "error"; error: { type: string; message?: string } } }
    | { type: "canceled" }
    | { type: "expired" };
}

/** One JSONL row → BatchResultItem. Exported for tests. */
export function mapBatchRow(row: BatchRowShape): BatchResultItem {
  switch (row.result.type) {
    case "succeeded": {
      const msg = row.result.message;
      const text = msg.content.find((b) => b.type === "text")?.text ?? "";
      return {
        customId: row.custom_id,
        ok: true,
        text,
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
        },
        stopReason: (msg.stop_reason ?? null) as StopReason,
        model: msg.model,
      };
    }
    case "errored":
      return {
        customId: row.custom_id,
        ok: false,
        text: "",
        usage: ZERO_BATCH_USAGE,
        stopReason: null,
        model: "",
        errorKind: errorKindFromBatchError(row.result.error.error.type),
      };
    case "expired":
    case "canceled":
      // Not processed → not billed. "unknown" routes these to the worker's
      // sync fallback (neither fail-fast nor wave-2-corrective).
      return {
        customId: row.custom_id,
        ok: false,
        text: "",
        usage: ZERO_BATCH_USAGE,
        stopReason: null,
        model: "",
        errorKind: "unknown",
      };
  }
}

/** Stream + map all results of an ended batch. */
export async function collectBatchResults(batchId: string): Promise<BatchResultItem[]> {
  const sdk = getAnthropicClient();
  const stream = await sdk.messages.batches.results(batchId);
  const out: BatchResultItem[] = [];
  for await (const row of stream) {
    out.push(mapBatchRow(row as unknown as BatchRowShape));
  }
  return out;
}

/**
 * Best-effort cancel — used by the worker's poll-timeout path so a batch we
 * stopped waiting for doesn't keep burning tokens we'll re-spend in the sync
 * fallback. Errors are swallowed: cancel-after-ended is a no-op race, and a
 * failed cancel only costs money, never correctness.
 */
export async function cancelGenerationBatch(batchId: string): Promise<void> {
  try {
    await getAnthropicClient().messages.batches.cancel(batchId);
  } catch (err) {
    console.warn(`[batch-client] cancel(${batchId}) failed (continuing):`, err);
  }
}
