// EMITTED RUNTIME MODULE. This source file is read verbatim by the compose
// worker (emitRelatedPostsTs) and written into the generated project at
// lib/jab/related-posts.ts. It MUST stay self-contained (no "@/..." imports):
// the WP call is dependency-injected so the generated page passes
// jabClient.callAbility and tests pass a fake.
//
// Why this exists: ACF relationship / post_object fields arrive on a block's
// attrs as thin post-refs ({ID, post_title, post_name, post_type}) with NO
// featured_image (plugin post_ref_schema). composeBlockTree is sync and cannot
// fetch, so the async page calls resolveRelationshipRefs AFTER composing and
// BEFORE rendering — it hydrates each ref with the referenced post's
// featured_image (via that CPT's by-slug ability) so components can bind it.

/** Minimal structural view of a composed block (matches RenderableBlock). */
export interface RBlock {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: RBlock[];
  _key: string;
  [k: string]: unknown;
}

/** A thin ACF relationship post-ref as the plugin serializes it. */
export interface PostRef {
  ID: number;
  post_type: string;
  post_name: string;
  post_title?: string;
  featured_image?: unknown;
  [k: string]: unknown;
}

export type CallAbility = (abilityName: string, input?: Record<string, unknown>) => Promise<unknown>;

/** A display image bound by generated components as `item.featured_image`. */
export interface ImageRef {
  url: string;
  alt?: string;
}

/**
 * Resolve a bare WP attachment ID to a display image. Injected so the runtime
 * stays self-contained + unit-testable; production wires `createWpMediaResolver`.
 * Returns null when the id can't be resolved (fail-soft).
 */
export type MediaResolver = (attachmentId: number) => Promise<ImageRef | null>;

/** Max concurrent by-slug fetches — keeps the MCP session from being stormed. */
const MAX_CONCURRENCY = 4;

export function isPostRef(v: unknown): v is PostRef {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).ID === "number" &&
    typeof (v as Record<string, unknown>).post_type === "string" &&
    typeof (v as Record<string, unknown>).post_name === "string"
  );
}

/** Every attrs value that is a non-empty array of post-refs is a relationship. */
function postRefArrays(block: RBlock): PostRef[][] {
  const out: PostRef[][] = [];
  const attrs = block.attrs;
  if (attrs && typeof attrs === "object") {
    for (const val of Object.values(attrs)) {
      if (Array.isArray(val) && val.length > 0 && val.every(isPostRef)) {
        out.push(val as PostRef[]);
      }
    }
  }
  return out;
}

function walk(blocks: RBlock[], visit: (b: RBlock) => void): void {
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    visit(b);
    if (Array.isArray(b.innerBlocks)) walk(b.innerBlocks, visit);
  }
}

/** Unique referenced IDs per post_type across the whole composed tree. */
export function collectRefsByType(blocks: RBlock[]): Map<string, Set<number>> {
  const byType = new Map<string, Set<number>>();
  walk(blocks, (b) => {
    for (const arr of postRefArrays(b)) {
      for (const ref of arr) {
        let set = byType.get(ref.post_type);
        if (!set) byType.set(ref.post_type, (set = new Set()));
        set.add(ref.ID);
      }
    }
  });
  return byType;
}

const bySlugAbility = (postType: string) =>
  `jab/get-${postType.toLowerCase().replace(/[\s_]+/g, "-")}-by-slug`;
const bySlugWrapper = (postType: string) => postType.toLowerCase().replace(/[\s-]+/g, "_");

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * ACF single-image field keys that name a post's PRIMARY image, highest
 * priority first. Two Roads beers store the can shot in `feature_image`; other
 * sites use these common variants. Checked before galleries / WP thumbnails.
 */
const PRIMARY_IMAGE_KEYS = [
  "feature_image",
  "featured_image",
  "main_image",
  "hero_image",
  "primary_image",
  "image",
  "card_image",
  "cover_image",
];

/** An ACF media value resolved to {url, alt}, or null if not an image object. */
function imageFromObject(v: unknown): ImageRef | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string" && o.url) {
      return { url: o.url, alt: typeof o.alt === "string" ? o.alt : undefined };
    }
  }
  return null;
}

