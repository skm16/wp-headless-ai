import { describe, it, expect } from "vitest";
import { buildComponentStoragePath } from "./persist-generation";

describe("buildComponentStoragePath", () => {
  it("produces a valid storage path for a standard block name", () => {
    const path = buildComponentStoragePath("build-abc", "core/heading");
    expect(path).toBe("builds/build-abc/components/CoreHeading.tsx");
  });

  it("handles acf_flex block names", () => {
    const path = buildComponentStoragePath("build-xyz", "acf_flex/page/sections/hero_section");
    expect(path).toBe("builds/build-xyz/components/AcfFlexPageSectionsHeroSection.tsx");
  });

  it("handles null block name (passthrough)", () => {
    const path = buildComponentStoragePath("build-123", "__null__");
    expect(path).toBe("builds/build-123/components/Null.tsx");
  });
});
