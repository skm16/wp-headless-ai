import { describe, it, expect } from "vitest";
import { extractNavPerf } from "./playwright-verify";

describe("extractNavPerf", () => {
  it("derives ttfb/load/transfer from a navigation timing entry", () => {
    const perf = extractNavPerf({
      requestStart: 10,
      responseStart: 48,
      startTime: 0,
      loadEventEnd: 1234,
      transferSize: 543210,
    });
    expect(perf).toEqual({ ttfbMs: 38, loadMs: 1234, transferBytes: 543210 });
  });

  it("rounds sub-millisecond values and clamps negatives to null", () => {
    const perf = extractNavPerf({
      requestStart: 100,
      responseStart: 90, // negative TTFB → null
      startTime: 0,
      loadEventEnd: 200.7,
      transferSize: 0,
    });
    expect(perf.ttfbMs).toBeNull();
    expect(perf.loadMs).toBe(201);
    expect(perf.transferBytes).toBe(0);
  });

  it("returns all-null for a null/garbage entry (fail-soft)", () => {
    expect(extractNavPerf(null)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
    expect(extractNavPerf({} as never)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
  });
});
