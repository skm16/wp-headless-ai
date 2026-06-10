# Batch API for Build Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Phase B component generation (and, on full builds, the Phase C header/footer shells) through the Anthropic Message Batches API behind `JAB_BATCH_GENERATE=1` for a 50% discount on all tokens, with a byte-identical sync path when the flag is off and the chat-edit regen path never batching.

**Architecture:** A new `lib/ai/batch-client.ts` wraps `getAnthropicClient().messages.batches.{create,retrieve,results,cancel}` behind typed `BatchRequestItem`/`BatchResultItem` contracts; a pure engine in `lib/jab/component-batch.ts` plans waves (partition, custom_id sanitization, wave-2 corrective items, poll verdicts) and finalizes results through the same validate/persist pipeline the sync path uses. The `generate-components` Inngest worker grows a flag-gated branch: wave-1 batch submit → durable `step.sleep` 30s poll loop (60-poll cap) → local validation → wave-2 corrective batch → sync fallback for stragglers; `compose-site` gets an analogous shells-ride-along for full (non-edit) builds.

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 3 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: Phase 1 (model-client `GenerateResult`/`StopReason`/`GenerateUsage`, `lib/ai/errors.ts`, `getAnthropicClient` adoption, `COMPONENT_TASK_BY_TIER`, migration 0034 telemetry columns) and Phase 2 (`COMPONENT_SYSTEM_CORE` prompt split, `buildRetryUserSuffix`, stop_reason handling, shell `{ system, user }` prompt builders + `shouldCacheShellPrefix`, sequential header→footer shells).

---

## Context & invariants (read before Task 1)

**Latency tradeoff (the deliberate cost of this phase).** The sync path returns each component in seconds; a Message Batch returns results only when the whole batch ends — typically minutes for a ~25-request batch, contractually up to 24h. The worker caps its wait at **60 polls × 30s ≈ 30 minutes per wave** and then falls back to the sync path for unfinished items, so worst-case wall time added to a full build is ~60 min (two waves) before sync recovery kicks in. This is acceptable ONLY for the queued build pipeline (discover → components → compose → deploy → verify → mandatory human review): nobody is blocked on first-token latency there. It is NOT acceptable for chat-edit regens (`lib/jab/regenerate-unit.ts` calls `generateComponent` directly and is untouched by this plan) — a user is actively waiting on the edit→preview loop. Savings: 50% off ALL tokens (input, output, cache writes/reads), combinable with the Phase 2 prompt caching — but note that identical cached prefixes *inside one batch* may all miss (concurrent-write rule); batch savings do not depend on cache hits.

**Flag matrix.**

| Env | Effect |
| --- | --- |
| `JAB_BATCH_GENERATE` unset / anything ≠ `"1"` | Sync path, byte-identical to pre-phase behavior |
| `JAB_BATCH_GENERATE=1` | Phase B LLM-tier entries batch; Phase C shells batch on full builds only |
| `JAB_GENERATE_MOCK=1` | **Wins over the batch flag** — MockModelClient sync path, $0, no batches API calls |
| edit builds (`config.mode === "edit"`) | Shells never batch (sequential sync stays); component regen never batches |

**Line-ref disclaimer.** All file/line refs below were verified 2026-06-10 at commit `b91d86a` (branch `feat/saas-e2e-loop`), BEFORE Phases 1–2 land. Phases 1–2 modify `model-client.ts`, `component-generator.ts`, `generate-shell.ts`, `shell-prompts.ts`, and `compose-site.ts`, so **re-locate every edit point by the quoted anchor text, not the line number**. Where a task moves post-Phase-2 code into a helper, the task pins faithfulness with an equivalence test rather than assuming the exact post-Phase-2 source.

**Contracts used from prior phases (cite: CONTRACTS block of the campaign).**
- Phase 1 `lib/ai/model-client.ts`: `GenerateUsage { inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens }`, `StopReason`, `GenerateResult { text; usage; stopReason; model }`, `GenerateOptions { cachedSystemPrefix?; systemPrompt; userPrompt; screenshotBase64? }`, `COMPONENT_TASK_BY_TIER`, `modelClientForTier` resolving via `getModelFor`, shared SDK via `getAnthropicClient()` from `lib/ai/client.ts`.
- Phase 1 `lib/ai/errors.ts`: `AiFailureKind`, `classifyAiError`, `isRetryableAiFailure`.
- Phase 1 migration `0034_ai_cost_telemetry.sql`: `block_inventory.failure_kind`, `input_tokens_cache_creation` — must be applied to BOTH Supabase projects (local "JAB WP" `ajfurojjxthhzkjqttri`, prod "jab-prod" `celzwcxkrmsbwiswkxug`) before any live batch run, stacked after the still-pending 0032+0033.
- Phase 2 `lib/ai/component-generator.ts`: `COMPONENT_SYSTEM_CORE`, `COMPONENT_PROMPT_VERSION`, `buildRetryUserSuffix(errors: string[], outputTail: string): string`, `GeneratedComponent` gains `failureKind`, trivial/Haiku tier passes `cachedSystemPrefix: undefined`.
- Phase 2 `lib/ai/shell-prompts.ts` / `generate-shell.ts`: prompt builders return `{ system: string; user: string }`, `shouldCacheShellPrefix(text)`, header runs before footer sequentially.

**SDK surface (verified against `@anthropic-ai/sdk` 0.95.1, `node_modules/.pnpm/@anthropic-ai+sdk@0.95.1_zod@3.25.76/.../resources/messages/batches.d.ts`):** `client.messages.batches.create({ requests: [{ custom_id, params }] })` → `MessageBatch { id, processing_status: 'in_progress' | 'canceling' | 'ended', request_counts, results_url }`; `batches.retrieve(id)`; `batches.results(id)` → async-iterable of `MessageBatchIndividualResponse { custom_id, result }` where `result.type ∈ succeeded | errored | canceled | expired`, `errored` carries `error: { type: 'error', error: { type: ErrorType } }` with `ErrorType = 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error' | 'rate_limit_error' | 'timeout_error' | 'overloaded_error' | 'api_error' | 'billing_error'`; `batches.cancel(id)`. `custom_id` must be 1–64 chars of `[a-zA-Z0-9_-]` and unique per batch.

**Test command.** `apps/web/package.json` (verified): `"test": "vitest run"`. Run a single file from the repo root as `pnpm --filter @jab/web test <relative-path>`; full suite `pnpm --filter @jab/web test`; typecheck `pnpm --filter @jab/web typecheck`.

---

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/web/lib/ai/batch-client.ts` | **Create** | Message Batches wrapper: `submitGenerationBatch` / `getBatchStatus` / `collectBatchResults` per CONTRACTS, plus `sanitizeBatchCustomId`, `buildBatchRequest`, `mapBatchRow`, `errorKindFromBatchError`, `cancelGenerationBatch` |
| `apps/web/lib/ai/batch-client.test.ts` | **Create** | Request-shape (cache_control blocks, custom_id), result-mapping (succeeded/errored/expired/canceled), status + cancel tests with mocked SDK |
| `apps/web/lib/ai/model-client.ts` | Modify | Export `modelConfigForTier(tier)` — single source for tier → `{ model, maxTokens }` used by both clients and batch items |
| `apps/web/lib/ai/model-client.test.ts` | Modify | Pin `modelConfigForTier` defaults + env override |
| `apps/web/lib/ai/component-generator.ts` | Modify | Export `buildComponentRequestParts` (extraction of the post-Phase-2 prompt split), `finalizeBatchGeneration`, `failedBatchComponent`, `addUsage`, `mergeUsageIntoComponent` |
| `apps/web/lib/ai/component-generator.test.ts` | Modify | Extraction-equivalence test; batch-vs-sync persisted-row identity test; finalize outcome tests |
| `apps/web/lib/jab/component-batch.ts` | **Create** | Pure batch-plan engine: `isBatchGenerateEnabled`, `partitionInventoryForBatch`, `buildComponentBatchItems`, `buildWave2Item`, `pollVerdict`, constants; plus the persisting `finalizeComponentWave` |
| `apps/web/lib/jab/component-batch.test.ts` | **Create** | Flag-gate (incl. mock precedence), partition, item-shape, wave-2 corrective item, pollVerdict, wave finalizer routing tests |
| `apps/web/lib/inngest/functions/generate-components.ts` | Modify | Flag-gated batch branch (wave-1 submit → poll → finalize → wave-2 → sync fallback); sync loop untouched inside `if (!batchEnabled)` |
| `apps/web/lib/ai/generate-shell.ts` | Modify | Export `buildShellRequestParts` (extraction), `buildShellBatchItem`, `finalizeShellBatchResult`, `mergeShellUsage` |
| `apps/web/lib/ai/generate-shell.test.ts` | Modify | Shell batch item/finalize tests (null on empty shellDom, fallback null on invalid TSX, usage merge) |
| `apps/web/lib/inngest/functions/compose-site.ts` | Modify | Shells-ride-along branch for `JAB_BATCH_GENERATE=1 && mode !== "edit"`; existing sequential path untouched in the else branch |
| `apps/web/.env.local.example` | Modify | Document `JAB_BATCH_GENERATE` under the feature-flags section (after line 92, verified) |
| `docs/batch-generation-runbook.md` | **Create** | Operator runbook: watch a batch, cancel a batch, latency/cost tradeoff, flag matrix |

---

### Task 1: batch-client request side — sanitizer, request builder, submitGenerationBatch

**Files:**
- Create: `apps/web/lib/ai/batch-client.ts`
- Create: `apps/web/lib/ai/batch-client.test.ts`

The custom_id constraint is 1–64 chars of `[a-zA-Z0-9_-]`. Block names like `acf_flex/page/page_builder/hero_section` contain `/`, so a sanitizer is required, with collision disambiguation because sanitization + truncation can collide.

- [ ] Write the failing test file `apps/web/lib/ai/batch-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./client", () => ({ getAnthropicClient: vi.fn() }));

import { getAnthropicClient } from "./client";
import {
  sanitizeBatchCustomId,
  buildBatchRequest,
  submitGenerationBatch,
  type BatchRequestItem,
} from "./batch-client";

function makeItem(over: Partial<BatchRequestItem> = {}): BatchRequestItem {
  return {
    customId: "core_button",
    model: "claude-sonnet-4-6",
    maxTokens: 8192,
    system: "per-build system",
    user: "user prompt",
    ...over,
  };
}

describe("sanitizeBatchCustomId", () => {
  it("replaces disallowed chars and stays within 1-64 [a-zA-Z0-9_-]", () => {
    const taken = new Set<string>();
    const id = sanitizeBatchCustomId("acf_flex/page/page_builder/hero_section", taken);
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(id).toBe("acf_flex_page_page_builder_hero_section");
  });

  it("truncates long names to <= 64 chars", () => {
    const taken = new Set<string>();
    const id = sanitizeBatchCustomId("x".repeat(200), taken);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("disambiguates collisions deterministically", () => {
    const taken = new Set<string>();
    const a = sanitizeBatchCustomId("core/button", taken);
    const b = sanitizeBatchCustomId("core button", taken); // sanitizes to the same base
    expect(a).toBe("core_button");
    expect(b).toBe("core_button_2");
    expect(a).not.toBe(b);
  });

  it("falls back to a non-empty id for all-invalid input", () => {
    const taken = new Set<string>();
    expect(sanitizeBatchCustomId("///", taken)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("buildBatchRequest", () => {
  it("renders cachedSystemPrefix as the FIRST system block with cache_control, per-call system second (uncached)", () => {
    const req = buildBatchRequest(makeItem({ cachedSystemPrefix: "STATIC CORE", system: "per-build" }));
    expect(req.custom_id).toBe("core_button");
    expect(req.params.model).toBe("claude-sonnet-4-6");
    expect(req.params.max_tokens).toBe(8192);
    expect(req.params.system).toEqual([
      { type: "text", text: "STATIC CORE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per-build" },
    ]);
  });

  it("renders a single uncached system block when cachedSystemPrefix is absent (Haiku tier)", () => {
    const req = buildBatchRequest(makeItem());
    expect(req.params.system).toEqual([{ type: "text", text: "per-build system" }]);
  });

  it("puts the screenshot image block BEFORE the user text block", () => {
    const req = buildBatchRequest(makeItem({ screenshotBase64: "aGk=" }));
    const content = req.params.messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGk=" },
    });
    expect(content[1]).toEqual({ type: "text", text: "user prompt" });
  });
});

describe("submitGenerationBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits all items via messages.batches.create and returns the batch id", async () => {
    const create = vi.fn().mockResolvedValue({ id: "msgbatch_abc" });
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { create } } });

    const id = await submitGenerationBatch([
      makeItem({ customId: "a" }),
      makeItem({ customId: "b", model: "claude-haiku-4-5-20251001", maxTokens: 2048 }),
    ]);

    expect(id).toBe("msgbatch_abc");
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.requests).toHaveLength(2);
    expect(body.requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(["a", "b"]);
    expect(body.requests[1].params.model).toBe("claude-haiku-4-5-20251001");
    expect(body.requests[1].params.max_tokens).toBe(2048);
  });

  it("throws loudly on duplicate custom_id", async () => {
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { create: vi.fn() } } });
    await expect(
      submitGenerationBatch([makeItem({ customId: "dup" }), makeItem({ customId: "dup" })]),
    ).rejects.toThrow(/duplicate custom_id/);
  });

  it("throws loudly on an invalid custom_id", async () => {
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { create: vi.fn() } } });
    await expect(submitGenerationBatch([makeItem({ customId: "has/slash" })])).rejects.toThrow(
      /custom_id/,
    );
  });

  it("throws on an empty item list", async () => {
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { create: vi.fn() } } });
    await expect(submitGenerationBatch([])).rejects.toThrow(/empty/);
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/batch-client.test.ts` — expect failure: `Cannot find module './batch-client'`.
- [ ] Create `apps/web/lib/ai/batch-client.ts`:

```ts
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
 * Base is truncated to 56 chars, leaving room for a `_NN` collision suffix.
 */
