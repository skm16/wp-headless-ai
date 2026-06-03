import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver, gteSemver, describePluginVersionChange } from "./semver.js";

describe("parseSemver", () => {
  it("parses major.minor.patch, tolerating a leading v and a pre-release suffix", () => {
    expect(parseSemver("0.7.1")).toEqual([0, 7, 1]);
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("0.7.1-beta.2")).toEqual([0, 7, 1]);
  });
  it("returns null on unparseable input", () => {
    expect(parseSemver("nope")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders numerically per component (0.10.0 > 0.9.0)", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("0.7.1", "0.7.1")).toBe(0);
  });
  it("sorts unparseable low; two unparseable are equal", () => {
    expect(compareSemver("x", "0.0.1")).toBe(-1);
    expect(compareSemver("0.0.1", "x")).toBe(1);
    expect(compareSemver("x", "y")).toBe(0);
  });
});

describe("gteSemver", () => {
  it("is true at or above the floor", () => {
    expect(gteSemver("0.7.0", "0.7.0")).toBe(true);
    expect(gteSemver("0.7.1", "0.7.0")).toBe(true);
    expect(gteSemver("0.6.3", "0.7.0")).toBe(false);
  });
});

describe("describePluginVersionChange", () => {
  it("reports an upgrade", () => {
    const c = describePluginVersionChange("0.6.0", "0.7.1");
    expect(c.kind).toBe("upgrade");
    expect(c.message).toContain("0.6.0");
    expect(c.message).toContain("0.7.1");
  });
  it("reports a downgrade with a caution", () => {
    const c = describePluginVersionChange("0.7.1", "0.6.0");
    expect(c.kind).toBe("downgrade");
  });
  it("reports unchanged", () => {
    expect(describePluginVersionChange("0.7.1", "0.7.1").kind).toBe("same");
  });
  it("is unknown when the live side reports no version (pre-v0.7.0 plugin)", () => {
    expect(describePluginVersionChange("0.7.1", null).kind).toBe("unknown");
    expect(describePluginVersionChange(null, null).kind).toBe("unknown");
  });
});
