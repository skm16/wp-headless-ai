import "server-only";
import type { ScrapeAgentResult } from "./scrape-agent";

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

export function buildRenderPrompt(scrape: ScrapeAgentResult): string {
  const lines: string[] = [];

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
  lines.push(
    `- primary CTA copy: "${scrape.design.buttonPair.primary.value}" (confidence ${scrape.design.buttonPair.primary.confidence})`,
  );
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
  if (value === null) {
    lines.push(`- ${label}: null (confidence ${confidence}) — fall back to neutral default`);
    return;
  }
  lines.push(`- ${label}: ${value} (confidence ${confidence})`);
  if (confidence < 0.7) {
    lines.push(`  ⚠ low confidence — model said: ${reasoning}`);
  }
}

export function getRenderSystem(): string {
  return RENDER_SYSTEM;
}
