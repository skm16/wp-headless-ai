import { describe, it, expect, vi, afterEach } from "vitest";
import { isResponsiveGenEnabled } from "./generation-flags";

afterEach(() => vi.unstubAllEnvs());

describe("isResponsiveGenEnabled", () => {
  it("is true only for the exact '1' value", () => {
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResponsiveGenEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("JAB_RESPONSIVE_GEN", "1");
    expect(isResponsiveGenEnabled()).toBe(true);
  });
});
