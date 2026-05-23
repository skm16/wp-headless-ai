import "server-only";
import type { ScrapeExtract } from "./scrape-extract";

/**
 * Prompts for the two-pass scrape pipeline.
 *
 * Why two passes (not one mega-prompt)?
 *
 *   - Replit's reference (`docs/replit-examples/extracted-design-example.json`)
 *     separates concerns explicitly: logo classification, button
 *     classification, personality inference are each their own task with its
 *     own confidence + reasoning. Doc §10 (transition.md) imports this
 *     pattern by name.
 *   - A single prompt forced to emit both prose markdown AND structured
 *     design-JSON simultaneously degrades both — the model under-thinks the
 *     part it's not currently emitting.
 *   - Errors are isolatable. If the design JSON fails to parse, the content
 *     markdown is still usable, and vice versa.
 *
 * Each pass gets a minimal, deterministic input from `scrape-extract.ts`
 * (titles / sections / images / palette) — no raw HTML reaches the model.
 * Inference happens against the *extracted signals*, not bytes.
 */

// ---------------------------------------------------------------------------
// Content pass — returns markdown describing the page's content hierarchy
// ---------------------------------------------------------------------------

const CONTENT_SYSTEM = `You are a content analyst. Given structured extracts from a website, you produce a clean markdown document that captures what the site is about and how its content is organized.

Output format — markdown only, no preamble:

# {Site name}
{One-sentence description if discernible}

## Brand
- Implied identity: {what they sell / who they serve}
- Voice: {tone you'd write copy in}

## Sections
For each meaningful section in source order:

### {Section heading or inferred role like "Hero"}
{1-3 sentences of the actual content. Use the source's words where possible.}

## Calls to action
- {button text} → {where it goes}

Do not invent content. If a section's text is sparse, write one short line acknowledging that. Aim for accuracy over completeness.`;

export function buildContentUserPrompt(extract: ScrapeExtract): string {
  const lines: string[] = [];

  lines.push("Source URL:", extract.url, "");
  if (extract.title) lines.push("Title:", extract.title, "");
  if (extract.description) lines.push("Description:", extract.description, "");

  if (extract.h1.length > 0) {
    lines.push("Primary headings (h1):");
    extract.h1.forEach((h) => lines.push(`- ${h}`));
    lines.push("");
  }
  if (extract.h2.length > 0) {
    lines.push("Section headings (h2):");
    extract.h2.forEach((h) => lines.push(`- ${h}`));
    lines.push("");
  }

  if (extract.navLinks.length > 0) {
    lines.push("Primary navigation:");
    extract.navLinks.forEach((l) => lines.push(`- ${l.text} → ${l.href}`));
    lines.push("");
  }

  if (extract.sections.length > 0) {
    lines.push("Sections (in source order):");
    extract.sections.forEach((s, i) => {
      lines.push(`${i + 1}. [${s.role}]${s.heading ? ` "${s.heading}"` : ""}`);
      lines.push(`   ${s.text}`);
    });
    lines.push("");
  }

  if (extract.buttons.length > 0) {
    lines.push("Button-like elements:");
    extract.buttons.forEach((b) =>
      lines.push(`- "${b.text}"${b.href ? ` → ${b.href}` : ""} (${b.region})`),
    );
    lines.push("");
  }

  if (extract.footerText) {
    lines.push("Footer text:", extract.footerText, "");
  }

  lines.push(
    "Produce the markdown document now. Quote source phrasing where it carries the brand voice.",
  );

  return lines.join("\n");
}

export function getContentSystem(): string {
  return CONTENT_SYSTEM;
}