export function sanitizeBatchCustomId(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56) || "item";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${n}`;
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
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/batch-client.test.ts` — expect PASS (the result-side describe blocks don't exist yet, so only these suites run).
- [ ] Commit: `git add apps/web/lib/ai/batch-client.ts apps/web/lib/ai/batch-client.test.ts && git commit -m "feat(saas): batch-client request side — Message Batches submit + custom_id sanitizer"`

---

### Task 2: batch-client result side — getBatchStatus, collectBatchResults, cancelGenerationBatch

**Files:**
- Modify: `apps/web/lib/ai/batch-client.ts` (append after `submitGenerationBatch`)
- Modify: `apps/web/lib/ai/batch-client.test.ts` (append suites)

- [ ] Append failing tests to `apps/web/lib/ai/batch-client.test.ts`:

```ts
import {
  getBatchStatus,
  collectBatchResults,
  cancelGenerationBatch,
  mapBatchRow,
  errorKindFromBatchError,
  type BatchRowShape,
} from "./batch-client";

describe("getBatchStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the processing_status from retrieve", async () => {
    const retrieve = vi.fn().mockResolvedValue({ processing_status: "ended" });
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { retrieve } } });
    expect(await getBatchStatus("msgbatch_1")).toBe("ended");
    expect(retrieve).toHaveBeenCalledWith("msgbatch_1");
  });

  it("maps a transient retrieve failure to 'errored' so the poll loop can continue", async () => {
    // classifyAiError(plain Error) → "unknown" which is NOT retryable, so use
    // a connection-shaped failure: Phase 1's classifyAiError maps
    // Anthropic.APIConnectionError → "connection" (retryable).
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const retrieve = vi
      .fn()
      .mockRejectedValue(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { retrieve } } });
    expect(await getBatchStatus("msgbatch_1")).toBe("errored");
  });

  it("rethrows non-retryable failures — polling cannot recover those", async () => {
    const retrieve = vi.fn().mockRejectedValue(new Error("401 invalid x-api-key"));
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { retrieve } } });
    // plain Error classifies as "unknown" → not retryable → rethrow
    await expect(getBatchStatus("msgbatch_1")).rejects.toThrow(/invalid x-api-key/);
  });
});

describe("mapBatchRow / collectBatchResults", () => {
  beforeEach(() => vi.clearAllMocks());

  const succeededRow: BatchRowShape = {
    custom_id: "core_button",
    result: {
      type: "succeeded",
      message: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "export function CoreButton() {}" }],
        usage: {
          input_tokens: 1200,
          output_tokens: 800,
          cache_read_input_tokens: 2500,
          cache_creation_input_tokens: 0,
        },
      },
    },
  };

  it("maps a succeeded row to ok:true with text/usage/stopReason/model", () => {
    const item = mapBatchRow(succeededRow);
    expect(item).toEqual({
      customId: "core_button",
      ok: true,
      text: "export function CoreButton() {}",
      usage: {
        inputTokens: 1200,
        outputTokens: 800,
        cacheReadTokens: 2500,
        cacheCreationTokens: 0,
      },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
    });
  });

  it("maps an errored row to ok:false with the classified errorKind", () => {
    const row: BatchRowShape = {
      custom_id: "x",
      result: {
        type: "errored",
        error: { type: "error", error: { type: "rate_limit_error" } },
      },
    };
    const item = mapBatchRow(row);
    expect(item.ok).toBe(false);
    expect(item.errorKind).toBe("rate_limit");
    expect(item.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(item.stopReason).toBeNull();
  });

  it("maps expired and canceled rows to ok:false errorKind 'unknown'", () => {
    expect(mapBatchRow({ custom_id: "a", result: { type: "expired" } }).errorKind).toBe("unknown");
    expect(mapBatchRow({ custom_id: "b", result: { type: "canceled" } }).errorKind).toBe("unknown");
  });

  it("collectBatchResults iterates the JSONL stream and maps each row", async () => {
    async function* rows() {
      yield succeededRow;
      yield { custom_id: "y", result: { type: "expired" } } as BatchRowShape;
    }
    const results = vi.fn().mockResolvedValue(rows());
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { results } } });
    const out = await collectBatchResults("msgbatch_2");
    expect(out).toHaveLength(2);
    expect(out[0].ok).toBe(true);
    expect(out[1]).toMatchObject({ customId: "y", ok: false, errorKind: "unknown" });
  });
});

describe("errorKindFromBatchError", () => {
  it("maps wire error types onto AiFailureKind", () => {
    expect(errorKindFromBatchError("rate_limit_error")).toBe("rate_limit");
    expect(errorKindFromBatchError("overloaded_error")).toBe("overloaded");
    expect(errorKindFromBatchError("api_error")).toBe("server_error");
    expect(errorKindFromBatchError("timeout_error")).toBe("connection");
    expect(errorKindFromBatchError("invalid_request_error")).toBe("bad_request");
    expect(errorKindFromBatchError("not_found_error")).toBe("bad_request");
    expect(errorKindFromBatchError("authentication_error")).toBe("auth");
    expect(errorKindFromBatchError("permission_error")).toBe("auth");
    expect(errorKindFromBatchError("billing_error")).toBe("auth");
    expect(errorKindFromBatchError("definitely_new_error")).toBe("unknown");
  });
});

describe("cancelGenerationBatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls batches.cancel and swallows errors (best-effort)", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already ended"));
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { cancel } } });
    await expect(cancelGenerationBatch("msgbatch_3")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("msgbatch_3");
  });
});
```

> Note: if Phase 1's `classifyAiError` constructs `Anthropic.APIConnectionError` differently than `new Anthropic.APIConnectionError({ message })` accepts in 0.95.1, adapt that one test to whatever construction Phase 1's own `errors.test.ts` uses — the assertion (`"errored"` on a retryable kind) is the contract, not the constructor.

- [ ] Run: `pnpm --filter @jab/web test lib/ai/batch-client.test.ts` — expect failure: `getBatchStatus` is not exported.
- [ ] Append to `apps/web/lib/ai/batch-client.ts`:

```ts
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
```

- [ ] Run: `pnpm --filter @jab/web test lib/ai/batch-client.test.ts` — expect PASS.
- [ ] Commit: `git add apps/web/lib/ai/batch-client.ts apps/web/lib/ai/batch-client.test.ts && git commit -m "feat(saas): batch-client result side — status/results/cancel + error-kind mapping"`

---

### Task 3: model-client — export modelConfigForTier

**Files:**
- Modify: `apps/web/lib/ai/model-client.ts` — post-Phase-1 `modelClientForTier` resolves models via `getModelFor(COMPONENT_TASK_BY_TIER[tier])` and memoizes clients (CONTRACTS). Pre-phase anchor: the `switch (tier)` table at lines 193–208 (`case "visual": ... maxTokens: 8192`).
- Modify: `apps/web/lib/ai/model-client.test.ts`

Batch items need `{ model, maxTokens }` without constructing a client. Extract the tier table into one exported function so the sync clients and batch items can never drift. **If Phase 1 already exported an equivalent helper, reuse it and skip the implementation step (record that in the execution notes).**

- [ ] Append a failing suite to `apps/web/lib/ai/model-client.test.ts`:

```ts
describe("modelConfigForTier", () => {
  afterEach(() => {
    delete process.env.JAB_AI_MODEL_COMPONENT_VISUAL;
    delete process.env.JAB_AI_MODEL;
  });

  it("returns the per-tier defaults (Sonnet visual/standard, Haiku trivial) with tier max_tokens", async () => {
    const { modelConfigForTier } = await import("./model-client");
    expect(modelConfigForTier("visual")).toEqual({ model: "claude-sonnet-4-6", maxTokens: 8192 });
    expect(modelConfigForTier("standard")).toEqual({ model: "claude-sonnet-4-6", maxTokens: 4096 });
    expect(modelConfigForTier("trivial")).toEqual({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 2048,
    });
  });

  it("honors the JAB_AI_MODEL_COMPONENT_VISUAL env override (Phase 1 hyphen-fixed key)", async () => {
    process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
    const { modelConfigForTier } = await import("./model-client");
    expect(modelConfigForTier("visual").model).toBe("claude-haiku-4-5-20251001");
  });
});
```

- [ ] Run: `pnpm --filter @jab/web test lib/ai/model-client.test.ts` — expect failure: `modelConfigForTier` is not exported.
- [ ] Implement in `apps/web/lib/ai/model-client.ts` (place above `modelClientForTier`; then make `modelClientForTier`'s non-mock branches read from it so there is exactly one table):

```ts
import { getModelFor, type AllowedModel } from "./model"; // merge with existing Phase 1 imports

export interface TierModelConfig {
  model: AllowedModel;
  maxTokens: number;
}

const MAX_TOKENS_BY_TIER: Record<Exclude<Tier, "passthrough">, number> = {
  visual: 8192,
  standard: 4096,
  trivial: 2048,
};

/**
 * Single source of truth for tier → { model, maxTokens }. Used by
 * modelClientForTier (sync clients) AND lib/jab/component-batch.ts (batch
 * request items) so the two paths cannot drift. Model resolves through
 * getModelFor(COMPONENT_TASK_BY_TIER[tier]) — the Phase 1 env-override path.
 */
export function modelConfigForTier(tier: Exclude<Tier, "passthrough">): TierModelConfig {
  return {
    model: getModelFor(COMPONENT_TASK_BY_TIER[tier]),
    maxTokens: MAX_TOKENS_BY_TIER[tier],
  };
}
```

and inside `modelClientForTier`, replace each non-mock construction's literal pair with the helper, e.g. (visual case shown; do the same for standard/trivial):

```ts
    case "visual": {
      if (mockEnabled) return new MockModelClient(modelConfigForTier("visual").model);
      const cfg = modelConfigForTier("visual");
      return memoizedClient(cfg); // Phase 1's Map-memoized constructor keyed by model+maxTokens
    }
```

(Adapt to Phase 1's actual memoization helper name; the invariant to preserve: the model/maxTokens a client is built with and the values `modelConfigForTier` reports are read from the SAME table.)

- [ ] Run: `pnpm --filter @jab/web test lib/ai/model-client.test.ts` — expect PASS.
- [ ] Run the full suite to catch drift: `pnpm --filter @jab/web test` — expect PASS.
- [ ] Commit: `git add apps/web/lib/ai/model-client.ts apps/web/lib/ai/model-client.test.ts && git commit -m "refactor(saas): single tier→model/maxTokens table via modelConfigForTier"`

---

### Task 4: component-generator — extract buildComponentRequestParts

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` — pre-phase anchor: the prompt-construction block inside `generateComponent` between the passthrough early-return and the attempt loop (pre-phase lines 708–725: `const guidance = opts.guidance ?? undefined;` through the `"\n\nUSER:\n"` split). Post-Phase-2 this block computes the three-way split `{ cachedSystemPrefix, systemPrompt, userPrompt }` per CONTRACTS.
- Modify: `apps/web/lib/ai/component-generator.test.ts`

The batch path must build the EXACT prompt the sync path would send. Extract the post-Phase-2 computation verbatim into an exported pure helper and re-point `generateComponent` at it. The test pins equivalence by capturing what `generateComponent` actually passes to the client.

- [ ] Append a failing suite to `apps/web/lib/ai/component-generator.test.ts` (reuse the file's existing `vi.mock("./model-client", ...)` hoisted mock — see its lines 16–23):

```ts
import { buildComponentRequestParts } from "./component-generator";
import { modelClientForTier } from "./model-client";

describe("buildComponentRequestParts — extraction equivalence", () => {
  it("returns exactly the prompt parts generateComponent passes to the client", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fake: ModelClient = {
      async generate(opts) {
        captured.push(opts as unknown as Record<string, unknown>);
        return {
          text: `import type { BlockNode } from "@/lib/jab/ability-client";\n\nexport function CoreButton({ block }: { block: BlockNode }) {\n  return <a>{String(block.attrs.text ?? "")}</a>;\n}\n`,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
        };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);

    const opts = {
      entry: makeVisualEntry(),
      tokens: null,
      screenshotBase64: undefined,
      dynamicList: null,
      sourceHosts: ["tworoadsbrewing.com"],
    };
    await generateComponent(opts);
    expect(captured).toHaveLength(1);

    const parts = buildComponentRequestParts(opts);
    expect(captured[0].cachedSystemPrefix).toBe(parts.cachedSystemPrefix);
    expect(captured[0].systemPrompt).toBe(parts.systemPrompt);
    expect(captured[0].userPrompt).toBe(parts.userPrompt);
  });

  it("passes cachedSystemPrefix for Sonnet tiers and undefined for trivial (Phase 2 contract)", () => {
    const visual = buildComponentRequestParts({ entry: makeVisualEntry(), tokens: null });
    expect(typeof visual.cachedSystemPrefix).toBe("string");
    expect((visual.cachedSystemPrefix ?? "").length).toBeGreaterThanOrEqual(10_000);

    const trivialEntry = { ...makeVisualEntry("core/paragraph"), tier: "trivial" as const };
    const trivial = buildComponentRequestParts({ entry: trivialEntry, tokens: null });
    expect(trivial.cachedSystemPrefix).toBeUndefined();
  });
});
```

(Note: `makeVisualEntry`, `generateComponent`, and `ModelClient` are already imported/defined at the top of this test file — pre-phase lines 1–56. If Phase 2 changed the fake-client return contract, mirror whatever shape Phase 2's own tests use for `GenerateResult`.)

- [ ] Run: `pnpm --filter @jab/web test lib/ai/component-generator.test.ts` — expect failure: `buildComponentRequestParts` is not exported.
- [ ] Implement in `apps/web/lib/ai/component-generator.ts`. **This is a MOVE, not a rewrite**: locate the post-Phase-2 block in `generateComponent` that selects the per-kind/tier prompt builder and computes the three prompt values, move it verbatim into the new exported function, and replace it in `generateComponent` with one call. Expected post-Phase-2 shape (adapt names to what Phase 2 actually landed; the equivalence test is the arbiter):

```ts
export interface ComponentRequestParts {
  /** COMPONENT_SYSTEM_CORE for Sonnet tiers; undefined for trivial/Haiku (Phase 2 contract). */
  cachedSystemPrefix: string | undefined;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Pure prompt-parts builder shared by the sync path (generateComponent) and
 * the batch path (lib/jab/component-batch.ts). MUST stay the single place
 * the component prompt split is computed — drift here would make batch
 * generations differ from sync generations for identical inputs.
 */
export function buildComponentRequestParts(opts: GenerateComponentOptions): ComponentRequestParts {
  const { entry, tokens } = opts;
  const guidance = opts.guidance ?? undefined;
  const sourceHost = opts.sourceHosts?.[0] ?? null;

  // ↓↓↓ MOVED VERBATIM from generateComponent (post-Phase-2 body) ↓↓↓
  // - per-kind/tier user-prompt builder selection (cpt_template / acf_flex /
  //   visual / standard / trivial)
  // - per-build systemPrompt (design-token JSON + sourceHost line)
  // - cachedSystemPrefix = COMPONENT_SYSTEM_CORE for visual/standard,
  //   undefined for trivial
  // ↑↑↑ end moved block ↑↑↑

  return { cachedSystemPrefix, systemPrompt, userPrompt };
}
```

and in `generateComponent`, the moved block becomes:

```ts
  const { cachedSystemPrefix, systemPrompt, userPrompt } = buildComponentRequestParts(opts);
```

- [ ] Run: `pnpm --filter @jab/web test lib/ai/component-generator.test.ts` — expect PASS.
- [ ] Run the full suite (`pnpm --filter @jab/web test`) — expect PASS (the move must not change any existing prompt test).
- [ ] Commit: `git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts && git commit -m "refactor(saas): extract buildComponentRequestParts for the batch path"`

---

### Task 5: component-generator — finalizeBatchGeneration + usage helpers + row-identity test

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` (append after `generateComponent`; reuses module-internal `postprocessGeneratedTsx`, `rewriteWpOriginUrls`, `validateTsx`, `MAX_COMPONENT_BYTES` (pre-phase line 48), `toPascalCase`, `passthroughFallback` (pre-phase lines 643–662))
- Modify: `apps/web/lib/ai/component-generator.test.ts`

This is the batch path's post-LLM pipeline. It MUST mirror the sync attempt body (pre-phase lines 753–794: trim → postprocess → origin-rewrite → byte cap → validateTsx → GeneratedComponent), so a batch result and a sync result for the same model output persist **identical rows** — pinned by the identity test below.

- [ ] Append failing tests:

```ts
import {
  finalizeBatchGeneration,
  failedBatchComponent,
  addUsage,
  mergeUsageIntoComponent,
} from "./component-generator";

const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreButton({ block }: { block: BlockNode }) {
  return <a className="btn">{String(block.attrs.text ?? "")}</a>;
}
`;

const USAGE = { inputTokens: 1200, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe("finalizeBatchGeneration", () => {
  it("produces a GeneratedComponent DEEP-EQUAL to the sync path's for the same model output (persisted-row identity)", async () => {
    // Sync side: generateComponent with a fake client returning VALID_TSX.
    const fake: ModelClient = {
      async generate() {
        return { text: VALID_TSX, usage: { ...USAGE }, stopReason: "end_turn", model: "claude-sonnet-4-6" };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);
    const opts = { entry: makeVisualEntry(), tokens: null, sourceHosts: ["tworoadsbrewing.com"] };
    const syncComponent = await generateComponent(opts);
    expect(syncComponent.compileStatus).toBe("ok");

    // Batch side: identical inputs through finalizeBatchGeneration.
    const outcome = finalizeBatchGeneration({
      entry: opts.entry,
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
      sourceHosts: opts.sourceHosts,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // Field-for-field identity — persistGeneration maps this object 1:1 into
    // the block_inventory row, so object identity ⇒ persisted-row identity.
    expect(Object.keys(outcome.component).sort()).toEqual(Object.keys(syncComponent).sort());
    expect(outcome.component).toEqual(syncComponent);
  });

  it("returns a retry descriptor with diagnostics + tail on TSX validation failure", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: "export function CoreButton() { return <div>unclosed; }",
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    expect(outcome.reason).toBe("validation");
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.errors.length).toBeLessThanOrEqual(3);
    expect(outcome.outputTail.length).toBeLessThanOrEqual(500);
  });

  it("returns reason 'max_tokens' on a truncated stop_reason without attempting validation", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "max_tokens",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
    });
    expect(outcome).toMatchObject({ kind: "retry", reason: "max_tokens" });
  });

  it("merges priorUsage into the ok component's accumulated usage", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 2,
      priorUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 },
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.component.inputTokens).toBe(1300);
    expect(outcome.component.outputTokens).toBe(650);
    expect(outcome.component.cacheReadTokens).toBe(10);
    expect(outcome.component.cacheCreationTokens).toBe(5);
    expect(outcome.component.compileAttemptCount).toBe(2);
  });
});

