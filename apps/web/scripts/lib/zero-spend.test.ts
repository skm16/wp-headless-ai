import { describe, it, expect } from "vitest";
import { findNonZeroSpend, type SpendRow } from "./zero-spend";

describe("findNonZeroSpend", () => {
  it("returns [] when every token column is zero or null", () => {
    const rows: SpendRow[] = [
      { label: "core/cover", tokens: [0, 0, 0, 0] },
      { label: "core/paragraph", tokens: [null, null, null, null] }, // passthrough rows never write tokens
      { label: "header", tokens: [0, null, 0, 0] },
    ];
    expect(findNonZeroSpend(rows)).toEqual([]);
  });

  it("returns exactly the rows with any positive token count", () => {
    const hot: SpendRow = { label: "core/cover", tokens: [0, 1432, 0, 812] };
    const rows: SpendRow[] = [
      { label: "core/paragraph", tokens: [0, 0, 0, 0] },
      hot,
    ];
    expect(findNonZeroSpend(rows)).toEqual([hot]);
  });

  it("treats negative values as not-spend (defensive against bad telemetry)", () => {
    expect(findNonZeroSpend([{ label: "x", tokens: [-5, null] }])).toEqual([]);
  });
});
