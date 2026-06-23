import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * fidelity-score — Phase 4 of the 2026-06-02 SaaS-app completion plan.
 *
 * Two functions:
 *   1. pixelDiffScore — synchronous PNG-to-PNG diff returning a ratio in
 *      [0, 1] (0 = perfect match, 1 = every pixel differs). Score is
 *      `1 - diffRatio` and gets persisted alongside `pixel_diff` so the
 *      review screen can show both.
 *   2. flagForVision — pure predicate that decides whether a page needs
 *      a downstream vision-LLM scoring pass. Default threshold 0.10 means
 *      anything beyond 10% pixel divergence is flagged.
 *
 * v1 scope (internal pilot): the vision-LLM scoring pass is a stub. The
 * worker calls `visionScore` only for flagged pages and currently echoes
 * the pixel-derived score with an empty issues list. Wiring a real LLM
 * call (image-input prompt against Anthropic) is a tracked follow-up;
 * the worker contract + the persisted fidelity_reports shape don't
 * change when that lands.
 *
 * Why no async / Sharp / canvas: pngjs + pixelmatch is pure JS, ships
 * cleanly inside the Inngest serverless runtime, and the Two Roads pilot
 * captures 1280×N PNGs that all decode under 200ms each. If that profile
 * shifts, swap pngjs for sharp.
 */

export interface PixelDiffInput {
  sourceBuffer: Buffer;
  generatedBuffer: Buffer;
  /**
   * pixelmatch sensitivity (0=strict, 1=loose). 0.1 is the default the
   * library recommends; we keep it explicit so reviewers can tune it.
   */
  threshold?: number;
}

export interface PixelDiffResult {
  /** Ratio of differing pixels in [0, 1], measured on the overlapping region. */
  diffRatio: number;
  /** 1 - diffRatio, clamped to [0, 1]. */
  score: number;
  /** Pixels-differing / total-pixels metadata for telemetry. */
  diffPixels: number;
  totalPixels: number;
  /**
   * True when source/generated dimensions differ. The diff is still MEASURED
   * (on the top-left overlapping region); sizeMismatch is a flag-reason for
   * the row, never a synthetic score.
   */
  sizeMismatch: boolean;
  /** abs(source.height − generated.height) in px; 0 when heights match. */
  heightDeltaPx: number;
}

/** Crop a decoded PNG to the top-left `width × height` region (no-op when already that size). */
function cropToRegion(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
  return out;
}

/**
 * Compare two PNG buffers pixel-by-pixel. When dimensions differ (the COMMON
 * case for fullPage captures — heights are content-dependent), both PNGs are
 * cropped to the overlapping top-left region (min width × min height) and the
 * diff is measured there. Pre-2026-06-10 this branch returned a synthetic
 * diffRatio of 0.5, which auto-flagged nearly every page for the vision pass
 * and saturated VISION_PER_BUILD_CAP with zero-signal pairs.
 */
export function pixelDiffScore(input: PixelDiffInput): PixelDiffResult {
  const source = PNG.sync.read(input.sourceBuffer);
  const generated = PNG.sync.read(input.generatedBuffer);

  const sizeMismatch =
    source.width !== generated.width || source.height !== generated.height;
  const heightDeltaPx = Math.abs(source.height - generated.height);
  const width = Math.min(source.width, generated.width);
  const height = Math.min(source.height, generated.height);
  const totalPixels = width * height;

  if (totalPixels === 0) {
    // Degenerate capture (zero-dimension PNG) — nothing measurable.
    // Defensive-only: valid PNGs are >=1x1 and PNG.sync.read throws on
    // malformed buffers above, so this can't be reached via the buffer API.
    return { diffRatio: 1, score: 0, diffPixels: 0, totalPixels: 0, sizeMismatch, heightDeltaPx };
  }

  const croppedSource = cropToRegion(source, width, height);
  const croppedGenerated = cropToRegion(generated, width, height);
  const diffPixels = pixelmatch(
    croppedSource.data,
    croppedGenerated.data,
    null,
    width,
    height,
    { threshold: input.threshold ?? 0.1 },
  );
  const diffRatio = diffPixels / totalPixels;
  return {
    diffRatio,
    score: clamp01(1 - diffRatio),
    diffPixels,
    totalPixels,
    sizeMismatch,
    heightDeltaPx,
  };
}

