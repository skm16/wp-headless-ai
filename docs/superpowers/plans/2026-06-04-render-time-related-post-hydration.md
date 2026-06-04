# Render-Time Related-Post Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated JAB sites render real featured images for ACF relationship/post-object content (e.g. the Two Roads "Featured Offerings" beers) by hydrating the thin post-refs at render time from the WP connection, then teaching the component generator to bind those images.

**Architecture:** The generated homepage already live-fetches its page via `jabClient.callAbility(...)` (ISR, `revalidate=60`) and walks it with the **synchronous, pure** `composeBlockTree`. An ACF relationship field surfaces at `block.attrs.<field>` as an array of bare post-refs `{ID, post_title, post_name, post_type}` with **no image**. We add a new **async** step in the emitted page — `resolveRelationshipRefs(blocks, callAbility)` — that runs *after* `composeBlockTree` and *before* the dispatcher map. It walks the composed tree, structurally detects post-ref arrays, dedupes them, fetches each referenced post via its `jab/get-<post_type>-by-slug` ability (which returns `featured_image`), and merges `featured_image` onto each ref **in place**. Because the data lands back on `block.attrs` verbatim, generated block components need no prop-contract change — they just read the now-present `featured_image`. In lockstep we flip the component-generator prompts (which currently tell the LLM "no image exists, draw no placeholder") to "these items are hydrated with `featured_image` — bind it."

**Tech Stack:** TypeScript, Next.js App Router (server components, ISR), Vitest, the JAB `@jab/core` SDK client, the emitted generated-project runtime (`lib/jab/*`), Anthropic-driven component generation (`apps/web/lib/ai/component-generator.ts`).

---

## Context an engineer needs before starting

These facts were established by reading the codebase (compose runtime, component generator, emitted client, plugin schema). Trust them; re-verify line numbers since the files change.

1. **`composeBlockTree` is synchronous and pure** ([apps/web/lib/jab/compose-block-tree-runtime.ts:42-61](../../../apps/web/lib/jab/compose-block-tree-runtime.ts)). It returns `RenderableBlock[]` and **must stay sync** — both page emitters and four paradigm synths call it without `await`, and the runtime file forbids `@/*` imports. **Do not make it async.** Resolution is a *separate* awaited step in the page.

2. **`RenderableBlock` shape** (runtime lines 13-27):
   ```ts
   interface BlockNode { blockName: string | null; attrs: Record<string, unknown>; innerBlocks?: BlockNode[]; innerHTML?: string; }
   type RenderableBlock = Omit<BlockNode, "innerBlocks"> & { _key: string; innerBlocks?: RenderableBlock[] };
   ```

3. **ACF flex layouts** become one block whose **entire raw ACF item is `attrs`** (runtime `synthAcfFlex`, ~line 92): `attrs: item as Record<string, unknown>`. So a relationship sub-field `featured_beers` arrives intact at `block.attrs.featured_beers` as `[{ID, post_title, post_name, post_type}, ...]`. The **field name is per-site and unknown at build time** — detect post-ref arrays *structurally*, never by a hardcoded key. ACF-template pages also pass `acf` through to `attrs` (`synthAcfTemplate`), so post-refs can appear outside `acf_flex` too — **walk the whole composed `RenderableBlock[]`** to cover all paradigms.

4. **The post-ref shape is thin** (plugin `Acf\Schema::post_ref_schema`, [packages/wp-plugin/includes/Acf/Schema.php:720-736](../../../packages/wp-plugin/includes/Acf/Schema.php)): only `{ID, post_title, post_name, post_type, post_date, post_status}` — **no `featured_image`**. That is why the LLM drew a placeholder.

5. **Per-CPT abilities return `featured_image`.** The list ability's `shape_row` and the by-slug ability both include `featured_image` (a `{url, alt, width, height}`-ish object or `null`). The by-slug ability name is **deterministically** `jab/get-<kebab(post_type)>-by-slug`; its response is wrapper-keyed by `snake(post_type)` (e.g. `response.beer`). This is why we use by-slug per unique ref — **no `rest_base`/manifest map needed**.

