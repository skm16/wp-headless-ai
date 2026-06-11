import { describe, it, expect } from "vitest";
import {
  stableStringify,
  sha256Hex,
  computePromptInputsHash,
  componentEntryHash,
  buildPriorHashIndex,
  selectReusablePrior,
  type PriorComponentRow,
} from "./component-carry-forward";

const BASE_HASH_ARGS = {
  blockName: "core/cover",
  tier: "visual",
  model: "claude-sonnet-4-6",
  promptVersion: 2,
  attrSamples: [{ url: "x", dimRatio: 50 }],
  domSample: "<div class=\"wp-block-cover\"/>",
  computedStyles: { viewports: { "1280": { ".wp-block-cover": ["color: red"] } } },
  tokens: { colors: [{ slug: "primary", color: "#111111" }] },
  sourceHost: "tworoadsbrewing.com",
  screenshotSha256: "abc123",
};

describe("stableStringify", () => {
  it("is key-order invariant for objects at every depth", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (arrays are NOT sorted)", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("drops undefined object values (JSON.stringify parity) and keeps null", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe(stableStringify({ b: null }));
    expect(stableStringify({ b: null })).toContain("null");
  });

  it("handles primitives and top-level null", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("s")).toBe(JSON.stringify("s"));
    expect(stableStringify(3)).toBe("3");
  });
});

describe("computePromptInputsHash", () => {
  it("returns a 64-char sha256 hex string", () => {
    expect(computePromptInputsHash(BASE_HASH_ARGS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to key order inside nested input objects", () => {
    const reordered = {
      ...BASE_HASH_ARGS,
      computedStyles: { viewports: { "1280": { ".wp-block-cover": ["color: red"] } } },
      tokens: { colors: [{ color: "#111111", slug: "primary" }] }, // keys flipped
    };
    expect(computePromptInputsHash(reordered)).toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the screenshot hash changes (visual-tier sensitivity)", () => {
    const other = { ...BASE_HASH_ARGS, screenshotSha256: "def456" };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the screenshot goes from present to null", () => {
    const other = { ...BASE_HASH_ARGS, screenshotSha256: null };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the model changes", () => {
    const other = { ...BASE_HASH_ARGS, model: "claude-haiku-4-5-20251001" };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when promptVersion is bumped", () => {
    const other = { ...BASE_HASH_ARGS, promptVersion: 3 };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when domSample / attrSamples / tokens / sourceHost change", () => {
    const base = computePromptInputsHash(BASE_HASH_ARGS);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, domSample: null })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, attrSamples: [] })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, tokens: null })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, sourceHost: null })).not.toBe(base);
  });
});