describe("failedBatchComponent / mergeUsageIntoComponent", () => {
  it("builds a failed passthrough component carrying usage + failureKind", () => {
    const c = failedBatchComponent({
      entry: makeVisualEntry(),
      usage: { ...USAGE },
      attemptCount: 1,
      failureKind: "bad_request",
      model: "claude-sonnet-4-6",
    });
    expect(c.compileStatus).toBe("failed");
    expect(c.tsx).toMatch(/wp-block-passthrough/); // passthroughFallback marker class
    expect(c.inputTokens).toBe(1200);
    expect(c.failureKind).toBe("bad_request");
  });

  it("mergeUsageIntoComponent adds prior wave spend + attempts onto a sync-fallback result", async () => {
    const fake: ModelClient = {
      async generate() {
        return { text: VALID_TSX, usage: { ...USAGE }, stopReason: "end_turn", model: "claude-sonnet-4-6" };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);
    const sync = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    const merged = mergeUsageIntoComponent(
      sync,
      { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 1 },
      2,
    );
    expect(merged.inputTokens).toBe(sync.inputTokens + 7);
    expect(merged.compileAttemptCount).toBe(sync.compileAttemptCount + 2);
    expect(merged.compileStatus).toBe(sync.compileStatus);
  });
});
```

> If post-Phase-2 `GeneratedComponent` carries `failureKind` under a different name, mirror the actual field everywhere in this task — the identity test will catch any omission.

- [ ] Run: `pnpm --filter @jab/web test lib/ai/component-generator.test.ts` — expect failure: `finalizeBatchGeneration` is not exported.
- [ ] Append to `apps/web/lib/ai/component-generator.ts`:

```ts
import type { GenerateUsage, StopReason } from "./model-client"; // merge into existing imports
import type { AiFailureKind } from "./errors"; // merge into existing imports

export const ZERO_GENERATE_USAGE: GenerateUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function addUsage(a: GenerateUsage, b: GenerateUsage): GenerateUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export interface BatchAttemptInput {
  entry: EnrichedInventoryEntry;
  text: string;
  usage: GenerateUsage;
  stopReason: StopReason;
  /** Ground-truth model from the batch result — persisted as-is (Phase 1 rule). */
  model: string;
  /** 1 for wave-1, 2 for wave-2. Becomes compileAttemptCount on the row. */
  attemptCount: number;
  /** Wave-1 spend, merged in when finalizing wave-2. */
  priorUsage?: GenerateUsage;
  sourceHosts?: string[];
}

export type BatchAttemptOutcome =
  | { kind: "ok"; component: GeneratedComponent }
  | { kind: "retry"; reason: "validation" | "max_tokens"; errors: string[]; outputTail: string };

/**
 * Batch-path twin of the sync attempt body in generateComponent:
 * trim → postprocess → origin-rewrite → byte cap → validateTsx. MUST stay
 * behaviorally identical to the sync body — pinned by the persisted-row
 * identity test in component-generator.test.ts.
 */
export function finalizeBatchGeneration(input: BatchAttemptInput): BatchAttemptOutcome {
  const blockName = input.entry.blockName ?? "__null__";
  const usage = input.priorUsage ? addUsage(input.priorUsage, input.usage) : input.usage;

  // Phase 2 stop_reason rule: a truncated generation is NEVER valid TSX worth
  // validating — surface it as its own retry reason so wave-2 raises max_tokens.
  if (input.stopReason === "max_tokens") {
    return {
      kind: "retry",
      reason: "max_tokens",
      errors: ["stop_reason=max_tokens — output truncated at the token ceiling"],
      outputTail: input.text.slice(-500),
    };
  }

  const rawTsx = input.text.trim();
  let tsx: string;
  try {
    tsx = postprocessGeneratedTsx(rawTsx, { expectedExportName: toPascalCase(blockName) });
  } catch (err) {
    return {
      kind: "retry",
      reason: "validation",
      errors: [`postprocess: ${err instanceof Error ? err.message : String(err)}`],
      outputTail: rawTsx.slice(-500),
    };
  }

  if (input.sourceHosts && input.sourceHosts.length > 0) {
    tsx = rewriteWpOriginUrls(tsx, { sourceHosts: input.sourceHosts });
  }

  if (Buffer.byteLength(tsx, "utf8") > MAX_COMPONENT_BYTES) {
    return {
      kind: "retry",
      reason: "validation",
      errors: [`size: ${Buffer.byteLength(tsx, "utf8")} bytes exceeds ${MAX_COMPONENT_BYTES}`],
      outputTail: tsx.slice(-500),
    };
  }

  const errors = validateTsx(tsx, `${toPascalCase(blockName)}.tsx`);
  if (errors.length > 0) {
    return {
      kind: "retry",
      reason: "validation",
      errors: errors.slice(0, 3),
      outputTail: tsx.slice(-500),
    };
  }

  return {
    kind: "ok",
    component: {
      blockName,
      tsx,
      compileStatus: "ok",
      compileAttemptCount: input.attemptCount,
      modelUsed: input.model,
      providerUsed: "anthropic",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      failureKind: null, // post-Phase-2 field — mirror the sync ok-return exactly
    },
  };
}

/** Terminal batch failure → passthrough fallback row (mirrors the sync tail return). */
export function failedBatchComponent(args: {
  entry: EnrichedInventoryEntry;
  usage: GenerateUsage;
  attemptCount: number;
  failureKind: AiFailureKind | "max_tokens" | null;
  model: string | null;
}): GeneratedComponent {
  const blockName = args.entry.blockName ?? "__null__";
  return {
    blockName,
    tsx: passthroughFallback(blockName),
    compileStatus: "failed",
    compileAttemptCount: args.attemptCount,
    modelUsed: args.model,
    providerUsed: "anthropic",
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    cacheReadTokens: args.usage.cacheReadTokens,
    cacheCreationTokens: args.usage.cacheCreationTokens,
    failureKind: args.failureKind,
  };
}

/** Fold prior batch-wave spend into a sync-fallback generateComponent result. */
export function mergeUsageIntoComponent(
  component: GeneratedComponent,
  prior: GenerateUsage,
  priorAttempts: number,
): GeneratedComponent {
  return {
    ...component,
    compileAttemptCount: component.compileAttemptCount + priorAttempts,
    inputTokens: component.inputTokens + prior.inputTokens,
    outputTokens: component.outputTokens + prior.outputTokens,
    cacheReadTokens: component.cacheReadTokens + prior.cacheReadTokens,
    cacheCreationTokens: component.cacheCreationTokens + prior.cacheCreationTokens,
  };
}
```

(Adjust the `failureKind` field name/values to the exact post-Phase-2 `GeneratedComponent` shape; if the sync ok-return sets it to something other than `null`, mirror that.)

- [ ] Run: `pnpm --filter @jab/web test lib/ai/component-generator.test.ts` — expect PASS (identity test green is the gate).
- [ ] Commit: `git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts && git commit -m "feat(saas): finalizeBatchGeneration — batch twin of the sync validate pipeline, row-identity pinned"`

---

### Task 6: lib/jab/component-batch.ts — pure batch-plan engine + flag gate

**Files:**
- Create: `apps/web/lib/jab/component-batch.ts`
- Create: `apps/web/lib/jab/component-batch.test.ts`

- [ ] Write the failing test file `apps/web/lib/jab/component-batch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";

// component-batch imports buildComponentRequestParts + modelConfigForTier;
// mock both so this suite tests ONLY the plan engine.
vi.mock("@/lib/ai/component-generator", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/ai/component-generator")>();
  return {
    ...orig,
    buildComponentRequestParts: vi.fn((opts: { entry: { blockName: string | null } }) => ({
      cachedSystemPrefix: "CORE",
      systemPrompt: `sys:${opts.entry.blockName}`,
      userPrompt: `user:${opts.entry.blockName}`,
    })),
    buildRetryUserSuffix: vi.fn(
      (errors: string[], tail: string) => `\nRETRY:${errors.join("|")}:${tail}`,
    ),
  };
});
vi.mock("@/lib/ai/model-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/ai/model-client")>();
  return {
    ...orig,
    modelConfigForTier: vi.fn((tier: string) =>
      tier === "trivial"
        ? { model: "claude-haiku-4-5-20251001", maxTokens: 2048 }
        : { model: "claude-sonnet-4-6", maxTokens: tier === "visual" ? 8192 : 4096 },
    ),
  };
});

