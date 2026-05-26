import "server-only";
import type { PostListRow, PostTypeRow, CptAbilityMeta } from "@/lib/jab/ability-client";

/**
 * Picks the subset of posts the discovery worker should pull blocks for and
 * screenshot. The goal of Phase A discovery is **template + block-type
 * inventory**, not content harvesting — so a single representative post per
 * non-page CPT is enough to surface every block type that CPT's template uses.
 * `post_type=page` is the exception: each page is bespoke unique content, so
 * we keep them all.
 *
 * Rationale (recorded 2026-05-26 against the Two Roads pilot):
 *   The naive "walk every post" approach has the worker pulling blocks for
 *   500+ posts on a real site (Two Roads has 88+ beers, 100+ events). That's
 *   400+ sequential MCP calls + ~1500 Playwright captures (3 viewports each)
 *   → 30–60 min uncapped. With seed selection:
 *     - pages: ~20 (unique content)
 *     - 12 other CPTs × 1 sample = 12
 *     - total ~32 pages × 3 viewports = ~96 captures → 5–15 min
 *   This is the production default; smoke runs further truncate via the
 *   `maxPages` event-payload cap.
 *
 * Future variant detection: if we find sites where one CPT has multiple
 * templates (e.g. "regular beer" vs "limited release" using different
 * Gutenberg patterns), bump `samplesPerNonPageCpt` per-CPT or pick samples
 * by hashing top-level block signatures. Deferred until pilot evidence
 * demands it.
 */

export interface CptListPair {
  cpt: PostTypeRow;
  meta: CptAbilityMeta;
  rows: PostListRow[];
}

export interface SelectSeedPagesOptions {
  /**
   * How many representative posts to keep per non-page CPT. Defaults to 1
   * because Phase A only needs template/block-type discovery — additional
   * samples add no inventory signal unless the CPT has template variants.
   */
  samplesPerNonPageCpt?: number;

  /**
   * Post-type slugs that should keep ALL rows (no sampling). Defaults to
   * `["page"]`. Use this for any post-type that contains bespoke unique
   * pages — typically just core's `page`, but agencies sometimes register
   * a "Landing Page" or "Microsite" CPT that should also be treated this way.
   */
  keepAllSlugs?: string[];
}

/**
 * Pure reducer — no I/O, deterministic given inputs. Preserves input order
 * (both across CPTs and within each CPT's row list), takes the FIRST N rows
 * per non-page CPT. The orchestrator's earlier list call orders rows by
 * publish date DESC, so taking the first is "most recently published" —
 * typically the most fleshed-out template instance.
 */
export function selectSeedPages(
  perCptLists: CptListPair[],
  options: SelectSeedPagesOptions = {},
): CptListPair[] {
  const samplesPerNonPageCpt = Math.max(1, options.samplesPerNonPageCpt ?? 1);
  const keepAllSlugs = new Set(options.keepAllSlugs ?? ["page"]);

  return perCptLists.map(({ cpt, meta, rows }) => {
    if (keepAllSlugs.has(cpt.slug)) {
      return { cpt, meta, rows };
    }
    return { cpt, meta, rows: rows.slice(0, samplesPerNonPageCpt) };
  });
}
