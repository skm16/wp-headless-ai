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
 * Hydrate every relationship post-ref in `blocks` with its referenced post's
 * featured_image (and any other fields the by-slug ability returns), mutating
 * attrs in place. Returns the same `blocks` array. Fail-soft: a per-ref fetch
 * error leaves that ref unenriched rather than throwing.
 */
export async function resolveRelationshipRefs(blocks: RBlock[], callAbility: CallAbility): Promise<RBlock[]> {
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

  // 2. Fetch each unique post by-slug, building a (post_type|ID) -> fetched map.
  const fetched = new Map<string, Record<string, unknown>>();
  for (const [postType, idMap] of refByTypeId) {
    const ability = bySlugAbility(postType);
    const wrapper = bySlugWrapper(postType);
    const refs = [...idMap.values()];
    await mapWithConcurrency(refs, MAX_CONCURRENCY, async (ref) => {
      try {
        const resp = (await callAbility(ability, { slug: ref.post_name })) as Record<string, unknown>;
        const record = resp?.[wrapper];
        if (record && typeof record === "object") {
          fetched.set(`${postType}|${ref.ID}`, record as Record<string, unknown>);
        }
      } catch {
        // fail-soft: leave this ref thin.
      }
    });
  }

  // 3. Merge featured_image (+ other fetched fields) onto every ref in place.
  walk(blocks, (b) => {
    for (const arr of postRefArrays(b)) {
      for (let i = 0; i < arr.length; i++) {
        const ref = arr[i];
        const record = fetched.get(`${ref.post_type}|${ref.ID}`);
        if (record) arr[i] = { ...ref, ...record };
      }
    }
  });

  return blocks;
}