/** A bare WP attachment ID (number, or numeric string) — else null. */
function attachmentId(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Normalize one ACF image value to {url, alt}, whatever its return_format:
 * a resolved media object → its url; a string URL → that url; a bare
 * attachment ID → resolved via `resolveMedia` (skipped when not injected).
 */
async function normalizeImage(v: unknown, resolveMedia?: MediaResolver): Promise<ImageRef | null> {
  const obj = imageFromObject(v);
  if (obj) return obj;
  if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return { url: v.trim() };
  const id = attachmentId(v);
  if (id != null && resolveMedia) return await resolveMedia(id);
  return null;
}

/**
 * Pick the display image from a fetched post record. Two Roads beers carry NO
 * top-level `featured_image` (no WP thumbnail) — their art lives in
 * `acf.feature_image` (+ a `gallery`). Priority: a named ACF image field →
 * the first ACF gallery/array image → the WP thumbnail → the first single
 * image-shaped ACF field. Returns null when the record carries no image.
 */
async function pickFeaturedImage(record: Record<string, unknown>, resolveMedia?: MediaResolver): Promise<ImageRef | null> {
  const acf = (record.acf && typeof record.acf === "object" && !Array.isArray(record.acf)
    ? (record.acf as Record<string, unknown>)
    : {});
  // 1. A named primary-image ACF field (covers Two Roads' acf.feature_image).
  for (const key of PRIMARY_IMAGE_KEYS) {
    if (key in acf) {
      const img = await normalizeImage(acf[key], resolveMedia);
      if (img) return img;
    }
  }
  // 2. The first ACF array whose first element is an image (e.g. gallery).
  for (const v of Object.values(acf)) {
    if (Array.isArray(v) && v.length > 0) {
      const img = await normalizeImage(v[0], resolveMedia);
      if (img) return img;
    }
  }
  // 3. The WP post thumbnail, if the plugin populated one.
  const thumb = await normalizeImage(record.featured_image, resolveMedia);
  if (thumb) return thumb;
  // 4. Any remaining single image-shaped ACF field.
  for (const v of Object.values(acf)) {
    const img = await normalizeImage(v, resolveMedia);
    if (img) return img;
  }
  return null;
}

/**
 * Build a {@link MediaResolver} backed by the WP REST media endpoint, using the
 * same WP_URL / WP_USER / WP_APP_PASSWORD env the jab client uses. Server-only.
 * Returns a no-op resolver (always null) when that env is absent, and caches by
 * id so repeated refs cost one fetch. The emitted page passes this to
 * `resolveRelationshipRefs`; unit tests inject a fake instead.
 */
export function createWpMediaResolver(): MediaResolver {
  const base = (process.env.WP_URL ?? "").replace(/\/+$/, "");
  const user = process.env.WP_USER ?? "";
  const pw = process.env.WP_APP_PASSWORD ?? "";
  if (!base || !user || !pw) return async () => null;
  const auth = "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");
  const cache = new Map<number, ImageRef | null>();
  return async (attachmentId: number): Promise<ImageRef | null> => {
    if (cache.has(attachmentId)) return cache.get(attachmentId) ?? null;
    let result: ImageRef | null = null;
    try {
      const r = await fetch(`${base}/wp-json/wp/v2/media/${attachmentId}`, {
        headers: { Authorization: auth },
      });
      if (r.ok) {
        const m = (await r.json()) as { source_url?: string; alt_text?: string };
        if (m?.source_url) result = { url: m.source_url, alt: m.alt_text ?? "" };
      }
    } catch {
      // fail-soft: unresolved id renders the component's graceful fallback.
    }
    cache.set(attachmentId, result);
    return result;
  };
}

/**
 * Hydrate every relationship post-ref in `blocks` with its referenced post's
 * display image (bound by components as `item.featured_image`) plus the other
 * fields the by-slug ability returns, mutating attrs in place. Returns the same
 * `blocks` array. The image is sourced via {@link pickFeaturedImage} (ACF image
 * field → gallery → WP thumbnail), normalizing object / URL / attachment-ID
 * forms — the last via the optional `resolveMedia`. Fail-soft: a per-ref fetch
 * error leaves that ref unenriched rather than throwing.
 */
export async function resolveRelationshipRefs(
  blocks: RBlock[],
  callAbility: CallAbility,
  resolveMedia?: MediaResolver,
): Promise<RBlock[]> {
  // 1. Collect unique (post_type, ID) refs. We need slugs to call by-slug, so
  //    also capture a representative ref (ID -> ref) per type from the tree.
  const refByTypeId = new Map<string, Map<number, PostRef>>();
  walk(blocks, (b) => {
    for (const arr of postRefArrays(b)) {
      for (const ref of arr) {
        let m = refByTypeId.get(ref.post_type);
        if (!m) refByTypeId.set(ref.post_type, (m = new Map()));
        if (!m.has(ref.ID)) m.set(ref.ID, ref);
      }
    }
  });
  if (refByTypeId.size === 0) return blocks;

  // 2. Fetch each unique post by-slug, then derive its display image. Store
  //    both keyed by (post_type|ID). Image derivation is awaited HERE (the
  //    async phase) so the merge below can stay a synchronous tree-walk.
  const fetched = new Map<string, { record: Record<string, unknown>; image: ImageRef | null }>();
  for (const [postType, idMap] of refByTypeId) {
    const ability = bySlugAbility(postType);
    const wrapper = bySlugWrapper(postType);
    const refs = [...idMap.values()];
    await mapWithConcurrency(refs, MAX_CONCURRENCY, async (ref) => {
      try {
        const resp = (await callAbility(ability, { slug: ref.post_name })) as Record<string, unknown>;
        const record = resp?.[wrapper];
        if (record && typeof record === "object") {
          const rec = record as Record<string, unknown>;
          const image = await pickFeaturedImage(rec, resolveMedia);
          fetched.set(`${postType}|${ref.ID}`, { record: rec, image });
        }
      } catch {
        // fail-soft: leave this ref thin.
      }
    });
  }

  // 3. Merge the fetched fields + the derived display image onto every ref in
  //    place. `featured_image` is set to the sourced image so components that
  //    bind `item.featured_image.url` render the real art (the can shot), not
  //    the WP thumbnail (absent for Two Roads beers).
  walk(blocks, (b) => {
    for (const arr of postRefArrays(b)) {
      for (let i = 0; i < arr.length; i++) {
        const ref = arr[i];
        const hit = fetched.get(`${ref.post_type}|${ref.ID}`);
        if (hit) {
          const merged = { ...ref, ...hit.record };
          if (hit.image) merged.featured_image = hit.image;
          arr[i] = merged;
        }
      }
    }
  });

  return blocks;
}