/**
 * Threshold for "do we need vision review of this page".
 * Default 0.10: a page where 10% or more pixels differ gets the
 * (currently stubbed) LLM scoring pass.
 */
export const DEFAULT_VISION_FLAG_THRESHOLD = 0.1;

export function flagForVision(
  diffRatio: number,
  threshold: number = DEFAULT_VISION_FLAG_THRESHOLD,
): boolean {
  return diffRatio > threshold;
}

/**
 * Cap on vision-LLM calls per build. Phase 4 plan: never more than 15
 * pages get the LLM scoring pass even if 100 are flagged — the rest get
 * the pixel-derived score only.
 */
export const VISION_PER_BUILD_CAP = 15;

/**
 * Viewports the verify pass pixel-diffs. Capture still grabs all three
 * (375/768/1280); scoring covers desktop (canonical, FIRST) + mobile only.
 * 768 (tablet) is captured-but-unscored — it rarely diverges from desktop in
 * ways 1280 doesn't already catch, and skipping it halves the diff/download
 * work.
 */
export const SCORED_VIEWPORTS = ["1280", "375"] as const;

/**
 * Catastrophic-mobile thresholds. A mobile page is "catastrophically worse"
 * — almost always overflow / off-canvas / collapsed layout — only when BOTH
 * hold: its pixel divergence clears an absolute FLOOR (so a uniformly-mediocre
 * page doesn't trip it) AND it is at least RATIO times worse than desktop (so
 * a page that's merely globally-off, already owned by desktop scoring, doesn't
 * double-fire). Deliberately conservative: false positives erode trust in the
 * gate, and legitimate mobile reflow can move 30-50% of pixels on a full-page
 * diff without anything being broken.
 */
export const CATASTROPHIC_MOBILE_DIFF_FLOOR = 0.6;
export const CATASTROPHIC_MOBILE_RATIO = 2;

/**
 * Candidate row for vision-budget allocation: page identity + the measured
 * pixel divergence from phase A of the verify worker.
 */
export interface VisionCandidate {
  pageInventoryId: string;
  diffRatio: number;
}

/**
 * Pick which pages get the (capped) vision pass: every flagged page, sorted
 * by measured divergence DESCENDING, truncated to the cap. Replaces the old
 * first-come-first-served decrement so the budget always lands on the worst
 * pages regardless of page_inventory query order.
 */
export function selectVisionPages(
  candidates: VisionCandidate[],
  cap: number = VISION_PER_BUILD_CAP,
  threshold: number = DEFAULT_VISION_FLAG_THRESHOLD,
): string[] {
  return candidates
    .filter((c) => flagForVision(c.diffRatio, threshold))
    .sort((a, b) => b.diffRatio - a.diffRatio)
    .slice(0, cap)
    .map((c) => c.pageInventoryId);
}

/**
 * Row-level reason for a dimension mismatch. Recorded in the persisted
 * `issues` list — never as a score (the score is the measured overlap diff).
 */
export function sizeMismatchIssue(
  heightDeltaPx: number,
): VisionScoreResult["issues"][number] {
  return {
    block_name: "_page",
    severity: "low",
    description: `viewport_size_mismatch: generated full-page height differs from source by ${heightDeltaPx}px; pixel diff was measured on the overlapping region.`,
  };
}

/**
 * Fail-soft marker appended when the vision pass could not run for a page
 * (download failure, future API error). The page keeps its pixel-derived
 * score; vision is advisory and must never fail a build.
 */
export function visionUnavailableIssue(
  reason: string,
): VisionScoreResult["issues"][number] {
  return {
    block_name: "_page",
    severity: "low",
    description: `vision_unavailable: ${reason} — score is pixel-derived.`,
  };
}

