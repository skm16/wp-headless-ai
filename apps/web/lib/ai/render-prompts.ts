import "server-only";
import type { ScrapeAgentResult } from "./scrape-agent";
import { sanitizeForPrompt } from "./sanitize";

export type RenderIntent = "faithful" | "refresh" | "reimagine";

/**
 * The three intent treatments map onto three different briefs handed to
 * the renderer. We keep these as full paragraphs (not single adjectives)
 * because Sonnet honors directive prose better than terse tags — and
 * because the user explicitly chose between these at step 0 of the
 * wizard, we owe them a meaningfully different output per choice.
 *
 * Tone gradient: faithful preserves; refresh modernizes; reimagine
 * rethinks. The constraints get progressively looser as the intent
 * becomes more permissive.
 *
 * The Faithful brief was rewritten 2026-05-25 from a one-paragraph
 * directive to a structured MUST PRESERVE / MAY UPGRADE / MUST NOT DO
 * contract sourced from §4.3 of docs/ai-prompt-modes.md. Refresh and
 * Reimagine remain on their original one-paragraph briefs until §5 / §6
 * of the spec deepen. The §2 global rule (JAB brand never bleeds) lives
 * in RENDER_SYSTEM below — not duplicated into the briefs — since the
 * validator-enforced rule is universal across all three treatments.
 */
const INTENT_BRIEFS: Record<RenderIntent, string> = {
  faithful: `Treatment: FAITHFUL.

This is a polish-and-speed pass, not a redesign. The agency picked Faithful because the existing site broadly works; what they want is "look, same site, but it loads instantly." Render the same site the client already has — section-for-section, copy-for-copy — but with modern semantic HTML, better mobile responsiveness, and accessibility floor compliance.

MUST PRESERVE (hard — no exceptions):
- Section sequence and count. If source has nav → hero → 3 feature cards → testimonial → footer, the rebuild has the same sequence and the same count. No condensing, no expanding, no reordering.
- Hero copy verbatim. Headline, subhead, primary CTA label — exact string match, punctuation and capitalization preserved.
- Per-section primary copy. Section headings and the first paragraph of body copy in each section, verbatim.
- CTA labels. Every button/link label preserved exactly. If source says "Book a discovery call →", the rebuild says exactly that.
- Color palette. Use the extracted hex values verbatim. No Tailwind named-color substitution ("close enough" blue-600 instead of #2563ff is forbidden).
- Typography families. Use the extracted heading and body fonts. Substitute only if the family is unloadable AND extraction confidence is below 0.4.
- Information hierarchy. What's above the fold in source stays above the fold in the rebuild.

MAY UPGRADE (encouraged where needed):
- Semantic HTML. <section>, <article>, <header>, <nav>, <footer> always.
- Mobile responsiveness. Tablet + mobile breakpoints with sensible grid → stack and font scaling, even when source is bolt-on responsive.
- Accessibility floor. Alt text on images, semantic heading order, color contrast ≥ 4.5:1 for body text — overrides source if source fails contrast.
- Performance. Compressed images, loading="lazy" below the fold. No inline styles in the JSX, no !important, no redundant wrapper divs.
- Provable bloat trimming. Duplicate content (same paragraph thrice from a CMS bug) — render once and leave a comment. Subjective bloat — leave alone.

MUST NOT DO (hard rules):
- Invent content. No new sections, testimonials, feature claims, or "and more" lists. If a section is sparse, render exactly what's there.
- Invent CTAs. No defaulting to "Get Started" or "Learn More". No adding a second CTA where source has one.
- "Improve" copy voice. "Reach out today for a free consultation" stays exactly that — not "Get in touch", not "Schedule a call." Voice is the client's.
- Collapse sections. Two source sections that say similar things both get rendered.
- Substitute palettes. Use the extracted hex verbatim — not "approximately #orange-600". The model literally cannot reach for Tailwind defaults.
- Promise pixel-perfect. Aim for "yes, that's a clean rebuild of our site" — not a pixel clone.

When in doubt: preserve. Ambiguous modernization? Ask "would the client recognize this as their site?" If yes, fine. If no, don't change it.`,
  refresh: `Treatment: REFRESH.

Keep the existing site's content, navigation, and message intact, but render them through a more modern visual treatment. Bigger typography hierarchy, more generous whitespace, contemporary section transitions, sharper CTAs. Copy stays substantively the same — light editing for clarity is fine, but don't invent new sections or rewrite the message. Think "same site, but if it were redesigned in 2026."`,
  reimagine: `Treatment: REIMAGINE.

Use the existing site's content, brand tokens, and audience as the brief, but build the homepage you would build today if you were starting fresh for this brand. New structural choices are welcome — feature ordering, hero treatment, supporting sections — as long as every claim is grounded in the source brief. Don't invent products, services, or testimonials that aren't in the content. Lean into the brand personality more boldly than a refresh would.`,
};

