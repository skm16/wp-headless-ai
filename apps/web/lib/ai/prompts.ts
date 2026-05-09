import "server-only";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Phase D prompts — promoted from scripts/validate-ai/src/prompts.ts after
 * the quality validation run. Same shape that produced the validated output;
 * only difference is the SDK source goes into a CACHED system block so
 * subsequent generations against the same project skip 95%+ of the input
 * cost.
 *
 * Cache TTL: 5 minutes (the default `ephemeral` value). Within an active
 * agency session the project's SDK source is constant, so generating
 * page 2/3/4/5 against the same project all hit the cache. After 5
 * minutes idle, the SDK is re-cached on next call.
 */

const STATIC_SYSTEM_BASE = `You are a senior Next.js engineer. You write clean, idiomatic React Server Components in TypeScript with Tailwind CSS.

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

export interface PromptContext {
  wpUrl: string;
  pageUrl: string;
  pagePath: string;
  pageHtml: string;
  abilitiesSummary: string;
  sdkSource: string;
}

/**
 * System param shaped for prompt caching. The first block is the constant
 * meta-prompt; the second block (the SDK source) is what gets cached. Calls
 * within ~5 minutes of each other reuse the cache; the response usage object
 * tells you whether it hit (`cache_read_input_tokens > 0`).
 */
export function buildSystemBlocks(
  sdkSource: string,
): Anthropic.Messages.MessageCreateParams["system"] {
  return [
    { type: "text", text: STATIC_SYSTEM_BASE },
    {
      type: "text",
      text: `# Generated SDK source — agencies' projects import from this verbatim\n\n\`\`\`ts\n${sdkSource}\n\`\`\``,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function buildUserPrompt(ctx: PromptContext): string {
  return [
    `# WordPress site`,
    `URL: ${ctx.wpUrl}`,
    `Rebuilding page: ${ctx.pagePath}  (live: ${ctx.pageUrl})`,
    ``,
    `# Available abilities (from the manifest)`,
    ctx.abilitiesSummary,
    ``,
    `# Source page HTML`,
    "```html",
    ctx.pageHtml,
    "```",
    ``,
    `Generate \`app/page.tsx\` now. Output ONLY the code block — no preamble.`,
  ].join("\n");
}
