import "server-only";
import type { EnrichedInventoryEntry } from "./content-detection";
import type { PageDiscoveryResult } from "./discovery-types";

/**
 * aggregate-dom-samples.ts — closes the brand-grounding loop.
 *
 * Maps each block_inventory entry to a representative outerHTML snippet from
 * one of its source pages. Downstream LLM prompts (Phase B / C) consume
 * this alongside theme stylesheets to ground generation in the actual
 * source DOM + CSS.
 *
 * Three correlation rules — one per inventory `kind`:
 *
 *   - `block` (Gutenberg core/* + acf/* + others): direct lookup by parsed
 *     blockName in the page's `wpBlockSamples`. The browser-side capture
 *     in playwright-discovery already deduped to one sample per blockName
 *     per page, so the first matching page wins. Returns null for blocks
 *     not present in any page's wpBlockSamples (custom-themed sites where
 *     `wp-block-*` classes aren't emitted at all).
 *
 *   - `acf_flex`: positional correlation. Parses `acf_flex/{cpt}/{field}/
 *     {layout}` from blockName. Walks the source pages (passed in via
 *     `pageAcfData`) to find the FIRST page where `acf[field]` contains
 *     this layout, records the layout's index in the flex array, then
 *     looks up `mainSections[index]` in that page's domSnapshot. Returns
 *     null if the layout's index falls outside the captured mainSections
 *     range (theme injected extra wrappers, the cap clipped further
 *     children, etc.).
 *
 *   - `cpt_template`: parses `cpt_template/{cpt}` from blockName. Picks the
 *     first page in this CPT's pageSlugs whose domSnapshot has a non-null
 *     `articleOuterHtml`, returns that. Falls back to the joined
 *     mainSections HTML (cap-bounded) if no `<article>` was captured.
 *
 * All returned HTML is capped at MAX_DOM_SAMPLE_BYTES by the caller-side
 * cap in playwright-discovery (50 KB per element). This aggregator does NOT
 * re-clip — the captures are already bounded.
 *
 * Returns a Map<blockName, outerHTML | null>. Callers persist non-null
 * entries on block_inventory.source_dom_sample; null entries leave the
 * column null in the upsert (preferred over emitting wrong correlations).
 */

export interface PageAcfData {
  slug: string;
  post_type: string;
  acf?: Record<string, unknown>;
}

const MAX_JOINED_SECTIONS_BYTES = 50_000;

export function aggregateDomSamples(
  inventory: EnrichedInventoryEntry[],
  pageAcfData: PageAcfData[],
  discoveryResults: PageDiscoveryResult[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();

  // Index pages by slug for fast lookup. Slug is unique per discovery
  // result (one row per page).
  const resultBySlug = new Map<string, PageDiscoveryResult>();
  for (const r of discoveryResults) resultBySlug.set(r.slug, r);

  const acfBySlug = new Map<string, PageAcfData>();
  for (const p of pageAcfData) acfBySlug.set(p.slug, p);

  // Index pages by post_type for cpt_template / acf_flex lookup paths
  // that don't already know which specific slug to use.
  const slugsByPostType = new Map<string, string[]>();
  for (const p of pageAcfData) {
    const arr = slugsByPostType.get(p.post_type) ?? [];
    arr.push(p.slug);
    slugsByPostType.set(p.post_type, arr);
  }

  for (const entry of inventory) {
    const key = entry.blockName ?? "__null__";

    if (entry.kind === "cpt_template") {
      out.set(key, sampleForCptTemplate(entry, slugsByPostType, resultBySlug));
      continue;
    }
    if (entry.kind === "acf_flex") {
      out.set(key, sampleForAcfFlex(entry, slugsByPostType, acfBySlug, resultBySlug));
      continue;
    }
    // kind === "block" — Gutenberg / namespaced block samples via wp-block-* classes.
    out.set(key, sampleForBlock(entry, resultBySlug));
  }

  return out;
}

function sampleForBlock(
  entry: EnrichedInventoryEntry,
  resultBySlug: Map<string, PageDiscoveryResult>,
): string | null {
  // Null blockName is the classic-editor sentinel — those have no
  // wp-block-* DOM, so there's nothing to sample. Persisted as null.
  if (!entry.blockName) return null;
  for (const slug of entry.pageSlugs) {
    const result = resultBySlug.get(slug);
    const sample = result?.domSnapshot?.wpBlockSamples.find(
      (s) => s.blockName === entry.blockName,
    );
    if (sample) return sample.outerHTML;
  }
  return null;
}

function sampleForAcfFlex(
  entry: EnrichedInventoryEntry,
  slugsByPostType: Map<string, string[]>,
  acfBySlug: Map<string, PageAcfData>,
  resultBySlug: Map<string, PageDiscoveryResult>,
): string | null {
  // blockName shape: `acf_flex/{cpt}/{field}/{layout}` — see
  // content-detection.ts:105 where this is constructed.
  const parts = entry.blockName?.split("/") ?? [];
  if (parts.length !== 4 || parts[0] !== "acf_flex") return null;
  const [, cptSlug, fieldName, layoutName] = parts;

  const candidateSlugs = slugsByPostType.get(cptSlug) ?? [];
  for (const slug of candidateSlugs) {
    const acfPage = acfBySlug.get(slug);
    if (!acfPage?.acf) continue;
    const field = acfPage.acf[fieldName];
    if (!Array.isArray(field)) continue;
    // Index of the first matching layout entry in this page's flex array.
    // Positional correlation rule: that index ↔ same-indexed direct child
    // of the page's <main> in the DOM snapshot.
    const idx = field.findIndex(
      (e) => typeof e === "object" && e !== null && (e as { acf_fc_layout?: unknown }).acf_fc_layout === layoutName,
    );
    if (idx < 0) continue;
    const result = resultBySlug.get(slug);
    const section = result?.domSnapshot?.mainSections[idx];
    if (section) return section.outerHTML;
    // No section at that index — theme inserted extra wrappers or the
    // cap clipped further children. Better to omit than emit a wrong
    // earlier-index section as this layout's DOM. Try next page.
  }
  return null;
}

function sampleForCptTemplate(
  entry: EnrichedInventoryEntry,
  slugsByPostType: Map<string, string[]>,
  resultBySlug: Map<string, PageDiscoveryResult>,
): string | null {
  // blockName shape: `cpt_template/{cpt}` — see content-detection.ts:122.
  const parts = entry.blockName?.split("/") ?? [];
  if (parts.length !== 2 || parts[0] !== "cpt_template") return null;
  const cptSlug = parts[1];

  const candidateSlugs = slugsByPostType.get(cptSlug) ?? [];
  for (const slug of candidateSlugs) {
    const result = resultBySlug.get(slug);
    const snapshot = result?.domSnapshot;
    if (!snapshot) continue;
    if (snapshot.articleOuterHtml) return snapshot.articleOuterHtml;
    // Article fallback: join the first few mainSections. Useful when the
    // theme doesn't use a top-level <article> (some classic themes don't).
    if (snapshot.mainSections.length > 0) {
      const joined = snapshot.mainSections.map((s) => s.outerHTML).join("\n");
      return joined.length > MAX_JOINED_SECTIONS_BYTES
        ? joined.slice(0, MAX_JOINED_SECTIONS_BYTES)
        : joined;
    }
  }
  return null;
}
