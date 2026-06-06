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

/**
 * Length of the first attrs value that is a non-empty array of objects (an
 * inline item list / snapshot), or 0 when there is none. For a dynamic layout
 * that still carries a snapshot (post_source:"latest" caches what it renders),
 * this length is the theme's own display count — a reliable, site-agnostic
 * signal for the query limit.
 */
function inlineSnapshotLength(attrs: Record<string, unknown>): number {
  for (const v of Object.values(attrs)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object")) return v.length;
  }
  return 0;
}

/** True when an attrs value is a non-empty array of objects (an inline list). */
function hasInlineItemArray(attrs: Record<string, unknown>): boolean {
  return inlineSnapshotLength(attrs) > 0;
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

/**
 * The built-in WordPress posts CPT (registered as `post`, list ability
 * `jab/get-posts` → wrapper `posts`). Restricting the alias below to this CPT
 * keeps the news/blog synonyms from accidentally matching a custom CPT.
 */
function isBlogCpt(postType: string): boolean {
  return /^posts?$/.test(postType.toLowerCase());
}

/**
 * Editorial labels for the blog. The built-in post CPT is almost always
 * surfaced in a theme under one of these words ("News From The Road", "Blog",
 * "Latest Articles") rather than the slug "post(s)", so head-noun/archive
 * matching structurally can't find it without this alias.
 */
const BLOG_ALIAS_TOKENS = new Set([
  "news", "blog", "blogs", "article", "articles", "story", "stories", "update", "updates", "press",
]);

/**
 * A layout's explicit content-source toggle (ACF field like `post_source`,
 * `source`, `query_type`, `mode`) is the strongest, most general dynamic
 * signal: the content model itself declares "query the CPT" vs "use my
 * hand-picked selection". When present it overrides the inline-array snapshot
 * heuristic in both directions. Returns:
 *   "dynamic" — latest/recent/auto/query → fetch live, ignore any inline array
 *   "manual"  — manual/select/curated   → render the inline selection, stay static
 *   null      — no recognizable toggle  → fall back to the inline-array heuristic
 */
const SOURCE_TOGGLE_KEY = /(^|_)source$|^query(_type)?$|^mode$|^display_type$/i;
const DYNAMIC_SOURCE_VALUES = new Set([
  "latest", "recent", "newest", "new", "auto", "automatic", "dynamic", "query",
  "latest_posts", "recent_posts", "latest-posts", "recent-posts",
]);
const MANUAL_SOURCE_VALUES = new Set([
  "manual", "select", "selected", "choose", "chosen", "custom", "specific",
  "handpicked", "hand_picked", "curated", "pick", "picked",
]);

export function readSourceToggle(attrs: Record<string, unknown>): "dynamic" | "manual" | null {
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v !== "string" || !SOURCE_TOGGLE_KEY.test(k)) continue;
    const val = v.trim().toLowerCase();
    if (DYNAMIC_SOURCE_VALUES.has(val)) return "dynamic";
    if (MANUAL_SOURCE_VALUES.has(val)) return "manual";
  }
  return null;
}

/** Does a CPT (post_type / slug) match the layout's archive link or head noun? */
function cptMatches(cpt: CptListMeta, layoutTokens: string[], archiveSlug: string | null): boolean {
  const p = cpt.postType.toLowerCase();
  const cptTokens = new Set([p, p.replace(/-/g, "")]);
  // singular/plural tolerance: strip a trailing "s" on both sides
  const singular = (t: string) => t.replace(/s$/, "");
  // Archive-link signal (strong + unambiguous): a view_all link to the CPT
  // archive, e.g. view_all_link.url = ".../events/" → "event".
  if (archiveSlug && (cptTokens.has(archiveSlug) || singular(archiveSlug) === singular(p))) return true;
  // Name signal: ONLY the head noun (last token). A list layout is named for the
  // thing it lists ("events", "upcoming_events" → "events"), not for an
  // incidental modifier. Matching ANY token false-positived badly via singular/
  // plural collapse: "page-headline"→"page"↔"pages", "join-our-team-cta"→"team",
  // "distributors-by-state"→"state"-isn't-a-CPT-but-"distributors"-was. The head
  // noun ("headline"/"cta"/"state") is correctly not a CPT in those cases.
  const head = layoutTokens[layoutTokens.length - 1];
  if (!head) return false;
  if (cptTokens.has(head) || singular(head) === singular(p)) return true;
  // Editorial-label alias — ONLY for the built-in blog CPT: "news"/"blog"/
  // "articles"/… → post(s). Scoped to isBlogCpt so a custom CPT never absorbs
  // these synonyms.
  if (isBlogCpt(cpt.postType)) {
    if (BLOG_ALIAS_TOKENS.has(head)) return true;
    if (archiveSlug && BLOG_ALIAS_TOKENS.has(archiveSlug)) return true;
  }
  return false;
}

/**
 * Decide whether an acf_flex layout is a dynamic-list placeholder for a CPT.
 * A placeholder is config-only (no inline item array) AND maps — by archive
 * link slug or by layout-name token — to a CPT that has a list ability.
 * Returns the query spec, or null when it's a normal static layout.
 */
export function detectDynamicList(input: DetectDynamicListInput): DynamicListSpec | null {
  const { blockName, attrSample, cpts } = input;
  const source = readSourceToggle(attrSample);
  // A manual/curated toggle is authoritative — render the hand-picked inline
  // selection statically regardless of name.
  if (source === "manual") return null;
  // The inline-array snapshot only short-circuits when the layout isn't
  // explicitly dynamic. With source==="dynamic" the array is a stale capture
  // (e.g. featured-news post_source:"latest" carries 2 frozen posts), so we
  // ignore it and resolve live.
  if (source !== "dynamic" && hasInlineItemArray(attrSample)) return null;

  const layoutName = blockName.split("/")[3] ?? "";
  const layoutTokens = tokens(layoutName);
  const archiveSlug = archiveSlugFromAttrs(attrSample);
  let match = cpts.find((c) => cptMatches(c, layoutTokens, archiveSlug));
  // A dynamic source toggle with no resolvable name/archive (e.g. "from-the-road")
  // defaults to the blog: a "latest"/"recent" content widget is almost always
  // the built-in post CPT.
  if (!match && source === "dynamic") {
    match = cpts.find((c) => isBlogCpt(c.postType));
  }
  if (!match) return null;

  // The blog is a recent-descending list, never event-style "upcoming": force
  // recent semantics even if the post CPT happens to expose an ACF date field
  // (which pickDateField would otherwise latch onto and wrongly future-filter,
  // emptying the list). Non-blog CPTs keep their date-driven upcoming behavior.
  const dateField = isBlogCpt(match.postType) ? null : match.dateField;
  // Limit = the theme's own display count when a snapshot reveals it; else the
  // default cap. (A config-only placeholder like upcoming_events has no
  // snapshot, so it caps at DEFAULT_LIMIT and the component slices to taste.)
  const snapshotLen = inlineSnapshotLength(attrSample);
  return {
    blockName,
    listAbility: match.listAbility,
    wrapperKey: match.wrapperKey,
    postType: match.postType,
    dateField,
    order: dateField ? "asc" : "desc",
    upcomingOnly: !!dateField,
    limit: snapshotLen > 0 ? snapshotLen : DEFAULT_LIMIT,
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
