# Generic Dynamic-List Placeholder (render-time CPT list hydration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make config-only ACF flex "list placeholder" layouts (e.g. Two Roads `upcoming_events` / `events`) render a real, date-filtered list of a WordPress CPT at render time — generically, driven by the connected site's manifest, with no plugin change.

**Architecture:** A pure detector flags an `acf_flex` layout as a *dynamic-list placeholder* when its captured attrs carry no inline item array but it maps (by layout-name tokens or a `view_all_link` archive path) to a CPT that has a list ability in the manifest. Phase B tells the LLM that such a layout's items arrive at `block.attrs.items: JabListItem[]` (so the generated component renders that contract). At compose time we emit a `DYNAMIC_LISTS` map (blockName → query spec) plus a self-contained `dynamic-lists.ts` runtime; the emitted page calls `resolveDynamicLists(blocks, callAbility, DYNAMIC_LISTS, mediaResolver)` after `composeBlockTree` and after `resolveRelationshipRefs` — over-fetching the CPT list ability, filtering to upcoming by the CPT's ACF start-date field, sorting, capping, normalizing, and injecting `block.attrs.items`. This exactly mirrors the existing `related-posts.ts` post-ref hydration precedent.

**Tech Stack:** TypeScript, Next.js App Router (emitted project), vitest, Supabase (`block_inventory`, `projects.manifest`), Inngest compose worker.

---

## Background facts (verified against live data — do not re-derive)

- The `upcoming_events` ACF layout's captured attrs are **config-only**: `{ acf_fc_layout, padding, section_headline, view_all_link:{url:".../events/"} }`. No `events` array exists in ACF — the WP theme queries the `event` CPT dynamically. (block_inventory, project `two-roads`.)
- The connected manifest has list ability `jab/get-event` (wrapper key `event`) and by-slug `jab/get-event-by-slug`. The `event` CPT's ACF fields are: `address, ticket_link, end_date__time, start_date__time, is_featured_event`. "Upcoming" = `acf.start_date__time >= today`, ascending. This is a **meta** date — the v0.7.0 list ability cannot filter it server-side, so we over-fetch + filter client-side (decided 2026-06-05).
- Render-time hydration precedent: [`lib/jab/related-posts-runtime.ts`](../../apps/web/lib/jab/related-posts-runtime.ts) is a self-contained (no `@/…` imports) module read verbatim by `emitRelatedPostsTs()` → `lib/jab/related-posts.ts`, called by the emitted page after compose. Mirror it.
- Map-emit precedent: [`emitAcfFlexFieldsTs`](../../apps/web/lib/jab/compose-site-emit.ts) walks `block_inventory` rows → emits `ACF_FLEX_FIELDS` constant to `lib/acf-flex-fields.ts`.
- ACF-flex prompt site: `acfFlexPrompt(entry, tokens, guidance)` in [`lib/ai/component-generator.ts`](../../apps/web/lib/ai/component-generator.ts) (the `postRelationWarning` block is the precedent for a "hydrated at render" prompt section).

## File Structure

- **Create** `apps/web/lib/jab/dynamic-list-detect.ts` — pure detector + manifest CPT-meta derivation (no I/O). Used by BOTH Phase B (prompt) and compose (map) — single source of truth (DRY).
- **Create** `apps/web/lib/jab/dynamic-list-detect.test.ts`
- **Create** `apps/web/lib/jab/dynamic-lists-runtime.ts` — self-contained emitted render-time hydrator (`resolveDynamicLists` + date/normalize helpers). NO `@/…` imports.
- **Create** `apps/web/lib/jab/dynamic-lists-runtime.test.ts`
- **Modify** `apps/web/lib/jab/compose-site-emit.ts` — add `emitDynamicListsTs()` (verbatim) + `emitDynamicListsMapTs(rows)`; wire imports + the `resolveDynamicLists` call into `emitHomepageTsx` and `emitCatchAllPageTsx`.
- **Modify** `apps/web/lib/jab/compose-site-emit.test.ts` — cover the new emitters + updated page emitters.
- **Modify** `apps/web/lib/inngest/functions/compose-site.ts` — upload `lib/jab/dynamic-lists.ts` + `lib/jab/dynamic-lists-map.ts` (derive map from `block_inventory` rows + manifest).
- **Modify** `apps/web/lib/ai/component-generator.ts` — `acfFlexPrompt` gains an optional `dynamicList` arg → emits the `block.attrs.items` contract section.
- **Modify** `apps/web/lib/ai/component-generator.test.ts` — cover the new prompt section.
- **Modify** `apps/web/lib/inngest/functions/generate-components.ts` — resolve the `dynamicList` spec (via the shared detector + manifest) and pass it to `acfFlexPrompt`.

No DB migration: `block_inventory.spec`/`kind` and `projects.manifest` already exist; the map is derived at compose time from those + the manifest. No `page_inventory` change.

---

## Task 1: Shared types + manifest CPT-meta derivation