/**
 * Medium-severity marker for a page whose SOURCE (original WordPress) screenshot
 * could not be captured at discovery — almost always a bot/WAF challenge on the
 * source site. Without the source PNG there is nothing to pixel-diff against, so
 * the page is recorded skipped (score=null) and excluded from fidelity_avg.
 * Previously that skip was SILENT (empty issues list); this issue makes the
 * review row say "we could not verify this page" so a reviewer approves it
 * knowingly rather than blind. NOT high severity — the clone may be fine; we
 * simply could not measure it, so it must not read as a clone defect or block.
 */
export function sourceUnverifiedIssue(
  routePath: string,
): VisionScoreResult["issues"][number] {
  return {
    block_name: "_page",
    severity: "medium",
    description: `source_unverified: the original WordPress page at ${routePath} could not be screenshotted at discovery (likely a bot/WAF challenge on the source site), so this clone page's fidelity could not be measured. Review it manually before approving.`,
  };
}

export interface VisionScoreInput {
  /** Pixel-derived score for the page. The v1 stub echoes this as the LLM score. */
  pixelDiffScore: number;
  /** Source (WP) full-page PNG at 1280w — provided so the Phase 7.1 real call is a stub-body swap. */
  sourceBuffer?: Buffer;
  /** Generated (clone) full-page PNG at 1280w. */
  generatedBuffer?: Buffer;
  /** Clone route path (e.g. "/about") for prompt grounding. */
  routePath?: string;
  /** Block names present on the page, for grounded issue attribution (issues key on block_name). */
  blockNames?: string[];
}

export interface VisionScoreResult {
  score: number;
  issues: Array<{
    block_name: string;
    severity: "low" | "medium" | "high";
    description: string;
  }>;
}

/**
 * Placeholder LLM scoring pass. v1 returns the pixel-derived score with an
 * empty issues list — no API call is made. Wiring a real Anthropic vision
 * call is the tracked Phase 7.1 follow-up.
 *
 * Stability contract: the RESULT shape (VisionScoreResult) and the
 * worker/persistence contract are the stable surface. VisionScoreInput is
 * the EXTENSION POINT — it already carries the buffers/route the real call
 * needs and may grow further (e.g. storage paths if scoring moves to a
 * Batch step).
 */
export async function visionScore(
  input: VisionScoreInput,
): Promise<VisionScoreResult> {
  return {
    score: clamp01(input.pixelDiffScore),
    issues: [],
  };
}

/**
 * Zero-score row for a page whose deployed URL answered 4xx/5xx. A 404
 * previously pixel-scored ~0.5 (dimension-mismatch fallback) and sailed
 * through to 'ready' — the most severe fidelity failure was the least
 * visible one. Score 0 + a high issue makes the review screen block it.
 *
 * `viewport` labels a NON-desktop failure (e.g. "mobile") so a page that
 * loads on desktop but 4xx/5xx on mobile reads correctly. Omitted → the
 * legacy desktop output, byte-identical.
 */
export function httpFailureRow(
  status: number | null | undefined,
  routePath: string,
  viewport?: string,
): { score: 0; issues: Array<{ block_name: string; severity: "high"; description: string }> } | null {
  if (typeof status !== "number" || status < 400) return null;
  const label = viewport ? ` (${viewport})` : "";
  return {
    score: 0,
    issues: [
      {
        block_name: "_page",
        severity: "high",
        description: `HTTP ${status} loading ${routePath}${label} — the deployed page failed to load. Routing or data fetch is broken for this page.`,
      },
    ],
  };
}

/**
 * High-severity issue for a dead internal link found by crawling the deployed
 * clone: a page renders fine but one of its `<a href>`s points at a route that
 * 404s/5xxs on the clone (a stale nav link, or a POST_TYPE_MAP long-tail entry
 * that isn't in page_inventory and was therefore never scored). Same posture as
 * httpFailureRow: the caller pairs this with a canonical score of 0 so the
 * REFERENCING page lands on the review screen and can't be silently approved.
 */
export function brokenLinkIssue(
  brokenPath: string,
  status: number | null,
  referencingRoute: string,
  siteWide = false,
): VisionScoreResult["issues"][number] {
  const statusPhrase = typeof status === "number" ? `HTTP ${status}` : "no response";
  const scope = siteWide
    ? " This link appears site-wide (nav/footer), so it is reported once here rather than on every page."
    : "";
  return {
    block_name: "_page",
    severity: "high",
    description: `broken_internal_link: ${referencingRoute} links to ${brokenPath}, which failed to load on the deployed clone (${statusPhrase}). Fix the link target or remove the link.${scope}`,
  };
}

