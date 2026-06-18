// NOTE: deliberately NOT "server-only". Pure prompt/string builders with no
// secrets and no Node APIs — operator scripts (scripts/debug-shell-llm.ts)
// import this module under tsx, where the server-only marker package is
// unresolvable (provided by Next's bundler, not node_modules).
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { sanitizeShellDom } from "@/lib/jab/sanitize-shell-dom";

export interface ShellMenuItem {
  title: string;
  url: string;
}

export interface ShellMenu {
  name: string;
  items: ShellMenuItem[];
}

export interface ShellPromptInput {
  shellDom: string;
  themeTokens: ThemeJsonTokens | null;
  menu: ShellMenu | null;
  logoUrl: string | null;
  siteName: string;
  siteDescription: string | null;
  // Class names extracted from captured theme stylesheets. The full CSS
  // bundles into the generated app at runtime via styles/theme.css, but the
  // LLM has no signal during generation about which class names that CSS
  // actually defines — so when the source DOM uses `.tworoads-hero`, the
  // LLM previously invented a Tailwind utility that doesn't match the
  // bundled CSS. Feeding the inventory lets the LLM reuse the actual names
  // from the source DOM and have them resolve at runtime.
  themeClassNames?: string[];
  /**
   * Computed (rendered) colors of THIS shell's root element, captured via
   * getComputedStyle during discovery. The real signal for the root
   * background — present even when the color comes from a theme class whose
   * CSS rule wasn't captured (the case that made the LLM default to bg-white).
   */
  shellColors?: { backgroundColor?: string; color?: string } | null;
  /** Targeted edit guidance for a chat-driven shell regeneration. Appended to the USER half only. */
  guidance?: string;
  /** Source-WP hostname; when set, the prompt declares its URLs internal. */
  sourceHost?: string | null;
  /**
   * When true (JAB_RESPONSIVE_GEN), append a responsive instruction to the
   * USER half: nav-collapse for the header, stack-on-mobile for the footer.
   * Shell capture has no per-viewport computed styles or screenshot, so this
   * is a textual instruction only.
   */
  responsive?: boolean;
}

/**
 * Size cap for an emitted shell component (post code-fence strip, post
 * origin-link rewrite).
 *
 * Originally 12KB based on a "typical" shell estimate. Bumped to 24KB after
 * validating against Two Roads (build 982f0d57): the high-fidelity footer
 * came in at 14.8KB — driven by 7 inline social SVG icons, 5-column nav
 * grid, 3 physical addresses, and a legal bar. The output had 0 TS
 * diagnostics — it was rejected purely on size, then replaced by the
 * deterministic fallback. That's a quality regression, not a safety win.
 *
 * Lives here (not generate-shell.ts) so operator tooling
 * (scripts/debug-shell-llm.ts) imports the SAME cap production enforces —
 * the debug fork previously pinned the retired 12KB cap and reported false
 * "OVER CAP" verdicts.
 */
export const MAX_SHELL_BYTES = 24_000;

/**
 * max_tokens for shell generations — mirrors the visual-tier ceiling the
 * compose worker's ModelClient runs shells with. Shared so the debug script
 * cannot drift from production. ~32KB worst-case output keeps MAX_SHELL_BYTES
 * meaningful as a runaway-generation flag.
 */
export const SHELL_MAX_TOKENS = 8192;

/**
 * Extract class-name selectors from captured theme stylesheet sources.
 * Deduplicated, sorted by length (descending — longer names tend to be
 * more semantic / theme-specific), capped at `limit` (default 80) to keep
 * the prompt budget bounded. Filters out single-letter and pure-number
 * names which are typically utility noise rather than theme vocabulary.
 *
 * Intentionally a simple regex over the source — a full CSS parser would
 * be more correct but adds a heavyweight dep for a heuristic input signal.
 * False positives (e.g. matching `.5em` inside a value) are tolerated; the
 * LLM filters them out by context.
 */
export function extractThemeClassNames(sheets: Array<{ css: string }>, limit = 80): string[] {
  const seen = new Set<string>();
  const pattern = /\.([a-zA-Z_-][a-zA-Z0-9_-]{1,})/g;
  for (const sheet of sheets) {
    for (const match of sheet.css.matchAll(pattern)) {
      const name = match[1];
      if (/^\d/.test(name)) continue;
      if (name.length < 3) continue;
      seen.add(name);
    }
  }
  return Array.from(seen).sort((a, b) => b.length - a.length).slice(0, limit);
}