import {
  isBatchGenerateEnabled,
  partitionInventoryForBatch,
  buildComponentBatchItems,
  buildWave2Item,
  pollVerdict,
  MAX_BATCH_POLLS,
  MAX_TOKENS_RETRY_CAP,
} from "./component-batch";

function entry(blockName: string | null, tier: EnrichedInventoryEntry["tier"]): EnrichedInventoryEntry {
  return {
    blockName,
    occurrenceCount: 1,
    pageSlugs: ["home"],
    attrSamples: [{}],
    tier,
    kind: "block",
    sourceDomSample: null,
    computedStyles: null,
  };
}

describe("isBatchGenerateEnabled (flag-off byte-identical gate)", () => {
  it("is OFF when unset, '0', 'true', or any value other than exactly '1'", () => {
    expect(isBatchGenerateEnabled({})).toBe(false);
    expect(isBatchGenerateEnabled({ JAB_BATCH_GENERATE: "0" })).toBe(false);
    expect(isBatchGenerateEnabled({ JAB_BATCH_GENERATE: "true" })).toBe(false);
    expect(isBatchGenerateEnabled({ JAB_BATCH_GENERATE: "" })).toBe(false);
  });

  it("is ON only for exactly '1'", () => {
    expect(isBatchGenerateEnabled({ JAB_BATCH_GENERATE: "1" })).toBe(true);
  });

  it("JAB_GENERATE_MOCK=1 wins — mock smoke runs must never hit the batches API", () => {
    expect(isBatchGenerateEnabled({ JAB_BATCH_GENERATE: "1", JAB_GENERATE_MOCK: "1" })).toBe(false);
  });
});

describe("partitionInventoryForBatch", () => {
  it("routes passthrough + null-name entries away from the batch", () => {
    const queue = [
      entry("core/button", "visual"),
      entry("core/html", "passthrough"),
      entry(null, "standard"),
      entry("core/paragraph", "trivial"),
    ];
    const { llmEntries, passthroughEntries } = partitionInventoryForBatch(queue);
    expect(llmEntries.map((e) => e.blockName)).toEqual(["core/button", "core/paragraph"]);
    expect(passthroughEntries).toHaveLength(2);
  });
});

describe("buildComponentBatchItems", () => {
  it("builds one item per entry with tier model/maxTokens, prompt parts, and a sanitized unique custom_id", () => {
    const e1 = entry("acf_flex/page/page_builder/hero", "visual");
    const e2 = entry("core/paragraph", "trivial");
    const plan = buildComponentBatchItems([
      { entry: e1, options: { entry: e1, tokens: null, screenshotBase64: "aGk=" } },
      { entry: e2, options: { entry: e2, tokens: null } },
    ]);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      customId: "acf_flex_page_page_builder_hero",
      model: "claude-sonnet-4-6",
      maxTokens: 8192,
      cachedSystemPrefix: "CORE",
      system: "sys:acf_flex/page/page_builder/hero",
      user: "user:acf_flex/page/page_builder/hero",
      screenshotBase64: "aGk=",
    });
    // trivial tier: no screenshot even if provided in options
    expect(plan.items[1].screenshotBase64).toBeUndefined();
    expect(plan.items[1].maxTokens).toBe(2048);
    expect(plan.blockNameByCustomId).toEqual({
      acf_flex_page_page_builder_hero: "acf_flex/page/page_builder/hero",
      core_paragraph: "core/paragraph",
    });
  });

  it("throws on a passthrough entry (must never reach the batch path)", () => {
    const e = entry("core/html", "passthrough");
    expect(() => buildComponentBatchItems([{ entry: e, options: { entry: e, tokens: null } }])).toThrow(
      /passthrough/,
    );
  });
});

describe("buildWave2Item", () => {
  it("appends the corrective suffix to the user prompt and keeps tier maxTokens for validation retries", () => {
    const e = entry("core/button", "visual");
    const item = buildWave2Item({
      descriptor: {
        blockName: "core/button",
        reason: "validation",
        errors: ["Bad.tsx(10): oops"],
        outputTail: "</div>",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attempts: 1,
      },
      options: { entry: e, tokens: null },
      taken: new Set<string>(),
    });
    expect(item.user).toBe("user:core/button\nRETRY:Bad.tsx(10): oops:</div>");
    expect(item.maxTokens).toBe(8192);
    expect(item.customId).toBe("core_button_r2");
  });

  it("raises maxTokens 1.5x capped at 16000 for max_tokens retries", () => {
    const e = entry("core/button", "visual");
    const item = buildWave2Item({
      descriptor: {
        blockName: "core/button",
        reason: "max_tokens",
        errors: ["stop_reason=max_tokens"],
        outputTail: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attempts: 1,
      },
      options: { entry: e, tokens: null },
      taken: new Set<string>(),
    });
    expect(item.maxTokens).toBe(Math.min(Math.ceil(8192 * 1.5), MAX_TOKENS_RETRY_CAP));
    expect(item.maxTokens).toBe(12288);
  });
});

describe("pollVerdict", () => {
  it("collects on ended, waits while in_progress/canceling/errored under the cap, times out at the cap", () => {
    expect(pollVerdict("ended", 0)).toBe("collect");
    expect(pollVerdict("in_progress", 0)).toBe("wait");
    expect(pollVerdict("canceling", 10)).toBe("wait");
    expect(pollVerdict("errored", 10)).toBe("wait"); // transient retrieve failure — keep polling
    expect(pollVerdict("in_progress", MAX_BATCH_POLLS)).toBe("timeout");
  });
});
```

- [ ] Run: `pnpm --filter @jab/web test lib/jab/component-batch.test.ts` — expect failure: `Cannot find module './component-batch'`.
- [ ] Create `apps/web/lib/jab/component-batch.ts`:

```ts
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { GenerateUsage } from "@/lib/ai/model-client";
import { modelConfigForTier } from "@/lib/ai/model-client";
import {
  buildComponentRequestParts,
  buildRetryUserSuffix,
  type GenerateComponentOptions,
} from "@/lib/ai/component-generator";
import { sanitizeBatchCustomId, type BatchRequestItem } from "@/lib/ai/batch-client";

/**
 * component-batch.ts — pure planning engine for the JAB_BATCH_GENERATE=1
 * Phase B batch path. The generate-components worker is a thin orchestrator
 * over these functions; everything decision-shaped lives here so it is
 * unit-testable without Inngest.
 */

/** 60 polls × 30s ≈ 30 minutes per wave before the sync fallback takes over. */
export const MAX_BATCH_POLLS = 60;
export const BATCH_POLL_INTERVAL = "30s";
/** Phase 2 parity: max_tokens retries raise the cap 1.5x, hard-capped at 16000. */
export const MAX_TOKENS_RETRY_CAP = 16_000;

export const ZERO_USAGE: GenerateUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Batch mode gate. Exactly "1" enables; JAB_GENERATE_MOCK=1 wins (a mock
 * smoke run must never touch the batches API — MockModelClient only exists
 * on the sync path). Anything else → the sync path, byte-identical.
 */
export function isBatchGenerateEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.JAB_BATCH_GENERATE === "1" && env.JAB_GENERATE_MOCK !== "1";
}

export function partitionInventoryForBatch(queue: EnrichedInventoryEntry[]): {
  llmEntries: EnrichedInventoryEntry[];
  passthroughEntries: EnrichedInventoryEntry[];
} {
  const llmEntries: EnrichedInventoryEntry[] = [];
  const passthroughEntries: EnrichedInventoryEntry[] = [];
  for (const entry of queue) {
    if (entry.tier === "passthrough" || entry.blockName === null) {
      passthroughEntries.push(entry);
    } else {
      llmEntries.push(entry);
    }
  }
  return { llmEntries, passthroughEntries };
}

export interface ComponentBatchPlan {
  items: BatchRequestItem[];
  blockNameByCustomId: Record<string, string>;
}

/** Wave-1 items: one per LLM-tier entry, custom_id = sanitized block_name. */
export function buildComponentBatchItems(
  entryOptions: Array<{ entry: EnrichedInventoryEntry; options: GenerateComponentOptions }>,
): ComponentBatchPlan {
  const taken = new Set<string>();
  const items: BatchRequestItem[] = [];
  const blockNameByCustomId: Record<string, string> = {};
  for (const { entry, options } of entryOptions) {
    if (entry.tier === "passthrough" || entry.blockName === null) {
      throw new Error(
        `[component-batch] passthrough entry ${entry.blockName ?? "__null__"} must not reach the batch path`,
      );
    }
    const parts = buildComponentRequestParts(options);
    const cfg = modelConfigForTier(entry.tier);
    const customId = sanitizeBatchCustomId(entry.blockName, taken);
    blockNameByCustomId[customId] = entry.blockName;
    items.push({
      customId,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      cachedSystemPrefix: parts.cachedSystemPrefix,
      system: parts.systemPrompt,
      user: parts.userPrompt,
      // Mirror the sync path: only the visual tier carries a screenshot.
      screenshotBase64: entry.tier === "visual" ? options.screenshotBase64 ?? undefined : undefined,
    });
  }
  return { items, blockNameByCustomId };
}

