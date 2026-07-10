// apps/web/lib/jab/batch-edit.test.ts
import { describe, it, expect } from "vitest";
import { coerceBatchState, batchRemainingFrom, batchProgressLabel } from "./batch-edit";

describe("coerceBatchState", () => {
  it("accepts a well-formed batch", () => {
    expect(coerceBatchState({ remaining: ["acf/a", "acf/b"], guidance: "make links uniform" }))
      .toEqual({ remaining: ["acf/a", "acf/b"], guidance: "make links uniform" });
  });
  it("accepts an empty remaining array (batch finished)", () => {
    expect(coerceBatchState({ remaining: [], guidance: "x" })).toEqual({ remaining: [], guidance: "x" });
  });
  it("returns null for null / non-object", () => {
    expect(coerceBatchState(null)).toBeNull();
    expect(coerceBatchState("nope")).toBeNull();
    expect(coerceBatchState(42)).toBeNull();
  });
  it("returns null when remaining is not a string[]", () => {
    expect(coerceBatchState({ remaining: "acf/a", guidance: "x" })).toBeNull();
    expect(coerceBatchState({ remaining: [1, 2], guidance: "x" })).toBeNull();
    expect(coerceBatchState({ remaining: ["ok", null], guidance: "x" })).toBeNull();
  });
  it("returns null when guidance is missing or not a string", () => {
    expect(coerceBatchState({ remaining: ["acf/a"] })).toBeNull();
    expect(coerceBatchState({ remaining: ["acf/a"], guidance: 5 })).toBeNull();
  });
  it("drops extra keys, keeping only remaining + guidance", () => {
    expect(coerceBatchState({ remaining: ["acf/a"], guidance: "x", evil: 1 }))
      .toEqual({ remaining: ["acf/a"], guidance: "x" });
  });
});

describe("batchRemainingFrom", () => {
  it("pulls remaining out of a persisted plan record", () => {
    expect(batchRemainingFrom({ batch: { remaining: ["acf/a", "acf/b"], guidance: "x" } }))
      .toEqual(["acf/a", "acf/b"]);
  });
  it("returns [] when there is no batch", () => {
    expect(batchRemainingFrom({ action: "just an edit" })).toEqual([]);
    expect(batchRemainingFrom(null)).toEqual([]);
    expect(batchRemainingFrom({ batch: null })).toEqual([]);
  });
  it("returns [] when batch.remaining is malformed", () => {
    expect(batchRemainingFrom({ batch: { remaining: "x", guidance: "y" } })).toEqual([]);
  });
});

describe("batchProgressLabel", () => {
  it("labels a positive remaining count", () => {
    expect(batchProgressLabel(2)).toBe("2 sections left in this change");
    expect(batchProgressLabel(1)).toBe("1 section left in this change");
  });
  it("returns null for zero", () => {
    expect(batchProgressLabel(0)).toBeNull();
  });
});
