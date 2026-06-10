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
  /** Ratio of differing pixels in [0, 1]. */
  diffRatio: number;
  /** 1 - diffRatio, clamped to [0, 1]. */
  score: number;
  /** Pixels-differing / total-pixels metadata for telemetry. */
  diffPixels: number;
  totalPixels: number;
  /** Whether resize/skip was needed because source/generated differed. */
  sizeMismatch: boolean;
}

/**
 * Compare two PNG buffers pixel-by-pixel. When the two PNGs have
 * different dimensions, we cannot run pixelmatch (it requires identical
 * width/height). In that case we return `sizeMismatch=true` with a
 * conservative score of 0.5 — better than NaN, worse than a clean diff
 * so the review surface notices.
 */
export function pixelDiffScore(input: PixelDiffInput): PixelDiffResult {
  const source = PNG.sync.read(input.sourceBuffer);
  const generated = PNG.sync.read(input.generatedBuffer);

  if (source.width !== generated.width || source.height !== generated.height) {
    return {
      diffRatio: 0.5,
      score: 0.5,
      diffPixels: 0,
      totalPixels: 0,
      sizeMismatch: true,
    };
  }

  const { width, height } = source;
  const diffPixels = pixelmatch(
    source.data,
    generated.data,
    null,
    width,
    height,
    { threshold: input.threshold ?? 0.1 },
  );
  const totalPixels = width * height;
  const diffRatio = totalPixels === 0 ? 1 : diffPixels / totalPixels;
  const clampedScore = clamp01(1 - diffRatio);
  return {
    diffRatio,
    score: clampedScore,
    diffPixels,
    totalPixels,
    sizeMismatch: false,
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

export interface VisionScoreInput {
  /** Pixel-derived score for the page. v1 echoes this as the LLM score. */
  pixelDiffScore: number;
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
 * Placeholder LLM scoring pass. v1 returns the pixel-derived score with
 * an empty issues list. Wiring a real Anthropic vision call is a tracked
 * follow-up — keep the function signature stable.
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
 */
export function httpFailureRow(
  status: number | null | undefined,
  routePath: string,
): { score: 0; issues: Array<{ block_name: string; severity: "high"; description: string }> } | null {
  if (typeof status !== "number" || status < 400) return null;
  return {
    score: 0,
    issues: [
      {
        block_name: "_page",
        severity: "high",
        description: `HTTP ${status} loading ${routePath} — the deployed page failed to load. Routing or data fetch is broken for this page.`,
      },
    ],
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
