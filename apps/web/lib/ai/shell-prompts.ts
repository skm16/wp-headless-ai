import "server-only";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

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
  /** Targeted edit guidance for a chat-driven shell regeneration. Appended to the USER half only. */
  guidance?: string;
}

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

function renderShellGuidanceSection(guidance: string | undefined): string {
  if (!guidance || !guidance.trim()) return "";
  return `\n## Targeted edit guidance
The user requested a specific change to this component. Apply it while keeping
the rest faithful to the source DOM:
${guidance.trim()}
`;
}

function sharedShellSystemPrompt(hasThemeClasses: boolean): string {
  const tailwindRule = hasThemeClasses
    ? `- Style with EITHER Tailwind tokens (listed below) OR class names from the source theme inventory (listed below). When the source DOM uses a theme class, reuse it verbatim. Inventing class names that appear in neither list is an error.`
    : `- Use Tailwind CSS classes ONLY. Available token list below; any class outside it is an error.`;
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
${tailwindRule}
- Do NOT import fonts. Do NOT use next/font.
- No external icon libraries. Inline SVG or emoji only.
- Use Next.js \`<Link>\` for internal nav; \`<a>\` for external.
- Static output — no hooks except mobile menu toggle (useState only).
- Match source DOM's structural hierarchy faithfully.
- Width contract: site-chrome elements (header / footer) span the full viewport unless the source DOM's root \`<header>\` / \`<footer>\` element carries an explicit \`max-w-*\` class or inline \`max-width\` style. When the source is full-bleed, render the root element as \`w-full\` with edge padding (\`px-4 sm:px-6 lg:px-8\` or similar) and do NOT wrap the root in a \`max-w-*\` container — that would constrain content the source intentionally bled to the edges. This rule applies to the OUTER element only; inner sub-sections (e.g. a typography column inside a full-bleed dark band) may still use \`max-w-*\` for readability. Two Roads footer is the canonical example: source is dark full-bleed, generated output wrapped it in \`max-w-7xl mx-auto\` and the deployed footer looked centered/boxed instead of edge-to-edge.
- EXACT signature required — the wrapping layout depends on it.
`;
}

export function headerPrompt(input: ShellPromptInput): string {
  const hasThemeClasses = (input.themeClassNames?.length ?? 0) > 0;
  const system = sharedShellSystemPrompt(hasThemeClasses);
  const tokens = renderTokenSection(input.themeTokens);
  const themeClasses = renderThemeClassSection(input.themeClassNames);
  const menu = renderMenuSection(input.menu);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const user = `## Source header DOM (rendered HTML from the WP site)
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${themeClasses}${menu}
${logo}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
${guidanceSection}Generate the Header component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

export function footerPrompt(input: ShellPromptInput): string {
  const hasThemeClasses = (input.themeClassNames?.length ?? 0) > 0;
  const system = sharedShellSystemPrompt(hasThemeClasses);
  const tokens = renderTokenSection(input.themeTokens);
  const themeClasses = renderThemeClassSection(input.themeClassNames);
  const menu = renderMenuSection(input.menu);
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const user = `## Source footer DOM
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${themeClasses}${menu}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
${guidanceSection}Generate the Footer component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
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
