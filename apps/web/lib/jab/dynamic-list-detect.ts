import "server-only";
import type { Manifest } from "@jab/core";
import type { DynamicListSpec } from "./dynamic-lists-runtime";

/** Query metadata for one CPT that has a list ability in the manifest. */
export interface CptListMeta {
  postType: string; // the response wrapper key === registered CPT slug
  listAbility: string; // e.g. "jab/get-event"
  wrapperKey: string; // e.g. "event"
  dateField: string | null; // ACF field used for "upcoming" filtering, or null
}

// Abilities that are NOT list endpoints: single-item fetch + taxonomy terms.
const NON_LIST_SUFFIX = /-by-slug$|-terms$/;

// Rank ACF field names by how strongly they name an event/start date.
const DATE_FIELD_PATTERNS: RegExp[] = [
  /^(event[_-]*)?start[_-]*date([_-]*time)?$/i,
  /start.*date/i,
  /^event[_-]*date([_-]*time)?$/i,
  /date.*time/i,
  /(^|_)date$/i,
];

function pickDateField(acfProps: Record<string, unknown> | null): string | null {
  if (!acfProps) return null;
  const names = Object.keys(acfProps);
  for (const re of DATE_FIELD_PATTERNS) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

function acfPropsFromListAbility(
  ability: Manifest["abilities"][number],
  wrapperKey: string,
): Record<string, unknown> | null {
  const wrapper = (ability.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.[
    wrapperKey
  ];
  if (!wrapper || typeof wrapper !== "object") return null;
  // List ability wrapper may be the item object directly or an array of items.
  const item = (wrapper as { items?: unknown }).items ?? wrapper;
  if (!item || typeof item !== "object") return null;
  const acf = (item as { properties?: Record<string, unknown> }).properties?.acf;
  if (!acf || typeof acf !== "object") return null;
  const props = (acf as { properties?: unknown }).properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
}

/**
 * Every list ability in the manifest, with its wrapper key (=== CPT slug) and
 * the ACF field to use for "upcoming" date filtering (null when none looks
 * like a date). A list ability is any `jab/get-*` that is NOT `*-by-slug` or
 * `*-terms`; the wrapper key is the sole top-level property of its outputSchema.
 */
export function cptListMetaFromManifest(manifest: Manifest | null): CptListMeta[] {
  if (!manifest?.abilities) return [];
  const out: CptListMeta[] = [];
  for (const ability of manifest.abilities) {
    if (!ability.name?.startsWith("jab/get-")) continue;
    if (NON_LIST_SUFFIX.test(ability.name)) continue;
    const props = (ability.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!props) continue;
    const keys = Object.keys(props);
    if (keys.length !== 1) continue; // list abilities wrap under a single CPT key
    const wrapperKey = keys[0];
    out.push({
      postType: wrapperKey,
      listAbility: ability.name,
      wrapperKey,
      dateField: pickDateField(acfPropsFromListAbility(ability, wrapperKey)),
    });
  }
  return out;
}

export interface DetectDynamicListInput {
  blockName: string;
  attrSample: Record<string, unknown>;
  cpts: CptListMeta[];
}

const DEFAULT_LIMIT = 12;

/** True when an attrs value is a non-empty array of objects (an inline list). */
function hasInlineItemArray(attrs: Record<string, unknown>): boolean {
  return Object.values(attrs).some(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object"),
  );
}

/** Last non-empty path segment of an archive-like URL, singular/plural tolerant. */
function archiveSlugFromAttrs(attrs: Record<string, unknown>): string | null {
  for (const v of Object.values(attrs)) {
    const url = typeof v === "string" ? v : v && typeof v === "object" ? (v as { url?: unknown }).url : undefined;
    if (typeof url !== "string") continue;
    // Only treat URL/path-like strings as archive links — a bare config token
    // (e.g. acf_fc_layout: "team") has no slash and is not an archive URL.
    if (!url.includes("/")) continue;
    const m = url
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .match(/([^/]+)$/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Normalize a token to comparable words: lowercase, split on non-alnum, drop "upcoming"/"all". */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t !== "upcoming" && t !== "all" && t !== "our" && t !== "featured");
}

/** Does a CPT (post_type / slug) match the layout name tokens or archive slug? */
function cptMatches(cpt: CptListMeta, layoutTokens: string[], archiveSlug: string | null): boolean {
  const cptTokens = new Set([cpt.postType.toLowerCase(), cpt.postType.toLowerCase().replace(/-/g, "")]);
  // singular/plural tolerance: strip a trailing "s" on both sides
  const singular = (t: string) => t.replace(/s$/, "");
  if (archiveSlug && (cptTokens.has(archiveSlug) || singular(archiveSlug) === singular(cpt.postType.toLowerCase())))
    return true;
  return layoutTokens.some((t) => cptTokens.has(t) || singular(t) === singular(cpt.postType.toLowerCase()));
}

/**
 * Decide whether an acf_flex layout is a dynamic-list placeholder for a CPT.
 * A placeholder is config-only (no inline item array) AND maps — by archive
 * link slug or by layout-name token — to a CPT that has a list ability.
 * Returns the query spec, or null when it's a normal static layout.
 */
export function detectDynamicList(input: DetectDynamicListInput): DynamicListSpec | null {
  const { blockName, attrSample, cpts } = input;
  if (hasInlineItemArray(attrSample)) return null;
  const layoutName = blockName.split("/")[3] ?? "";
  const layoutTokens = tokens(layoutName);
  const archiveSlug = archiveSlugFromAttrs(attrSample);
  const match = cpts.find((c) => cptMatches(c, layoutTokens, archiveSlug));
  if (!match) return null;
  return {
    blockName,
    listAbility: match.listAbility,
    wrapperKey: match.wrapperKey,
    postType: match.postType,
    dateField: match.dateField,
    order: match.dateField ? "asc" : "desc",
    upcomingOnly: !!match.dateField,
    limit: DEFAULT_LIMIT,
  };
}

export interface AcfFlexInventoryRow {
  block_name: string;
  kind: string | null;
  spec: unknown;
}

/**
 * Build the DynamicListSpec list for a build: every acf_flex block_inventory
 * row whose captured spec (attrSample) is detected as a dynamic-list
 * placeholder against the manifest's CPT list abilities.
 */
export function dynamicListSpecsFromInventory(
  rows: AcfFlexInventoryRow[],
  manifest: Manifest | null,
): DynamicListSpec[] {
  const cpts = cptListMetaFromManifest(manifest);
  if (cpts.length === 0) return [];
  const out: DynamicListSpec[] = [];
  for (const row of rows) {
    if (row.kind !== "acf_flex") continue;
    const attrSample =
      row.spec && typeof row.spec === "object" && !Array.isArray(row.spec)
        ? (row.spec as Record<string, unknown>)
        : {};
    const spec = detectDynamicList({ blockName: row.block_name, attrSample, cpts });
    if (spec) out.push(spec);
  }
  return out;
}
