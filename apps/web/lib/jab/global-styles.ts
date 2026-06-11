// NOTE: deliberately NOT "server-only". Pure token distillation (the only
// other import is type-only) — imported by scripts/debug-shell-llm.ts.
import type { GlobalStylesResponse } from "./ability-client";

/**
 * Distills WP's global-styles response into the token shape Phase B
 * (tailwind.config emit) consumes. Lives separate from the ability-client
 * fetch because Phase B may swap in computed-CSS-derived tokens for
 * classic themes where global-styles is unavailable.
 *
 * Returns null when there's nothing usable — caller falls back to
 * inference from `block_inventory.computed_styles`.
 */

export interface ThemeJsonTokens {
  colorPalette?: Array<{ slug: string; color: string }>;
  fontSizes?: Array<{ slug: string; size: string }>;
  fontFamilies?: Array<{ slug: string; fontFamily: string }>;
  blockGap?: string;
  /**
   * The raw payload, preserved for any consumer that wants the full tree.
   * Optional because the classic-theme adapter (`brandTokensFromDesignAnalysis`)
   * synthesizes a ThemeJsonTokens from the AI scrape-agent output, which has
   * no corresponding wp/v2/global-styles response. No production consumer
   * reads `raw` today; it stays in the type for debug/audit roundtrips on the
   * theme.json path only.
   */
  raw?: GlobalStylesResponse;
}

export function extractThemeJsonTokens(
  response: GlobalStylesResponse | null,
): ThemeJsonTokens | null {
  if (!response || typeof response !== "object") return null;
  const settings = (response.settings ?? {}) as Record<string, Record<string, unknown>>;
  const color = settings.color ?? {};
  const typography = settings.typography ?? {};
  const spacing = settings.spacing ?? {};

  const palette = Array.isArray(color.palette)
    ? (color.palette as Array<{ slug?: unknown; color?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.color === "string")
        .map((e) => ({ slug: e.slug as string, color: e.color as string }))
    : undefined;

  const fontSizes = Array.isArray(typography.fontSizes)
    ? (typography.fontSizes as Array<{ slug?: unknown; size?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.size === "string")
        .map((e) => ({ slug: e.slug as string, size: e.size as string }))
    : undefined;

  const fontFamilies = Array.isArray(typography.fontFamilies)
    ? (typography.fontFamilies as Array<{ slug?: unknown; fontFamily?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.fontFamily === "string")
        .map((e) => ({ slug: e.slug as string, fontFamily: e.fontFamily as string }))
    : undefined;

  const blockGap = typeof spacing.blockGap === "string" ? (spacing.blockGap as string) : undefined;

  if (!palette && !fontSizes && !fontFamilies && !blockGap) return null;

  return { colorPalette: palette, fontSizes, fontFamilies, blockGap, raw: response };
}

/**
 * Shape produced by the AI scrape-agent (lib/ai/scrape-agent.ts
 * DesignAnalysisSchema). Mirrored here as a structural type so the adapter
 * doesn't pull in zod or the full scrape-agent module — keeps the
 * server-only constraint of global-styles.ts narrow.
 */
export interface ScrapedBrandTokens {
  colors?: {
    primary?: { value?: string | null } | null;
    secondary?: { value?: string | null } | null;
    accent?: { value?: string | null } | null;
  } | null;
  typography?: {
    heading?: { value?: string | null } | null;
    body?: { value?: string | null } | null;
  } | null;
}

/**
 * Adapter: convert the AI scrape-agent's `design_tokens.colors` /
 * `design_tokens.typography` output into a `ThemeJsonTokens` value so the
 * existing Phase B/C consumers (emitTailwindConfigTs, renderTokenSection in
 * shell-prompts) light up for classic-theme WP sites that have no
 * theme.json.
 *
 * Background: WP's `/wp-json/wp/v2/global-styles` is FSE-only. Classic
 * themes (Two Roads, most agency builds) return null, which left
 * `themeTokens` null in compose-site.ts, which made the LLM emit `bg-white`
 * masthead + empty Tailwind tokens for the Two Roads pilot (build
 * `982f0d57`). The scrape-agent had already extracted brand colors and
 * typography — they just weren't threaded into the compose pipeline.
 *
 * Returns null when there's nothing usable (no hex colors AND no font
 * families found) so callers can `?? null` past it to keep the
 * Tailwind-defaults branch.
 *
 * Slug assignment is structural (`primary` / `secondary` / `accent` /
 * `heading` / `body`) matching the scrape-agent's field names — these
 * become Tailwind keys (`bg-primary`, `font-heading`) the LLM can target.
 */
export function brandTokensFromDesignAnalysis(
  scraped: ScrapedBrandTokens | null | undefined,
): ThemeJsonTokens | null {
  if (!scraped) return null;

  const palette: Array<{ slug: string; color: string }> = [];
  for (const slug of ["primary", "secondary", "accent"] as const) {
    const entry = scraped.colors?.[slug];
    const value = entry?.value;
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
      palette.push({ slug, color: value });
    }
  }

  const fontFamilies: Array<{ slug: string; fontFamily: string }> = [];
  for (const slug of ["heading", "body"] as const) {
    const entry = scraped.typography?.[slug];
    const value = entry?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      fontFamilies.push({ slug, fontFamily: value.trim() });
    }
  }

  if (palette.length === 0 && fontFamilies.length === 0) return null;

  return {
    colorPalette: palette.length > 0 ? palette : undefined,
    fontFamilies: fontFamilies.length > 0 ? fontFamilies : undefined,
  };
}

/**
 * Composite resolver: prefer the WP theme.json tokens when present, fall
 * back to the AI scrape-agent's brand inference for classic themes. Returns
 * null only when neither path produced anything.
 *
 * When BOTH are present we currently prefer themeJson — it's the authoritative
 * source the site authors maintain; the scrape inference is a heuristic
 * shortcut. Future work could merge them (theme.json defines vocabulary,
 * scrape fills gaps); the single pilot we have today (Two Roads) is purely
 * classic-theme so the merge case isn't load-bearing yet.
 */
export function resolveThemeTokens(
  themeJson: ThemeJsonTokens | null | undefined,
  scraped: ScrapedBrandTokens | null | undefined,
): ThemeJsonTokens | null {
  if (themeJson) return themeJson;
  return brandTokensFromDesignAnalysis(scraped);
}
