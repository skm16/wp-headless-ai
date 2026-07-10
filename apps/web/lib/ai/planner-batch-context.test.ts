import { describe, it, expect } from "vitest";
import { appendBatchContext } from "./planner-batch-context";

describe("appendBatchContext", () => {
  it("appends a machine-readable batch line when the plan carries an in-progress batch", () => {
    const out = appendBatchContext("Restyled Featured Beer.", {
      batch: { remaining: ["acf/featured-news", "acf/visit-us"], guidance: "uniform View More link" },
    });
    expect(out).toContain("Restyled Featured Beer.");
    expect(out).toContain("acf/featured-news");
    expect(out).toContain("acf/visit-us");
    expect(out).toContain("uniform View More link");
    expect(out.toLowerCase()).toContain("remaining");
  });
  it("returns content unchanged when there is no batch", () => {
    expect(appendBatchContext("hi", { action: "x" })).toBe("hi");
    expect(appendBatchContext("hi", null)).toBe("hi");
  });
  it("returns content unchanged when remaining is empty (batch finished)", () => {
    expect(appendBatchContext("done", { batch: { remaining: [], guidance: "x" } })).toBe("done");
  });
});
