import "server-only";
import type { BlockNode } from "./ability-client";
import type { PriorPage } from "./incremental";

/**
 * carry-forward.ts — pure incremental carry-forward engine.
 *
 * All functions here are deterministic and DB-free. The discover-site worker
 * loads prior-build artifacts, calls these to decide what to re-fetch and what
 * to carry, then re-aggregates block_inventory from the UNION of fresh +
 * carried trees so the result is identical to a full build. Keyed by
 * (post_type, slug) — two CPTs can share a slug, so a slug-only key would
 * cross-wire carries.
 */

export interface CurrentPageRef {
  slug: string;
  postType: string;
  modifiedGmt: string | null;
}

/** Collision-safe key. WP sanitizes slugs + post types to never contain a
 *  space, so the space separator can't be forged across the two segments. */
export function pageKey(postType: string, slug: string): string {
  return `${postType} ${slug}`;
}

/**
 * Split current pages into those that must be re-fetched (new or touched since
 * the window) and those that are unchanged (carry-forward candidates). With no
 * window (first build / no prior watermark) everything is changed.
 */
export function partitionPages(
  current: CurrentPageRef[],
  prior: PriorPage[],
  window: { modifiedAfter?: string },
): { changed: CurrentPageRef[]; unchanged: CurrentPageRef[] } {
  if (!window.modifiedAfter) {
    return { changed: [...current], unchanged: [] };
  }
  const after = window.modifiedAfter;
  const priorKeys = new Set(prior.map((p) => pageKey(p.postType, p.slug)));
  const changed: CurrentPageRef[] = [];
  const unchanged: CurrentPageRef[] = [];
  for (const c of current) {
    const isNew = !priorKeys.has(pageKey(c.postType, c.slug));
    const isTouched = typeof c.modifiedGmt === "string" && c.modifiedGmt >= after;
    // A null modifiedGmt cannot be proven unchanged → treat as changed.
    const unknown = typeof c.modifiedGmt !== "string";
    if (isNew || isTouched || unknown) changed.push(c);
    else unchanged.push(c);
  }
  return { changed, unchanged };
}

/**
 * An unchanged page can only be carried if its tree was persisted by a prior
 * build. Pages whose prior build predates migration 0027 have no tree and must
 * be re-fetched.
 */
export function splitByTreeAvailability(
  unchanged: CurrentPageRef[],
  priorTreesByKey: Map<string, BlockNode[]>,
): { carriable: CurrentPageRef[]; mustRefetch: CurrentPageRef[] } {
  const carriable: CurrentPageRef[] = [];
  const mustRefetch: CurrentPageRef[] = [];
  for (const c of unchanged) {
    if (priorTreesByKey.has(pageKey(c.postType, c.slug))) carriable.push(c);
    else mustRefetch.push(c);
  }
  return { carriable, mustRefetch };
}