export function intentBrief(intent: RenderIntent): string {
  return INTENT_BRIEFS[intent];
}

/**
 * Renderer prompts — the third pass of the wow flow.
 *
 * The scrape-agent produces *what* the page is about (content) and *how
 * it looks* (design tokens with confidence). This renderer takes both and
 * emits a single self-contained HTML document the iframe renders as the
 * preview's `srcDoc`.
 *
 * Why inline HTML and not React/JSX:
 *   - The wow preview is a *throwaway* artifact. It's not committed,
 *     not the actual deploy target, and is replaced by the real
 *     manifest-driven page generation after signup. JSX would imply
 *     architecture this doesn't have.
 *   - srcDoc keeps the iframe sandbox tight — no network requests off
 *     the document, no XHR, no third-party fetches.
 *   - The agency reads the HTML when they're inspecting the output;
 *     keeping it close to "what a hand-built static page looks like"
 *     is friendlier than reading rendered React.
 */

const RENDER_SYSTEM = `You are a senior frontend engineer specializing in agency-style marketing sites. Given a content brief + design tokens, you output a single self-contained HTML document that becomes the agency's preview of their client's new homepage.

CRITICAL RULE — the output is the client's brand, not the platform's:
Never use any of the platform's (JAB's) brand identity. The following are off-limits in any output, regardless of treatment intent:
- Colors: #060d16, #0a1628, #0f2040, #1a3158, #00c9a7, #2563ff, #ff4444, #f59e0b, #f0f4f8, #7a9ab8, #3a5070
- Fonts: Syne, DM Sans, JetBrains Mono
A post-output validator rejects any HTML containing these tokens. The client's brand is what was extracted from their source site; render that, not the platform's identity.

Output format — a single \`\`\`html code block. No prose before or after.

Requirements:
- Complete document: \`<!doctype html>\` through \`</html>\`.
- ALL CSS is inline in a single \`<style>\` element inside \`<head>\`. No external stylesheets. No JS.
- Use ONLY the colors and fonts provided in the design tokens. Do not invent values. If a token is null, fall back to a neutral default (slate / system-ui).
- Apply the brand personality (tone, energy, audience) to the copy AND the visual treatment — a "luxe / low-energy / wedding photographers" site looks different from "playful / high-energy / craft beer enthusiasts."
- Structure: \`<nav>\` → hero \`<section>\` → 2-3 supporting \`<section>\`s drawn from the content brief → \`<footer>\`.
- Mobile-first responsive — at least one \`@media\` breakpoint for tablet, one for desktop. Use sensible font scaling, grid → stack transitions.
- Semantic HTML (\`section\`, \`article\`, \`header\`, \`nav\`, \`footer\`). No \`<div>\` salad.
- Use the actual content from the brief. Don't invent products, services, or testimonials that aren't there. If a section's content is sparse, write a short heading and one paragraph — do not pad.
- If a logo URL is provided AND its confidence is ≥ 0.7, include it in the nav as an \`<img>\`. Below that, use the site name as text.
- If a favicon URL is provided, include it in \`<head>\` as \`<link rel="icon" href="...">\`. Browsers render it as the tab icon — a small but recognizable brand cue.
- Web-safe rendering: no \`<script>\`, no iframes, no fetch() to external resources. Inline SVG icons are fine. External images via \`<img src>\` ARE allowed and expected for the logo / favicon.
- Accessibility: alt text on images, sufficient color contrast, semantic heading order.
- No external font loading — use the font-family name in CSS; the iframe's browser will render with whatever's installed. This is acceptable for a preview.`;