/**
 * High-severity issue when the MOBILE render is catastrophically worse than
 * desktop (see CATASTROPHIC_MOBILE_DIFF_FLOOR / _RATIO). Returns null when
 * mobile is comparable, merely mediocre, or only as-bad-as an already-bad
 * desktop. Same posture as httpFailureRow: the caller pairs a non-null return
 * with a canonical score of 0 so the review screen surfaces the breakage.
 */
export function mobileDivergenceIssue(
  desktopDiffRatio: number,
  mobileDiffRatio: number,
  routePath: string,
): VisionScoreResult["issues"][number] | null {
  const aboveFloor = mobileDiffRatio >= CATASTROPHIC_MOBILE_DIFF_FLOOR;
  // Multiplicative form avoids divide-by-zero when desktop is a perfect 0.
  const relativelyWorse = mobileDiffRatio >= desktopDiffRatio * CATASTROPHIC_MOBILE_RATIO;
  if (!aboveFloor || !relativelyWorse) return null;
  return {
    block_name: "_page",
    severity: "high",
    description: `mobile_layout_broken: the deployed page at ${routePath} diverges far more on mobile (375px, ${Math.round(
      mobileDiffRatio * 100,
    )}% pixel diff) than on desktop (${Math.round(
      desktopDiffRatio * 100,
    )}%) — almost always overflow, off-canvas content, or a collapsed responsive layout. Check the page on a phone before approving.`,
  };
}

/**
 * One viewport's persisted fidelity entry. Lives under
 * fidelity_reports.viewport_scores keyed by viewport width string.
 */
export interface ViewportScoreEntry {
  score: number | null;
  pixel_diff: number | null;
  http_status: number | null;
  size_mismatch: boolean;
  height_delta_px: number;
  skipped: boolean;
  /**
   * True when THIS viewport is the reason the page is gate-blocked — an HTTP
   * 4xx/5xx on it, or (for mobile) a catastrophic divergence from desktop.
   * It is the single source of truth the review UI badges against, because a
   * divergence-blocked viewport keeps its REAL measured score (the canonical
   * page score is what drops to 0), so score-based re-derivation would miss it.
   */
  blocking: boolean;
}

/** Map a measured pixel-diff to a persisted viewport entry. */
export function viewportScoreEntry(
  diff: PixelDiffResult,
  httpStatus: number | null,
  blocking = false,
): ViewportScoreEntry {
  return {
    score: diff.score,
    pixel_diff: diff.diffRatio,
    http_status: httpStatus,
    size_mismatch: diff.sizeMismatch,
    height_delta_px: diff.heightDeltaPx,
    skipped: false,
    blocking,
  };
}

/** Entry for a viewport whose source/generated capture was missing or failed. */
export function skippedViewportEntry(httpStatus: number | null, blocking = false): ViewportScoreEntry {
  return {
    score: null,
    pixel_diff: null,
    http_status: httpStatus,
    size_mismatch: false,
    height_delta_px: 0,
    skipped: true,
    blocking,
  };
}

/** Assemble the persisted viewport_scores object, dropping undefined viewports. */
export function buildViewportScores(
  entries: Partial<Record<string, ViewportScoreEntry>>,
): Record<string, ViewportScoreEntry> {
  const out: Record<string, ViewportScoreEntry> = {};
  for (const [vp, entry] of Object.entries(entries)) {
    if (entry) out[vp] = entry;
  }
  return out;
}

/**
 * The canonical (persisted `score` column) value. Stays the desktop score
 * UNLESS a catastrophic mobile failure exists — then it drops to 0 so the
 * page reads as broken on the review screen, identical posture to the desktop
 * httpFailureRow. The true per-viewport numbers are preserved in viewport_scores.
 */
export function resolveCanonicalScore(desktopScore: number, mobileBlocking: boolean): number {
  return mobileBlocking ? 0 : desktopScore;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
