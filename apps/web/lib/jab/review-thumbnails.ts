/**
 * review-thumbnails — pure helpers for the build-review screen's
 * source-vs-generated thumbnail grid. No I/O: the server component builds the
 * request list here, batch-signs it via Supabase Storage, then renders.
 */

/** Viewports rendered as thumbnails on the review row: desktop then mobile. */
export const THUMBNAIL_VIEWPORTS = ["1280", "375"] as const;

export type ThumbKind = "source" | "generated";

export interface ThumbRequest {
  /** "<pageInventoryId>:<viewport>:<kind>" */
  key: string;
  /** Bucket-relative storage path to sign. */
  path: string;
}

interface PageLike {
  id: string;
  source_screenshot_paths: { source?: Record<string, string> } | null;
}
interface FidelityLike {
  generated_screenshot_paths: { source?: Record<string, string> } | null;
}

/** De-duplicated list of bucket paths to batch-sign, one per existing thumbnail. */
export function buildThumbnailRequests(
  pages: PageLike[],
  fidelityByPageId: Map<string, FidelityLike>,
): ThumbRequest[] {
  const out: ThumbRequest[] = [];
  for (const page of pages) {
    const sourceMap = page.source_screenshot_paths?.source ?? {};
    const generatedMap = fidelityByPageId.get(page.id)?.generated_screenshot_paths?.source ?? {};
    for (const vp of THUMBNAIL_VIEWPORTS) {
      const sourcePath = sourceMap[vp];
      if (sourcePath) out.push({ key: `${page.id}:${vp}:source`, path: sourcePath });
      const generatedPath = generatedMap[vp];
      if (generatedPath) out.push({ key: `${page.id}:${vp}:generated`, path: generatedPath });
    }
  }
  return out;
}

/**
 * Read one viewport's entry from the persisted viewport_scores JSONB.
 * `blocking` is the UI badge signal. The worker stamps `entry.blocking` as the
 * single source of truth (it fires for a catastrophic mobile divergence even
 * though that entry keeps its real, non-zero measured score). The score===0 /
 * http>=400 derivations are kept as back-compat fallbacks for rows written
 * before the flag existed.
 */
export function pickViewportScore(
  viewportScores: unknown,
  viewport: string,
): { score: number | null; blocking: boolean } | null {
  if (!viewportScores || typeof viewportScores !== "object") return null;
  const entry = (viewportScores as Record<string, unknown>)[viewport];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { score?: unknown; http_status?: unknown; skipped?: unknown; blocking?: unknown };
  const score = typeof e.score === "number" ? e.score : null;
  const httpStatus = typeof e.http_status === "number" ? e.http_status : null;
  const skipped = e.skipped === true;
  const blocking =
    e.blocking === true || (!skipped && score === 0) || (httpStatus !== null && httpStatus >= 400);
  return { score, blocking };
}