6. **The emitted client** is `jabClient` (`lib/jab/client.ts`, rendered by `renderJabClient` in `@jab/core`). It exposes `callAbility<TInput, TOutput>(abilityName, input?, requestOptions?): Promise<TOutput>`. It does a one-time MCP handshake (a shared `initPromise` dedupes concurrent first-callers — safe for `Promise.all`), but has **no session-expiry refresh**. MCP concurrency is a real constraint (parallel prerender storms were documented in the New-Ink-Site reference) — so **dedupe refs and cap concurrency**; rely on ISR for caching.

7. **Generated-project runtime files are emitted, not imported.** A new runtime module must be a self-contained source file under `apps/web/lib/jab/` that the compose worker reads (`readFileSync`) and uploads into the build tree (mirror `emit-compose-block-tree` at [apps/web/lib/inngest/functions/compose-site.ts:429-433](../../../apps/web/lib/inngest/functions/compose-site.ts)). It must typecheck under the compile gate (`JAB_COMPOSE_TYPECHECK`).

8. **`next/image` already whitelists the WP host** (`emitNextConfigTs` builds `remotePatterns` from `new URL(wpUrl).hostname`), and the emitted `MediaImage` shim branches `next/image` vs plain `<img>` by host. So a beer `featured_image.url` (on the `wp_url` uploads host) renders without config changes.

9. **Component generator prompts currently say the opposite of what we want.** Three sites tell the LLM relationship items carry **no** image and to avoid placeholders: the shared system-prompt "Image binding contract" (~[component-generator.ts:86-100](../../../apps/web/lib/ai/component-generator.ts)), the `acf_flex` `postRelationWarning` (~:564-566), and the `cpt_template` `summarizeAcfFields` post-relation branch (~:432-444). Pinned tests assert the current strings (~:208, :209, :297, :371). All must flip in lockstep with the runtime hydration.

### OUT OF SCOPE (do not implement here)

- **"Upcoming Events" section.** It is a *dynamic date-windowed query*, not a relationship — the ACF carries no refs (it renders "No upcoming events at this time"). It needs a different render-time path (call `jab/get-events` with `date_after`). **Crucially, if events filter on an ACF meta date (e.g. `event_start_date`) rather than `post_date`, the v0.7.0 list ability cannot reproduce it** (no `meta_query` filter), which would require a plugin change. Verify the event CPT's date semantics first; planned separately.
- **`content_ownership` wiring** into compose/discover (separate gap).
- **A media-URL host-rewrite helper** (New-Ink-Site's `rewriteWpMediaUrl`) — only needed post-cutover; Two Roads media is already on the WP origin host.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `apps/web/lib/jab/related-posts-runtime.ts` | Self-contained, dependency-injected render-time resolver: detect post-ref arrays, dedupe, fetch each via by-slug, merge `featured_image` in place. Emitted into the build tree as `lib/jab/related-posts.ts`. | Create |
| `apps/web/lib/jab/related-posts-runtime.test.ts` | Unit tests for the resolver (pure detection + merge + a fake `callAbility`). | Create |
| `apps/web/lib/jab/compose-site-emit.ts` | Add `emitRelatedPostsTs()`; wire `resolveRelationshipRefs` into `emitHomepageTsx` + `emitCatchAllPageTsx`. | Modify |
| `apps/web/lib/jab/compose-site-emit.test.ts` | Tests for the emitter + updated page-emit assertions. | Modify |
| `apps/web/lib/inngest/functions/compose-site.ts` | Add an `emit-related-posts` upload step. | Modify |
| `apps/web/lib/ai/component-generator.ts` | Flip the three relationship-image prompt sites to bind `featured_image`. | Modify |
| `apps/web/lib/ai/component-generator.test.ts` | Update pinned assertions to the new directive. | Modify |

---

## Task 1: Render-time resolver runtime module (pure + DI'd)

**Files:**
- Create: `apps/web/lib/jab/related-posts-runtime.ts`
- Test: `apps/web/lib/jab/related-posts-runtime.test.ts`

The module is **self-contained** (no `@/*` imports) so it both unit-tests in `apps/web` and emits cleanly into the generated project. The WP call is injected as a `callAbility` function so tests pass a fake.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/related-posts-runtime.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  isPostRef,
  collectRefsByType,
  resolveRelationshipRefs,
  type RBlock,
} from "./related-posts-runtime";

