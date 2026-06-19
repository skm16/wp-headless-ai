import { resolveThemeTokens, type ThemeJsonTokens, type ScrapedBrandTokens } from "@/lib/jab/global-styles";
import type { BuildConfig } from "./build-config";

/**
 * Token source for compose. A publish_draft build whose draft had token edits
 * carries the already-merged tokens in config.tokens — compose prefers them so
 * the published clone reflects the brand edit WITHOUT mutating projects.design_tokens
 * (that commit happens only on production-publish, in publishBuildAction).
 * Every other build resolves the project's tokens exactly as before.
 */
export function resolveBuildTokens(
  config: BuildConfig,
  projectDesignTokens: unknown,
): ThemeJsonTokens | null {
  if (config.mode === "publish_draft" && config.tokens) return config.tokens;
  const dt = (projectDesignTokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  return resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
}
