import { describe, it, expect } from "vitest";
import { partitionSonnetWarmup } from "./sonnet-warmup";
import type { EnrichedInventoryEntry } from "./inventory";

function entry(over: Partial<EnrichedInventoryEntry>): EnrichedInventoryEntry {
  return {
    blockName: "core/button",
    occurrenceCount: 1,
    pageSlugs: ["home"],
    attrSamples: [{}],
    tier: "visual",
    kind: "block",
    sourceDomSample: null,
    computedStyles: null,
    ...over,
  } as EnrichedInventoryEntry;
}

describe("partitionSonnetWarmup", () => {
  it("pulls the FIRST Sonnet-tier entry (visual or standard) out of the queue", () => {
    const q = [
      entry({ blockName: "core/html", tier: "passthrough" }),
      entry({ blockName: "core/heading", tier: "trivial" }),
      entry({ blockName: "core/cover", tier: "visual" }),
      entry({ blockName: "core/quote", tier: "standard" }),
    ];
    const { warmup, rest } = partitionSonnetWarmup(q);
    expect(warmup?.blockName).toBe("core/cover");
    expect(rest.map((e) => e.blockName)).toEqual(["core/html", "core/heading", "core/quote"]);
  });

  it("standard tier qualifies when it comes first (same Sonnet model = same cache)", () => {
    const q = [entry({ blockName: "cpt/beer", tier: "standard" }), entry({ tier: "visual" })];
    expect(partitionSonnetWarmup(q).warmup?.blockName).toBe("cpt/beer");
  });

  it("skips null-blockName rows (they early-return without an LLM call)", () => {
    const q = [
      entry({ blockName: null as unknown as string, tier: "visual" }),
      entry({ blockName: "core/cover", tier: "visual" }),
    ];
    const { warmup, rest } = partitionSonnetWarmup(q);
    expect(warmup?.blockName).toBe("core/cover");
    expect(rest.map((e) => e.blockName)).toEqual([null]);
  });

  it("returns null warmup + untouched queue when no Sonnet-tier entry exists", () => {
    const q = [entry({ tier: "trivial" }), entry({ tier: "passthrough" })];
    const { warmup, rest } = partitionSonnetWarmup(q);
    expect(warmup).toBeNull();
    expect(rest).toEqual(q);
  });

  it("preserves relative order of the remaining entries", () => {
    const q = [entry({ blockName: "a", tier: "trivial" }), entry({ blockName: "b", tier: "visual" }), entry({ blockName: "c", tier: "trivial" })];
    expect(partitionSonnetWarmup(q).rest.map((e) => e.blockName)).toEqual(["a", "c"]);
  });
});