**Files:**
- Create: `apps/web/lib/jab/dynamic-list-detect.ts`
- Test: `apps/web/lib/jab/dynamic-list-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { cptListMetaFromManifest } from "./dynamic-list-detect";
import type { Manifest } from "@jab/core";

const manifest = (abilities: Manifest["abilities"]): Manifest => ({
  schemaVersion: 1, source: "x", fetchedAt: "x",
  server: { namespace: "jab", route: "/wp-json/jab/v1" }, abilities,
});

describe("cptListMetaFromManifest", () => {
  it("derives postType/listAbility/wrapperKey/dateField for a CPT with a start-date ACF field", () => {
    const m = manifest([
      {
        name: "jab/get-event", label: "", description: "", inputSchema: {},
        outputSchema: { type: "object", properties: { event: {
          type: "object",
          properties: { acf: { type: "object", properties: {
            address: { type: "string" }, start_date__time: { type: "string" }, end_date__time: { type: "string" },
          } } },
        } } },
      },
    ]);
    expect(cptListMetaFromManifest(m)).toEqual([
      { postType: "event", listAbility: "jab/get-event", wrapperKey: "event", dateField: "start_date__time" },
    ]);
  });

  it("ignores by-slug + term abilities and CPTs with no date field get dateField null", () => {
    const m = manifest([
      { name: "jab/get-event-by-slug", label: "", description: "", inputSchema: {}, outputSchema: {} },
      { name: "jab/get-team-member-category-terms", label: "", description: "", inputSchema: {}, outputSchema: {} },
      { name: "jab/get-team-member", label: "", description: "", inputSchema: {},
        outputSchema: { type: "object", properties: { "team-member": {
          type: "object", properties: { acf: { type: "object", properties: { bio: { type: "string" } } } },
        } } } },
    ]);
    expect(cptListMetaFromManifest(m)).toEqual([
      { postType: "team-member", listAbility: "jab/get-team-member", wrapperKey: "team-member", dateField: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: FAIL — `cptListMetaFromManifest` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
import "server-only";
import type { Manifest } from "@jab/core";

/** Query metadata for one CPT that has a list ability in the manifest. */
export interface CptListMeta {
  postType: string;       // the response wrapper key === registered CPT slug
  listAbility: string;    // e.g. "jab/get-event"
  wrapperKey: string;     // e.g. "event"
  dateField: string | null; // ACF field used for "upcoming" filtering, or null
}

// Abilities that are NOT list endpoints: single-item fetch + taxonomy terms.
const NON_LIST_SUFFIX = /-by-slug$|-terms$/;

// Rank ACF field names by how strongly they name an event/start date.
const DATE_FIELD_PATTERNS: RegExp[] = [
  /^(event[_-]?)?start[_-]?date([_-]?time)?$/i,
  /start.*date/i,
  /^event[_-]?date([_-]?time)?$/i,
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

function acfPropsFromListAbility(ability: Manifest["abilities"][number], wrapperKey: string): Record<string, unknown> | null {
  const wrapper = (ability.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.[wrapperKey];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/dynamic-list-detect.ts apps/web/lib/jab/dynamic-list-detect.test.ts
git commit -m "feat(saas): derive CPT list metadata from manifest for dynamic-list hydration"
```

---

## Task 2: The placeholder detector