function renderTokenSection(tokens: ThemeJsonTokens | null): string {
  if (!tokens) return "## Tailwind tokens\nUse Tailwind defaults — no custom tokens captured.\n";
  // Emit slug + hex pairs so the LLM can match a source DOM `style="background-color: #FDB813"`
  // to the matching token (`bg-primary`) instead of approximating with a Tailwind utility
  // (`bg-yellow-400`). Pre-2026-05-29 this section emitted only slug names, which left the
  // model with no way to map the captured Two Roads `#ffc72c` masthead to `bg-primary` —
  // it chose `bg-white` and the deployed masthead lost its brand color.
  const colorPairs = (tokens.colorPalette ?? [])
    .slice(0, 12)
    .map((c) => `${c.slug} (${c.color})`)
    .join(", ");
  const fontPairs = (tokens.fontFamilies ?? [])
    .slice(0, 6)
    .map((f) => `${f.slug} (${f.fontFamily})`)
    .join(", ");
  return `## Available Tailwind tokens
Colors: ${colorPairs || "(none)"}
Font families: ${fontPairs || "(none)"}
Use ONLY these token names — any class outside this set is a generation error.
When the source DOM uses a literal color value (e.g. \`background-color: #ffc72c\` or \`color: rgb(255,199,44)\`), prefer the matching token class (\`bg-primary\` / \`text-primary\` for that hex) over a Tailwind utility approximation (\`bg-yellow-400\`). Match by hex value, not by semantic name.
`;
}

function renderMenuSection(menu: ShellMenu | null): string {
  if (!menu || menu.items.length === 0) return "## Menu\nNo menu data captured.\n";
  const items = menu.items.slice(0, 20).map((i) => `- ${i.title} → ${i.url}`).join("\n");
  return `## Menu: ${menu.name}\n${items}\n`;
}

function renderThemeClassSection(classNames: string[] | undefined): string {
  if (!classNames || classNames.length === 0) return "";
  return `## Source theme class names (from bundled theme.css)
The generated app bundles the source site's compiled CSS at \`styles/theme.css\`
under a \`.jab-theme\` scope. The class names below are defined in that CSS.
When the source DOM uses one of these classes, PREFER to reuse the class
name verbatim (the bundled CSS will resolve it at runtime) over inventing
a Tailwind utility that approximates the same look. Combine with Tailwind
utilities for spacing / layout corrections as needed:
${classNames.map((n) => `- ${n}`).join("\n")}
`;
}

/**
 * Surface the chrome root's COMPUTED colors so the LLM paints the root with
 * the matching brand token instead of defaulting to bg-white. This is the
 * fix for the general case where the source background is set by a CSS class
 * whose rule never reached the model (truncated/external CSS): getComputedStyle
 * resolved the real color at capture time, and the token table below lets the
 * model map that rgb()/hex value to e.g. `bg-primary`. Site-agnostic — every
 * build feeds its own captured chrome colors.
 */
function renderShellColorsSection(colors: { backgroundColor?: string; color?: string } | null | undefined): string {
  if (!colors || (!colors.backgroundColor && !colors.color)) return "";
  const lines: string[] = [];
  if (colors.backgroundColor) lines.push(`- root background-color: \`${colors.backgroundColor}\``);
  if (colors.color) lines.push(`- root text color: \`${colors.color}\``);
  // The "never bg-white" directive ONLY applies when a real (non-transparent,
  // non-near-white) background actually survived capture. A header whose
  // background is white/transparent yields no background line here, and the
  // model is free to pick bg-white — the capture side already filtered the
  // no-signal cases (see shapeShellComputedColors), so a present background
  // line is always a genuine brand color.
  const bgRule = colors.backgroundColor
    ? "\nThe background-color above is a real brand color — map it to the matching brand token (e.g. `bg-primary` when it equals the primary hex/rgb) and apply it to the root element. Do NOT default the root to `bg-white`."
    : "";
  return `## Source chrome computed colors (rendered)
These are the REAL rendered colors of this element's ROOT, read via
getComputedStyle — authoritative even when the source DOM carries only a
theme class (e.g. \`brand-is-light\`) whose CSS rule isn't in the inventory
above. Map each value to the matching brand token (\`bg-primary\` / \`text-primary\`
when it equals the primary hex/rgb).${bgRule}
${lines.join("\n")}
`;
}

