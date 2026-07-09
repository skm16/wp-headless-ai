import "server-only";
import { validateTsx } from "./component-generator";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import type { ModelClient, GenerateUsage } from "./model-client";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";

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
  /**
   * Source-WP host(s). When set, a belt-and-suspenders prompt line tells the
   * model these hosts are the SAME site (use root-relative paths). Secondary to
   * the deterministic rewriteWpOriginUrls pass applied in patchUnitSource — the
   * rewrite is the guarantee; the prompt line is a cheap nudge.
   */
  sourceHosts?: string[];
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
  const internalHostsLine =
    input.sourceHosts && input.sourceHosts.length > 0
      ? `\n- The hosts ${input.sourceHosts.join(", ")} are THIS site. Any link to them must be a root-relative path (e.g. "/events"), never an absolute URL.`
      : "";
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.${themeClassSection}${tokenSection}${internalHostsLine}`;
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
  /**
   * Source-WP host variants (bare + www). When set, an LLM-introduced absolute
   * source-origin URL is rewritten to a root-relative path — mirrors the Phase B
   * generator (component-generator.ts:767-769). Absent → no rewrite (safe
   * default; entry.tsx only intercepts root-relative hrefs, so an absolute
   * source URL would otherwise navigate off the clone).
   */
  sourceHosts?: string[];
  /**
   * Exact source-permalink → clone route_path overrides (from page_inventory.link,
   * migration 0033) — the SAME map shell compose passes (compose-site.ts:602).
   * Without it, origin-stripping alone yields a root-relative but WRONG path
   * whenever a WP permalink diverges from its JAB route (e.g. /about-us/ → /about):
   * `rewriteWpOriginUrls` looks the stripped pathname up here and falls back to
   * plain origin-stripping for unmapped paths. Especially load-bearing for shell
   * (nav) edits. Absent/empty → plain origin-stripping (correct when route IS /<slug>).
   */
  routePathMap?: Record<string, string>;
}

export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    themeClassNames: opts.themeClassNames,
    tokens: opts.tokens,
    sourceHosts: opts.sourceHosts,
  });
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    // Attempt 1 uses the base user prompt. A retry appends the prior failure so
    // the model gets a corrective signal instead of an identical re-roll (the
    // #1 cause of doubled-cost guaranteed-identical failures).
    const userPrompt =
      attempt === 0
        ? prompt.user
        : `${prompt.user}\n\n## Your previous output failed validation with:\n${lastError}\n\nReturn ONLY the corrected raw TSX for the component — no prose, no markdown fences, no explanation. Keep the named export \`${opts.exportName}\`.`;

    // Merge note: master's GenerateOptions replaced the old `cacheSystemPrompt`
    // boolean with a separate `cachedSystemPrefix` block. The patch loop is only
    // 2 attempts at low volume, so caching here is negligible — pass the system
    // text uncached rather than refactor buildPatchPrompt into stable+varying parts.
    const result = await opts.client.generate({
      systemPrompt: prompt.system,
      userPrompt,
    });
    usage.push(result.usage);

    let candidate: string;
    try {
      candidate = postprocessGeneratedTsx(result.text, { expectedExportName: opts.exportName });
    } catch (err) {
      lastError = `postprocess: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    // Deterministic origin-strip — mirrors component-generator.ts:767-769 AND the
    // shell compose call (compose-site.ts:599-604), which passes routePathMap too.
    // Runs AFTER postprocess (canonical TSX) and BEFORE the size cap (rewriting
    // only ever shortens). entry.tsx intercepts only root-relative hrefs, so an
    // LLM-introduced absolute source URL would escape the clone without this; and
    // without routePathMap a diverged permalink (e.g. /about-us/) rewrites to a
    // root-relative but WRONG /about-us instead of the real route /about.
    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      candidate = rewriteWpOriginUrls(candidate, {
        sourceHosts: opts.sourceHosts,
        routePathMap: opts.routePathMap,
      });
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
