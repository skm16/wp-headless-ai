import { describe, it, expect } from "vitest";
import { buildShellStoragePath, shouldReuseShell } from "./persist-shell-generation";

describe("buildShellStoragePath", () => {
  it("returns builds/<id>/project/components/site/Header.tsx for header", () => {
    expect(buildShellStoragePath("abc-123", "header")).toBe(
      "builds/abc-123/project/components/site/Header.tsx",
    );
  });

  it("returns Footer.tsx for footer", () => {
    expect(buildShellStoragePath("xyz-456", "footer")).toBe(
      "builds/xyz-456/project/components/site/Footer.tsx",
    );
  });
});

describe("shouldReuseShell — JAB_SKIP_SHELL_REGEN decision", () => {
  it("reuses when skip enabled, no edit guidance, and the artifact exists", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: true })).toBe(true);
  });

  it("does NOT reuse when the skip flag is off (default production behaviour)", () => {
    expect(shouldReuseShell({ skipEnabled: false, hasEditGuidance: false, artifactExists: true })).toBe(false);
  });

  it("does NOT reuse when no prior artifact exists (first compose of the build)", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: false })).toBe(false);
  });

  it("does NOT reuse when this is a shell-scope edit targeting the kind — the edit MUST regenerate", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: true, artifactExists: true })).toBe(false);
  });
});