const beerRef = (id: number, slug: string) => ({
  ID: id, post_title: `Beer ${id}`, post_name: slug, post_type: "beer",
});

describe("isPostRef", () => {
  it("accepts a thin post-ref object", () => {
    expect(isPostRef(beerRef(12, "road-2-ruin"))).toBe(true);
  });
  it("rejects non-refs (missing ID / post_type / post_name)", () => {
    expect(isPostRef({ post_title: "x" })).toBe(false);
    expect(isPostRef({ ID: 1, post_type: "beer" })).toBe(false);
    expect(isPostRef(null)).toBe(false);
    expect(isPostRef("road-2-ruin")).toBe(false);
  });
});

describe("collectRefsByType", () => {
  it("walks blocks + innerBlocks and groups unique refs by post_type", () => {
    const blocks: RBlock[] = [
      { blockName: "acf_flex/page/pb/featured", _key: "a",
        attrs: { featured_beers: [beerRef(1, "a"), beerRef(2, "b")], heading: "Featured" } },
      { blockName: "acf_flex/page/pb/more", _key: "b",
        attrs: { picks: [beerRef(2, "b")] },           // dup id 2 collapses
        innerBlocks: [
          { blockName: "x", _key: "c", attrs: { events: [{ ID: 9, post_title: "E", post_name: "e", post_type: "event" }] } },
        ] },
    ];
    const map = collectRefsByType(blocks);
    expect([...(map.get("beer") ?? [])].sort()).toEqual([1, 2]);
    expect([...(map.get("event") ?? [])]).toEqual([9]);
  });
  it("ignores arrays that are not all post-refs", () => {
    const blocks: RBlock[] = [
      { blockName: "x", _key: "a", attrs: { tags: ["ipa", "lager"], mixed: [beerRef(1, "a"), { foo: 1 }] } },
    ];
    expect(collectRefsByType(blocks).size).toBe(0);
  });
});

