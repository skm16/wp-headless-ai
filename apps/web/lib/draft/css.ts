import "server-only";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { tailwindExtendFromTokens } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * css — Tailwind 3 JIT over the draft's raw TSX sources, using the SAME
 * theme.extend mapping the emitted tailwind.config.ts serializes
 * (tailwindExtendFromTokens) and the same `important: "#jab-app"` scoping
 * (the /draft HTML shell sets <html id="jab-app">). The build's scoped
 * theme.css (emitThemeCss output) is appended verbatim, matching the
 * emitted globals.css import order: tailwind first, theme second.
 */
export interface BuildDraftCssInput {
  /** Raw TSX sources to scan: all effective components + shell + dispatcher. */
  sources: string[];
  tokens: ThemeJsonTokens | null;
  /** Pre-scoped theme css (emitThemeCss output) or null when none captured. */
  themeCss: string | null;
}

export async function buildDraftCss(input: BuildDraftCssInput): Promise<string> {
  const extend = tailwindExtendFromTokens(input.tokens);
  const result = await postcss([
    tailwindcss({
      content: input.sources.map((raw) => ({ raw, extension: "tsx" })),
      important: "#jab-app",
      theme: { extend },
    } as never),
  ]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
    from: undefined,
  });
  const themePart = input.themeCss ? `\n/* --- captured source theme (scoped) --- */\n${input.themeCss}\n` : "";
  return result.css + themePart;
}
