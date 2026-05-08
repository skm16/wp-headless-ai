/**
 * Prompt templates — iterate these freely. The whole point of this script
 * is to A/B-test phrasings on real WP sites until output quality is good
 * enough to bake into the Phase D worker.
 *
 * What "good enough" means for v0:
 *   - Compiles cleanly under TypeScript strict mode
 *   - Uses the typed SDK (no raw fetch / no REST URLs)
 *   - Server Component (no "use client") — fetches data server-side
 *   - Reasonable Tailwind classes and visual hierarchy
 *   - Hero / sections / CTA / footer present where the source has them
 *   - Doesn't hallucinate ability names that aren't in the manifest
 */

export interface PromptInputs {
  wpUrl: string;
  pageUrl: string;
  pagePath: string;
  pageHtml: string;
  abilitiesSummary: string;
  sdkSource: string;
}

export const SYSTEM_PROMPT = `You are a senior Next.js engineer. You write clean, idiomatic React Server Components in TypeScript with Tailwind CSS.

You have a typed SDK (\`@/lib/sdk\`) generated from the WordPress site's MCP-exposed abilities. Use it for all content fetching. NEVER write raw \`fetch()\` calls to WP REST endpoints.

Hard requirements:
- One file: \`app/page.tsx\`
- Server Component (no "use client", no useState, no useEffect)
- Default-export an async function called \`Page\`
- Imports come from \`@/lib/sdk\` for content fetching, plus Next.js / React as needed
- TypeScript strict mode — no \`any\`, no \`@ts-ignore\`, no implicit \`any\`
- Tailwind classes only — no styled-jsx, no CSS modules
- Output ONLY the file contents inside a single \`\`\`tsx code block. No prose before or after the code block.

You will receive:
1. A summary of the WordPress site's abilities (the typed functions you can call)
2. The actual SDK source you'll be importing (so you know the function signatures)
3. The HTML of the source page
4. The page path you're rebuilding

Match the source page's visual structure approximately — hero / sections / cards / CTA / footer where present. Don't try to pixel-match — you're writing a clean rebuild, not a port. Use semantic HTML (\`section\`, \`article\`, \`header\`, \`footer\`, \`nav\`).

If the source HTML references content that maps to an SDK call, fetch it. If the page has hard-coded marketing copy with no obvious ability backing it, write the copy inline as a literal — don't invent abilities.

Concurrency hint: if you need multiple SDK calls, parallelize them with \`Promise.all\` so the page renders fast.`;

export function buildUserPrompt(i: PromptInputs): string {
  return [
    `# WordPress site`,
    `URL: ${i.wpUrl}`,
    `Rebuilding page: ${i.pagePath}  (live: ${i.pageUrl})`,
    ``,
    `# Available abilities (from the manifest)`,
    i.abilitiesSummary,
    ``,
    `# SDK source you can import from \`@/lib/sdk\``,
    "```ts",
    i.sdkSource,
    "```",
    ``,
    `# Source page HTML`,
    "```html",
    i.pageHtml,
    "```",
    ``,
    `Generate \`app/page.tsx\` now. Output ONLY the code block — no preamble.`,
  ].join("\n");
}