describe("componentEntryHash", () => {
  const ENTRY = {
    blockName: "core/cover" as string | null,
    tier: "visual",
    model: "claude-sonnet-4-6",
    promptVersion: 2,
    attrSamples: [{ url: "x" }] as unknown,
    occurrenceCount: 3,
    pageSlugs: ["home", "about"],
    spec: null as unknown,
    dynamicList: null as unknown,
    domSample: "<div/>",
    computedStyles: null as unknown,
    tokens: null as unknown,
    sourceHost: null as string | null,
    screenshotSha256: null as string | null,
  };

  it("returns null for passthrough tier and for null blockName (no LLM call, nothing to reuse)", () => {
    expect(componentEntryHash({ ...ENTRY, tier: "passthrough" })).toBeNull();
    expect(componentEntryHash({ ...ENTRY, blockName: null })).toBeNull();
  });

  it("returns a hash for visual / standard / trivial tiers", () => {
    for (const tier of ["visual", "standard", "trivial"]) {
      expect(componentEntryHash({ ...ENTRY, tier })).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("changes when the acf_flex spec changes (prompt-relevant input)", () => {
    const a = componentEntryHash({ ...ENTRY, spec: { sub_fields: ["a"] } });
    const b = componentEntryHash({ ...ENTRY, spec: { sub_fields: ["b"] } });
    expect(a).not.toBe(b);
  });

  it("changes when the detected dynamicList changes (prompt contract input)", () => {
    const a = componentEntryHash({ ...ENTRY, dynamicList: { postType: "events" } });
    const b = componentEntryHash({ ...ENTRY, dynamicList: null });
    expect(a).not.toBe(b);
  });

  it("changes when occurrenceCount changes (rendered in visual/standard prompts)", () => {
    const a = componentEntryHash({ ...ENTRY, occurrenceCount: 3 });
    const b = componentEntryHash({ ...ENTRY, occurrenceCount: 4 });
    expect(a).not.toBe(b);
  });

  it("changes when a top-5 pageSlug changes (prompt renders the first 5)", () => {
    const a = componentEntryHash({ ...ENTRY, pageSlugs: ["home", "about", "c", "d", "e", "f"] });
    const b = componentEntryHash({ ...ENTRY, pageSlugs: ["home", "events", "c", "d", "e", "f"] });
    expect(a).not.toBe(b);
  });

  it("is UNCHANGED when only pageSlugs beyond the top 5 change (prompt never renders them)", () => {
    const a = componentEntryHash({ ...ENTRY, pageSlugs: ["a", "b", "c", "d", "e", "f"] });
    const b = componentEntryHash({ ...ENTRY, pageSlugs: ["a", "b", "c", "d", "e", "zzz"] });
    expect(a).toBe(b);
  });

  it("trivial tier: hash UNCHANGED when attrSamples[1] changes (trivialPrompt renders only [0])", () => {
    const a = componentEntryHash({ ...ENTRY, tier: "trivial", attrSamples: [{ url: "x" }, { url: "y" }] });
    const b = componentEntryHash({ ...ENTRY, tier: "trivial", attrSamples: [{ url: "x" }, { url: "z" }] });
    expect(a).toBe(b);
  });

  it("trivial tier: hash CHANGES when attrSamples[0] changes (the rendered sample)", () => {
    const a = componentEntryHash({ ...ENTRY, tier: "trivial", attrSamples: [{ url: "x" }, { url: "y" }] });
    const b = componentEntryHash({ ...ENTRY, tier: "trivial", attrSamples: [{ url: "X2" }, { url: "y" }] });
    expect(a).not.toBe(b);
  });

  it("visual tier: hash CHANGES when attrSamples[1] changes (visualPrompt renders up to 3 samples)", () => {
    const a = componentEntryHash({ ...ENTRY, tier: "visual", attrSamples: [{ url: "x" }, { url: "y" }] });
    const b = componentEntryHash({ ...ENTRY, tier: "visual", attrSamples: [{ url: "x" }, { url: "z" }] });
    expect(a).not.toBe(b);
  });
});

describe("buildPriorHashIndex / selectReusablePrior", () => {
  const okRow: PriorComponentRow = {
    block_name: "core/cover",
    prompt_inputs_hash: "h1",
    compile_status: "ok",
    model_used: "claude-sonnet-4-6",
    provider_used: "anthropic",
  };

  it("indexes only compile_status='ok' rows with a non-null hash", () => {
    const index = buildPriorHashIndex([
      okRow,
      { ...okRow, block_name: "core/group", prompt_inputs_hash: "h2", compile_status: "failed" },
      { ...okRow, block_name: "core/list", prompt_inputs_hash: null },
    ]);
    expect(index.get("h1")?.block_name).toBe("core/cover");
    expect(index.has("h2")).toBe(false);
    expect(index.size).toBe(1);
  });

  it("FLAG OFF: never reuses, even on a perfect hash match (byte-identical default path)", () => {
    const index = buildPriorHashIndex([okRow]);
    expect(selectReusablePrior({ flagEnabled: false, hash: "h1", index })).toBeNull();
  });

  it("flag on + matching hash → returns the prior row; null hash or miss → null", () => {
    const index = buildPriorHashIndex([okRow]);
    expect(selectReusablePrior({ flagEnabled: true, hash: "h1", index })?.block_name).toBe("core/cover");
    expect(selectReusablePrior({ flagEnabled: true, hash: null, index })).toBeNull();
    expect(selectReusablePrior({ flagEnabled: true, hash: "nope", index })).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("hashes the well-known empty-string vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
