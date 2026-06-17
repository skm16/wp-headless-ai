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
  finalizeComponentWave,
  MAX_BATCH_POLLS,
  MAX_TOKENS_RETRY_CAP,
} from "./component-batch";
import type { BatchResultItem } from "@/lib/ai/batch-client";
import type { PersistGenerationInput } from "@/lib/ai/persist-generation";

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

  it("routes the classic block (null name, tier 'classic') away from the batch LLM path", () => {
    // The Classic block must NOT reach the batch LLM submission — its
    // ClassicContent wrapper is deterministic. partition sends it to the
    // passthrough side (blockName === null), where generateComponent's
    // isClassicBlock special-case returns the wrapper. buildComponentBatchItems
    // also hard-throws on a classic entry as a backstop.
    const { llmEntries, passthroughEntries } = partitionInventoryForBatch([
      entry("acf/hero", "visual"),
      entry(null, "classic"),
    ]);
    expect(llmEntries.map((e) => e.blockName)).toEqual(["acf/hero"]);
    expect(passthroughEntries).toHaveLength(1);
    expect(passthroughEntries[0].blockName).toBeNull();
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
    // max_tokens retries get the corrective suffix too — a truncated output is
    // still a failed output, and the suffix carries the diagnostics + tail.
    expect(item.user).toBe("user:core/button\nRETRY:stop_reason=max_tokens:");
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

const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreButton({ block }: { block: BlockNode }) {
  return <a>{String(block.attrs.text ?? "")}</a>;
}
`;

const VALID_QUOTE_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreQuote({ block }: { block: BlockNode }) {
  return <blockquote>{String(block.attrs.value ?? "")}</blockquote>;
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

  it("silently drops an orphan result whose customId has no blockNameByCustomId entry", async () => {
    const { persisted, persist } = setup();
    const e = entry("core/button", "visual");
    const out = await finalizeComponentWave({
      ...base,
      // ghost_xyz is not in blockNameByCustomId — it must be ignored entirely:
      // no persist, no syncFallback entry, no throw; normal routing proceeds.
      results: [okResult("core_button"), okResult("ghost_xyz")],
      blockNameByCustomId: { core_button: "core/button" },
      entries: [e],
      persist,
    });
    expect(out.okCount).toBe(1);
    expect(out.retry).toEqual([]);
    expect(out.syncFallback).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].component.blockName).toBe("core/button");
  });

  it("downgrades an entry to the sync fallback when its persist throws, without losing the rest of the wave", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const persisted: PersistGenerationInput[] = [];
      const persist = async (input: PersistGenerationInput) => {
        if (input.component.blockName === "core/button") {
          throw new Error("storage write failed");
        }
        persisted.push(input);
        return { storagePath: "x" };
      };
      const e1 = entry("core/button", "visual"); // ok result, persist throws
      const e2 = entry("core/quote", "standard"); // ok result, persist succeeds
      const out = await finalizeComponentWave({
        ...base,
        results: [okResult("core_button"), okResult("core_quote", { text: VALID_QUOTE_TSX })],
        blockNameByCustomId: { core_button: "core/button", core_quote: "core/quote" },
        entries: [e1, e2],
        priorUsageByBlockName: {
          "core/button": { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
        persist,
      });
      // The failed-persist entry recovers via the sync path, carrying the
      // usage/attempts the persisted component would have carried.
      expect(out.syncFallback).toEqual([
        {
          blockName: "core/button",
          usage: { inputTokens: 107, outputTokens: 53, cacheReadTokens: 0, cacheCreationTokens: 0 },
          attempts: 1,
        },
      ]);
      // The rest of the wave still routes normally.
      expect(out.okCount).toBe(1);
      expect(out.retry).toEqual([]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].component.blockName).toBe("core/quote");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("core/button");
    } finally {
      warnSpy.mockRestore();
    }
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
