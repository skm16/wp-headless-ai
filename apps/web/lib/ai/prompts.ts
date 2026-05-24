import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { DesignTokens, Personality } from "@/lib/jab/page-context";

// Confidence thresholds mirror `components/design-tokens-review.tsx`. Keep
// these aligned with that file when tuning; the agency-facing UI badges
// the same fields against the same scale, so the prompt's framing should
// match what the human reviewer sees.
const HIGH_CONFIDENCE = 0.7;
const REVIEW_CONFIDENCE = 0.4;

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
   * Tailwind colors each generation. When `designContext.tokens` is
   * non-null the structured LLM-extracted colors take precedence and
   * this list is suppressed from the prompt.
   */
  brandColors: string[];
  /**
   * Stage 2 design extraction output. Higher-quality than `brandColors`
   * (LLM-extracted from rendered HTML, with per-field confidence +
   * reasoning) — when present, used as the authoritative palette,
   * typography, and brand-voice signal. Either field may be null
   * independently (one column persists, the other failed validation,
   * etc.). Both null means the worker hadn't run yet at generation
   * time; fall back to brandColors.
   */
  designContext: {
    tokens: DesignTokens | null;
    personality: Personality | null;
  };
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

  // Color palette: prefer structured tokens (LLM-extracted with
  // confidence + reasoning) when available; fall back to ad-hoc hex
  // extraction when Stage 2 didn't produce color signal specifically.
  // The two are NOT mutually exclusive — Stage 2 may have rendered
  // typography / logo / CTA copy but failed to clear the confidence
  // floor on colors, in which case we still want the ad-hoc palette
  // as a color-specific fallback rather than leaving the AI to guess.
  const tokenRender = ctx.designContext.tokens
    ? appendDesignTokensSection(sections, ctx.designContext.tokens)
    : { rendered: false, renderedColors: false };
  if (!tokenRender.renderedColors && ctx.brandColors.length > 0) {
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

  if (ctx.designContext.personality) {
    appendPersonalitySection(sections, ctx.designContext.personality);
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

// ---------------------------------------------------------------------------
// Design-context section builders
// ---------------------------------------------------------------------------

/**
 * Render structured color + typography + logo signals from Stage 2
 * extraction. Confidence tier drives the imperative: high → "match this,"
 * review → "treat as suggestion," refuse-tier fields are omitted entirely
 * (sub-0.4 confidence is noise — passing it through would actively hurt).
 *
 * Returns `{ rendered, renderedColors }` so the caller can detect both
 * "did any subsection fire" and "did the color subsection specifically
 * fire" — the latter drives the ad-hoc brandColors color-only fallback
 * (typography / CTA-only Stage 2 output still needs the hex palette).
 */
function appendDesignTokensSection(
  sections: string[],
  tokens: DesignTokens,
): { rendered: boolean; renderedColors: boolean } {
  // Buffer the whole section locally so we only push to the caller's
  // array if it ends up non-trivial. Avoids the "empty header" failure
  // mode when Stage 2 returned data but every field is sub-confidence.
  const local: string[] = [];
  const subsections: string[] = [];

  const colorLines: string[] = [];
  appendColorLine(colorLines, "Primary", tokens.colors.primary);
  appendColorLine(colorLines, "Secondary", tokens.colors.secondary);
  appendColorLine(colorLines, "Accent", tokens.colors.accent);
  const renderedColors = colorLines.length > 0;
  if (renderedColors) {
    subsections.push("colors");
    local.push(``);
    local.push(`## Brand colors`);
    local.push(...colorLines);
    local.push(
      `Pick Tailwind classes whose values approximate these. Match the hue family — emerald/teal/cyan/blue/indigo/purple/pink/rose/red/orange/amber/yellow/lime/green/slate/zinc/stone — and don't substitute generic palettes.`,
    );
  }

  const typoLines: string[] = [];
  appendFontLine(typoLines, "Heading", tokens.typography.heading);
  appendFontLine(typoLines, "Body", tokens.typography.body);
  if (typoLines.length > 0) {
    subsections.push("typography");
    local.push(``);
    local.push(`## Typography`);
    local.push(...typoLines);
    local.push(
      `Tailwind's default config ships \`font-sans\`, \`font-serif\`, \`font-mono\` only. Pick the family that matches each extracted font's tone (e.g. Playfair Display → \`font-serif\`, Inter → \`font-sans\`). If a specific font is critical to the brand, add a Google Fonts \`<link>\` in the JSX head; otherwise the family utility is sufficient for v0.`,
    );
  }

  if (tokens.logo.src && tokens.logo.confidence >= REVIEW_CONFIDENCE) {
    subsections.push("logo");
    local.push(``);
    local.push(`## Logo`);
    local.push(`- src: ${tokens.logo.src}`);
    local.push(`- confidence: ${formatConfidence(tokens.logo.confidence)}`);
    local.push(`- reasoning: ${sanitizeReasoning(tokens.logo.reasoning)}`);
    local.push(
      `Use this URL in the page header (e.g. an \`<img>\` in a \`<header>\` element). Cross-origin is fine — the agency's Next.js project allows remote images by default in v0.`,
    );
  }

  // Button copy hints — only show when primary copy was extracted with
  // signal; the AI may still want to write its own CTA based on content.
  // Schema allows primary.value to be null for sites with no clear CTA
  // (personal blogs, portfolios) — skip the section entirely in that case.
  if (
    tokens.buttonPair.primary.value &&
    tokens.buttonPair.primary.confidence >= REVIEW_CONFIDENCE
  ) {
    subsections.push("CTA copy");
    local.push(``);
    local.push(`## Existing CTA copy (observed on the live site)`);
    local.push(`- Primary: "${tokens.buttonPair.primary.value}"`);
    if (
      tokens.buttonPair.secondary.value &&
      tokens.buttonPair.secondary.confidence >= REVIEW_CONFIDENCE
    ) {
      local.push(`- Secondary: "${tokens.buttonPair.secondary.value}"`);
    }
    local.push(
      `Use these verbatim when the source page surfaces a matching CTA. Don't invent new CTAs ("Get Started" / "Learn More") if the live site uses something more specific.`,
    );
  }

  if (local.length === 0) return { rendered: false, renderedColors: false };

  sections.push(``);
  sections.push(
    `# Design context (Stage 2 extraction — LLM-analyzed from rendered HTML)`,
  );
  // Dynamic descriptor — list only subsections that actually rendered so
  // we don't tell the model to consult "colors, typography, and logo" when
  // only CTA copy is present.
  sections.push(
    `These signals were extracted from the connected WordPress site with per-field confidence + reasoning. Use them as primary guidance for ${formatList(subsections)}. Fields below the 40% confidence floor are omitted — don't assume they don't exist, just that we didn't have strong enough signal to commit.`,
  );
  sections.push(...local);
  return { rendered: true, renderedColors };
}

function appendColorLine(
  lines: string[],
  label: string,
  // `value` is `string | null` because secondary/accent are nullable in
  // the schema. `primary.value` is always non-null per Zod, but it shares
  // this helper so the null guard below is the type-safe path; for primary
  // the guard is effectively unreachable.
  field: { value: string | null; confidence: number; reasoning: string },
): void {
  if (field.value === null) return;
  if (field.confidence < REVIEW_CONFIDENCE) return;
  const suffix =
    field.confidence >= HIGH_CONFIDENCE
      ? ` — confidence ${formatConfidence(field.confidence)}`
      : ` — confidence ${formatConfidence(field.confidence)}, treat as suggestion`;
  lines.push(`- ${label}: ${field.value}${suffix}`);
  lines.push(`  Why: ${sanitizeReasoning(field.reasoning)}`);
}

function appendFontLine(
  lines: string[],
  label: string,
  field: { value: string | null; confidence: number; reasoning: string },
): void {
  if (field.value === null) return;
  if (field.confidence < REVIEW_CONFIDENCE) return;
  const suffix =
    field.confidence >= HIGH_CONFIDENCE
      ? ` — confidence ${formatConfidence(field.confidence)}`
      : ` — confidence ${formatConfidence(field.confidence)}, treat as suggestion`;
  lines.push(`- ${label}: "${field.value}"${suffix}`);
  lines.push(`  Why: ${sanitizeReasoning(field.reasoning)}`);
}

/**
 * Render brand voice / audience signals. Only include fields above the
 * review floor; below that is noise. Lower-confidence values get a
 * "treat as suggestion" caveat so the AI doesn't over-index on weak signal.
 */
function appendPersonalitySection(
  sections: string[],
  personality: Personality,
): void {
  const lines: string[] = [];
  if (personality.tone.confidence >= REVIEW_CONFIDENCE) {
    const caveat =
      personality.tone.confidence >= HIGH_CONFIDENCE
        ? ""
        : " (treat as suggestion)";
    lines.push(`- Tone: ${personality.tone.value}${caveat}`);
  }
  if (personality.energy.confidence >= REVIEW_CONFIDENCE) {
    const caveat =
      personality.energy.confidence >= HIGH_CONFIDENCE
        ? ""
        : " (treat as suggestion)";
    lines.push(`- Energy: ${personality.energy.value}${caveat}`);
  }
  if (personality.audience.confidence >= REVIEW_CONFIDENCE) {
    const caveat =
      personality.audience.confidence >= HIGH_CONFIDENCE
        ? ""
        : " (treat as suggestion)";
    lines.push(`- Audience: ${personality.audience.value}${caveat}`);
  }
  if (lines.length === 0) return;
  sections.push(``);
  sections.push(`# Brand voice & audience`);
  sections.push(
    `Use these as guidance for any inline marketing copy you write (headings, taglines, CTA microcopy). Don't write generic SaaS-ese when the brand voice is concrete.`,
  );
  sections.push(...lines);
}

function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}

/**
 * The Stage 2 scrape agent returns LLM-authored reasoning strings. They're
 * validated only as non-empty; nothing prevents the model from emitting
 * markdown headings, fenced code blocks, or stray backticks. Interpolating
 * those verbatim into the generation prompt risks confusing Sonnet's
 * code-block boundary detection — the worst case is a reasoning string
 * containing "```tsx" mid-prompt, which the model could mistake for the
 * start of the expected output block.
 *
 * Strip the structural characters; keep the substance.
 */
function sanitizeReasoning(text: string): string {
  return text
    .replace(/```/g, "'''") // neutralize fences
    .replace(/^#+\s/gm, "") // strip ATX heading markers
    .trim();
}

/**
 * Render a short comma list: ["colors"] → "colors", ["colors","logo"] →
 * "colors and logo", ["colors","typography","logo"] → "colors, typography, and logo".
 */
function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