/** Wave-1 → wave-2 carry descriptor (small: safe as an Inngest step output). */
export interface Wave2Descriptor {
  blockName: string;
  reason: "validation" | "max_tokens";
  errors: string[]; // first 3 diagnostics
  outputTail: string; // last ≤500 chars of the failed output
  usage: GenerateUsage; // wave-1 spend, merged into the final row
  attempts: number; // attempts consumed so far (1 after wave-1)
}

/** Entries that exhausted the batch path and recover via sync generateComponent. */
export interface SyncFallbackDescriptor {
  blockName: string;
  usage: GenerateUsage;
  attempts: number;
}

/** Wave-2 corrective item: same prompt + Phase 2 corrective suffix; raised cap on truncation. */
export function buildWave2Item(args: {
  descriptor: Wave2Descriptor;
  options: GenerateComponentOptions;
  taken: Set<string>;
}): BatchRequestItem {
  const entry = args.options.entry;
  if (entry.tier === "passthrough" || entry.blockName === null) {
    throw new Error("[component-batch] buildWave2Item called with a passthrough entry");
  }
  const parts = buildComponentRequestParts(args.options);
  const cfg = modelConfigForTier(entry.tier);
  const maxTokens =
    args.descriptor.reason === "max_tokens"
      ? Math.min(Math.ceil(cfg.maxTokens * 1.5), MAX_TOKENS_RETRY_CAP)
      : cfg.maxTokens;
  return {
    customId: sanitizeBatchCustomId(`${entry.blockName}_r2`, args.taken),
    model: cfg.model,
    maxTokens,
    cachedSystemPrefix: parts.cachedSystemPrefix,
    system: parts.systemPrompt,
    user: parts.userPrompt + buildRetryUserSuffix(args.descriptor.errors, args.descriptor.outputTail),
    screenshotBase64: entry.tier === "visual" ? args.options.screenshotBase64 ?? undefined : undefined,
  };
}

/** Poll-loop decision: collect | wait | timeout. "errored" (transient retrieve failure) waits. */
export function pollVerdict(
  status: "in_progress" | "ended" | "canceling" | "errored",
  polls: number,
  cap: number = MAX_BATCH_POLLS,
): "collect" | "wait" | "timeout" {
  if (status === "ended") return "collect";
  if (polls >= cap) return "timeout";
  return "wait";
}
```

- [ ] Run: `pnpm --filter @jab/web test lib/jab/component-batch.test.ts` — expect PASS.
- [ ] Commit: `git add apps/web/lib/jab/component-batch.ts apps/web/lib/jab/component-batch.test.ts && git commit -m "feat(saas): component-batch plan engine — gate, partition, wave items, poll verdicts"`

---

### Task 7: component-batch — finalizeComponentWave (persisting wave finalizer)

**Files:**
- Modify: `apps/web/lib/jab/component-batch.ts` (append)
- Modify: `apps/web/lib/jab/component-batch.test.ts` (append)

This is the routing brain: per entry, decide persist-ok / wave-2-retry / fail-fast / sync-fallback. Persistence is injectable so tests capture rows without Supabase.

Routing rules (mirrors Phase 2's sync typed-error semantics):
- result missing, or `ok:false` with a retryable/unknown `errorKind` (incl. expired/canceled) → **sync fallback** (the batch never produced output; sync recovery is the second attempt).
- `ok:false` with `bad_request`/`auth` → **fail fast** to passthrough, persist with `failureKind`, NO further attempts (Phase 2 rule).
- `ok:true` + validates → **persist ok**.
- `ok:true` + validation/max_tokens failure → wave-1: **wave-2 corrective**; wave-2: **persist failed** passthrough (2 generation attempts total, exactly like the sync loop).

- [ ] Append failing tests:

```ts
import { finalizeComponentWave } from "./component-batch";
import type { BatchResultItem } from "@/lib/ai/batch-client";
import type { PersistGenerationInput } from "@/lib/ai/persist-generation";

const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreButton({ block }: { block: BlockNode }) {
  return <a>{String(block.attrs.text ?? "")}</a>;
}
`;

function okResult(customId: string, over: Partial<BatchResultItem> = {}): BatchResultItem {
  return {
    customId,
    ok: true,
    text: VALID_TSX,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason: "end_turn",
    model: "claude-sonnet-4-6",
    ...over,
  };
}

describe("finalizeComponentWave", () => {
  function setup() {
    const persisted: PersistGenerationInput[] = [];
    const persist = async (input: PersistGenerationInput) => {
      persisted.push(input);
      return { storagePath: "x" };
    };
    return { persisted, persist };
  }
  const base = {
    buildId: "b1",
    projectId: "p1",
    attempt: 1 as const,
    sourceHosts: [] as string[],
    priorUsageByBlockName: {},
  };

  it("persists ok rows and counts them", async () => {
    const { persisted, persist } = setup();
    const e = entry("core/button", "visual");
    const out = await finalizeComponentWave({
      ...base,
      results: [okResult("core_button")],
      blockNameByCustomId: { core_button: "core/button" },
      entries: [e],
      persist,
    });
    expect(out.okCount).toBe(1);
    expect(out.retry).toEqual([]);
    expect(out.syncFallback).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].component.compileStatus).toBe("ok");
    expect(persisted[0].buildId).toBe("b1");
  });

  it("routes wave-1 validation failures to the retry list (nothing persisted yet)", async () => {
    const { persisted, persist } = setup();
    const e = entry("core/button", "visual");
    const out = await finalizeComponentWave({
      ...base,
      results: [okResult("core_button", { text: "export function CoreButton() { return <div>; }" })],
      blockNameByCustomId: { core_button: "core/button" },
      entries: [e],
      persist,
    });
    expect(out.okCount).toBe(0);
    expect(out.retry).toHaveLength(1);
    expect(out.retry[0]).toMatchObject({ blockName: "core/button", reason: "validation", attempts: 1 });
    expect(persisted).toHaveLength(0);
  });

  it("persists failed passthrough on attempt 2 validation failure (2 attempts total, like sync)", async () => {
    const { persisted, persist } = setup();
    const e = entry("core/button", "visual");
    const out = await finalizeComponentWave({
      ...base,
      attempt: 2,
      results: [okResult("core_button_r2", { text: "export function CoreButton() { return <div>; }" })],
      blockNameByCustomId: { core_button_r2: "core/button" },
      entries: [e],
      priorUsageByBlockName: {
        "core/button": { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
      priorAttemptsByBlockName: { "core/button": 1 },
      persist,
    });
    expect(out.retry).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].component.compileStatus).toBe("failed");
    expect(persisted[0].component.compileAttemptCount).toBe(2);
    // wave-1 + wave-2 spend accumulated on the row
    expect(persisted[0].component.inputTokens).toBe(107);
  });

  it("fails fast (persist failed + failureKind) on bad_request/auth without retry or fallback", async () => {
    const { persisted, persist } = setup();
    const e = entry("core/button", "visual");
    const out = await finalizeComponentWave({
      ...base,
      results: [
        {
          customId: "core_button",
          ok: false,
          text: "",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: null,
          model: "",
          errorKind: "bad_request",
        },
      ],
      blockNameByCustomId: { core_button: "core/button" },
      entries: [e],
      persist,
    });
    expect(out.retry).toEqual([]);
    expect(out.syncFallback).toEqual([]);
    expect(persisted[0].component.compileStatus).toBe("failed");
    expect(persisted[0].component.failureKind).toBe("bad_request");
  });

  it("routes missing results and retryable API errors to the sync fallback", async () => {
    const { persisted, persist } = setup();
    const e1 = entry("core/button", "visual"); // no result at all (unfinished batch)
    const e2 = entry("core/quote", "standard"); // rate-limited row
    const out = await finalizeComponentWave({
      ...base,
      results: [
        {
          customId: "core_quote",
          ok: false,
          text: "",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: null,
          model: "",
          errorKind: "rate_limit",
        },
      ],
      blockNameByCustomId: { core_quote: "core/quote" },
      entries: [e1, e2],
      persist,
    });
    expect(persisted).toHaveLength(0);
    expect(out.syncFallback.map((d) => d.blockName).sort()).toEqual(["core/button", "core/quote"]);
  });
});
```

- [ ] Run: `pnpm --filter @jab/web test lib/jab/component-batch.test.ts` — expect failure: `finalizeComponentWave` is not exported.
- [ ] Append to `apps/web/lib/jab/component-batch.ts`:

```ts
import {
  addUsage,
  failedBatchComponent,
  finalizeBatchGeneration,
} from "@/lib/ai/component-generator"; // merge into the existing import
import type { BatchResultItem } from "@/lib/ai/batch-client"; // merge into the existing import
import {
  persistGeneration,
  type PersistGenerationInput,
} from "@/lib/ai/persist-generation";

export interface WaveFinalizeArgs {
  buildId: string;
  projectId: string;
  /** Collected batch results ([] when the batch timed out uncollectable). */
  results: BatchResultItem[];
  blockNameByCustomId: Record<string, string>;
  /** The LLM-tier entries this wave covered. */
  entries: EnrichedInventoryEntry[];
  attempt: 1 | 2;
  sourceHosts: string[];
  priorUsageByBlockName: Record<string, GenerateUsage>;
  priorAttemptsByBlockName?: Record<string, number>;
  /** Injectable for tests; defaults to the real persistGeneration. */
  persist?: (input: PersistGenerationInput) => Promise<{ storagePath: string | null }>;
}

export interface WaveFinalizeOutcome {
  okCount: number;
  retry: Wave2Descriptor[];
  syncFallback: SyncFallbackDescriptor[];
}

/**
 * Route every entry of a finished (or timed-out) wave:
 *   ok + valid            → persist ok
 *   ok + invalid (wave 1) → wave-2 corrective descriptor
 *   ok + invalid (wave 2) → persist failed passthrough (2 attempts total)
 *   bad_request | auth    → persist failed passthrough + failureKind (fail fast)
 *   anything else         → sync-fallback descriptor (batch produced nothing)
 * Persists terminal rows immediately so the Inngest step output stays small
 * (descriptors only — never TSX).
 */
export async function finalizeComponentWave(args: WaveFinalizeArgs): Promise<WaveFinalizeOutcome> {
  const persist = args.persist ?? persistGeneration;
  const resultByBlockName = new Map<string, BatchResultItem>();
  for (const result of args.results) {
    const blockName = args.blockNameByCustomId[result.customId];
    if (blockName) resultByBlockName.set(blockName, result);
  }

  let okCount = 0;
  const retry: Wave2Descriptor[] = [];
  const syncFallback: SyncFallbackDescriptor[] = [];

  for (const entry of args.entries) {
    const blockName = entry.blockName;
    if (blockName === null) continue; // partition guarantees this never happens
    const prior = args.priorUsageByBlockName[blockName] ?? ZERO_USAGE;
    const priorAttempts = args.priorAttemptsByBlockName?.[blockName] ?? args.attempt - 1;
    const result = resultByBlockName.get(blockName);

    if (!result) {
      // Unfinished / lost row — the batch never billed us for it.
      syncFallback.push({ blockName, usage: prior, attempts: priorAttempts });
      continue;
    }

    if (!result.ok) {
      if (result.errorKind === "bad_request" || result.errorKind === "auth") {
        // Phase 2 rule: non-retryable → no second attempt, fail to passthrough.
        const component = failedBatchComponent({
          entry,
          usage: prior,
          attemptCount: priorAttempts + 1,
          failureKind: result.errorKind,
          model: null,
        });
        await persist({ buildId: args.buildId, projectId: args.projectId, component });
        continue;
      }
      // rate_limit / overloaded / server_error / connection / unknown
      // (incl. expired + canceled) → recover on the sync path.
      syncFallback.push({
        blockName,
        usage: addUsage(prior, result.usage),
        attempts: priorAttempts + 1,
      });
      continue;
    }

    const outcome = finalizeBatchGeneration({
      entry,
      text: result.text,
      usage: result.usage,
      stopReason: result.stopReason,
      model: result.model,
      attemptCount: priorAttempts + 1,
      priorUsage: prior,
      sourceHosts: args.sourceHosts,
    });

    if (outcome.kind === "ok") {
      await persist({ buildId: args.buildId, projectId: args.projectId, component: outcome.component });
      okCount++;
      continue;
    }

    if (args.attempt === 1) {
      retry.push({
        blockName,
        reason: outcome.reason,
        errors: outcome.errors,
        outputTail: outcome.outputTail,
        usage: addUsage(prior, result.usage),
        attempts: priorAttempts + 1,
      });
    } else {
      const component = failedBatchComponent({
        entry,
        usage: addUsage(prior, result.usage),
        attemptCount: priorAttempts + 1,
        failureKind: outcome.reason === "max_tokens" ? "max_tokens" : null,
        model: result.model,
      });
      await persist({ buildId: args.buildId, projectId: args.projectId, component });
    }
  }

  return { okCount, retry, syncFallback };
}
```