function renderShellGuidanceSection(guidance: string | undefined): string {
  if (!guidance || !guidance.trim()) return "";
  return `\n## Targeted edit guidance
The user requested a specific change to this component. Apply it while keeping
the rest faithful to the source DOM:
${guidance.trim()}
`;
}

function renderResponsiveSection(kind: "header" | "footer", responsive: boolean | undefined): string {
  if (!responsive) return "";
  if (kind === "header") {
    return `\n## Responsive requirement (mobile)
The source nav must remain usable on a 375px phone. Emit a responsive header:
show the full horizontal nav at \`md:\` and up, and BELOW \`md\` collapse it to
a toggle button (a hamburger \`<button>\`) that reveals the links. A \`useState\`
toggle is permitted (the only allowed hook); keep all link labels/hrefs from
the source — do not drop nav items on mobile, only restyle their container.
`;
  }
  return `\n## Responsive requirement (mobile)
On a 375px phone the footer must stack: multi-column footer layouts collapse to
a single column (\`grid-cols-1 md:grid-cols-N\` or \`flex-col md:flex-row\`).
Keep every column's content; only change the layout at the \`md:\` breakpoint.
`;
}

function sharedShellSystemPrompt(hasThemeClasses: boolean, sourceHost?: string | null): string {
  const tailwindRule = hasThemeClasses
    ? `- Style with EITHER Tailwind tokens (listed below) OR class names from the source theme inventory (listed below). When the source DOM uses a theme class, reuse it verbatim. Inventing class names that appear in neither list is an error.`
    : `- Use Tailwind CSS classes ONLY. Available token list below; any class outside it is an error.`;
  const internalLinksRule = sourceHost
    ? `- Links whose host is ${sourceHost} are INTERNAL links to THIS site. Emit them as root-relative paths copied EXACTLY from the source URL's path (e.g. https://${sourceHost}/visit-us/ → /visit-us). NEVER emit ${sourceHost} in any href, and NEVER invent a path that is not in the source DOM.`
    : null;
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
${tailwindRule}
- Do NOT import fonts. Do NOT use next/font.
- No external icon libraries. Inline SVG or emoji only.
- Use Next.js \`<Link>\` for internal nav; \`<a>\` for external.
${internalLinksRule ? `${internalLinksRule}\n` : ""}- Static output — no hooks except mobile menu toggle (useState only).
- Match source DOM's structural hierarchy faithfully.
- Width contract: site-chrome elements (header / footer) span the full viewport unless the source DOM's root \`<header>\` / \`<footer>\` element carries an explicit \`max-w-*\` class or inline \`max-width\` style. When the source is full-bleed, render the root element as \`w-full\` with edge padding (\`px-4 sm:px-6 lg:px-8\` or similar) and do NOT wrap the root in a \`max-w-*\` container — that would constrain content the source intentionally bled to the edges. This rule applies to the OUTER element only; inner sub-sections (e.g. a typography column inside a full-bleed dark band) may still use \`max-w-*\` for readability. Two Roads footer is the canonical example: source is dark full-bleed, generated output wrapped it in \`max-w-7xl mx-auto\` and the deployed footer looked centered/boxed instead of edge-to-edge.
- EXACT signature required — the wrapping layout depends on it.
`;
}

export interface ShellPromptParts {
  /**
   * Per-project-stable sections: contract rules + token table + theme-class
   * inventory + menu. Byte-identical for the header and footer calls of one
   * compose run — when >= 10,000 chars (shouldCacheShellPrefix) this becomes
   * the cachedSystemPrefix and the sequential footer call reads the header
   * call's cache write.
   */
  system: string;
  /** Per-kind/per-call content: colors, logo, identity, signature, guidance, then the sanitized shellDom LAST. */
  user: string;
}

