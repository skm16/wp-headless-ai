import "server-only";
import { validateTsx } from "./component-generator";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import type { ModelClient, GenerateUsage } from "./model-client";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * patch-component — the Live Draft edit primitive (spec §6.2.3). Unlike the
 * Phase B generator (which re-derives a component from DOM samples and can
 * silently lose earlier edits), this takes the CURRENT draft TSX as input and
 * asks for a minimal modification — iterative chat edits compound instead of
 * resetting. Same validation discipline as generation: postprocess → parse
 * check → size cap, two attempts.
 *
 * Theme-class inventory + token-hex hints (added 2026-06-16): the patch LLM
 * previously had NO signal about which class names the bundled theme CSS
 * defines or which hex maps to which token, so it invented dead classes
 * (e.g. footer-v2-grid) and approximated brand colors with stock Tailwind
 * utilities. Both sections are SOFT — block-level edits legitimately need
 * Tailwind layout utilities never present in theme CSS — and the deterministic
 * dead-class oracle is the real guardrail. Both are byte-additive: when no
 * inventory/tokens are supplied the prompt is identical to before.
 */
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** Class names defined in the bundled source theme CSS (SOFT prefer hint). */
  themeClassNames?: string[];
  /** Theme tokens, for the slug+hex "match by hex" section (SOFT). */
  tokens?: ThemeJsonTokens | null;
}

function renderPatchThemeClassSection(classNames: string[] | undefined): string {
  if (!classNames || classNames.length === 0) return "";
  return `

## Source theme class names (defined in the bundled theme CSS)
These class names are defined in the site's compiled CSS, which the clone
bundles at runtime. When the current source already uses one of these classes,
PREFER to keep it verbatim (the bundled CSS resolves it) rather than swapping
it for a Tailwind approximation. You MAY also use standard Tailwind utilities
for layout/spacing — inventing a class that is in NEITHER list resolves to no
CSS and does nothing, so avoid it:
${classNames.map((n) => `- ${n}`).join("\n")}`;
}

function renderPatchTokenSection(tokens: ThemeJsonTokens | null | undefined): string {
  if (!tokens) return "";
  const colorPairs = (tokens.colorPalette ?? []).slice(0, 12).map((c) => `${c.slug} (${c.color})`).join(", ");
  const fontPairs = (tokens.fontFamilies ?? []).slice(0, 6).map((f) => `${f.slug} (${f.fontFamily})`).join(", ");
  if (!colorPairs && !fontPairs) return "";
  return `

## Available theme tokens
Colors: ${colorPairs || "(none)"}
Font families: ${fontPairs || "(none)"}
The generated tailwind.config maps each slug to a Tailwind class (e.g. \`bg-primary\`,
\`text-primary\`, \`font-heading\`). When the edit introduces a literal color value
(e.g. \`#ffc72c\` or \`rgb(255,199,44)\`), prefer the matching token class over a
Tailwind utility approximation (\`bg-yellow-400\`). Match by hex value, not by semantic name.`;
}

export function buildPatchPrompt(input: PatchPromptInput): { system: string; user: string } {
  const themeClassSection = renderPatchThemeClassSection(input.themeClassNames);
  const tokenSection = renderPatchTokenSection(input.tokens);
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.${themeClassSection}${tokenSection}`;
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}`;
  return { system, user };
}

export type PatchResult =
  | { ok: true; tsx: string; attempts: number; usage: GenerateUsage[] }
  | { ok: false; error: string; attempts: number; usage: GenerateUsage[] };

export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** MAX_COMPONENT_BYTES (10_000) for components, MAX_SHELL_BYTES (24_000) for shell. */
  maxBytes: number;
  client: ModelClient;
  /** SOFT prefer-inventory of class names defined in the bundled theme CSS. */
  themeClassNames?: string[];
  /** Theme tokens for the slug+hex "match by hex" prompt section. */
  tokens?: ThemeJsonTokens | null;
}

export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    themeClassNames: opts.themeClassNames,
    tokens: opts.tokens,
  });
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await opts.client.generate({
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      cacheSystemPrompt: attempt === 0,
    });
    usage.push(result.usage);

    let candidate: string;
    try {
      candidate = postprocessGeneratedTsx(result.text, { expectedExportName: opts.exportName });
    } catch (err) {
      lastError = `postprocess: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (Buffer.byteLength(candidate, "utf-8") > opts.maxBytes) {
      lastError = `output exceeds ${opts.maxBytes} bytes`;
      continue;
    }
    const errors = validateTsx(candidate, `${opts.exportName}.tsx`);
    if (errors.length > 0) {
      lastError = `parse errors: ${errors.slice(0, 3).join("; ")}`;
      continue;
    }
    return { ok: true, tsx: candidate, attempts: attempt + 1, usage };
  }
  return { ok: false, error: lastError, attempts: 2, usage };
}
