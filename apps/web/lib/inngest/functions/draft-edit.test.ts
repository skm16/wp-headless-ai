import { describe, it, expect, afterEach, vi } from "vitest";
import {
  unitKeyFor,
  exportNameFor,
  maxBytesFor,
  detectAndMaybeStripDeadClasses,
  resolveDataShapeForEdit,
  failedEditChatPatch,
} from "./draft-edit";
import { CLASSIC_COMPONENT_NAME } from "@/lib/jab/classic-content";
import type { BlockInventoryLike } from "@/lib/jab/resolve-block-data-source";

describe("resolveDataShapeForEdit — the data-shape gating invariant (Defect 3 efficiency)", () => {
  const relationEntry: BlockInventoryLike = {
    blockName: "acf/featured-beer",
    attrSamples: [{ beers: [{ ID: 1, post_title: "X", post_name: "x", post_type: "beer" }] }],
  };
  const directAcfEntry: BlockInventoryLike = {
    blockName: "acf/section",
    attrSamples: [{ heading: "Our Beers", subtitle: "On tap" }],
  };

  it("does NOT load the manifest for a cosmetic edit (gate miss)", async () => {
    const loadManifest = vi.fn(async () => null);
    const out = await resolveDataShapeForEdit({
      guidance: "make it bigger",
      loadBlockEntry: async () => relationEntry,
      loadManifest,
    });
    expect(loadManifest).not.toHaveBeenCalled();
    expect(out).toBeUndefined();
  });

  it("does NOT load the manifest for a direct-acf hit (fields come from the block sample)", async () => {
    const loadManifest = vi.fn(async () => null);
    const out = await resolveDataShapeForEdit({
      guidance: "show the subtitle",
      loadBlockEntry: async () => directAcfEntry,
      loadManifest,
    });
    expect(loadManifest).not.toHaveBeenCalled();
    expect(out).toContain("heading"); // direct-acf still produces a section from the sample
  });

  it("DOES load the manifest for a data-relevant relation edit", async () => {
    const loadManifest = vi.fn(async () => null); // null → section fail-softs to undefined, but the read fired
    await resolveDataShapeForEdit({
      guidance: "show the beer description",
      loadBlockEntry: async () => relationEntry,
      loadManifest,
    });
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  it("returns undefined (loads nothing) when there is no block entry", async () => {
    const loadManifest = vi.fn(async () => null);
    const out = await resolveDataShapeForEdit({
      guidance: "show the beer description",
      loadBlockEntry: async () => null,
      loadManifest,
    });
    expect(loadManifest).not.toHaveBeenCalled();
    expect(out).toBeUndefined();
  });
});

describe("failedEditChatPatch — preserves the batch echo (findings A+B)", () => {
  it("returns null so the assistant message content + needs_clarification are untouched on edit failure", () => {
    // The assistant turn carries the echoed 'remaining: …' list the planner
    // needs; overwriting it (old behavior) destroyed the history-only queue and
    // made an error bubble render an 'Apply to all' chip. The failure must
    // surface via the linked edit's failed status + error_text instead.
    expect(failedEditChatPatch()).toBeNull();
  });
});

describe("draft-edit pure helpers", () => {
  it("unitKeyFor maps component targets to block names and shell targets to shell: keys", () => {
    expect(unitKeyFor("component", "acf/hero")).toBe("acf/hero");
    expect(unitKeyFor("shell", "header")).toBe("shell:header");
    expect(unitKeyFor("shell", "footer")).toBe("shell:footer");
  });

  it("exportNameFor matches the dispatcher convention for components and Header/Footer for shell", () => {
    expect(exportNameFor("component", "acf/hero")).toBe("AcfHero");
    expect(exportNameFor("shell", "header")).toBe("Header");
    expect(exportNameFor("shell", "footer")).toBe("Footer");
  });

  it("exportNameFor resolves the Classic block to the ClassicContent export the wrapper declares", () => {
    // The Classic edit target ("__null__") must resolve to the same name the
    // ClassicContent wrapper exports, so the patched source path + export agree.
    expect(exportNameFor("component", "__null__")).toBe(CLASSIC_COMPONENT_NAME);
    expect(exportNameFor("component", "__null__")).toBe("ClassicContent");
  });

  it("maxBytesFor uses the component cap for components and the shell cap for shell", () => {
    expect(maxBytesFor("component")).toBe(10_000);
    expect(maxBytesFor("shell")).toBe(24_000);
  });
});

const TOKENS = { colorPalette: [{ slug: "primary", color: "#0a4f8a" }] };

describe("detectAndMaybeStripDeadClasses", () => {
  const prev = process.env.JAB_STRIP_DEAD_CLASSES;
  afterEach(() => {
    if (prev === undefined) delete process.env.JAB_STRIP_DEAD_CLASSES;
    else process.env.JAB_STRIP_DEAD_CLASSES = prev;
  });

  it("reports the dead count and leaves TSX untouched when the flag is off (default)", async () => {
    delete process.env.JAB_STRIP_DEAD_CLASSES;
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(tsx);
  });

  it("strips dead classes when JAB_STRIP_DEAD_CLASSES=1", async () => {
    process.env.JAB_STRIP_DEAD_CLASSES = "1";
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(`export function X() { return <div className="text-4xl">y</div>; }`);
  });
});
