import "server-only";
import type { ScrapeExtract, ExtractedImage } from "./scrape-extract";
import { sanitizeForPrompt } from "./sanitize";

/**
 * Deterministic selectors for the design-pass fields that don't need an
 * LLM at all. Replaces three of the design pass's five output fields with
 * pure code:
 *
 *   - `colors` — top 3 chromatic hex values from `paletteSamples`, in
 *     occurrence-rank order. Filters greyscale/near-neutral so the LLM-era
 *     failure mode of "primary = #ffffff" can't recur.
 *   - `logo` — heuristic on `images`: prefer `region: "header"` + non-empty
 *     alt; fall through to any header/nav image; last resort, first image.
 *
 * The LLM still handles `typography`, `buttonPair`, and `personality` —
 * those require either richer per-element signal we don't extract (which
 * font goes with which heading) or semantic inference (which CTA is
 * "primary"; what's the brand voice).
 *
 * The public `DesignAnalysis` shape is unchanged — the design-pass
 * orchestrator stitches the deterministic + LLM subsets together before
 * returning.
 */

const CHROMATIC_THRESHOLD = 20;
const MAX_CHROMATIC = 3;

export interface DeterministicColors {
  primary: ColorField;
  secondary: ColorField;
  accent: ColorField;
}

export interface ColorField {
  value: string;
  confidence: number;
  reasoning: string;
}

export interface DeterministicLogo {
  src: string | null;
  confidence: number;
  reasoning: string;
}

/**
 * Pick top 3 chromatic colors from the frequency-ranked palette samples.
 * Confidence drops by rank (0.85 / 0.7 / 0.55) — coarse but matches the
 * LLM-era distribution well enough that downstream confidence-thresholding
 * keeps working. Returns nulls (with confidence 0) only when fewer than
 * 3 chromatic samples exist — usually a sign of a scrape that hit a
 * single-color reset CSS.
 */
export function pickColors(extract: ScrapeExtract): {
  primary: ColorField;
  secondary: { value: string | null; confidence: number; reasoning: string };
  accent: { value: string | null; confidence: number; reasoning: string };
} {
  const chromatic = extract.paletteSamples.filter(isChromatic).slice(0, MAX_CHROMATIC);
  const totalSamples = extract.paletteSamples.length;

  const labelFor = (rank: number) =>
    `rank ${rank + 1} of ${chromatic.length} chromatic samples (${totalSamples} total palette samples after greyscale filter)`;

  // Tier-1 (no chromatic): emit a black primary with confidence 0 + null
  // secondary/accent. The renderer's confidence-thresholding (sub-0.4
  // means "omit") will drop primary from the prompt entirely; downstream
  // falls back to its system-ui-on-slate default. Sustains the schema
  // invariant that primary.value is a hex string.
  if (chromatic.length === 0) {
    return {
      primary: {
        value: "#000000",
        confidence: 0,
        reasoning: "no chromatic colors in palette samples — page likely uses inherited theme colors not present in inline <style>",
      },
      secondary: { value: null, confidence: 0, reasoning: "no chromatic samples" },
      accent: { value: null, confidence: 0, reasoning: "no chromatic samples" },
    };
  }

  return {
    primary: {
      value: chromatic[0]!,
      confidence: 0.85,
      reasoning: labelFor(0),
    },
    secondary: {
      value: chromatic[1] ?? null,
      confidence: chromatic[1] ? 0.7 : 0,
      reasoning: chromatic[1] ? labelFor(1) : "only one chromatic sample available",
    },
    accent: {
      value: chromatic[2] ?? null,
      confidence: chromatic[2] ? 0.55 : 0,
      reasoning: chromatic[2]
        ? labelFor(2)
        : chromatic.length === 2
          ? "only two chromatic samples available"
          : "only one chromatic sample available",
    },
  };
}

/**
 * Logo heuristic. Returns null when the page has no `<img>` tags at all
 * (single-page apps that render images via JS after load, or text-only
 * sites). The renderer's confidence-thresholding omits sub-0.4 fields
 * entirely; logo with confidence 0 just means "no logo for the nav."
 */
export function pickLogo(images: ExtractedImage[]): DeterministicLogo {
  const headerWithAlt = images.find((i) => i.region === "header" && i.alt);
  if (headerWithAlt) {
    return {
      src: headerWithAlt.src,
      confidence: 0.95,
      // Sanitize alt before interpolation: this string flows into the
      // renderer's user prompt (render-prompts.ts) and a malicious alt
      // attribute could otherwise smuggle instructions into a paid LLM
      // call. Limit to printable ASCII, truncate to 80 chars.
      reasoning: `image in <header> with alt="${sanitizeForPrompt(headerWithAlt.alt!)}" — strongest logo signal`,
    };
  }

  const anyHeader = images.find((i) => i.region === "header");
  if (anyHeader) {
    return {
      src: anyHeader.src,
      confidence: 0.7,
      reasoning: "image in <header> region (no alt text)",
    };
  }

  const anyNav = images.find((i) => i.region === "nav");
  if (anyNav) {
    return {
      src: anyNav.src,
      confidence: 0.55,
      reasoning: "image in <nav> region — header had none",
    };
  }

  if (images.length > 0) {
    return {
      src: images[0]!.src,
      confidence: 0.3,
      reasoning: "no header/nav image found; first <img> on page as a guess",
    };
  }

  return {
    src: null,
    confidence: 0,
    reasoning: "no <img> tags found on page",
  };
}

/**
 * Saturation gate. A hex is "chromatic" if its max-channel-min-channel
 * spread is large enough to read as a color rather than a neutral
 * (white/black/grey). Threshold 20/255 ≈ 8% — empirically catches the
 * usual WP-theme-reset greys (#fff, #000, #333, #666, #ccc) while
 * keeping brand-color near-greys (e.g. #4d4d80 — a desaturated purple).
 */
function isChromatic(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min >= CHROMATIC_THRESHOLD;
}