**Files:**
- Modify: `apps/web/lib/jab/dynamic-list-detect.ts`
- Test: `apps/web/lib/jab/dynamic-list-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { detectDynamicList } from "./dynamic-list-detect";

const EVENT_META = { postType: "event", listAbility: "jab/get-event", wrapperKey: "event", dateField: "start_date__time" };

describe("detectDynamicList", () => {
  it("flags a config-only events layout that links to the CPT archive", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/upcoming_events",
      attrSample: { acf_fc_layout: "upcoming_events", section_headline: "Upcoming Events", view_all_link: { url: "https://x.com/events/" } },
      cpts: [EVENT_META],
    });
    expect(spec).toEqual({
      blockName: "acf_flex/page/page_builder/upcoming_events",
      listAbility: "jab/get-event", wrapperKey: "event", postType: "event",
      dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 12,
    });
  });

  it("matches by layout-name token when there is no archive link", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/events",
      attrSample: { acf_fc_layout: "events", section_headline: "Upcoming Two Roads Events" },
      cpts: [EVENT_META],
    });
    expect(spec?.listAbility).toBe("jab/get-event");
  });

  it("returns null when the layout already carries an inline item array (static, not a placeholder)", () => {
    expect(detectDynamicList({
      blockName: "acf_flex/page/page_builder/featured_beers",
      attrSample: { acf_fc_layout: "featured_beers", beers: [{ ID: 1, post_title: "IPA", post_name: "ipa" }] },
      cpts: [{ postType: "beer", listAbility: "jab/get-beer", wrapperKey: "beer", dateField: null }],
    })).toBeNull();
  });

  it("returns null when no CPT matches the layout name or link", () => {
    expect(detectDynamicList({
      blockName: "acf_flex/page/page_builder/newsletter",
      attrSample: { acf_fc_layout: "newsletter", heading: "Sign up" },
      cpts: [EVENT_META],
    })).toBeNull();
  });

  it("sets upcomingOnly false / order desc when the matched CPT has no date field (recent-list fallback)", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/team",
      attrSample: { acf_fc_layout: "team", view_all_link: { url: "/team-member/" } },
      cpts: [{ postType: "team-member", listAbility: "jab/get-team-member", wrapperKey: "team-member", dateField: null }],
    });
    expect(spec).toMatchObject({ listAbility: "jab/get-team-member", dateField: null, upcomingOnly: false, order: "desc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: FAIL — `detectDynamicList` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `dynamic-list-detect.ts`)

```typescript
/** The render-time query descriptor for one dynamic-list placeholder block. */
export interface DynamicListSpec {
  blockName: string;
  listAbility: string;
  wrapperKey: string;
  postType: string;
  dateField: string | null;
  order: "asc" | "desc";
  upcomingOnly: boolean;
  limit: number;
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
    const url = typeof v === "string" ? v : (v && typeof v === "object" ? (v as { url?: unknown }).url : undefined);
    if (typeof url !== "string") continue;
    const m = url.replace(/[?#].*$/, "").replace(/\/+$/, "").match(/([^/]+)$/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Normalize a token to comparable words: lowercase, split on non-alnum, drop "upcoming"/"all". */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && t !== "upcoming" && t !== "all" && t !== "our" && t !== "featured");
}

/** Does a CPT (post_type / slug) match the layout name tokens or archive slug? */
function cptMatches(cpt: CptListMeta, layoutTokens: string[], archiveSlug: string | null): boolean {
  const cptTokens = new Set([cpt.postType.toLowerCase(), cpt.postType.toLowerCase().replace(/-/g, "")]);
  // singular/plural tolerance: strip a trailing "s" on both sides
  const singular = (t: string) => t.replace(/s$/, "");
  if (archiveSlug && (cptTokens.has(archiveSlug) || singular(archiveSlug) === singular(cpt.postType.toLowerCase()))) return true;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/dynamic-list-detect.ts apps/web/lib/jab/dynamic-list-detect.test.ts
git commit -m "feat(saas): detect config-only ACF flex layouts as dynamic-list placeholders"
```

---

## Task 3: Render-time runtime — date parsing + item normalization (pure helpers)

**Files:**
- Create: `apps/web/lib/jab/dynamic-lists-runtime.ts`
- Test: `apps/web/lib/jab/dynamic-lists-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseAcfDate, selectListItems, normalizeRecord } from "./dynamic-lists-runtime";

describe("parseAcfDate", () => {
  it("parses 'Y-m-d H:i:s'", () => {
    expect(parseAcfDate("2026-06-06 18:00:00")).toBe(new Date("2026-06-06T18:00:00").getTime());
  });
  it("parses compact 'Ymd'", () => {
    expect(parseAcfDate("20260610")).toBe(new Date(2026, 5, 10).getTime());
  });
  it("returns null for junk/empty", () => {
    expect(parseAcfDate("")).toBeNull();
    expect(parseAcfDate("not a date")).toBeNull();
  });
});

describe("selectListItems", () => {
  const now = new Date("2026-06-04T12:00:00").getTime();
  const rec = (id: number, d: string) => ({ id, acf: { start_date__time: d }, date: "2020-01-01T00:00:00" });

  it("keeps only future events, sorts ascending, caps to limit", () => {
    const items = selectListItems(
      [rec(1, "2026-06-10 00:00:00"), rec(2, "2026-06-06 00:00:00"), rec(3, "2026-05-01 00:00:00")],
      { dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([2, 1]);
  });

  it("with no date field, returns input order capped (recent-list fallback)", () => {
    const items = selectListItems(
      [{ id: 9, acf: {} }, { id: 8, acf: {} }, { id: 7, acf: {} }],
      { dateField: null, order: "desc", upcomingOnly: false, limit: 2 }, now,
    );
    expect(items.map((r) => r.id)).toEqual([9, 8]);
  });
});

describe("normalizeRecord", () => {
  it("maps a CPT record to the JabListItem contract", async () => {
    const item = await normalizeRecord(
      { id: 5, title: "Trivia Night", link: "https://x.com/event/trivia", excerpt: "Fun",
        featured_image: { url: "https://x.com/a.jpg", alt: "a" }, acf: { start_date__time: "2026-06-10 18:00:00", ticket_link: "t" } },
      { dateField: "start_date__time" },
    );
    expect(item).toEqual({
      id: 5, title: "Trivia Night", url: "https://x.com/event/trivia", excerpt: "Fun",
      image: { url: "https://x.com/a.jpg", alt: "a" },
      date: "2026-06-10 18:00:00",
      acf: { start_date__time: "2026-06-10 18:00:00", ticket_link: "t" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-lists-runtime.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write minimal implementation**

```typescript
// EMITTED RUNTIME MODULE. Read verbatim by emitDynamicListsTs() and written to
// the generated project at lib/jab/dynamic-lists.ts. MUST stay self-contained
// (no "@/…" imports): the WP call + media resolver are dependency-injected so
// the generated page passes jabClient.callAbility and tests pass fakes.
//
// Why this exists: config-only ACF "list placeholder" layouts (e.g.
// upcoming_events) carry NO inline data — the source theme renders them from a
// dynamic CPT query. composeBlockTree is sync and cannot fetch, so the async
// page calls resolveDynamicLists AFTER composing: it over-fetches the CPT list
// ability, filters to upcoming by the CPT's ACF start-date field, sorts, caps,
// normalizes each record to JabListItem, and injects block.attrs.items.

export interface RBlock {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: RBlock[];
  _key: string;
  [k: string]: unknown;
}

export type CallAbility = (abilityName: string, input?: Record<string, unknown>) => Promise<unknown>;
export type MediaResolver = (attachmentId: number) => Promise<{ url: string; alt?: string } | null>;

/** The shape generated dynamic-list components bind to as `block.attrs.items`. */
export interface JabListItem {
  id: number;
  title: string;
  url: string;
  excerpt: string;
  image: { url: string; alt: string } | null;
  date: string | null;
  acf: Record<string, unknown>;
}

export interface DynamicListSpec {
  blockName: string;
  listAbility: string;
  wrapperKey: string;
  postType: string;
  dateField: string | null;
  order: "asc" | "desc";
  upcomingOnly: boolean;
  limit: number;
}

/** Parse the common ACF date encodings to epoch ms, or null. */
export function parseAcfDate(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
    const t = new Date(y, mo - 1, d).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

interface RawRecord { id?: unknown; acf?: unknown; [k: string]: unknown }

function dateValue(rec: RawRecord, dateField: string | null): number | null {
  if (!dateField) return null;
  const acf = rec.acf && typeof rec.acf === "object" ? (rec.acf as Record<string, unknown>) : {};
  return parseAcfDate(acf[dateField]);
}

/**
 * Filter (upcoming), sort, and cap raw CPT records per the spec. `now` is
 * injected for testability. Records whose date can't be parsed are kept only
 * when upcomingOnly is false; when filtering upcoming they're dropped.
 */
export function selectListItems<T extends RawRecord>(
  records: T[],
  spec: Pick<DynamicListSpec, "dateField" | "order" | "upcomingOnly" | "limit">,
  now: number,
): T[] {
  let rows = records.slice();
  if (spec.upcomingOnly && spec.dateField) {
    rows = rows.filter((r) => {
      const t = dateValue(r, spec.dateField);
      return t !== null && t >= startOfDay(now);
    });
    rows.sort((a, b) => (dateValue(a, spec.dateField)! - dateValue(b, spec.dateField)!) * (spec.order === "asc" ? 1 : -1));
  }
  return rows.slice(0, spec.limit);
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Map a raw CPT record to the JabListItem contract. */
export async function normalizeRecord(
  rec: RawRecord,
  opts: { dateField: string | null; resolveMedia?: MediaResolver },
): Promise<JabListItem> {
  const acf = rec.acf && typeof rec.acf === "object" ? (rec.acf as Record<string, unknown>) : {};
  const title = pickString(rec.title) ?? "";
  return {
    id: typeof rec.id === "number" ? rec.id : 0,
    title,
    url: pickString(rec.link) ?? pickString((rec as { permalink?: unknown }).permalink) ?? "#",
    excerpt: stripHtml(pickString(rec.excerpt) ?? ""),
    image: await pickImage(rec, opts.resolveMedia),
    date: opts.dateField ? (typeof acf[opts.dateField] === "string" ? (acf[opts.dateField] as string) : null) : null,
    acf,
  };
}

function pickString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { rendered?: unknown }).rendered === "string") {
    return (v as { rendered: string }).rendered;
  }
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

const PRIMARY_IMAGE_KEYS = ["feature_image", "featured_image", "main_image", "hero_image", "cover_image", "card_image", "image"];

async function pickImage(rec: RawRecord, resolveMedia?: MediaResolver): Promise<{ url: string; alt: string } | null> {
  const fromThumb = imageFrom(rec.featured_image);
  if (fromThumb) return fromThumb;
  const acf = rec.acf && typeof rec.acf === "object" ? (rec.acf as Record<string, unknown>) : {};
  for (const k of PRIMARY_IMAGE_KEYS) {
    if (k in acf) {
      const img = imageFrom(acf[k]);
      if (img) return img;
      const id = attachmentId(acf[k]);
      if (id != null && resolveMedia) {
        const r = await resolveMedia(id);
        if (r) return { url: r.url, alt: r.alt ?? "" };
      }
    }
  }
  return null;
}

function imageFrom(v: unknown): { url: string; alt: string } | null {
  if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
    const o = v as { url: string; alt?: unknown };
    return { url: o.url, alt: typeof o.alt === "string" ? o.alt : "" };
  }
  if (typeof v === "string" && /^https?:\/\//i.test(v)) return { url: v, alt: "" };
  return null;
}

function attachmentId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) { const n = +v.trim(); return n > 0 ? n : null; }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-lists-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/dynamic-lists-runtime.ts apps/web/lib/jab/dynamic-lists-runtime.test.ts
git commit -m "feat(saas): dynamic-list runtime date parsing + record normalization"
```

---

## Task 4: Render-time runtime — `resolveDynamicLists` (the tree-walking hydrator)

**Files:**
- Modify: `apps/web/lib/jab/dynamic-lists-runtime.ts`
- Test: `apps/web/lib/jab/dynamic-lists-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveDynamicLists } from "./dynamic-lists-runtime";

describe("resolveDynamicLists", () => {
  const SPEC = {
    "acf_flex/page/page_builder/upcoming_events": {
      blockName: "acf_flex/page/page_builder/upcoming_events",
      listAbility: "jab/get-event", wrapperKey: "event", postType: "event",
      dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 3,
    },
  };
  const now = new Date("2026-06-04T12:00:00").getTime();

  it("injects block.attrs.items from the list ability, filtered + normalized", async () => {
    const calls: Array<[string, unknown]> = [];
    const callAbility = async (name: string, input?: Record<string, unknown>) => {
      calls.push([name, input]);
      return { event: [
        { id: 1, title: "Past", link: "/event/past", excerpt: "", acf: { start_date__time: "2026-05-01 00:00:00" } },
        { id: 2, title: "Soon", link: "/event/soon", excerpt: "Soon!", acf: { start_date__time: "2026-06-06 00:00:00" } },
      ] };
    };
    const blocks = [{ blockName: "acf_flex/page/page_builder/upcoming_events", attrs: { section_headline: "Upcoming Events" }, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);

    expect(calls[0][0]).toBe("jab/get-event");
    expect(blocks[0].attrs.section_headline).toBe("Upcoming Events"); // config preserved
    const items = blocks[0].attrs.items as Array<{ id: number }>;
    expect(items.map((i) => i.id)).toEqual([2]); // only the future event
  });

  it("sets items to [] (never throws) when the ability call fails — component renders its empty state", async () => {
    const callAbility = async () => { throw new Error("boom"); };
    const blocks = [{ blockName: "acf_flex/page/page_builder/upcoming_events", attrs: {}, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);
    expect(blocks[0].attrs.items).toEqual([]);
  });

  it("ignores blocks with no matching spec", async () => {
    const callAbility = async () => ({ event: [] });
    const blocks = [{ blockName: "acf_flex/page/page_builder/newsletter", attrs: {}, _key: "flex-0" }];
    await resolveDynamicLists(blocks, callAbility, SPEC, undefined, now);
    expect(blocks[0].attrs.items).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-lists-runtime.test.ts`
Expected: FAIL — `resolveDynamicLists` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `dynamic-lists-runtime.ts`)

```typescript
function walk(blocks: RBlock[], visit: (b: RBlock) => void): void {
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    visit(b);
    if (Array.isArray(b.innerBlocks)) walk(b.innerBlocks, visit);
  }
}

/**
 * For every block whose blockName has a DynamicListSpec, fetch the CPT list
 * ability, select upcoming/recent records, normalize them, and set
 * block.attrs.items (a JabListItem[]). Mutates in place; returns the same
 * array. Fail-soft: any error sets items to [] so the component renders its
 * own empty state rather than crashing the page. `now` is injected for tests;
 * production passes Date.now().
 */
export async function resolveDynamicLists(
  blocks: RBlock[],
  callAbility: CallAbility,
  specs: Record<string, DynamicListSpec>,
  resolveMedia?: MediaResolver,
  now: number = Date.now(),
): Promise<RBlock[]> {
  const targets: RBlock[] = [];
  walk(blocks, (b) => {
    if (b.blockName && specs[b.blockName]) targets.push(b);
  });
  for (const block of targets) {
    const spec = specs[block.blockName as string];
    try {
      // Over-fetch (the v0.7.0 list ability can't filter an ACF meta date), then
      // filter client-side. numberposts capped at the plugin's 100 ceiling.
      const resp = (await callAbility(spec.listAbility, { numberposts: 100, include: { blocks: false, content: false } })) as Record<string, unknown>;
      const raw = resp?.[spec.wrapperKey];
      const records = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      const selected = selectListItems(records, spec, now);
      block.attrs.items = await Promise.all(selected.map((r) => normalizeRecord(r, { dateField: spec.dateField, resolveMedia })));
    } catch {
      block.attrs.items = [];
    }
  }
  return blocks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-lists-runtime.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/dynamic-lists-runtime.ts apps/web/lib/jab/dynamic-lists-runtime.test.ts
git commit -m "feat(saas): resolveDynamicLists render-time hydrator (over-fetch + filter + inject items)"
```

---

## Task 5: Emit the runtime + the DYNAMIC_LISTS map

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test** (add to `compose-site-emit.test.ts`)

```typescript
import { emitDynamicListsTs, emitDynamicListsMapTs } from "./compose-site-emit";

describe("emitDynamicListsTs", () => {
  it("emits the runtime verbatim with resolveDynamicLists exported", () => {
    const out = emitDynamicListsTs();
    expect(out).toContain("export async function resolveDynamicLists");
    expect(out).not.toContain('from "@/'); // self-contained
  });
});

describe("emitDynamicListsMapTs", () => {
  it("emits a DYNAMIC_LISTS const keyed by blockName", () => {
    const out = emitDynamicListsMapTs([
      {
        blockName: "acf_flex/page/page_builder/upcoming_events", listAbility: "jab/get-event",
        wrapperKey: "event", postType: "event", dateField: "start_date__time",
        order: "asc", upcomingOnly: true, limit: 12,
      },
    ]);
    expect(out).toContain("export const DYNAMIC_LISTS");
    expect(out).toContain('"acf_flex/page/page_builder/upcoming_events"');
    expect(out).toContain('"jab/get-event"');
  });

  it("emits an empty map when there are no dynamic lists", () => {
    expect(emitDynamicListsMapTs([])).toContain("export const DYNAMIC_LISTS: Record<string, DynamicListSpec> = {};");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/compose-site-emit.test.ts`
Expected: FAIL — emitters not exported.

- [ ] **Step 3: Write minimal implementation** (add to `compose-site-emit.ts`, near `emitRelatedPostsTs` / `emitAcfFlexFieldsTs`)

```typescript
import type { DynamicListSpec } from "./dynamic-list-detect";

/**
 * lib/jab/dynamic-lists.ts emitter — the render-time hydrator, read verbatim
 * from dynamic-lists-runtime.ts (a self-contained module). Mirrors
 * emitRelatedPostsTs.
 */
export function emitDynamicListsTs(): string {
  return readFileSync(join(process.cwd(), "lib/jab/dynamic-lists-runtime.ts"), "utf8");
}

/**
 * lib/jab/dynamic-lists-map.ts emitter — the blockName→DynamicListSpec map the
 * page passes to resolveDynamicLists. Derived at compose time from the
 * detector over block_inventory acf_flex rows + the manifest.
 */
export function emitDynamicListsMapTs(specs: DynamicListSpec[]): string {
  const body = specs.length === 0
    ? ""
    : "\n" + specs.map((s) => `  ${JSON.stringify(s.blockName)}: ${JSON.stringify(s)},`).join("\n") + "\n";
  return `import type { DynamicListSpec } from "./dynamic-lists";\n\nexport const DYNAMIC_LISTS: Record<string, DynamicListSpec> = {${body}};\n`;
}
```

Note: ensure `DynamicListSpec` is exported from `dynamic-lists-runtime.ts` (it is, Task 3) so the emitted `dynamic-lists-map.ts` `import type { DynamicListSpec } from "./dynamic-lists"` resolves in the generated project.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): emit dynamic-lists runtime + DYNAMIC_LISTS map"
```

---

## Task 6: Wire `resolveDynamicLists` into the page emitters

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (`emitHomepageTsx`, `emitCatchAllPageTsx`)
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test** (add)

```typescript
import { emitHomepageTsx, emitCatchAllPageTsx } from "./compose-site-emit";

describe("page emitters wire dynamic lists", () => {
  it("homepage imports + calls resolveDynamicLists after compose", () => {
    const src = emitHomepageTsx({ slug: "home", abilityName: "jab/get-page-by-slug", wrapperKey: "page", paradigms: ["acf_flex"], postType: "page" });
    expect(src).toContain('import { resolveDynamicLists } from "@/lib/jab/dynamic-lists";');
    expect(src).toContain('import { DYNAMIC_LISTS } from "@/lib/jab/dynamic-lists-map";');
    expect(src).toContain("await resolveDynamicLists(blocks, (name, input) => jabClient.callAbility(name, input), DYNAMIC_LISTS, createWpMediaResolver());");
  });

  it("catch-all imports + calls resolveDynamicLists after compose", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toContain('import { resolveDynamicLists } from "@/lib/jab/dynamic-lists";');
    expect(src).toContain("await resolveDynamicLists(blocks,");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/compose-site-emit.test.ts`
Expected: FAIL — imports/calls absent.

- [ ] **Step 3: Write minimal implementation** — in `emitHomepageTsx`, after the existing `resolveRelationshipRefs` line add the import lines (top) and the call. Precise edits:

In `emitHomepageTsx` template, change the import block to add:
```typescript
import { resolveDynamicLists } from "@/lib/jab/dynamic-lists";
import { DYNAMIC_LISTS } from "@/lib/jab/dynamic-lists-map";
```
and after `await resolveRelationshipRefs(...)` add:
```typescript
  await resolveDynamicLists(blocks, (name, input) => jabClient.callAbility(name, input), DYNAMIC_LISTS, createWpMediaResolver());
```
Apply the identical two additions to `emitCatchAllPageTsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS. Also run existing emitter tests to confirm no snapshot breaks: `npx vitest run lib/jab/compose-site-emit.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): call resolveDynamicLists in emitted homepage + catch-all pages"
```

---

## Task 7: Upload the runtime + map from the compose worker

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts`

- [ ] **Step 1: Write the failing test**

This worker step is integration-glue; assert via a focused unit on the map-derivation helper. Add an exported pure helper `dynamicListSpecsFromInventory(rows, manifest)` to `dynamic-list-detect.ts` and test it:

`apps/web/lib/jab/dynamic-list-detect.test.ts` (add):
```typescript
import { dynamicListSpecsFromInventory } from "./dynamic-list-detect";

it("dynamicListSpecsFromInventory flags acf_flex rows that map to a CPT list", () => {
  const m = manifest([
    { name: "jab/get-event", label: "", description: "", inputSchema: {},
      outputSchema: { type: "object", properties: { event: { type: "object", properties: { acf: { type: "object", properties: { start_date__time: { type: "string" } } } } } } } },
  ]);
  const rows = [
    { block_name: "acf_flex/page/page_builder/upcoming_events", kind: "acf_flex", spec: { acf_fc_layout: "upcoming_events", view_all_link: { url: "/events/" } } },
    { block_name: "acf_flex/page/page_builder/newsletter", kind: "acf_flex", spec: { acf_fc_layout: "newsletter" } },
    { block_name: "core/paragraph", kind: "block", spec: null },
  ];
  const specs = dynamicListSpecsFromInventory(rows, m);
  expect(specs.map((s) => s.blockName)).toEqual(["acf_flex/page/page_builder/upcoming_events"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: FAIL — `dynamicListSpecsFromInventory` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `dynamic-list-detect.ts`)

```typescript
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
export function dynamicListSpecsFromInventory(rows: AcfFlexInventoryRow[], manifest: Manifest | null): DynamicListSpec[] {
  const cpts = cptListMetaFromManifest(manifest);
  if (cpts.length === 0) return [];
  const out: DynamicListSpec[] = [];
  for (const row of rows) {
    if (row.kind !== "acf_flex") continue;
    const attrSample = row.spec && typeof row.spec === "object" && !Array.isArray(row.spec)
      ? (row.spec as Record<string, unknown>)
      : {};
    const spec = detectDynamicList({ blockName: row.block_name, attrSample, cpts });
    if (spec) out.push(spec);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/dynamic-list-detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the worker** — in `compose-site.ts`, where `emitAcfFlexFieldsTs` + `emitRelatedPostsTs` are uploaded (around lines 430/448), the `block_inventory` rows and `manifest` are already in scope (used by `emitAcfFlexFieldsTs` and `abilityMetaFor`). Add two uploads inside the same wave:

```typescript
import { emitDynamicListsTs, emitDynamicListsMapTs } from "@/lib/jab/compose-site-emit";
import { dynamicListSpecsFromInventory } from "@/lib/jab/dynamic-list-detect";
// ...
uploads.push(
  step.run("emit-dynamic-lists-runtime", () =>
    uploadToProject(buildId, "lib/jab/dynamic-lists.ts", emitDynamicListsTs())),
);
uploads.push(
  step.run("emit-dynamic-lists-map", () =>
    uploadToProject(
      buildId,
      "lib/jab/dynamic-lists-map.ts",
      emitDynamicListsMapTs(dynamicListSpecsFromInventory(inventoryRows, manifest)),
    )),
);
```
Use the exact variable names already in `compose-site.ts` for the `block_inventory` rows (the array passed to `emitAcfFlexFieldsTs`) and the loaded `manifest`. Confirm both are in scope at that point; if the rows variable selects a narrower column set, extend its `.select(...)` to include `kind, spec` (it already selects `block_name`).

- [ ] **Step 6: Run the full suite + commit**

Run: `cd apps/web && npx vitest run`
Expected: PASS (all).

```bash
git add apps/web/lib/jab/dynamic-list-detect.ts apps/web/lib/jab/dynamic-list-detect.test.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(saas): derive + upload DYNAMIC_LISTS map from inventory in compose worker"
```

---

## Task 8: Teach the component generator the dynamic-list contract

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` (`acfFlexPrompt`)
- Modify: `apps/web/lib/inngest/functions/generate-components.ts`
- Test: `apps/web/lib/ai/component-generator.test.ts`

- [ ] **Step 1: Write the failing test** (add)

```typescript
import { acfFlexPrompt } from "./component-generator";

it("acfFlexPrompt adds the dynamic-list contract when a spec is supplied", () => {
  const entry = {
    blockName: "acf_flex/page/page_builder/upcoming_events", kind: "acf_flex",
    occurrenceCount: 1, pageSlugs: ["home"], attrSamples: [{ section_headline: "Upcoming Events" }],
    spec: { section_headline: "Upcoming Events" }, tier: "visual",
  } as Parameters<typeof acfFlexPrompt>[0];
  const prompt = acfFlexPrompt(entry, null, undefined, {
    blockName: entry.blockName!, listAbility: "jab/get-event", wrapperKey: "event",
    postType: "event", dateField: "start_date__time", order: "asc", upcomingOnly: true, limit: 12,
  });
  expect(prompt).toContain("block.attrs.items");
  expect(prompt).toContain("injected at render");
  expect(prompt).toMatch(/empty state|no .* found/i);
});

it("acfFlexPrompt omits the dynamic-list section when no spec is supplied", () => {
  const entry = {
    blockName: "acf_flex/page/page_builder/newsletter", kind: "acf_flex",
    occurrenceCount: 1, pageSlugs: ["home"], attrSamples: [{}], spec: {}, tier: "visual",
  } as Parameters<typeof acfFlexPrompt>[0];
  expect(acfFlexPrompt(entry, null)).not.toContain("block.attrs.items");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/component-generator.test.ts`
Expected: FAIL — `acfFlexPrompt` takes 3 args / no items contract.

- [ ] **Step 3: Write minimal implementation** — change `acfFlexPrompt` signature + add the section:

```typescript
import type { DynamicListSpec } from "@/lib/jab/dynamic-list-detect";

export function acfFlexPrompt(
  entry: EnrichedInventoryEntry,
  tokens: ThemeJsonTokens | null,
  guidance?: string,
  dynamicList?: DynamicListSpec | null,
): string {
  // ...existing body unchanged through postRelationWarning...
  const dynamicListSection = dynamicList
    ? `\n## Dynamic list (injected at render)\nThis layout is a placeholder for a dynamic list of "${dynamicList.postType}" items. The captured attrs above contain ONLY configuration (headline, links, padding) — the items are NOT in the attrs. At render, an array is injected as \`block.attrs.items\`, typed:\n\`\`\`ts\ninterface JabListItem { id: number; title: string; url: string; excerpt: string; image: { url: string; alt: string } | null; date: string | null; acf: Record<string, unknown> }\n\`\`\`\nRender the list by mapping over \`block.attrs.items\` (cast via \`unknown\` to \`JabListItem[]\`). Bind each card's link to \`item.url\`, title to \`item.title\`, image to \`<img src={item.image?.url} alt={item.image?.alt ?? item.title} />\` with a brand-tinted fallback when \`item.image\` is null, and the date badge/meta from \`item.date\` (and CPT-specific extras from \`item.acf\`, e.g. ticket links). When \`block.attrs.items\` is empty, render a brief empty state (e.g. "No upcoming events."). Keep the headline/links from the config attrs above. Match the attached screenshot's card count and layout.\n`
    : "";
  // ...append ${dynamicListSection} into the `user` template (next to ${postRelationWarning})...
}
```
Append `${dynamicListSection}` in the `user` template string right after `${postRelationWarning}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/component-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Resolve + pass the spec in `generate-components.ts`** — where it builds the prompt for an `acf_flex` entry, compute the dynamic-list spec from the entry + manifest and pass it:

```typescript
import { cptListMetaFromManifest, detectDynamicList } from "@/lib/jab/dynamic-list-detect";
// near where the acf_flex branch calls acfFlexPrompt(entry, tokens, guidance):
const cpts = cptListMetaFromManifest(manifest); // manifest already loaded in this worker
const attrSample = (entry.spec ?? entry.attrSamples[0] ?? {}) as Record<string, unknown>;
const dynamicList = entry.blockName ? detectDynamicList({ blockName: entry.blockName, attrSample, cpts }) : null;
const prompt = acfFlexPrompt(entry, tokens, guidance, dynamicList);
```
(Compute `cpts` once outside the per-entry loop if convenient.)

- [ ] **Step 6: Run the full suite + commit**

Run: `cd apps/web && npx vitest run`
Expected: PASS (all).

```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts apps/web/lib/inngest/functions/generate-components.ts
git commit -m "feat(saas): teach acf_flex component prompt the dynamic-list items contract"
```

---

## Task 9: Typecheck + full build verification

- [ ] **Step 1: Typecheck the emitted-runtime self-containment** — confirm `dynamic-lists-runtime.ts` has no `@/…` imports and compiles:

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full unit suite**

Run: `cd apps/web && npx vitest run`
Expected: all green.

- [ ] **Step 3: Live rebuild + manual verification (operator step)**

Trigger a fresh full build of the `two-roads` project (Issue #2 paradigm fix + this feature both flow through on a full rebuild — discovery recomputes paradigms; Phase B regenerates the event components with the items contract; compose emits the map + runtime). After deploy:
- Homepage "Upcoming Events" shows real upcoming events (cards with dates), not "No upcoming events found."
- No default WordPress Sample Page boilerplate above the footer (Issue #2).
- `/events` page shows the full upcoming list.

Record the deploy URL + a screenshot in the smoke runbook.

- [ ] **Step 4: Final commit (if any doc updates)**

```bash
git add docs/
git commit -m "docs(saas): record dynamic-list + paradigm-fix smoke results"
```

---

## Self-Review notes

- **Spec coverage:** detection (Task 2), query+filter (Tasks 3–4), normalized item shape (Task 3 `JabListItem`), generic manifest-driven mapping (Tasks 1,7), component contract (Task 8), emit/wiring (Tasks 5–7). Frontend over-fetch + filter (no plugin change): Task 4 `numberposts:100` + client filter.
- **Type consistency:** `DynamicListSpec` is defined once in `dynamic-lists-runtime.ts` (emitted) AND mirrored in `dynamic-list-detect.ts`. ⚠️ KEEP THESE STRUCTURALLY IDENTICAL — the detector builds the object the runtime consumes. Consider importing the type from one place: `dynamic-list-detect.ts` may `import type { DynamicListSpec } from "./dynamic-lists-runtime"` (server code can import the runtime's type; only the EMITTED copy must avoid `@/…`). Prefer that to avoid drift.
- **Limit/fidelity:** `limit` defaults to 12; the generated component matches the screenshot's visible card count (the visual-tier prompt includes the screenshot). Per-layout limits are a future refinement, not v1.
- **Known DRY debt:** image-pick logic is duplicated (compactly) between `related-posts-runtime.ts` and `dynamic-lists-runtime.ts` because both are self-contained emitted modules. Acceptable; note for a future shared-emitted-helper pass.
