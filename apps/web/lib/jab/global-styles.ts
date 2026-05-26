import "server-only";
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
  /** The raw payload, preserved for any consumer that wants the full tree. */
  raw: GlobalStylesResponse;
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
