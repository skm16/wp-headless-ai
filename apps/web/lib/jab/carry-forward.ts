import "server-only";
import type { BlockNode } from "./ability-client";
import type { PriorPage } from "./incremental";
import type { PageBlocksInput } from "./inventory";
import type { PersistPagesPage } from "./persist-discovery";
import type { Paradigm } from "./paradigm-detection";
import type { PageDiscoveryResult } from "./discovery-types";

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

/** Rebuild buildInventory() input for carriable pages from their stored trees. */
export function carriedInventoryInput(
  carriable: CurrentPageRef[],
  priorTreesByKey: Map<string, BlockNode[]>,
): PageBlocksInput[] {
  const out: PageBlocksInput[] = [];
  for (const c of carriable) {
    const tree = priorTreesByKey.get(pageKey(c.postType, c.slug));
    if (tree) out.push({ slug: c.slug, post_type: c.postType, blocks: tree });
  }
  return out;
}

/** All block names appearing in the given trees (null → "__null__"), recursive. */
export function blockNamesInTrees(pages: PageBlocksInput[]): Set<string> {
  const names = new Set<string>();
  const walk = (blocks: BlockNode[]): void => {
    for (const b of blocks) {
      names.add(b.blockName ?? "__null__");
      if (b.innerBlocks && b.innerBlocks.length > 0) walk(b.innerBlocks);
    }
  };
  for (const p of pages) walk(p.blocks);
  return names;
}

/** Prior block_inventory sample for a single block name (de-keyed). */
export interface PriorBlockSample {
  blockName: string;
  computedStyles: unknown | null;
  sourceDomSample: string | null;
}

/**
 * For block names that appear on carried (unchanged) pages, fill computed_styles
 * / source_dom_sample from the prior build when the fresh capture didn't produce
 * them. Fresh always wins.
 *
 * Fill rules (asserted by the tests):
 *   - computed: fill when the key is absent OR present-null.
 *   - dom:      fill ONLY when the key is absent. A present-null fresh dom is a
 *               deliberate "ambiguous correlation" decision and is preserved.
 */
export function fillCarriedSamples(
  freshComputedByName: Record<string, unknown>,
  freshDomByName: Map<string, string | null>,
  priorBlocks: PriorBlockSample[],
  blockNamesNeedingFill: Set<string>,
): { computed: Record<string, unknown>; dom: Map<string, string | null> } {
  const computed: Record<string, unknown> = { ...freshComputedByName };
  const dom = new Map(freshDomByName);
  const priorByName = new Map(priorBlocks.map((b) => [b.blockName, b]));
  for (const name of blockNamesNeedingFill) {
    const p = priorByName.get(name);
    if (!p) continue;
    if ((!(name in computed) || computed[name] == null) && p.computedStyles != null) {
      computed[name] = p.computedStyles;
    }
    if (!dom.has(name) && p.sourceDomSample != null) {
      dom.set(name, p.sourceDomSample);
    }
  }
  return { computed, dom };
}

/** Shape of a prior page_inventory row needed to carry it forward. */
export interface PriorPageRow {
  slug: string;
  post_type: string;
  title: string | null;
  route_path: string;
  block_count: number;
  paradigms: string[];
  source_screenshot_paths: { source?: Record<string, unknown> } | null;
  source_modified_gmt: string | null;
  block_tree: BlockNode[] | null;
}

/**
 * Map a prior page_inventory row into the PersistPagesPage the new build will
 * re-upsert. Screenshots are carried by REFERENCE (the prior build's Storage
 * paths) — see the plan's safety note on Storage coupling. blockCapturesByViewport
 * is transient (computed-styles aggregation input) and not persisted, so it is
 * empty here; carried block samples are filled from prior block_inventory instead.
 */
export function carriedPageRow(prior: PriorPageRow): PersistPagesPage {
  const screenshotPaths = (prior.source_screenshot_paths?.source ?? {}) as PageDiscoveryResult["screenshotPaths"];
  return {
    slug: prior.slug,
    post_type: prior.post_type,
    title: prior.title ?? "",
    route_path: prior.route_path,
    block_count: prior.block_count,
    paradigms: prior.paradigms as Paradigm[],
    discovery: {
      slug: prior.slug,
      post_type: prior.post_type,
      screenshotPaths,
      blockCapturesByViewport: {},
    },
    sourceModifiedGmt: prior.source_modified_gmt,
    blockTree: prior.block_tree ?? null,
  };
}
