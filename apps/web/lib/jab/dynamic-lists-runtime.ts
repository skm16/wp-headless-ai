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
    // Prefer the ACF date (events: start_date__time). Fall back to the WP
    // published date so blog/news lists — which have no ACF date field —
    // still surface a date on each card.
    date: pickDate(rec, acf, opts.dateField),
    acf,
  };
}

function pickDate(rec: RawRecord, acf: Record<string, unknown>, dateField: string | null): string | null {
  if (dateField && typeof acf[dateField] === "string") return acf[dateField] as string;
  const published = (rec as { date?: unknown; date_gmt?: unknown }).date ?? (rec as { date_gmt?: unknown }).date_gmt;
  return typeof published === "string" ? published : null;
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
      // filter client-side. numberposts is capped at the plugin's 100 ceiling.
      // Only `numberposts` is sent: the list ability declares
      // additionalProperties:false and already returns `acf` + `featured_image`
      // by default, so we pass nothing else (no `include` — lists don't carry
      // blocks/content, and an unverified sub-shape there risks a hard reject
      // that would silently empty the list).
      const resp = (await callAbility(spec.listAbility, { numberposts: 100 })) as Record<string, unknown>;
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
