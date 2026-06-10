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
