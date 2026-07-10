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

describe("appendBatchContext — failed batch apply turn (re-adversarial residual 2)", () => {
  it("flags the failed block so the planner re-drives it instead of silently advancing", () => {
    // An optimistically-written echo excludes the current block from `remaining`
    // (it's the block just attempted). If that edit FAILED, the planner must be
    // told the block did NOT succeed — otherwise it skips a broken block and
    // falsely reports the batch complete. The failed block is the plan's target.
    const out = appendBatchContext(
      "Restyled Featured Beer — remaining: Featured News, Visit Us.",
      {
        target: "acf/featured-beer",
        batch: { remaining: ["acf/featured-news", "acf/visit-us"], guidance: "uniform View More" },
      },
      { editFailed: true },
    );
    expect(out.toLowerCase()).toContain("failed");
    expect(out).toContain("acf/featured-beer"); // names the block to retry
    expect(out).toContain("acf/featured-news"); // still lists the rest
  });

  it("does NOT flag failure on a successful apply turn (editFailed falsy)", () => {
    const out = appendBatchContext(
      "Restyled Featured Beer.",
      { target: "acf/featured-beer", batch: { remaining: ["acf/featured-news"], guidance: "x" } },
      { editFailed: false },
    );
    expect(out.toLowerCase()).not.toContain("failed");
  });

  it("ignores editFailed when there is no batch (ordinary single edit)", () => {
    const out = appendBatchContext("Made it bolder.", { target: "acf/x", action: "y" }, { editFailed: true });
    expect(out).toBe("Made it bolder.");
  });
});
