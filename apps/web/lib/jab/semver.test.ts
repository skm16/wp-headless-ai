import { describe, it, expect } from "vitest";
import { compareSemver, gteSemver } from "./semver";

describe("compareSemver", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("0.7.1", "0.7.0")).toBe(1);
    expect(compareSemver("0.6.9", "0.7.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.7.0", "0.7.0")).toBe(0);
  });
  it("tolerates a leading v and missing patch", () => {
    expect(compareSemver("v0.7", "0.7.0")).toBe(0);
    expect(compareSemver("0.7.2", "v0.7")).toBe(1);
  });
  it("treats unparseable input as 0.0.0 (lowest)", () => {
    expect(compareSemver("", "0.0.1")).toBe(-1);
    expect(compareSemver("garbage", "0.0.0")).toBe(0);
  });
});

describe("gteSemver", () => {
  it("is true when a >= b", () => {
    expect(gteSemver("0.7.1", "0.7.0")).toBe(true);
    expect(gteSemver("0.7.0", "0.7.0")).toBe(true);
    expect(gteSemver("0.6.3", "0.7.0")).toBe(false);
  });
});
