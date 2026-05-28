import "server-only";
import type { BlockNode } from "./ability-client";

/**
 * Cross-module type definitions for Phase A discovery. Kept separate from
 * ability-client.ts (which speaks MCP) and playwright-discovery.ts (which
 * speaks Chromium) because both modules + the inventory reducer + the
 * Inngest worker all need to import these.
 *
 * Conventions:
 *   - Viewport widths are FIXED to the three the design doc §6.1 calls out:
 *     375 (mobile), 768 (tablet), 1280 (desktop). The Phase B / E pipelines
 *     consume the same triple — do not parameterize without changing them.
 *   - `slug` is the URL-routable slug, NOT the post id. `post_type` carries
 *     the WP post type for downstream dispatch (page, post, beer, etc.).
 *   - `BoundingRect` numbers are CSS pixels (post-DPR-divided), matching
 *     what `Element.getBoundingClientRect()` reports.
 */

export type ViewportWidth = 375 | 768 | 1280;

export const VIEWPORT_WIDTHS: readonly ViewportWidth[] = [375, 768, 1280] as const;

/**
 * The input contract to playwright-discovery: one entry per page to capture.
 */
export interface PageDescriptor {
  slug: string;
  post_type: string;
  /** Absolute URL on the WP origin — playwright navigates to this. */
  url: string;
  /**
   * Optional flattened top-level block list. When present, used by the
   * bounding-rect mapper to zip DOM-order matches against block-tree order
   * when class-based mapping misses. When absent, only class-based mapping
   * is attempted.
   */
  topLevelBlockNames?: (string | null)[];
}

/**
 * Subset of CSSStyleDeclaration we extract per block instance.
 * Aligned with design doc §6.1's enumerated list — about 30 properties.
 */
export interface ComputedStyles {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  textAlign?: string;
  textTransform?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  borderTopWidth?: string;
  borderRightWidth?: string;
  borderBottomWidth?: string;
  borderLeftWidth?: string;
  borderColor?: string;
  borderRadius?: string;
  display?: string;
  flexDirection?: string;
  gap?: string;
  gridTemplateColumns?: string;
  alignItems?: string;
  justifyContent?: string;
  boxShadow?: string;
  opacity?: string;
}

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Per-block-instance capture from Playwright. One entry per instance, not
 * per type — the inventory reducer aggregates per type later.
 *
 * `blockName` is `string | null` because classic-editor content emits null
 * blocks (top-level untyped HTML).
 */
export interface BlockInstanceCapture {
  blockName: string | null;
  computedStyles: ComputedStyles;
  boundingRect: BoundingRect;
}

/**
 * One sample of a Gutenberg-class-named block as it renders in the source DOM.
 * Captured by the 1280-viewport pass; used by aggregate-dom-samples to pair
 * block_inventory rows with their rendered HTML.
 *
 * `blockName` is the reverse-mapped name from `wp-block-{name}` →
 * `core/{name}` (or `acf/{name}`, etc. for namespaced blocks). Matches the
 * shape inventory.ts uses.
 */
export interface WpBlockDomSample {
  blockName: string;
  outerHTML: string;
}

/**
 * Direct child of the theme's main content container (`<main>`, `[role=main]`,
 * `<article>`, or first fallback). One entry per top-level section in
 * document order — used for positional correlation of `acf_flex` layouts
 * to their rendered HTML (Nth ACF flex entry → Nth main section).
 */
export interface MainSectionSample {
  index: number;
  outerHTML: string;
  classNames: string[];
}

/**
 * Per-page DOM snapshot. Captured ONCE per page on the 1280-viewport pass
 * (DOM doesn't change responsively — only the CSS rules that target it do).
 *
 * Both fields use `outerHTML` of the matched element. Capped at 50 KB per
 * element by the aggregator before persistence.
 */
export interface PageDomSnapshot {
  /**
   * Every element matching `[class*="wp-block-"]` with its parsed block name
   * and outerHTML. Empty for custom-themed sites that don't emit `wp-block-*`
   * classes (Two Roads being the canonical example).
   */
  wpBlockSamples: WpBlockDomSample[];
  /**
   * Ordered direct children of the page's main content container. Used by
   * the aggregator's positional heuristic for acf_flex layouts.
   */
  mainSections: MainSectionSample[];
  /**
   * Whole-page wrapper outerHTML — first `<article>` if present, else
   * the main content container itself. Used as the DOM sample for
   * `cpt_template/{cpt}` entries.
   */
  articleOuterHtml: string | null;
}

/**
 * Per-page output of playwright-discovery. One entry per page across all
 * three viewports — the per-viewport screenshot paths land in
 * `screenshotPaths`, keyed by viewport width as a stringified number.
 */
export interface PageDiscoveryResult {
  slug: string;
  post_type: string;
  screenshotPaths: Record<string, string>; // "375" | "768" | "1280" → storage path
  /**
   * Captures keyed by viewport. Each viewport's array is one entry per
   * block instance VISIBLE at that viewport (so a desktop-only block has
   * no entry in the 375 array).
   */
  blockCapturesByViewport: Record<string, BlockInstanceCapture[]>;
  /**
   * DOM snapshot for this page, captured on the 1280 viewport. Optional
   * because the 1280 capture can fail independently of the other viewports;
   * pages without `domSnapshot` simply contribute nothing to DOM-sample
   * aggregation.
   */
  domSnapshot?: PageDomSnapshot;
  /**
   * Pages that failed to capture at any viewport land with a non-empty
   * `failures` field; the worker treats this as fail-soft (page still
   * inventoried block-wise, just no screenshots/computed-CSS available).
   */
  failures?: Array<{ viewport: ViewportWidth; reason: string }>;
}
