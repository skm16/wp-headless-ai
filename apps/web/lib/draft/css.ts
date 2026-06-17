import "server-only";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { tailwindExtendFromTokens, brandTypographyCss } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * css — Tailwind 3 JIT over the draft's raw TSX sources, using the SAME
 * theme.extend mapping the emitted tailwind.config.ts serializes
 * (tailwindExtendFromTokens) and the same `important: "#jab-app"` scoping
 * (the /draft HTML shell sets <html id="jab-app">). The build's scoped
 * theme.css (emitThemeCss output) is appended verbatim, matching the
 * emitted globals.css import order: tailwind first, theme second.
 */
/**
 * Static, inlined subset of Tailwind's preflight. The draft disables Tailwind's
 * own preflight plugin (it reads ./css/preflight.css via __dirname, which Next
 * production bundling rewrites to the route-chunk dir → ENOENT at runtime — see
 * the corePlugins note in buildDraftCss). The deployed site ships the FULL
 * preflight via `@tailwind base;` (compose-site-emit.ts emitGlobalsCss), so
 * every generated component is authored against border-box + reset media/heading
 * defaults. We re-inject the load-bearing subset here.
 *
 * GLOBAL, not `.jab-theme`-scoped: deployed preflight is global (the
 * `important: "#jab-app"` strategy "scopes utilities only, leaving preflight/base
 * global" — compose-site-emit.ts:809-815). A scoped box-sizing would not reach
 * shell/dispatcher markup rendered outside <main className="jab-theme">.
 *
 * Emitted FIRST in buildDraftCss's return (beneath utilities, the captured theme,
 * the scoped list/anchor resets, and brand typography) so every later layer wins
 * on source order — exactly the precedence `@tailwind base` has on the deployed
 * site. box-sizing is the priority line; the rest mirrors preflight's media,
 * heading, and form-control normalisation so utility-styled components lay out
 * identically to production.
 */
const PREFLIGHT_BASE = `/* --- preflight base (global, mirrors @tailwind base) --- */
*, ::before, ::after { box-sizing: border-box; }
body { margin: 0; }
img, svg, video, canvas, audio, iframe, embed, object { display: block; max-width: 100%; }
img, video { height: auto; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
button, input, optgroup, select, textarea { font: inherit; color: inherit; }
button, [type=button], [type=submit] { background-color: transparent; background-image: none; }
`;

export interface BuildDraftCssInput {
  /** Raw TSX sources to scan: all effective components + shell + dispatcher. */
  sources: string[];
  tokens: ThemeJsonTokens | null;
  /** Pre-scoped theme css (emitThemeCss output) or null when none captured. */
  themeCss: string | null;
}

export async function buildDraftCss(input: BuildDraftCssInput): Promise<string> {
  const extend = tailwindExtendFromTokens(input.tokens);
  // Tailwind's preflight plugin reads ./css/preflight.css via __dirname, which
  // Next.js production bundling rewrites to the emitting route-chunk directory
  // (.next/server/app/api/inngest/) — causing an ENOENT at runtime. Disable
  // preflight: the draft iframe is sandboxed and scoped under #jab-app, so
  // CSS normalisation is neither necessary nor desirable.
  const result = await postcss([
    tailwindcss({
      content: input.sources.map((raw) => ({ raw, extension: "tsx" })),
      important: "#jab-app",
      theme: { extend },
      corePlugins: { preflight: false },
    } as never),
  ]).process("@tailwind components;\n@tailwind utilities;\n", {
    from: undefined,
  });
  const themePart = input.themeCss ? `\n/* --- captured source theme (scoped) --- */\n${input.themeCss}\n` : "";

  // Preflight replacement (scoped to .jab-theme). Preflight is disabled above
  // (it reads ./css/preflight.css via __dirname, which Next bundling can't
  // resolve at runtime), but the generated components assume its base resets:
  //   - lists with no bullets/indent (footer nav <ul>s otherwise show UA discs)
  //   - links that inherit color + font (footer <a>s otherwise fall back to the
  //     UA blue + system font instead of the footer's `text-white` / brand font)
  // Emitted AFTER the captured theme CSS so a theme rule like
  // `.jab-theme a { color: #0275d8 }` (equal specificity) is beaten on source
  // order — letting footer links inherit white. Matches the deployed site's
  // Tailwind-preflight behavior for these elements.
  const baseResets = `
/* --- preflight replacement (scoped base resets) --- */
.jab-theme ul, .jab-theme ol, .jab-theme menu { list-style: none; margin: 0; padding: 0; }
.jab-theme a { color: inherit; text-decoration: inherit; font: inherit; }
`;

  // Brand-typography overrides — mirrors the deployed emitGlobalsCss layer
  // (brandTypographyCss). Generated components use bare semantic elements
  // (<h4>, no font class), so without `.jab-theme h1..h6 { font-family: <brand> }`
  // headings fall back to the theme's system base font (the footer "Explore"
  // heading rendered in -apple-system instead of Anton). Derive the heading/body
  // faces from the same fontFamilies slugs compose-site uses.
  const brandFonts = {
    heading: input.tokens?.fontFamilies?.find((f) => f.slug === "heading")?.fontFamily ?? null,
    body: input.tokens?.fontFamilies?.find((f) => f.slug === "body")?.fontFamily ?? null,
  };
  const brandTypography = brandTypographyCss(brandFonts);
  const brandPart = brandTypography ? `\n/* --- brand typography (scoped) --- */\n${brandTypography}\n` : "";

  // PREFLIGHT_BASE first → it sits beneath utilities (result.css), the captured
  // theme (themePart), the scoped list/anchor resets (baseResets), and brand
  // typography (brandPart) on source order — the same precedence @tailwind base
  // has on the deployed site, where every later layer is meant to override it.
  return `${PREFLIGHT_BASE}\n${result.css}${themePart}${baseResets}${brandPart}`;
}
