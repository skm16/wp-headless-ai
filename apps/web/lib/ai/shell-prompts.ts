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
}

function renderTokenSection(tokens: ThemeJsonTokens | null): string {
  if (!tokens) return "## Tailwind tokens\nUse Tailwind defaults — no custom tokens captured.\n";
  const colors = (tokens.colorPalette ?? []).slice(0, 12).map((c) => c.slug).join(", ");
  const fonts = (tokens.fontFamilies ?? []).slice(0, 6).map((f) => f.slug).join(", ");
  return `## Available Tailwind tokens
Colors: ${colors || "(none)"}
Font families: ${fonts || "(none)"}
Use ONLY these token names — any class outside this set is a generation error.
`;
}

function renderMenuSection(menu: ShellMenu | null): string {
  if (!menu || menu.items.length === 0) return "## Menu\nNo menu data captured.\n";
  const items = menu.items.slice(0, 20).map((i) => `- ${i.title} → ${i.url}`).join("\n");
  return `## Menu: ${menu.name}\n${items}\n`;
}

function sharedShellSystemPrompt(): string {
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
- Use Tailwind CSS classes ONLY. Available token list below; any class outside it is an error.
- Do NOT import fonts. Do NOT use next/font.
- No external icon libraries. Inline SVG or emoji only.
- Use Next.js \`<Link>\` for internal nav; \`<a>\` for external.
- Static output — no hooks except mobile menu toggle (useState only).
- Match source DOM's structural hierarchy faithfully.
- EXACT signature required — the wrapping layout depends on it.
`;
}

export function headerPrompt(input: ShellPromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const user = `## Source header DOM (rendered HTML from the WP site)
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
${logo}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
Generate the Header component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

export function footerPrompt(input: ShellPromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const user = `## Source footer DOM
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
Generate the Footer component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

/**
 * Deterministic fallback emitted when shellDom is empty OR the LLM
 * compile-gate fails twice. Known-ugly but always renderable.
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
