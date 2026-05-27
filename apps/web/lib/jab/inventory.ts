import "server-only";
import type { BlockNode } from "./ability-client";

export type { EnrichedInventoryEntry, ContentKind, AcfFlexLayoutData, CptTemplateData, CptTemplateSpec } from "./content-detection";
export { detectContentKinds } from "./content-detection";

/**
 * inventory.ts — Phase A reducer.
 *
 * Walks every page's BlockNode[] tree (recursively into innerBlocks),
 * accumulates per-block-name occurrence counts, attribute samples (capped
 * at 5 distinct shapes), the set of pages each block appears on, and
 * assigns an initial tier per the v1 heuristics seed list below.
 *
 * The reducer is PURE — no DB / Storage / network. The Inngest worker in
 * Task 17 calls `buildInventory(pages)` and persists the result.
 *
 * Tier assignment (v1 SEED LIST — tune after first Two Roads run):
 *
 *   trivial    — core/heading, core/paragraph, core/list, core/list-item,
 *                core/separator, core/spacer, core/quote, core/preformatted,
 *                core/code, core/html
 *
 *   standard   — core/columns, core/column, core/group, core/cover,
 *                core/buttons, core/button, core/image, core/embed,
 *                core/social-links, core/social-link
 *
 *   visual     — core/gallery, core/media-text, core/post-template,
 *                core/query, core/post-featured-image, anything matching
 *                `acf/*`
 *
 *   passthrough — anything else, OR occurrence_count <= 2 (overrides above),
 *                 OR blockName === null (classic-editor content).
 *
 * Tunability: the maps below are exported so future code (e.g. a Phase F
 * UI override) can read them without re-deriving.
 */

export const TIER_TRIVIAL = new Set([
  "core/heading",
  "core/paragraph",
  "core/list",
  "core/list-item",
  "core/separator",
  "core/spacer",
  "core/quote",
  "core/preformatted",
  "core/code",
  "core/html",
]);

export const TIER_STANDARD = new Set([
  "core/columns",
  "core/column",
  "core/group",
  "core/cover",
  "core/buttons",
  "core/button",
  "core/image",
  "core/embed",
  "core/social-links",
  "core/social-link",
]);

export const TIER_VISUAL = new Set([
  "core/gallery",
  "core/media-text",
  "core/post-template",
  "core/query",
  "core/post-featured-image",
]);

export type Tier = "trivial" | "standard" | "visual" | "passthrough";

export interface InventoryEntry {
  blockName: string | null;
  occurrenceCount: number;
  pageSlugs: string[];
  attrSamples: Array<Record<string, unknown>>;
  tier: Tier;
}

export interface PageBlocksInput {
  slug: string;
  post_type: string;
  blocks: BlockNode[];
}

const MAX_ATTR_SAMPLES_PER_BLOCK = 5;
export const MAX_PAGE_SLUGS_PER_BLOCK = 50;

/**
 * Build the full inventory from a list of pages' block trees.
 */
export function buildInventory(pages: PageBlocksInput[]): InventoryEntry[] {
  const accum = new Map<
    string,
    {
      blockName: string | null;
      occurrenceCount: number;
      pageSlugs: Set<string>;
      attrShapes: Map<string, Record<string, unknown>>;
    }
  >();

  for (const page of pages) {
    walkBlocks(page.blocks, page.slug, accum);
  }

  const out: InventoryEntry[] = [];
  for (const [, entry] of accum) {
    out.push({
      blockName: entry.blockName,
      occurrenceCount: entry.occurrenceCount,
      pageSlugs: Array.from(entry.pageSlugs).slice(0, MAX_PAGE_SLUGS_PER_BLOCK),
      attrSamples: Array.from(entry.attrShapes.values()).slice(0, MAX_ATTR_SAMPLES_PER_BLOCK),
      tier: assignTier(entry.blockName, entry.occurrenceCount),
    });
  }
  // Stable order: occurrence desc, then name asc (nulls last).
  out.sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    if (a.blockName === null) return 1;
    if (b.blockName === null) return -1;
    return a.blockName.localeCompare(b.blockName);
  });
  return out;
}

/**
 * Recursive walk. Uses block name as the accumulator key. `null` blockName
 * (classic-editor) lands under the literal key `__null__` to keep the Map
 * single-typed without an extra branch on every read.
 */
function walkBlocks(
  blocks: BlockNode[],
  pageSlug: string,
  accum: Map<
    string,
    {
      blockName: string | null;
      occurrenceCount: number;
      pageSlugs: Set<string>;
      attrShapes: Map<string, Record<string, unknown>>;
    }
  >,
): void {
  for (const block of blocks) {
    const key = block.blockName ?? "__null__";
    let entry = accum.get(key);
    if (!entry) {
      entry = {
        blockName: block.blockName,
        occurrenceCount: 0,
        pageSlugs: new Set<string>(),
        attrShapes: new Map<string, Record<string, unknown>>(),
      };
      accum.set(key, entry);
    }
    entry.occurrenceCount += 1;
    entry.pageSlugs.add(pageSlug);

    // Sample shape = sorted keys list. Different keysets → different sample.
    // This is intentionally coarse — different VALUES under the same keyset
    // are NOT new samples. Same-shape samples after the first are dropped.
    const shapeKey = Object.keys(block.attrs).sort().join(",");
    if (!entry.attrShapes.has(shapeKey) && entry.attrShapes.size < MAX_ATTR_SAMPLES_PER_BLOCK) {
      // Defensive shallow clone — don't hand the LLM mutable references to
      // the worker's input data.
      entry.attrShapes.set(shapeKey, { ...block.attrs });
    }

    if (block.innerBlocks && block.innerBlocks.length > 0) {
      walkBlocks(block.innerBlocks, pageSlug, accum);
    }
  }
}

function assignTier(blockName: string | null, occurrence: number): Tier {
  // Null blockName = classic-editor / untyped passthrough.
  if (blockName === null) return "passthrough";
  // Rare blocks fall back regardless of name heuristic.
  if (occurrence <= 2) return "passthrough";
  if (blockName.startsWith("acf/")) return "visual";
  if (TIER_VISUAL.has(blockName)) return "visual";
  if (TIER_STANDARD.has(blockName)) return "standard";
  if (TIER_TRIVIAL.has(blockName)) return "trivial";
  // Unknown block name (third-party plugin, theme block, etc.) → passthrough.
  return "passthrough";
}
