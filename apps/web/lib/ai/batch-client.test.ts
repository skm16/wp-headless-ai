import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("./client", () => ({ getAnthropicClient: vi.fn() }));

import { getAnthropicClient } from "./client";
import {
  sanitizeBatchCustomId,
  buildBatchRequest,
  submitGenerationBatch,
  getBatchStatus,
  collectBatchResults,
  cancelGenerationBatch,
  mapBatchRow,
  errorKindFromBatchError,
  type BatchRequestItem,
  type BatchRowShape,
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

  it("emits both system blocks and both content blocks when cachedSystemPrefix and screenshotBase64 are both present", () => {
    const req = buildBatchRequest(makeItem({ cachedSystemPrefix: "STATIC", screenshotBase64: "aGk=" }));
    expect(req.params.system).toHaveLength(2);
    expect(req.params.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(req.params.system[1]).not.toHaveProperty("cache_control");
    const content = req.params.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("text");
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

describe("getBatchStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the processing_status from retrieve", async () => {
    const retrieve = vi.fn().mockResolvedValue({ processing_status: "ended" });
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { retrieve } } });
    expect(await getBatchStatus("msgbatch_1")).toBe("ended");
    expect(retrieve).toHaveBeenCalledWith("msgbatch_1");
  });

  it("passes through a real processing_status of 'errored' (Anthropic-side batch failure)", async () => {
    // Distinct from the transient-failure case below: here the API itself
    // reports the batch as errored, and the value flows through untouched.
    const retrieve = vi.fn().mockResolvedValue({ processing_status: "errored" });
    (getAnthropicClient as Mock).mockReturnValue({ messages: { batches: { retrieve } } });
    expect(await getBatchStatus("msgbatch_1")).toBe("errored");
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