// ---------------------------------------------------------------------------
// Design pass — returns JSON with confidence + reasoning per field
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM = `You are a design analyst. Given structured extracts from a website (palette samples, font samples, image candidates, button text), you classify the site's visual identity and brand personality.

Output format — a single JSON object inside a \`\`\`json code block. No prose before or after.

Required shape:

\`\`\`json
{
  "colors": {
    "primary":   { "value": "#RRGGBB", "confidence": 0.0, "reasoning": "..." },
    "secondary": { "value": "#RRGGBB" | null, "confidence": 0.0, "reasoning": "..." },
    "accent":    { "value": "#RRGGBB" | null, "confidence": 0.0, "reasoning": "..." }
  },
  "typography": {
    "heading": { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." },
    "body":    { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." }
  },
  "logo": {
    "src": "https://..." | null,
    "confidence": 0.0,
    "reasoning": "Why this image over the others — region, alt text, size cue."
  },
  "buttonPair": {
    "primary":   { "text": "...", "confidence": 0.0, "reasoning": "..." },
    "secondary": { "text": "..." | null, "confidence": 0.0, "reasoning": "..." }
  },
  "personality": {
    "tone":     { "value": "...", "confidence": 0.0, "reasoning": "One short phrase: playful / serious / luxe / utilitarian / etc." },
    "energy":   { "value": "low" | "medium" | "high", "confidence": 0.0, "reasoning": "..." },
    "audience": { "value": "...", "confidence": 0.0, "reasoning": "Who is this site for, in one phrase." }
  }
}
\`\`\`

Rules:
- Confidence is a number between 0 and 1. Be honest about uncertainty — under-claim, not over-claim.
- Reasoning must cite the actual evidence ("the palette sample #4f46e5 appears in 3 buttons" / "the image at index 0 sits in <header> with alt 'Acme logo'") — not generic justifications.
- Logo selection: prefer images in the \`header\` region with non-trivial alt text. Confidence drops if no header-region image exists.
- Color selection: pick from the palette samples provided. The model may NOT invent a hex value that isn't in the input.
- Typography: pick from the font samples provided. Same constraint — no invention.
- If you genuinely cannot infer a field, set its value to null and confidence to 0.`;

export function buildDesignUserPrompt(extract: ScrapeExtract): string {
  const lines: string[] = [];

  lines.push("Source URL:", extract.url, "");
  if (extract.title) lines.push("Title:", extract.title, "");
  if (extract.description) lines.push("Description:", extract.description);

  lines.push("");
  if (extract.paletteSamples.length > 0) {
    lines.push("Palette samples (from inline <style> + style attributes):");
    extract.paletteSamples.forEach((c, i) => lines.push(`[${i}] ${c}`));
  } else {
    lines.push("Palette samples: NONE (no inline <style> hex/rgb values found)");
  }
  lines.push("");

  if (extract.fontSamples.length > 0) {
    lines.push("Font-family samples:");
    extract.fontSamples.forEach((f, i) => lines.push(`[${i}] ${f}`));
  } else {
    lines.push("Font-family samples: NONE found in inline styles");
  }
  lines.push("");

  lines.push("Image candidates (for logo selection):");
  if (extract.images.length === 0) {
    lines.push("(none)");
  } else {
    extract.images.forEach((img, i) =>
      lines.push(
        `[${i}] region=${img.region} alt=${JSON.stringify(img.alt ?? "")} src=${img.src}`,
      ),
    );
  }
  lines.push("");
  if (extract.faviconUrl) lines.push("Favicon URL:", extract.faviconUrl, "");
  if (extract.socialImage) lines.push("OG/social image:", extract.socialImage, "");

  if (extract.buttons.length > 0) {
    lines.push("Button-like elements:");
    extract.buttons.forEach((b, i) =>
      lines.push(`[${i}] "${b.text}" (${b.region})${b.href ? ` → ${b.href}` : ""}`),
    );
    lines.push("");
  }

  if (extract.h1.length > 0 || extract.h2.length > 0) {
    lines.push("Headings (for personality inference):");
    extract.h1.forEach((h) => lines.push(`- h1: ${h}`));
    extract.h2.slice(0, 6).forEach((h) => lines.push(`- h2: ${h}`));
    lines.push("");
  }

  lines.push(
    "Produce the design JSON now. Cite the indexed evidence in your reasoning.",
  );

  return lines.join("\n");
}

export function getDesignSystem(): string {
  return DESIGN_SYSTEM;
}