export function buildRenderPrompt(
  scrape: ScrapeAgentResult,
  opts: { intent?: RenderIntent } = {},
): string {
  const lines: string[] = [];

  // Intent first so Sonnet sees the treatment directive before the source
  // material. Order matters here — a faithful brief framed after the
  // content tends to drift toward "improve the page" tendencies, where
  // the same brief at the top steers the output correctly.
  if (opts.intent) {
    lines.push("# Treatment intent");
    lines.push(intentBrief(opts.intent));
    lines.push("");
  }

  lines.push("# Source site");
  lines.push(`URL: ${scrape.url}`);
  if (scrape.extract.title) lines.push(`Site name (from <title>): ${scrape.extract.title}`);
  lines.push("");

  lines.push("# Content brief");
  lines.push(scrape.contentMarkdown);
  lines.push("");

  lines.push("# Design tokens");
  lines.push("");
  lines.push("## Colors");
  formatToken(
    lines,
    "primary",
    scrape.design.colors.primary.value,
    scrape.design.colors.primary.confidence,
    scrape.design.colors.primary.reasoning,
  );
  formatToken(
    lines,
    "secondary",
    scrape.design.colors.secondary.value,
    scrape.design.colors.secondary.confidence,
    scrape.design.colors.secondary.reasoning,
  );
  formatToken(
    lines,
    "accent",
    scrape.design.colors.accent.value,
    scrape.design.colors.accent.confidence,
    scrape.design.colors.accent.reasoning,
  );
  lines.push("");

  lines.push("## Typography");
  formatToken(
    lines,
    "heading family",
    scrape.design.typography.heading.value,
    scrape.design.typography.heading.confidence,
    scrape.design.typography.heading.reasoning,
  );
  formatToken(
    lines,
    "body family",
    scrape.design.typography.body.value,
    scrape.design.typography.body.confidence,
    scrape.design.typography.body.reasoning,
  );
  lines.push("");

  lines.push("## Logo");
  lines.push(
    `- src: ${scrape.design.logo.src ?? "null"} (confidence ${scrape.design.logo.confidence})`,
  );
  lines.push(`- reasoning: ${scrape.design.logo.reasoning}`);
  lines.push("");

  lines.push("## Favicon");
  lines.push(`- href: ${scrape.extract.faviconUrl ?? "null"}`);
  lines.push("");

  lines.push("## Buttons");
  if (scrape.design.buttonPair.primary.value) {
    lines.push(
      `- primary CTA copy: "${scrape.design.buttonPair.primary.value}" (confidence ${scrape.design.buttonPair.primary.confidence})`,
    );
  } else {
    lines.push(
      `- primary CTA copy: (none observed — site has no prominent CTA, e.g. personal blog or portfolio)`,
    );
  }
  if (scrape.design.buttonPair.secondary.value) {
    lines.push(
      `- secondary CTA copy: "${scrape.design.buttonPair.secondary.value}" (confidence ${scrape.design.buttonPair.secondary.confidence})`,
    );
  }
  lines.push("");

  lines.push("## Brand personality");
  lines.push(`- tone: ${scrape.design.personality.tone.value} (confidence ${scrape.design.personality.tone.confidence})`);
  lines.push(`- energy: ${scrape.design.personality.energy.value}`);
  lines.push(`- audience: ${scrape.design.personality.audience.value}`);
  lines.push("");

  lines.push(
    "Produce the HTML document now. Use the actual color and font values verbatim. Apply the brand personality to copy choices.",
  );

  return lines.join("\n");
}

function formatToken(
  lines: string[],
  label: string,
  value: string | null,
  confidence: number,
  reasoning: string,
): void {
  // Confidence floor: sub-0.4 fields are treated as null even if a value
  // exists. Matches §8.1 of docs/ai-prompt-modes.md ("sub-0.4 fields omitted
  // entirely"). Important specifically for the deterministic pickColors
  // zero-chromatic path, which emits `value: "#000000", confidence: 0` to
  // satisfy the non-nullable schema invariant on primary — without this gate
  // the renderer would treat that sentinel hex as the brand primary.
  if (value === null || confidence < 0.4) {
    lines.push(`- ${label}: null (confidence ${confidence}) — fall back to neutral default`);
    return;
  }
  lines.push(`- ${label}: ${value} (confidence ${confidence})`);
  if (confidence < 0.7) {
    // Reasoning strings are LLM-authored by the design pass — defensive
    // sanitize before interpolating into the prompt's markdown structure.
    // Closes the regression from §8.6 (was at deleted prompts.ts:372).
    lines.push(`  ⚠ low confidence — model said: ${sanitizeForPrompt(reasoning, 500)}`);
  }
}

export function getRenderSystem(): string {
  return RENDER_SYSTEM;
}
