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
- Use literal Unicode characters (❤, →, ★, etc.) in JSX text. NEVER write \`\\uXXXX\` escape sequences in JSX — they render as literal text, not the character. If you need the heart emoji, write ❤ directly, or use the HTML entity \`&#x2764;\`, or wrap a JS expression like \`{"\\u2764"}\`.
- WordPress returns text with HTML entities (\`&amp;\`, \`&#038;\`, \`&#8217;\`, \`&hellip;\`, \`&nbsp;\`, \`&quot;\`, \`&lt;\`, \`&gt;\`, etc.). Any time you render WP-sourced text as visible JSX (menu titles, page titles, post titles, etc.), pipe it through a small \`decode\` helper that replaces these entities with the literal characters. Don't render WP text as-is — it will display "News &#038; Resources" instead of "News & Resources".

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
  /**
   * Front-page info (id + slug + title) when the worker successfully
   * looked it up via /wp-json/wp/v2/settings. When present the AI
   * MUST use this slug — no guessing. When null the AI falls back
   * to inferring from the path.
   */
  frontPage: {
    id: number;
    slug: string;
    title: string;
  } | null;
  /**
   * Hex colors extracted from the source page's <style> blocks. Used
   * as palette ground-truth so the AI doesn't roll the dice on
   * Tailwind colors each generation.
   */
  brandColors: string[];
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
  const sections: string[] = [];

  sections.push(`# WordPress site`);
  sections.push(`URL: ${ctx.wpUrl}`);
  sections.push(`Rebuilding page: ${ctx.pagePath}  (live: ${ctx.pageUrl})`);

  if (ctx.frontPage) {
    sections.push(``);
    sections.push(`# Front page facts (looked up via /wp-json/wp/v2/settings)`);
    sections.push(
      `- WordPress is configured to render this page as the homepage.`,
    );
    sections.push(`- Page ID: ${ctx.frontPage.id}`);
    sections.push(`- Page slug: "${ctx.frontPage.slug}"`);
    if (ctx.frontPage.title) {
      sections.push(`- Page title: "${ctx.frontPage.title}"`);
    }
    sections.push(
      `- Use this exact slug when calling getPageBySlug. Do NOT guess.`,
    );
  }

  if (ctx.brandColors.length > 0) {
    sections.push(``);
    sections.push(`# Brand color palette (extracted from source <style> blocks)`);
    sections.push(
      `These hex colors appear in the live site's stylesheets. Pick Tailwind classes whose values approximate these — don't substitute generic palettes (no defaulting to purple/indigo when the source is teal/orange):`,
    );
    sections.push(ctx.brandColors.map((c) => `- ${c}`).join("\n"));
    sections.push(
      `If a color clearly looks like a primary brand hue (highest occurrence, used in headers/buttons/accents), match its hue family. Tailwind has emerald/teal/cyan/blue/indigo/purple/pink/rose/red/orange/amber/yellow/lime/green/slate/zinc/stone families — pick the one closest to the dominant brand color, not just whatever feels designerly.`,
    );
  }

  sections.push(``);
  sections.push(`# Available abilities (from the manifest)`);
  sections.push(ctx.abilitiesSummary);

  sections.push(``);
  sections.push(`# Source page HTML`);
  sections.push("```html");
  sections.push(ctx.pageHtml);
  sections.push("```");

  sections.push(``);
  sections.push(
    `Generate \`app/page.tsx\` now. Output ONLY the code block — no preamble.`,
  );

  return sections.join("\n");
}
