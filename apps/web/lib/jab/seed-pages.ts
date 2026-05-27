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

/**
 * Hoist the WP front-page slug to position 0 of its CPT, and hoist that CPT
 * to position 0 of the seed list. Pure — returns new arrays without mutating
 * inputs.
 *
 * Three cases:
 * 1. frontPageSlug is null OR not found anywhere → return seedCptLists unchanged
 * 2. frontPageSlug found in seedCptLists → reorder (row to position 0 of its
 *    CPT, CPT to position 0 of the list)
 * 3. frontPageSlug found in perCptLists but NOT in seedCptLists (was sampled
 *    out by selectSeedPages) → inject the row at position 0 of its CPT's seed
 *    list (replacing any existing rows for that slug), hoist the CPT to
 *    position 0
 *
 * The point of this: smoke caps + sampling can drop the homepage from the
 * collection pipeline. With this hoist, the homepage is always captured
 * first, regardless of smoke cap or sample-per-cpt setting.
 */
export function hoistFrontPage(
  seedCptLists: CptListPair[],
  perCptLists: CptListPair[],
  frontPageSlug: string | null,
): CptListPair[] {
  if (!frontPageSlug) return seedCptLists;

  // Case 2: found in seeds.
  for (let i = 0; i < seedCptLists.length; i++) {
    const rowIdx = seedCptLists[i].rows.findIndex((r) => r.slug === frontPageSlug);
    if (rowIdx < 0) continue;
    const cptPair = seedCptLists[i];
    const targetRow = cptPair.rows[rowIdx];
    const reorderedRows = [
      targetRow,
      ...cptPair.rows.filter((_, j) => j !== rowIdx),
    ];
    const reorderedPair: CptListPair = { ...cptPair, rows: reorderedRows };
    // Hoist this CPT to position 0.
    return [reorderedPair, ...seedCptLists.slice(0, i), ...seedCptLists.slice(i + 1)];
  }

  // Case 3: found in perCptLists but not in seeds.
  for (const perCpt of perCptLists) {
    const matchRow = perCpt.rows.find((r) => r.slug === frontPageSlug);
    if (!matchRow) continue;

    // Find this CPT's seed entry (every CPT should be in seedCptLists with at
    // least its first row — selectSeedPages preserves the CPT list itself, just
    // truncates rows).
    const seedIdx = seedCptLists.findIndex((s) => s.cpt.slug === perCpt.cpt.slug);
    if (seedIdx >= 0) {
      const seed = seedCptLists[seedIdx];
      // Prepend the matched row, dedupe in case of slug overlap.
      const reorderedRows = [
        matchRow,
        ...seed.rows.filter((r) => r.slug !== frontPageSlug),
      ];
      const reorderedPair: CptListPair = { ...seed, rows: reorderedRows };
      return [
        reorderedPair,
        ...seedCptLists.slice(0, seedIdx),
        ...seedCptLists.slice(seedIdx + 1),
      ];
    }
    // CPT not in seeds at all (highly unusual — selectSeedPages preserves CPTs).
    // Inject as a new entry at position 0.
    return [{ cpt: perCpt.cpt, meta: perCpt.meta, rows: [matchRow] }, ...seedCptLists];
  }

  // Case 1 (not found anywhere): return unchanged.
  return seedCptLists;
}
