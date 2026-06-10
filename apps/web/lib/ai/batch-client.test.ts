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
