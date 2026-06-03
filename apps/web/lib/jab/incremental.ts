import type { PostListRow } from "./ability-client";

export interface PriorPage {
  slug: string;
  postType: string;
  modifiedGmt: string | null;
}
export interface ChangedSet {
  changedSlugs: Set<string>;
  isFullSync: boolean;
}

/** Latest modified_gmt across rows (ISO strings sort lexicographically). */
export function maxModifiedGmt(rows: Array<{ modified_gmt?: string }>): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const m = r.modified_gmt;
    if (typeof m === "string" && m !== "" && (max === null || m > max)) max = m;
  }
  return max;
}

export function resolveSyncWindow(priorWatermark: string | null): { modifiedAfter?: string } {
  return priorWatermark ? { modifiedAfter: priorWatermark } : {};
}

/**
 * Decide which slugs changed since the prior build. With no window (first
 * build or no prior watermark) → full sync (every page). With a window →
 * pages whose modified_gmt is at/after the window, plus any slug not present
 * in the prior build (brand-new content). Deletions are handled by the caller
 * diffing prior vs current slug sets; this returns what to (re)capture.
 */
export function selectChangedPages(
  prior: PriorPage[],
  current: PostListRow[],
  window: { modifiedAfter?: string },
): ChangedSet {
  if (!window.modifiedAfter) {
    return { changedSlugs: new Set(current.map((r) => r.slug)), isFullSync: true };
  }
  const priorSlugs = new Set(prior.map((p) => p.slug));
  const changed = new Set<string>();
  for (const r of current) {
    const isNew = !priorSlugs.has(r.slug);
    const isTouched = typeof r.modified_gmt === "string" && r.modified_gmt >= window.modifiedAfter;
    if (isNew || isTouched) changed.add(r.slug);
  }
  return { changedSlugs: changed, isFullSync: false };
}