describe("resolveRelationshipRefs", () => {
  it("fetches each unique ref by-slug and merges featured_image in place", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { featured_beers: [beerRef(1, "road-2-ruin"), beerRef(2, "cruise")] } },
    ];
    const callAbility = vi.fn(async (name: string, input: any) => {
      expect(name).toBe("jab/get-beer-by-slug");
      const map: Record<string, unknown> = {
        "road-2-ruin": { ID: 1, post_title: "Road 2 Ruin", featured_image: { url: "https://wp/r2r.png", alt: "R2R" } },
        "cruise": { ID: 2, post_title: "Cruise Control", featured_image: { url: "https://wp/cc.png", alt: "CC" } },
      };
      return { beer: map[input.slug] };  // wrapper key = snake(post_type)
    });

    const out = await resolveRelationshipRefs(blocks, callAbility);

    const refs = out[0].attrs.featured_beers as any[];
    expect(refs[0].featured_image.url).toBe("https://wp/r2r.png");
    expect(refs[1].featured_image.url).toBe("https://wp/cc.png");
    // one call per unique slug
    expect(callAbility).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeated refs across blocks into a single fetch", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { picks: [beerRef(1, "road-2-ruin")] } },
      { blockName: "g", _key: "b", attrs: { more: [beerRef(1, "road-2-ruin")] } },
    ];
    const callAbility = vi.fn(async () => ({ beer: { ID: 1, featured_image: { url: "u", alt: "" } } }));
    await resolveRelationshipRefs(blocks, callAbility);
    expect(callAbility).toHaveBeenCalledTimes(1);
  });

  it("is fail-soft: a fetch error leaves the ref unenriched, others still resolve", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { b: [beerRef(1, "ok"), beerRef(2, "boom")] } },
    ];
    const callAbility = vi.fn(async (_n: string, input: any) => {
      if (input.slug === "boom") throw new Error("WP 500");
      return { beer: { ID: 1, featured_image: { url: "u", alt: "" } } };
    });
    const out = await resolveRelationshipRefs(blocks, callAbility);
    const refs = out[0].attrs.b as any[];
    expect(refs[0].featured_image.url).toBe("u");
    expect(refs[1].featured_image).toBeUndefined();   // unenriched, no throw
  });

  it("no post-refs → no calls, returns the same blocks", async () => {
    const blocks: RBlock[] = [{ blockName: "p", _key: "a", attrs: { content: "hi" } }];
    const callAbility = vi.fn();
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect(callAbility).not.toHaveBeenCalled();
    expect(out).toBe(blocks);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run lib/jab/related-posts-runtime.test.ts`
Expected: FAIL — `Cannot find module './related-posts-runtime'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/jab/related-posts-runtime.ts
//
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run lib/jab/related-posts-runtime.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/related-posts-runtime.ts apps/web/lib/jab/related-posts-runtime.test.ts
git commit -m "feat(saas): render-time related-post resolver runtime (by-slug featured_image hydration)"
```

---

## Task 2: Emit the resolver into the generated project

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (add `emitRelatedPostsTs`)
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (add upload step)

The emitter reads the runtime source file and returns it verbatim (no import-rewrite needed — the module is self-contained). Mirror the `emit-compose-block-tree` pattern that `readFileSync`s `compose-block-tree-runtime.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// add to apps/web/lib/jab/compose-site-emit.test.ts
import { emitRelatedPostsTs } from "./compose-site-emit";

describe("compose-site-emit — related-posts runtime", () => {
  it("emits a self-contained module exporting resolveRelationshipRefs with no @/ imports", () => {
    const src = emitRelatedPostsTs();
    expect(src).toMatch(/export async function resolveRelationshipRefs/);
    expect(src).toMatch(/export function isPostRef/);
    // self-contained: must not import from the generated-project alias.
    expect(src).not.toMatch(/from ["']@\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts -t "related-posts runtime"`
Expected: FAIL — `emitRelatedPostsTs` is not exported.

- [ ] **Step 3: Implement the emitter**

Add near `emitJabClientTs` in `apps/web/lib/jab/compose-site-emit.ts`. Note `compose-site-emit.ts` already imports `readFileSync`/`join` is used in `compose-site.ts`, not here — so use `node:fs`/`node:path` directly:

```ts
// apps/web/lib/jab/compose-site-emit.ts (add imports at top if absent)
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Emit the render-time related-post resolver into the generated project at
 * lib/jab/related-posts.ts. Read verbatim from related-posts-runtime.ts (a
 * self-contained, DI'd module — no import rewrite needed).
 */
export function emitRelatedPostsTs(): string {
  return readFileSync(join(process.cwd(), "lib/jab/related-posts-runtime.ts"), "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts -t "related-posts runtime"`
Expected: PASS.

- [ ] **Step 5: Wire the upload step into the compose worker**

In `apps/web/lib/inngest/functions/compose-site.ts`, add to the import from `@/lib/jab/compose-site-emit` the name `emitRelatedPostsTs`, then add an upload step next to `emit-compose-block-tree` (~line 429):

```ts
uploads.push(
  step.run("emit-related-posts", () =>
    uploadToProject(buildId, "lib/jab/related-posts.ts", emitRelatedPostsTs()),
  ),
);
```

- [ ] **Step 6: Typecheck + run the emit suite**

Run: `cd apps/web && pnpm typecheck && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(saas): emit related-posts resolver into generated project tree"
```

---

## Task 3: Wire the resolver into the emitted pages

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (`emitHomepageTsx`, `emitCatchAllPageTsx`)
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

Both emitted pages call `composeBlockTree(...)` then `.map(BlockDispatcher)`. Insert an `await resolveRelationshipRefs(blocks, ...)` between them. The resolver mutates in place and returns the same array.

- [ ] **Step 1: Write the failing test**

```ts
// add to apps/web/lib/jab/compose-site-emit.test.ts (within the app/layout / homepage describe area)
describe("compose-site-emit — homepage wires render-time relation hydration", () => {
  it("awaits resolveRelationshipRefs between composeBlockTree and the dispatcher", () => {
    const src = emitHomepageTsx({
      slug: "home", abilityName: "jab/get-pages-by-slug", wrapperKey: "page",
      paradigms: ["acf_flex"], postType: "page",
    });
    expect(src).toMatch(/import \{ resolveRelationshipRefs \} from "@\/lib\/jab\/related-posts"/);
    expect(src).toMatch(/const blocks = composeBlockTree\(/);
    expect(src).toMatch(/await resolveRelationshipRefs\(blocks, \(name, input\) => jabClient\.callAbility\(name, input\)\)/);
    // hydration must run before the dispatcher map
    expect(src.indexOf("resolveRelationshipRefs")).toBeLessThan(src.indexOf("BlockDispatcher"));
  });

  it("catch-all page wires the same hydration", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toMatch(/import \{ resolveRelationshipRefs \} from "@\/lib\/jab\/related-posts"/);
    expect(src).toMatch(/await resolveRelationshipRefs\(blocks, \(name, input\) => jabClient\.callAbility\(name, input\)\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts -t "render-time relation hydration"`
Expected: FAIL — the import + await line are absent.

- [ ] **Step 3: Update `emitHomepageTsx`**

In the returned template literal, add the import and the await. The current body (verify exact text in the file) is:

```ts
import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";
```
Add a line:
```ts
import { resolveRelationshipRefs } from "@/lib/jab/related-posts";
```
And change the page body from:
```ts
  const blocks = composeBlockTree(
    record as Parameters<typeof composeBlockTree>[0],
    ${JSON.stringify(input.postType)},
    ${JSON.stringify(input.paradigms)},
    { acfFlexFields: ACF_FLEX_FIELDS },
  );
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
```
to:
```ts
  const blocks = composeBlockTree(
    record as Parameters<typeof composeBlockTree>[0],
    ${JSON.stringify(input.postType)},
    ${JSON.stringify(input.paradigms)},
    { acfFlexFields: ACF_FLEX_FIELDS },
  );
  await resolveRelationshipRefs(blocks, (name, input) => jabClient.callAbility(name, input));
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
```

- [ ] **Step 4: Update `emitCatchAllPageTsx`** the same way

Add the `import { resolveRelationshipRefs } from "@/lib/jab/related-posts";` line and insert `await resolveRelationshipRefs(blocks, (name, input) => jabClient.callAbility(name, input));` immediately after its `const blocks = composeBlockTree(...)` and before the `return ( <main ...`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS (new tests + all existing homepage/catch-all assertions still green).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: no errors. (The emitted strings aren't typechecked here, but the emitter source is.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): hydrate relationship refs in emitted homepage + catch-all pages"
```

---

## Task 4: Flip the component-generator prompts to bind `featured_image`

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts`
- Modify: `apps/web/lib/ai/component-generator.test.ts`

Now that relationship items are hydrated at render, the generator must tell the LLM to bind `item.featured_image.url` (with a graceful fallback when absent), instead of "no image exists, draw no placeholder." Three coordinated sites.

> **Correction applied during execution (commit `1a361cd`):** the prompt strings below originally instructed `<MediaImage src={item.featured_image.url} ... />`. That is WRONG — the emitted `MediaImage` shim signature is `MediaImage({ block }: { block: BlockNode })` (it takes a Gutenberg block, not `src`/`alt`, and is dispatcher-wired for `core/image` only — not LLM-importable). Emitting `<MediaImage src=.../>` would fail the `tsc --noEmit` compile gate. The shipped prompts bind a plain `<img src={item.featured_image.url} alt={item.featured_image.alt ?? item.post_title} />` instead (`next/image` would require explicit `width`/`height` and also fail the gate if omitted). The test assertions assert `<img`, not `<MediaImage`. Read the actual committed `component-generator.ts`/`.test.ts` as the source of truth, not the `<MediaImage>` snippets below.

- [ ] **Step 1: Update the pinned tests first (red)**

In `apps/web/lib/ai/component-generator.test.ts`, replace the assertions that pin the OLD message. Find the `acf_flex` prompt test (~:208-209) asserting `/NO featured_image/` and `do NOT render a literal placeholder box`, and change them to assert the new directive:

```ts
// acf_flex prompt with a relationship sample present
expect(out).toMatch(/hydrated at render with a `featured_image`/);
expect(out).toMatch(/render `<MediaImage[^`]*src=\{[^}]*featured_image\.url\}/);
expect(out).not.toMatch(/do NOT render a literal placeholder box/);
```
For the test (~:297) asserting `not.toMatch(/NO featured_image/)` on a non-relationship sample, leave it (no relationship → no directive). For the `cpt_template` schema test (~:371), update similarly to expect the bind directive when the schema's array items are post-records.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm exec vitest run lib/ai/component-generator.test.ts`
Expected: FAIL — generator still emits the old "NO featured_image" text.

- [ ] **Step 3: Update the `acf_flex` `postRelationWarning`** (~component-generator.ts:564-566)

Replace the warning string. Current (verify in file):
```ts
const postRelationWarning = postRelationFields.length > 0
  ? `\n## Post-relation fields detected in sample\nThese sample-attr fields contain arrays of bare WP_Post records ({ID, post_title, post_name, post_type, ...}) and carry NO featured_image / image URL by default: ${postRelationFields.map((f) => `\`${f}\``).join(", ")}.\nApply the Image binding contract: do NOT render literal placeholder boxes for these items. Use a brand-tinted color block, gradient, or icon — or omit the image area entirely.\n`
  : "";
```
New:
```ts
const postRelationWarning = postRelationFields.length > 0
  ? `\n## Post-relation fields (hydrated at render)\nThese fields are arrays of related posts: ${postRelationFields.map((f) => `\`${f}\``).join(", ")}. At render time each item is hydrated at render with a \`featured_image\` object \`{ url, alt }\` (plus its title/slug). Bind the image: render \`<MediaImage src={item.featured_image.url} alt={item.featured_image.alt ?? item.post_title} ... />\` for each item. Guard for the rare missing image: when \`item.featured_image?.url\` is absent, fall back to a brand-tinted block — never a literal "placeholder" box.\n`
  : "";
```

- [ ] **Step 4: Update the `cpt_template` post-relation branch** (~component-generator.ts:432-444 in `summarizeAcfFields`)

Replace the line pushed for post-record arrays. Current pushes "NO featured_image / image URL is present by default ... do NOT render a literal placeholder box." New:
```ts
lines.push(
  `- ${name}: array of related posts — each item is hydrated at render with { post_title, post_name, featured_image: { url, alt } }. Bind the image via <MediaImage src={item.featured_image.url} alt={item.featured_image.alt ?? item.post_title} />; if featured_image is missing, fall back to a brand-tinted block.`,
);
```

- [ ] **Step 5: Update the shared system-prompt Image binding contract** (~component-generator.ts:86-100)

Replace the hard sentences that say relationship arrays "return bare WP_Post records ... no featured_image field" and "There is no runtime magic that fills in missing image URLs." New text:
```
- Relationship / post_object arrays ARE hydrated at render: each item carries
  `featured_image: { url, alt }` alongside `post_title` / `post_name`. Bind the
  image (MediaImage/next-image/<img>) to `item.featured_image.url`. Only when
  `item.featured_image?.url` is genuinely absent, fall back to a brand-tinted
  block — never emit a gray "placeholder" box or a fake `<XPlaceholderImage>`.
```
(Keep the rest of the contract intact. This busts the system-prompt cache — expected, cost-only.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run lib/ai/component-generator.test.ts`
Expected: PASS with the new directives.

- [ ] **Step 7: Typecheck + full app suite**

Run: `cd apps/web && pnpm typecheck && pnpm exec vitest run`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts
git commit -m "feat(saas): generate relationship components that bind hydrated featured_image"
```

---

## Task 5: Live validation against Two Roads (manual, gated on spend)

**Files:** none (operator validation).

This task confirms the end-to-end result on the pilot. It requires a paid compose+deploy and a component regeneration (so Phase B re-runs with the new prompts). Coordinate with the operator before spending.

- [ ] **Step 1: Re-generate components + compose + deploy**

A targeted `jab-fix-build resume` only re-composes; it does **not** re-run Phase B component generation, so the beer component keeps its placeholder. To pick up the prompt flip, the Featured Offerings component must be regenerated. Either trigger a fresh build for the Two Roads project, or re-run the components phase for the relationship block type, then let compose + deploy proceed. (Operator chooses the cheapest path; document which.)

- [ ] **Step 2: Verify via Playwright on the new deployment**

After the build reaches `ready`, navigate to the new preview URL and confirm in the "Featured Offerings" cards:
- Each beer card renders a real `<img>`/`next-image` whose `naturalWidth > 0` (not the SVG placeholder, not alt text).
- The image `src` is a real `wp-content/uploads` URL on the WP host, returning HTTP 200.
- Console has no new errors.

- [ ] **Step 3: Record the outcome**

Note the build id + preview URL + before/after screenshots in the build's review notes. If images render, mark the beer-image item resolved. If not, capture the rendered beer-card HTML + the fetched `jab/get-beer-by-slug` response shape for diagnosis (most likely: the by-slug wrapper key or `featured_image` field name differs — adjust `bySlugWrapper`/the merge in `related-posts-runtime.ts`).

---

## Self-Review

**Spec coverage:**
- Render-time hydration of relationship featured images (beers) → Tasks 1–3. ✓
- Components bind the hydrated image → Task 4. ✓
- Uses current plugin (v0.7.1), app-only, no plugin release → by-slug ability is already registered per CPT; no schema/PHP change. ✓
- Live validation → Task 5. ✓
- Events explicitly deferred with the meta-date caveat → Context "OUT OF SCOPE". ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step has full code; prompt edits quote the new strings verbatim. ✓

**Type consistency:** `RBlock`/`PostRef`/`CallAbility`/`resolveRelationshipRefs`/`collectRefsByType`/`isPostRef` are defined in Task 1 and referenced unchanged in Tasks 2–3. The emitted page calls `resolveRelationshipRefs(blocks, (name, input) => jabClient.callAbility(name, input))`, matching the `CallAbility` signature. ✓

**Known risk to watch during execution:** the by-slug response wrapper key is derived as `snake(post_type)`. If a CPT has a collision-suffixed by-slug ability or a `rest_base`-divergent wrapper, the merge will no-op (fail-soft → ref stays thin → graceful fallback renders). Task 5 Step 3 covers detecting and correcting this against the live response.