- [ ] Run: `pnpm --filter @jab/web test lib/jab/component-batch.test.ts` — expect PASS.
- [ ] Commit: `git add apps/web/lib/jab/component-batch.ts apps/web/lib/jab/component-batch.test.ts && git commit -m "feat(saas): finalizeComponentWave — persist/retry/fail-fast/fallback routing for batch waves"`

---

### Task 8: generate-components worker — flag-gated batch branch

**Files:**
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` — anchors (pre-phase): `const BATCH_SIZE = 5;` (line 55), the `let generatedCount = 0;` + batches construction (lines 263–268), the `for (let batchIdx = 0...)` sync loop (lines 270–343), the worker docstring's "not Batch API — see plan decision #4" (line 39).

No new unit tests in this task — the worker is a thin orchestrator over the Task 1–7 tested modules and this repo does not invoke Inngest handlers in vitest (verified: no `InngestTestEngine` usage anywhere). The gates are: full suite green, `pnpm --filter @jab/web typecheck` green, and a `git diff` review confirming the sync loop moved inside `if (!batchEnabled)` UNMODIFIED.

- [ ] Update the worker docstring: replace the line `* Parallelism: batches of 5 concurrent generate calls (not Batch API —` and the following sentence fragment (`* see plan decision #4). ...`) so the block reads:

```
 * Parallelism (sync path, default): batches of 5 concurrent generate calls.
 * Plan decision #4 (no Batch API) is re-opened behind JAB_BATCH_GENERATE=1
 * (docs/superpowers/plans/2026-06-10-ai-call-optimization/03-batch-api.md):
 * LLM-tier entries go through one Message Batch (50% off all tokens), a
 * 30s/60-poll step.sleep loop, a wave-2 corrective batch for validation
 * failures, and a sync fallback for stragglers. Flag off → the sync path
 * below runs byte-identical. JAB_GENERATE_MOCK=1 always wins (sync + mock).
 * Each sync batch runs inside a single step.run boundary
```

- [ ] Add imports at the top of the file:

```ts
import {
  isBatchGenerateEnabled,
  partitionInventoryForBatch,
  buildComponentBatchItems,
  buildWave2Item,
  finalizeComponentWave,
  pollVerdict,
  MAX_BATCH_POLLS,
  BATCH_POLL_INTERVAL,
  type Wave2Descriptor,
  type SyncFallbackDescriptor,
} from "@/lib/jab/component-batch";
import {
  submitGenerationBatch,
  getBatchStatus,
  collectBatchResults,
  cancelGenerationBatch,
  type BatchRequestItem,
} from "@/lib/ai/batch-client";
import { mergeUsageIntoComponent, type GenerateComponentOptions } from "@/lib/ai/component-generator";
```

- [ ] Add a module-level screenshot helper near `BATCH_SIZE` (the batch branch can't reach the sync loop's closure-local `loadScreenshot`; logic copied from it — pre-phase lines 280–306):

```ts
/**
 * JIT screenshot download for the batch branch (the sync loop keeps its own
 * closure-local copy). Base64 bodies must NEVER be a step.run return value
 * (Inngest step-output budget) — call this INSIDE the step that needs it.
 */
async function loadScreenshotCached(
  supabase: ReturnType<typeof createAdminClient>,
  cache: Map<string, string | null>,
  pathBySlug: Record<string, string>,
  slug: string,
): Promise<string | undefined> {
  if (cache.has(slug)) return cache.get(slug) ?? undefined;
  const path = pathBySlug[slug];
  if (!path) {
    cache.set(slug, null);
    return undefined;
  }
  try {
    const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(path);
    if (error || !data) {
      cache.set(slug, null);
      return undefined;
    }
    const b64 = Buffer.from(await data.arrayBuffer()).toString("base64");
    cache.set(slug, b64);
    return b64;
  } catch {
    cache.set(slug, null);
    return undefined;
  }
}
```

- [ ] Wrap the existing sync loop and add the batch branch. Locate `let generatedCount = 0;` (pre-phase line 263). Keep it. Then replace the region from `const batches: EnrichedInventoryEntry[][] = [];` (line 265) through the end of the sync `for` loop (line 343, the line before the `// Terminal-state guard (see mark-components-phase)` comment) with:

```ts
    const batchEnabled = isBatchGenerateEnabled(process.env);

    if (!batchEnabled) {
      // ─── SYNC PATH (default) — UNCHANGED, byte-identical to pre-phase ───
      const batches: EnrichedInventoryEntry[][] = [];
      for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        batches.push(queue.slice(i, i + BATCH_SIZE));
      }

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        // ... the existing step.run(`generate-batch-${batchIdx}`, ...) body
        // moves here VERBATIM (pre-phase lines 270-343). Do not edit it.
      }
    } else {
      // ─── BATCH PATH (JAB_BATCH_GENERATE=1) ───
      const { llmEntries, passthroughEntries } = partitionInventoryForBatch(queue);

      // Per-entry options builder shared by submit steps + sync fallback.
      // Deterministic per replay — rebuilt from step-memoized inputs.
      const entryByBlockName = new Map<string, EnrichedInventoryEntry>(
        llmEntries.map((e) => [e.blockName as string, e]),
      );
      const optionsForEntry = (
        entry: EnrichedInventoryEntry,
        screenshotBase64: string | undefined,
      ): GenerateComponentOptions => {
        let dynamicList: DynamicListSpec | null = null;
        if (entry.kind === "acf_flex" && entry.blockName) {
          const spec = entry.spec as Record<string, unknown> | undefined;
          const firstSample = entry.attrSamples[0] as Record<string, unknown> | undefined;
          dynamicList = detectDynamicList({
            blockName: entry.blockName,
            attrSample: spec ?? firstSample ?? {},
            cpts,
          });
        }
        return { entry, tokens, screenshotBase64, dynamicList, sourceHosts };
      };

      // 1. Passthrough rows: zero-LLM early-return, persisted like the sync loop.
      if (passthroughEntries.length > 0) {
        const passthroughOk = await step.run("batch-passthrough", async () => {
          let ok = 0;
          for (const entry of passthroughEntries) {
            const component = await generateComponent({ entry, tokens, sourceHosts });
            await persistGeneration({ buildId, projectId, component });
            if (component.compileStatus !== "failed") ok++;
          }
          return ok;
        });
        generatedCount += passthroughOk;
      }

      let wave2: Wave2Descriptor[] = [];
      let syncFallback: SyncFallbackDescriptor[] = [];

      if (llmEntries.length > 0) {
        // 2. Wave-1 submit. Screenshots download INSIDE the step.
        const wave1 = await step.run("batch-submit-wave-1", async () => {
          const supabase = createAdminClient();
          const cache = new Map<string, string | null>();
          const entryOptions: Array<{
            entry: EnrichedInventoryEntry;
            options: GenerateComponentOptions;
          }> = [];
          for (const entry of llmEntries) {
            let screenshotBase64: string | undefined;
            if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
              screenshotBase64 = await loadScreenshotCached(
                supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
              );
            }
            entryOptions.push({ entry, options: optionsForEntry(entry, screenshotBase64) });
          }
          const plan = buildComponentBatchItems(entryOptions);
          const batchId = await submitGenerationBatch(plan.items);
          console.log(
            `[generate-components] batch wave-1 submitted: ${plan.items.length} items, batch ${batchId}`,
          );
          return { batchId, blockNameByCustomId: plan.blockNameByCustomId };
        });

        // 3. Durable poll loop: 30s sleeps, MAX_BATCH_POLLS cap (~30 min).
        let polls = 0;
        let verdict: "collect" | "wait" | "timeout" = "wait";
        while (verdict === "wait") {
          const status = await step.run(`batch-wave1-poll-${polls}`, () =>
            getBatchStatus(wave1.batchId),
          );
          verdict = pollVerdict(status, polls);
          if (verdict === "wait") {
            polls++;
            await step.sleep(`batch-wave1-sleep-${polls}`, BATCH_POLL_INTERVAL);
          }
        }

        let collectable = verdict === "collect";
        if (verdict === "timeout") {
          // Stop paying for a batch we won't wait for; drain once so already-
          // finished rows are still collected before the sync fallback.
          await step.run("batch-wave1-cancel", () => cancelGenerationBatch(wave1.batchId));
          await step.sleep("batch-wave1-drain-sleep", BATCH_POLL_INTERVAL);
          const drained = await step.run("batch-wave1-drain-poll", () =>
            getBatchStatus(wave1.batchId),
          );
          collectable = drained === "ended";
          console.warn(
            `[generate-components] batch wave-1 timed out after ${MAX_BATCH_POLLS} polls (collectable=${collectable})`,
          );
        }

        // 4. Finalize wave-1: collect → validate → persist terminal rows.
        //    Step output carries ONLY small descriptors (never TSX).
        const wave1Outcome = await step.run("batch-finalize-wave-1", async () =>
          finalizeComponentWave({
            buildId,
            projectId,
            results: collectable ? await collectBatchResults(wave1.batchId) : [],
            blockNameByCustomId: wave1.blockNameByCustomId,
            entries: llmEntries,
            attempt: 1,
            sourceHosts,
            priorUsageByBlockName: {},
          }),
        );
        generatedCount += wave1Outcome.okCount;
        wave2 = wave1Outcome.retry;
        syncFallback = wave1Outcome.syncFallback;
      }

      // 5. Wave-2 corrective batch (validation/max_tokens failures only).
      if (wave2.length > 0) {
        const wave2Submit = await step.run("batch-submit-wave-2", async () => {
          const supabase = createAdminClient();
          const cache = new Map<string, string | null>();
          const taken = new Set<string>();
          const items: BatchRequestItem[] = [];
          const blockNameByCustomId: Record<string, string> = {};
          for (const descriptor of wave2) {
            const entry = entryByBlockName.get(descriptor.blockName);
            if (!entry) continue;
            let screenshotBase64: string | undefined;
            if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
              screenshotBase64 = await loadScreenshotCached(
                supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
              );
            }
            const item = buildWave2Item({
              descriptor,
              options: optionsForEntry(entry, screenshotBase64),
              taken,
            });
            blockNameByCustomId[item.customId] = descriptor.blockName;
            items.push(item);
          }
          const batchId = await submitGenerationBatch(items);
          console.log(
            `[generate-components] batch wave-2 submitted: ${items.length} corrective items, batch ${batchId}`,
          );
          return { batchId, blockNameByCustomId };
        });

        let polls2 = 0;
        let verdict2: "collect" | "wait" | "timeout" = "wait";
        while (verdict2 === "wait") {
          const status = await step.run(`batch-wave2-poll-${polls2}`, () =>
            getBatchStatus(wave2Submit.batchId),
          );
          verdict2 = pollVerdict(status, polls2);
          if (verdict2 === "wait") {
            polls2++;
            await step.sleep(`batch-wave2-sleep-${polls2}`, BATCH_POLL_INTERVAL);
          }
        }

        let collectable2 = verdict2 === "collect";
        if (verdict2 === "timeout") {
          await step.run("batch-wave2-cancel", () => cancelGenerationBatch(wave2Submit.batchId));
          await step.sleep("batch-wave2-drain-sleep", BATCH_POLL_INTERVAL);
          const drained = await step.run("batch-wave2-drain-poll", () =>
            getBatchStatus(wave2Submit.batchId),
          );
          collectable2 = drained === "ended";
        }

        const wave2Outcome = await step.run("batch-finalize-wave-2", async () =>
          finalizeComponentWave({
            buildId,
            projectId,
            results: collectable2 ? await collectBatchResults(wave2Submit.batchId) : [],
            blockNameByCustomId: wave2Submit.blockNameByCustomId,
            entries: wave2
              .map((d) => entryByBlockName.get(d.blockName))
              .filter((e): e is EnrichedInventoryEntry => e !== undefined),
            attempt: 2,
            sourceHosts,
            priorUsageByBlockName: Object.fromEntries(wave2.map((d) => [d.blockName, d.usage])),
            priorAttemptsByBlockName: Object.fromEntries(
              wave2.map((d) => [d.blockName, d.attempts]),
            ),
          }),
        );
        generatedCount += wave2Outcome.okCount;
        syncFallback = syncFallback.concat(wave2Outcome.syncFallback);
      }

      // 6. Sync fallback for stragglers (API failures / unfinished batches):
      //    the normal generateComponent path, prior wave spend merged in.
      for (let i = 0; i < syncFallback.length; i += BATCH_SIZE) {
        const chunk = syncFallback.slice(i, i + BATCH_SIZE);
        const chunkOk = await step.run(`batch-sync-fallback-${i / BATCH_SIZE}`, async () => {
          const supabase = createAdminClient();
          const cache = new Map<string, string | null>();
          let ok = 0;
          for (const descriptor of chunk) {
            const entry = entryByBlockName.get(descriptor.blockName);
            if (!entry) continue;
            let screenshotBase64: string | undefined;
            if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
              screenshotBase64 = await loadScreenshotCached(
                supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
              );
            }
            const generated = await generateComponent(optionsForEntry(entry, screenshotBase64));
            const component = mergeUsageIntoComponent(
              generated, descriptor.usage, descriptor.attempts,
            );
            await persistGeneration({ buildId, projectId, component });
            if (component.compileStatus !== "failed") ok++;
          }
          return ok;
        });
        generatedCount += chunkOk;
      }
    }
```

(Everything after this region — the `update-counts` terminal-state guard, `dispatch-compose`, the return, the catch — stays untouched.)

- [ ] Typecheck: `pnpm --filter @jab/web typecheck` — expect clean.
- [ ] Full suite: `pnpm --filter @jab/web test` — expect PASS (sync-path behavior unchanged is the regression gate; every existing component/worker-adjacent test must stay green).
- [ ] Verify the sync loop moved unmodified: `git diff apps/web/lib/inngest/functions/generate-components.ts` — confirm the `generate-batch-${batchIdx}` step body shows only indentation-level changes (the diff inside the `if (!batchEnabled)` block must contain no logic edits).
- [ ] Commit: `git add apps/web/lib/inngest/functions/generate-components.ts && git commit -m "feat(saas): generate-components batch mode behind JAB_BATCH_GENERATE — wave-1/wave-2/sync-fallback"`

---

### Task 9: generate-shell — batch item builder + result finalizer

**Files:**
- Modify: `apps/web/lib/ai/generate-shell.ts` — anchors (pre-phase): the prompt construction in `generateShell` (lines 108–122, `const promptInput = {...}` through the sentinel split — post-Phase-2 this is a `{ system, user }` + `shouldCacheShellPrefix` computation), the attempt body (lines 130–173), `MAX_SHELL_BYTES` (line 43).
- Modify: `apps/web/lib/ai/generate-shell.test.ts`

Same extraction pattern as Task 4: move the post-Phase-2 prompt-parts computation into an exported `buildShellRequestParts`, then add the batch item builder + result finalizer that mirror the sync attempt body. The shells batch is wave-1 only — any failure falls back to sync `generateShell` (which carries Phase 2's own corrective retry), so no shell wave-2 is needed.

- [ ] Append failing tests to `apps/web/lib/ai/generate-shell.test.ts` (reuse that file's existing option fixtures/mocks; the snippet below assumes a local `makeShellOpts()` helper — if the existing file already has an options factory, use it instead of redefining):

```ts
import {
  buildShellRequestParts,
  buildShellBatchItem,
  finalizeShellBatchResult,
  mergeShellUsage,
} from "./generate-shell";
import type { BatchResultItem } from "@/lib/ai/batch-client";

const VALID_HEADER_TSX = `export function Header() {
  return <header className="p-4">site</header>;
}
`;

function makeShellOpts(over: Partial<import("./generate-shell").GenerateShellOptions> = {}) {
  return {
    kind: "header" as const,
    shellDom: "<header><nav><a href='/'>Home</a></nav></header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Two Roads",
    siteDescription: null,
    client: { async generate() { throw new Error("client must not be called by batch helpers"); } },
    ...over,
  };
}

describe("buildShellRequestParts / buildShellBatchItem", () => {
  it("returns null for empty shellDom (sync short-circuit owns that case)", () => {
    expect(buildShellRequestParts(makeShellOpts({ shellDom: "" }))).toBeNull();
    expect(buildShellBatchItem(makeShellOpts({ shellDom: "   " }), "shell_header")).toBeNull();
  });

  it("builds a batch item with the visual-tier model config and the shell prompt parts", () => {
    const item = buildShellBatchItem(makeShellOpts(), "shell_header");
    expect(item).not.toBeNull();
    expect(item!.customId).toBe("shell_header");
    expect(item!.model).toBe("claude-sonnet-4-6");
    expect(item!.maxTokens).toBe(8192);
    expect(item!.user.length).toBeGreaterThan(0);
    expect(item!.system.length).toBeGreaterThan(0);
    expect(item!.screenshotBase64).toBeUndefined();
  });
});

describe("finalizeShellBatchResult", () => {
  const okResult: BatchResultItem = {
    customId: "shell_header",
    ok: true,
    text: VALID_HEADER_TSX,
    usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason: "end_turn",
    model: "claude-sonnet-4-6",
  };

  it("returns a persisted-shape GeneratedShell on a valid result", () => {
    const shell = finalizeShellBatchResult(makeShellOpts(), okResult);
    expect(shell).not.toBeNull();
    expect(shell!).toMatchObject({
      shellKind: "header",
      compileStatus: "ok",
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
      inputTokens: 900,
      outputTokens: 400,
    });
    expect(shell!.tsx).toContain("export function Header");
  });

  it("returns null (→ sync fallback) for API failures, truncation, and invalid TSX", () => {
    expect(
      finalizeShellBatchResult(makeShellOpts(), { ...okResult, ok: false, text: "", errorKind: "rate_limit" }),
    ).toBeNull();
    expect(
      finalizeShellBatchResult(makeShellOpts(), { ...okResult, stopReason: "max_tokens" }),
    ).toBeNull();
    expect(
      finalizeShellBatchResult(makeShellOpts(), {
        ...okResult,
        text: "export function Header() { return <header>broken; }",
      }),
    ).toBeNull();
  });
});

describe("mergeShellUsage", () => {
  it("adds prior batch spend + attempts onto a sync-fallback GeneratedShell", () => {
    const base = {
      shellKind: "header" as const,
      tsx: VALID_HEADER_TSX,
      compileStatus: "ok" as const,
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic" as const,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const merged = mergeShellUsage(
      base,
      { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 },
      1,
    );
    expect(merged.inputTokens).toBe(1000);
    expect(merged.outputTokens).toBe(450);
    expect(merged.compileAttemptCount).toBe(2);
  });
});
```

- [ ] Run: `pnpm --filter @jab/web test lib/ai/generate-shell.test.ts` — expect failure: `buildShellRequestParts` is not exported.
- [ ] Implement in `apps/web/lib/ai/generate-shell.ts`:

```ts
import { modelConfigForTier, type GenerateUsage, type StopReason } from "./model-client"; // merge into existing imports
import type { BatchRequestItem, BatchResultItem } from "./batch-client";

export interface ShellRequestParts {
  cachedSystemPrefix: string | undefined;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Pure prompt-parts builder shared by sync generateShell and the batch
 * ride-along. Returns null for empty shellDom (the sync short-circuit emits
 * the deterministic fallback for that case). MOVE the post-Phase-2 prompt
 * computation from generateShell into here VERBATIM — the {system,user}
 * builder call plus the shouldCacheShellPrefix split — and re-point
 * generateShell at this helper.
 */
export function buildShellRequestParts(opts: GenerateShellOptions): ShellRequestParts | null {
  if (!opts.shellDom || opts.shellDom.trim().length === 0) return null;
  // ↓↓↓ MOVED VERBATIM from generateShell (post-Phase-2 body):
  //   - promptInput construction
  //   - headerPrompt/footerPrompt → { system, user }
  //   - shouldCacheShellPrefix(stableSections) → cachedSystemPrefix vs
  //     uncached systemPrompt placement
  // ↑↑↑ end moved block ↑↑↑
  return { cachedSystemPrefix, systemPrompt, userPrompt };
}

/** Shell entry for a Message Batch. Shells run on the visual-tier model config. */
export function buildShellBatchItem(
  opts: GenerateShellOptions,
  customId: string,
): BatchRequestItem | null {
  const parts = buildShellRequestParts(opts);
  if (!parts) return null;
  const cfg = modelConfigForTier("visual");
  return {
    customId,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    cachedSystemPrefix: parts.cachedSystemPrefix,
    system: parts.systemPrompt,
    user: parts.userPrompt,
  };
}

/**
 * Batch twin of generateShell's per-attempt body (postprocess → relink →
 * byte cap → validate). Returns null on ANY failure — the caller falls back
 * to sync generateShell, which carries the corrective retry; merge the
 * wasted batch spend in via mergeShellUsage.
 */
export function finalizeShellBatchResult(
  opts: GenerateShellOptions,
  result: BatchResultItem,
): GeneratedShell | null {
  if (!result.ok) return null;
  if (result.stopReason === "max_tokens") return null;

  const relink = (tsx: string): string =>
    opts.sourceHosts && opts.sourceHosts.length > 0
      ? rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap })
      : tsx;

  const expectedName = opts.kind === "header" ? "Header" : "Footer";
  let stripped: string;
  try {
    stripped = postprocessGeneratedTsx(result.text.trim(), { expectedExportName: expectedName });
  } catch {
    return null;
  }
  stripped = relink(stripped);
  if (Buffer.byteLength(stripped, "utf8") > MAX_SHELL_BYTES) return null;
  if (validateTsx(stripped, `${expectedName}.tsx`).length > 0) return null;

  return {
    shellKind: opts.kind,
    tsx: stripped,
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: result.model,
    providerUsed: "anthropic",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
  };
}

/** Fold wasted batch spend into a sync-fallback GeneratedShell before persisting. */
export function mergeShellUsage(
  shell: GeneratedShell,
  prior: GenerateUsage,
  priorAttempts: number,
): GeneratedShell {
  return {
    ...shell,
    compileAttemptCount: shell.compileAttemptCount + priorAttempts,
    inputTokens: shell.inputTokens + prior.inputTokens,
    outputTokens: shell.outputTokens + prior.outputTokens,
    cacheReadTokens: shell.cacheReadTokens + prior.cacheReadTokens,
    cacheCreationTokens: shell.cacheCreationTokens + prior.cacheCreationTokens,
  };
}
```

(If post-Phase-1/2 `GeneratedShell` carries extra fields — e.g. `failureKind` — mirror the sync ok-return exactly; the persisted upsert in `persist-shell-generation.ts:103-119` maps the object 1:1.)

- [ ] Run: `pnpm --filter @jab/web test lib/ai/generate-shell.test.ts` — expect PASS, and the full suite (`pnpm --filter @jab/web test`) stays green (the buildShellRequestParts move must not change sync behavior).
- [ ] Commit: `git add apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/generate-shell.test.ts && git commit -m "feat(saas): shell batch helpers — request parts extraction + batch finalizer with sync fallback"`

---

### Task 10: compose-site — shells-ride-along for full builds

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` — anchors (pre-phase): `const shellClient = modelClientForTier("visual");` (line 629), `baseShellInput` (lines 634–655), `shellEditGuidance` (lines 660–663), `skipShellRegen` (lines 669–670), the shell generation block (pre-phase `await Promise.all([...generate-header..., ...generate-footer...])`, lines 672–715 — post-Phase-2 this is sequential header→footer steps; treat whatever is there as "the sync shell block").

Batch applies ONLY when `JAB_BATCH_GENERATE=1` AND the build is not an edit (`isEditConfig(buildConfig)` is already imported, line 57). Edit builds keep the sequential sync path (a user is iterating). Wave-1 only; per-shell failure → sync `generateShell` fallback with usage merge.

- [ ] Add imports:

```ts
import { isBatchGenerateEnabled, pollVerdict, MAX_BATCH_POLLS, BATCH_POLL_INTERVAL } from "@/lib/jab/component-batch";
import { submitGenerationBatch, getBatchStatus, collectBatchResults, cancelGenerationBatch, type BatchRequestItem, type BatchResultItem } from "@/lib/ai/batch-client";
import { buildShellBatchItem, finalizeShellBatchResult, mergeShellUsage, type GenerateShellOptions } from "@/lib/ai/generate-shell"; // merge with the existing generateShell import
```

- [ ] Directly after the `skipShellRegen` const, add an options factory and the branch gate, then wrap the existing sync shell block in the `else`:

```ts
    const shellOptsFor = (kind: "header" | "footer"): GenerateShellOptions => ({
      ...baseShellInput,
      kind,
      shellDom:
        (kind === "header" ? designTokens.shellDom?.header : designTokens.shellDom?.footer) ?? "",
      shellColors:
        (kind === "header" ? designTokens.shellStyles?.header : designTokens.shellStyles?.footer) ??
        null,
      guidance: shellEditGuidance(kind),
    });

    // Shells-ride-along: batch the header+footer LLM calls on FULL builds
    // when JAB_BATCH_GENERATE=1. Edit builds always keep the sequential sync
    // path — a user is waiting on the edit→preview loop.
    const shellBatchEnabled = isBatchGenerateEnabled(process.env) && !isEditConfig(buildConfig);

    if (!shellBatchEnabled) {
      // ─── SYNC SHELL PATH — UNCHANGED (post-Phase-2 sequential steps) ───
      // ... the existing generate-header / generate-footer step block moves
      // here VERBATIM. Do not edit it.
    } else {
      // ─── SHELL BATCH PATH ───
      // Reuse carve-out first (JAB_SKIP_SHELL_REGEN): only non-reused kinds batch.
      const kindsToGenerate: Array<"header" | "footer"> = [];
      for (const kind of ["header", "footer"] as const) {
        const artifactExists = await step.run(`shell-batch-reuse-check-${kind}`, () =>
          shellArtifactExists(buildId, kind),
        );
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            hasEditGuidance: false, // edit builds never reach this branch
            artifactExists,
          })
        ) {
          console.log(`[compose-site ${buildId}] JAB_SKIP_SHELL_REGEN: reusing existing ${kind}`);
        } else {
          kindsToGenerate.push(kind);
        }
      }

      // Submit one batch for the kinds that have shellDom. Kinds with empty
      // shellDom skip the batch — sync generateShell's short-circuit emits
      // the deterministic fallback at zero tokens.
      const submitted = await step.run("shell-batch-submit", async () => {
        const entries: Array<{ kind: "header" | "footer"; item: BatchRequestItem }> = [];
        for (const kind of kindsToGenerate) {
          const item = buildShellBatchItem(shellOptsFor(kind), `shell_${kind}`);
          if (item) entries.push({ kind, item });
        }
        if (entries.length === 0) return null;
        const batchId = await submitGenerationBatch(entries.map((e) => e.item));
        console.log(`[compose-site ${buildId}] shell batch submitted: ${batchId}`);
        return { batchId, kinds: entries.map((e) => e.kind) };
      });

      for (const kind of kindsToGenerate) {
        if (!submitted || !submitted.kinds.includes(kind)) {
          await step.run(`shell-batch-empty-${kind}`, async () => {
            const out = await generateShell(shellOptsFor(kind));
            await persistShellGeneration({ buildId, projectId, shell: out });
            return { shellKind: kind, compileStatus: out.compileStatus };
          });
        }
      }

      if (submitted) {
        let polls = 0;
        let verdict: "collect" | "wait" | "timeout" = "wait";
        while (verdict === "wait") {
          const status = await step.run(`shell-batch-poll-${polls}`, () =>
            getBatchStatus(submitted.batchId),
          );
          verdict = pollVerdict(status, polls);
          if (verdict === "wait") {
            polls++;
            await step.sleep(`shell-batch-sleep-${polls}`, BATCH_POLL_INTERVAL);
          }
        }
        let collectable = verdict === "collect";
        if (verdict === "timeout") {
          await step.run("shell-batch-cancel", () => cancelGenerationBatch(submitted.batchId));
          await step.sleep("shell-batch-drain-sleep", BATCH_POLL_INTERVAL);
          const drained = await step.run("shell-batch-drain-poll", () =>
            getBatchStatus(submitted.batchId),
          );
          collectable = drained === "ended";
        }

        // Finalize: persist valid batch shells; report fallbacks (small output).
        const shellFallbacks = await step.run("shell-batch-finalize", async () => {
          const results: BatchResultItem[] = collectable
            ? await collectBatchResults(submitted.batchId)
            : [];
          const byId = new Map(results.map((r) => [r.customId, r]));
          const fallbacks: Array<{
            kind: "header" | "footer";
            priorUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
          }> = [];
          for (const kind of submitted.kinds) {
            const result = byId.get(`shell_${kind}`);
            const shell = result ? finalizeShellBatchResult(shellOptsFor(kind), result) : null;
            if (shell) {
              await persistShellGeneration({ buildId, projectId, shell });
            } else {
              fallbacks.push({
                kind,
                priorUsage: result?.ok
                  ? result.usage
                  : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
              });
            }
          }
          return fallbacks;
        });

        // Sync fallback — SEQUENTIAL, header first (Phase 2 cache-ordering rule).
        for (const fallback of shellFallbacks) {
          await step.run(`shell-batch-fallback-${fallback.kind}`, async () => {
            const out = await generateShell(shellOptsFor(fallback.kind));
            await persistShellGeneration({
              buildId,
              projectId,
              shell: mergeShellUsage(out, fallback.priorUsage, 1),
            });
            return { shellKind: fallback.kind, compileStatus: out.compileStatus };
          });
        }
      }
    }