/**
 * Build-time cache qualifier: the stable shell prefix only clears Sonnet
 * 4.6's 2048-token minimum cacheable size when it is large enough. 10,000
 * chars ≈ ~2,500 tokens (the same floor COMPONENT_SYSTEM_CORE pins via
 * unit test). Below the floor the stable text stays in the uncached
 * systemPrompt — correct but unaided by caching; do NOT pad to qualify.
 */
export function shouldCacheShellPrefix(text: string): boolean {
  return text.length >= 10_000;
}

/**
 * Prompt-side bound for the sanitized shellDom (~15K tokens). The capture
 * side keeps its raw 100KB transport cap (capture-theme-stylesheets.ts);
 * sanitizeShellDom strips script/style/comments/data-attrs/srcset/base64
 * first, so this cap rarely binds on real WP chrome after the 40-70% cut.
 */
export const SHELL_DOM_PROMPT_MAX_BYTES = 60_000;

function buildShellSystem(input: ShellPromptInput): string {
  const hasThemeClasses = (input.themeClassNames?.length ?? 0) > 0;
  return [
    sharedShellSystemPrompt(hasThemeClasses, input.sourceHost),
    renderTokenSection(input.themeTokens),
    renderThemeClassSection(input.themeClassNames),
    renderMenuSection(input.menu),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

export function headerPrompt(input: ShellPromptInput): ShellPromptParts {
  const system = buildShellSystem(input);
  const colors = renderShellColorsSection(input.shellColors);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const responsiveSection = renderResponsiveSection("header", input.responsive);
  const dom = sanitizeShellDom(input.shellDom, SHELL_DOM_PROMPT_MAX_BYTES);
  const user = `${colors}${logo}## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
${guidanceSection}${responsiveSection}Generate the Header component matching the structure of the source header DOM below (rendered HTML from the WP site, sanitized).

## Source header DOM
\`\`\`html
${dom}
\`\`\``;
  return { system, user };
}

export function footerPrompt(input: ShellPromptInput): ShellPromptParts {
  const system = buildShellSystem(input);
  const colors = renderShellColorsSection(input.shellColors);
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const responsiveSection = renderResponsiveSection("footer", input.responsive);
  const dom = sanitizeShellDom(input.shellDom, SHELL_DOM_PROMPT_MAX_BYTES);
  const user = `${colors}## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
${guidanceSection}${responsiveSection}Generate the Footer component matching the structure of the source footer DOM below (rendered HTML from the WP site, sanitized).

## Source footer DOM
\`\`\`html
${dom}
\`\`\``;
  return { system, user };
}

/**
 * Deterministic fallback emitted when shellDom is empty OR the LLM
 * compile-gate fails twice. Known-ugly but always renderable.
 *
 * The fallback's `max-w-6xl mx-auto` deliberately VIOLATES the LLM
 * prompt's "Width contract" rule. That rule is a quality lever for the
 * faithful-to-source LLM path; the fallback exists specifically because
 * no source DOM was available (so there's no "full-bleed source" to
 * honor) and a constrained layout reads better than full-bleed for a
 * generic skeleton. If a future change makes the fallback derive from
 * captured source intent, the contradiction should be resolved.
 */
export function shellDeterministicFallback(
  kind: "header" | "footer",
  menu: ShellMenu | null,
  siteName: string,
): string {
  const safeName = JSON.stringify(siteName);
  const navItems = (menu?.items ?? [])
    .slice(0, 8)
    .map((i) => `        <a href=${JSON.stringify(i.url)} className="hover:underline">${i.title}</a>`)
    .join("\n");
  if (kind === "header") {
    return `export function Header() {
  return (
    <header className="w-full border-b border-gray-200 px-6 py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-6">
        <a href="/" className="text-xl font-semibold">{${safeName}}</a>
        <nav className="flex gap-5 text-sm">
${navItems}
        </nav>
      </div>
    </header>
  );
}
`;
  }
  return `export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="w-full border-t border-gray-200 px-6 py-8 mt-12">
      <div className="max-w-6xl mx-auto flex flex-col gap-4 text-sm text-gray-600">
        <nav className="flex flex-wrap gap-5">
${navItems}
        </nav>
        <p>© {year} {${safeName}}. All rights reserved.</p>
      </div>
    </footer>
  );
}
`;
}
