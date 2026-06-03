import { describe, it, expect } from "vitest";
import {
  isActiveBuildStatus,
  isTerminalBuildStatus,
  phaseLabel,
  BUILD_PHASES,
  TIMELINE_PHASES,
} from "./build-status";

describe("isActiveBuildStatus", () => {
  it("returns true for in-flight phases", () => {
    expect(isActiveBuildStatus("queued")).toBe(true);
    expect(isActiveBuildStatus("discovering")).toBe(true);
    expect(isActiveBuildStatus("components")).toBe(true);
    expect(isActiveBuildStatus("composing")).toBe(true);
    expect(isActiveBuildStatus("building")).toBe(true);
    expect(isActiveBuildStatus("verifying")).toBe(true);
  });

  it("returns false for terminal phases", () => {
    expect(isActiveBuildStatus("ready")).toBe(false);
    expect(isActiveBuildStatus("failed")).toBe(false);
    expect(isActiveBuildStatus("cancelled")).toBe(false);
  });

  it("returns false for null / undefined / empty", () => {
    expect(isActiveBuildStatus(null)).toBe(false);
    expect(isActiveBuildStatus(undefined)).toBe(false);
    expect(isActiveBuildStatus("")).toBe(false);
  });

  it("returns false for unknown strings", () => {
    expect(isActiveBuildStatus("running")).toBe(false);
    expect(isActiveBuildStatus("pending")).toBe(false);
  });
});

describe("isTerminalBuildStatus", () => {
  it("only treats ready/failed/cancelled as terminal", () => {
    expect(isTerminalBuildStatus("ready")).toBe(true);
    expect(isTerminalBuildStatus("failed")).toBe(true);
    expect(isTerminalBuildStatus("cancelled")).toBe(true);
    expect(isTerminalBuildStatus("queued")).toBe(false);
    expect(isTerminalBuildStatus("discovering")).toBe(false);
    expect(isTerminalBuildStatus(null)).toBe(false);
  });
});

describe("phaseLabel", () => {
  it("returns a non-empty string for every BUILD_PHASES value", () => {
    for (const phase of BUILD_PHASES) {
      const label = phaseLabel(phase);
      expect(label).toBeTruthy();
      expect(typeof label).toBe("string");
      // First char must be upper-case so the label reads as a phrase
      // (e.g. "Queued", not "queued") — defense against accidentally
      // mapping a phase to its raw value.
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });

  it("returns 'Unknown' for null/undefined/empty", () => {
    expect(phaseLabel(null)).toBe("Unknown");
    expect(phaseLabel(undefined)).toBe("Unknown");
    expect(phaseLabel("")).toBe("Unknown");
  });

  it("returns the raw status for unrecognized strings (fallback)", () => {
    expect(phaseLabel("running")).toBe("running");
  });
});

describe("TIMELINE_PHASES", () => {
  it("excludes terminal failure phases", () => {
    expect(TIMELINE_PHASES).not.toContain("failed");
    expect(TIMELINE_PHASES).not.toContain("cancelled");
  });

  it("includes ready as the final timeline rung", () => {
    expect(TIMELINE_PHASES[TIMELINE_PHASES.length - 1]).toBe("ready");
  });

  it("orders phases linearly: queued first", () => {
    expect(TIMELINE_PHASES[0]).toBe("queued");
  });
});
