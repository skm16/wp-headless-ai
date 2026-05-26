// apps/web/lib/jab/global-styles.test.ts
import { describe, it, expect } from "vitest";
import { extractThemeJsonTokens } from "./global-styles";

describe("extractThemeJsonTokens", () => {
  it("flattens settings + styles into the persistence shape", () => {
    const result = extractThemeJsonTokens({
      settings: {
        color: { palette: [{ slug: "primary", color: "#1a4d2e" }] },
        typography: { fontSizes: [{ slug: "large", size: "32px" }] },
        spacing: { blockGap: "24px" },
      },
      styles: { color: { background: "#fff" } },
    });
    expect(result).not.toBeNull();
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#1a4d2e" }]);
    expect(result!.fontSizes).toEqual([{ slug: "large", size: "32px" }]);
    expect(result!.blockGap).toBe("24px");
  });

  it("returns null when no usable tokens present", () => {
    expect(extractThemeJsonTokens(null)).toBeNull();
    expect(extractThemeJsonTokens({})).toBeNull();
  });
});