```

> Note: the sync shell block being wrapped builds its options inline (pre-phase lines 684–690 / 705–711); when moving it into the else-branch you may either leave it verbatim or substitute `shellOptsFor(kind)` ONLY IF the substitution is provably identical (`shellOptsFor` was derived from those exact lines). When in doubt, leave it verbatim — flag-off byte-identity outranks DRY here.

- [ ] Typecheck: `pnpm --filter @jab/web typecheck` — expect clean.
- [ ] Full suite: `pnpm --filter @jab/web test` — expect PASS.
- [ ] Verify via `git diff apps/web/lib/inngest/functions/compose-site.ts` that the sync shell block contains no logic edits (indentation only).
- [ ] Commit: `git add apps/web/lib/inngest/functions/compose-site.ts && git commit -m "feat(saas): compose-site shells-ride-along batch for full builds (JAB_BATCH_GENERATE)"`

---

### Task 11: flag documentation, operator runbook, final verification

**Files:**
- Modify: `apps/web/.env.local.example` — feature-flags section (verified: `# JAB_GENERATE_MOCK=1` block ends at line 92)
- Create: `docs/batch-generation-runbook.md`

- [ ] Add to `apps/web/.env.local.example`, directly after the `# JAB_GENERATE_MOCK=1` line:

```
# Batch API for build pipelines: Phase B component generation + Phase C
# shells on FULL builds route through Anthropic Message Batches (50% off all
# tokens). Adds batch queue latency — typically minutes, capped at ~30min per
# wave before the worker falls back to the synchronous path. Chat-edit regens
# and edit builds NEVER batch. Ignored when JAB_GENERATE_MOCK=1 (mock wins).
# Off unless exactly "1". Runbook: docs/batch-generation-runbook.md
# JAB_BATCH_GENERATE=1
```

