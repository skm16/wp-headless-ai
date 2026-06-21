import { describe, it, expect } from "vitest";
import { resolveBuildTokens } from "./compose-build-tokens";
import type { BuildConfig } from "./build-config";

describe("resolveBuildTokens", () => {
  const projectDt = { themeJson: { colorPalette: [{ slug: "primary", color: "#000" }] } };

  it("prefers config.tokens when present (publish_draft with token edits)", () => {
    const cfg = {
      mode: "publish_draft",
      tokens: { colorPalette: [{ slug: "primary", color: "#c00" }] },
    } as unknown as BuildConfig;
    expect(resolveBuildTokens(cfg, projectDt)?.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });

  it("falls back to resolveThemeTokens over projects.design_tokens otherwise", () => {
    expect(resolveBuildTokens({ mode: "full" } as BuildConfig, projectDt)?.colorPalette).toEqual([
      { slug: "primary", color: "#000" },
    ]);
    expect(
      resolveBuildTokens({ mode: "publish_draft" } as unknown as BuildConfig, projectDt)?.colorPalette,
    ).toEqual([{ slug: "primary", color: "#000" }]);
  });
});