- [ ] Create `docs/batch-generation-runbook.md`:

```markdown
# Batch generation runbook (JAB_BATCH_GENERATE)

Operator guide for the Message-Batches build path (Phase 3 of the
2026-06-10 AI-call-optimization campaign,
`docs/superpowers/plans/2026-06-10-ai-call-optimization/03-batch-api.md`).

## What the flag does

`JAB_BATCH_GENERATE=1` (in the **Inngest worker process env** — the dev
server reads `.env.local` at boot, same dual-process trap as
`JAB_GENERATE_MOCK`) routes:

- **generate-components (Phase B):** all LLM-tier block entries into one
  Message Batch (custom_id = sanitized block_name) → 30s poll loop (60-poll
  cap ≈ 30 min) → local validateTsx → a wave-2 corrective batch (`*_r2`
  custom_ids) for validation/truncation failures → synchronous
  `generateComponent` fallback for anything the batch never finished.
  Passthrough rows never batch (zero-LLM path, unchanged).
- **compose-site (Phase C):** header+footer into one batch on FULL builds
  only. Edit builds and chat-edit regens ALWAYS stay synchronous.

Telemetry is persisted identically to the sync path (same
`block_inventory` / `shell_generations` columns; batch waves accumulate into
the same token counters, `compile_attempt_count` counts waves + sync
fallback attempts). Requires migration 0034 applied to BOTH Supabase
projects first (see the two-supabase-projects memory note).

## The tradeoff

| | Sync (default) | Batch (`JAB_BATCH_GENERATE=1`) |
| --- | --- | --- |
| Token price | 100% | **50%** (all tokens, incl. output + cache) |
| Phase B wall time | ~1–3 min | typically +5–20 min; worst case +~60 min (two waves) then sync recovery |
| Use for | demos, edit loops, anything human-watched | overnight/bulk full builds, scoped rebuilds, cost-sensitive pilots |

## Watching a batch

1. **Inngest dev UI** (http://localhost:8288): the run shows
   `batch-submit-wave-1` (output carries the `batchId`), then alternating
   `batch-wave1-poll-N` / sleep steps. The batch id is also logged:
   `[generate-components] batch wave-1 submitted: N items, batch msgbatch_...`.
2. **Anthropic Console** → Usage → Batches: shows request_counts
   (processing/succeeded/errored/canceled/expired).
3. **API:**

   ```bash
   curl https://api.anthropic.com/v1/messages/batches/msgbatch_XXX \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01"
   ```

   Watch `processing_status` (`in_progress` → `ended`) and `request_counts`.

## Cancelling a batch

```bash
curl -X POST https://api.anthropic.com/v1/messages/batches/msgbatch_XXX/cancel \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```

- Cancelling moves the batch `canceling` → `ended`; already-finished rows
  remain collectable, cancelled rows return `result.type: "canceled"`.
- The worker treats canceled/expired rows as sync-fallback stragglers — it
  will regenerate them synchronously and the build still completes. You do
  NOT need to touch the build row.
- The worker also cancels automatically when a wave exceeds the 60-poll cap.
- To stop the BUILD (not just the batch), use the normal build-discard path;
  the worker's terminal-state guards stop before dispatching compose.

## Caching interaction

Batch requests carry the same cache_control blocks as sync requests and the
50% discount stacks with cache reads. BUT: identical cached prefixes
submitted in one batch may all be processed concurrently and miss the cache
(readable only after a first response). Do not expect `input_tokens_cached`
to be high inside a single batch — the 50% batch discount, not the cache,
is the dominant saving on this path.

## Quick smoke

`JAB_BATCH_GENERATE=1` in `.env.local`, restart `pnpm dev` + Inngest, then
`pnpm --filter @jab/web smoke:generate` against a discovered build. Expect
the wave steps in the Inngest UI and non-zero token columns on
block_inventory afterward. With `JAB_GENERATE_MOCK=1` also set, mock wins:
no batch steps appear and cost stays $0.
```

- [ ] Final verification (flag-off byte-identity sweep):
  - `pnpm --filter @jab/web test` — full suite PASS.
  - `pnpm --filter @jab/web typecheck` — clean.
  - `git diff master...HEAD --stat -- apps/web/lib/inngest/functions/generate-components.ts apps/web/lib/inngest/functions/compose-site.ts` and re-confirm both sync blocks are indentation-only moves.
  - Optional live validation (operator decision, costs real tokens): set `JAB_BATCH_GENERATE=1` in the worker env and run `pnpm --filter @jab/web smoke:generate` per the runbook; confirm `batch-submit-wave-1` → poll → finalize steps in the Inngest UI and that `block_inventory` rows carry tokens + `compile_status` exactly like a sync run.
- [ ] Commit: `git add apps/web/.env.local.example docs/batch-generation-runbook.md && git commit -m "docs(saas): JAB_BATCH_GENERATE flag docs + batch generation operator runbook"`
