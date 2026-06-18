# Posts-Front Blog-Index in Live Draft + Review/Fidelity Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For WordPress sites whose Reading setting is "Your latest posts" (`show_on_front="posts"`), make the Live Draft preview render the latest-posts homepage (instead of `not_found`) AND give that synthesized homepage a `page_inventory` `/` row so it is captured, fidelity-scored, and shown on the review screen — closing both halves of the independent-review High finding.

**Architecture:** The deployed side already works ([resolveHomepageEmit](../../../apps/web/lib/jab/homepage-emit.ts) + [emitBlogIndexTsx](../../../apps/web/lib/jab/compose-site-emit.ts) emit a real latest-posts `app/page.tsx` via the posts list ability + `normalizeRecord`). **Half A** mirrors that runtime in the draft: `resolveDraftRoute` gains a `blogIndex` resolution, `loadDraftPageData` calls the list ability server-side and returns a new `{ kind: "blogIndex", heading, items }` result, and the draft browser runtime (`entry.tsx`) renders the list with the same JSX/classNames `emitBlogIndexTsx` uses. **Half B** makes discovery synthesize a stable blog-index `page_inventory` row (`route_path="/"`, the WP home URL as its capture source) so the existing capture → verify-fidelity → review machinery covers it unchanged. No LLM runs in either path; no DB migration (rides existing `site_builds.config` JSONB + `page_inventory` columns).

**Tech Stack:** TypeScript, Next.js 15 (App Router server route + a browser esbuild bundle), React 18 (draft runtime), Supabase (Postgres + private Storage), Playwright (discovery/verify capture — not unit-tested), Vitest. Shared list runtime: `normalizeRecord` / `JabListItem` (`lib/jab/dynamic-lists-runtime.ts`).

## Global Constraints

- **The draft must MIRROR the deployed blog-index exactly.** Same list ability + wrapper key (from `listAbilityMetaFor`), same `normalizeRecord` call (`{ dateField: null, resolveMedia, postType: "post" }`), same local `/<postType>/<slug>` card links, and the SAME `limit` (12) and `heading` ("Latest Posts"). To prevent drift, these two values become shared constants used by BOTH `emitBlogIndexTsx`'s caller and the draft.
- **No LLM in the draft or discovery path.** This is deterministic data assembly only.
- **No DB migration.** `show_on_front` already lives in `site_builds.config` (written by `buildFrontPageConfigPatch`); the synthesized page row uses existing `page_inventory` columns.
- **Half B's synthesized row must not break existing consumers.** It carries `block_count: 0`, `paradigms: []`, an empty `block_tree`, a stable reserved slug, and `post_type: "post"`. Counts, carry-forward (slug-keyed), capture, verify-fidelity, and the review screen must all keep working; edit builds inherit it via the existing page_inventory clone (no edit-build code change).
- **Errors stay loud.** A posts-front site with no registered posts list ability must fail loudly in the draft (a typed `error` result), exactly as the deployed `resolveHomepageEmit` throws.
- **Both Supabase projects** — no migration here, so nothing to apply; this constraint is noted only to confirm there is no DB step.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands:** single file `pnpm --filter @jab/web test -- <path>`; full suite `pnpm --filter @jab/web test`; typecheck `pnpm --filter @jab/web run typecheck`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/web/lib/jab/homepage-emit.ts` | Shared blog-index constants (`BLOG_INDEX_LIMIT`, `BLOG_INDEX_HEADING`) + (Task 5) the synthesized-row/descriptor helper + reserved slug. | Modify |
| `apps/web/lib/inngest/functions/compose-site.ts` | Use the shared constants in the `emitBlogIndexTsx` call (drift guard). | Modify |
| `apps/web/lib/draft/route-resolve.ts` | `resolveDraftRoute` gains a `showOnFront` param + a `blogIndex` resolution kind (mirrors `resolveHomepageEmit`'s posts branch). | Modify |
| `apps/web/lib/draft/route-resolve.test.ts` | Tests for the blogIndex resolution + back-compat. | Modify |
| `apps/web/lib/draft/page-data.ts` | New `loadShowOnFront` dep + a blog-index branch returning `{ kind: "blogIndex", heading, items }`; wire dep in `defaultDraftPageDeps`. | Modify |
| `apps/web/lib/draft/page-data.test.ts` | Tests for the blog-index data path (dep-injected). | Modify |
| `apps/web/app/api/draft/[projectId]/page/route.ts` | Map the `blogIndex` result kind to HTTP 200. | Modify |
| `apps/web/lib/draft/runtime/entry.tsx` | Render the `blogIndex` result kind (list JSX mirroring `emitBlogIndexTsx`). | Modify |
| `apps/web/lib/inngest/functions/discover-site.ts` | When `show_on_front="posts"`, add the blog-index capture descriptor + synthesized page row. | Modify |
| `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md` | Mark finding #1 fully closed; note residuals. | Modify |
| `CLAUDE.md` | Snapshot line. | Modify |

---

### Task 1: Shared blog-index constants (drift guard)

**Files:**
- Modify: `apps/web/lib/jab/homepage-emit.ts`
- Modify: `apps/web/lib/inngest/functions/compose-site.ts:459-465`
- Test: `apps/web/lib/jab/homepage-emit.test.ts`

**Interfaces:**
- Produces: `BLOG_INDEX_LIMIT = 12`, `BLOG_INDEX_HEADING = "Latest Posts"` exported from `homepage-emit.ts`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/homepage-emit.test.ts` (create if missing, importing from `./homepage-emit`):

```ts
import { BLOG_INDEX_LIMIT, BLOG_INDEX_HEADING } from "./homepage-emit";

describe("blog-index constants", () => {
  it("pins the deployed defaults so the draft can mirror them", () => {
    expect(BLOG_INDEX_LIMIT).toBe(12);
    expect(BLOG_INDEX_HEADING).toBe("Latest Posts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- lib/jab/homepage-emit.test.ts`
Expected: FAIL — exports undefined.

- [ ] **Step 3: Add the constants**

In `apps/web/lib/jab/homepage-emit.ts`, after `BLOG_INDEX_POST_TYPE`:

```ts
/**
 * Blog-index render defaults. SHARED so the deployed emitBlogIndexTsx caller
 * (compose-site.ts) and the Live Draft renderer stay in lockstep — a drift
 * here would make the draft preview disagree with the published homepage.
 */
export const BLOG_INDEX_LIMIT = 12;
export const BLOG_INDEX_HEADING = "Latest Posts";
```

- [ ] **Step 4: Use them in the compose call**

In `apps/web/lib/inngest/functions/compose-site.ts`, change the `emitBlogIndexTsx` call (lines 459-465) to use the constants. Add `BLOG_INDEX_LIMIT, BLOG_INDEX_HEADING` to the existing `@/lib/jab/homepage-emit` import (line 81), then:

```ts
          homepage.kind === "blogIndex"
            ? emitBlogIndexTsx({
                listAbility: homepage.listAbility,
                wrapperKey: homepage.wrapperKey,
                postType: homepage.postType,
                limit: BLOG_INDEX_LIMIT,
                heading: BLOG_INDEX_HEADING,
              })
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @jab/web test -- lib/jab/homepage-emit.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/homepage-emit.ts apps/web/lib/jab/homepage-emit.test.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "refactor(blog-index): shared BLOG_INDEX_LIMIT/HEADING constants for draft-deployed parity"
```

---

### Task 2: `blogIndex` resolution in `resolveDraftRoute`

**Files:**
- Modify: `apps/web/lib/draft/route-resolve.ts`
- Test: `apps/web/lib/draft/route-resolve.test.ts`

**Interfaces:**
- Consumes: `listAbilityMetaFor` (from `@/lib/jab/ability-meta`), `BLOG_INDEX_POST_TYPE` (from `@/lib/jab/homepage-emit`).
- Produces: `resolveDraftRoute(rawPath, pages, manifest, frontPageSlug, showOnFront?)` — new optional 5th arg; a new resolution variant `{ kind: "blogIndex"; listAbility: string; wrapperKey: string; postType: string }`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/lib/draft/route-resolve.test.ts`, add a manifest with a posts list ability to the existing fixtures and append:

```ts
import { BLOG_INDEX_POST_TYPE } from "@/lib/jab/homepage-emit";

describe("resolveDraftRoute — posts-front blog index", () => {
  // A manifest exposing the posts LIST ability (jab/get-posts) whose output
  // wraps the array under "posts".
  const POSTS_MANIFEST = {
    abilities: [
      { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
      { name: "jab/get-post-by-slug" },
    ],
  };

  it("resolves '/' to a blogIndex target when show_on_front is posts", () => {
    const r = resolveDraftRoute("/", [], POSTS_MANIFEST, null, "posts");
    expect(r).toEqual({
      kind: "blogIndex",
      listAbility: "jab/get-posts",
      wrapperKey: "posts",
      postType: BLOG_INDEX_POST_TYPE,
    });
  });

  it("still resolves a static front page when show_on_front is not posts", () => {
    const pages = [{ slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] }];
    const manifest = { abilities: [{ name: "jab/get-page-by-slug" }] };
    const r = resolveDraftRoute("/", pages, manifest, "home", "page");
    expect(r).toMatchObject({ kind: "page", target: { slug: "home", postType: "page" } });
  });

  it("is not_found for posts-front '/' when no posts list ability is registered (loud, mirrors deployed throw)", () => {
    const r = resolveDraftRoute("/", [], { abilities: [] }, null, "posts");
    expect(r).toEqual({ kind: "not_found" });
  });

  it("defaults to the existing behavior when showOnFront is omitted (back-compat)", () => {
    // No front row, null slug, no showOnFront → not_found (the encoded behavior).
    expect(resolveDraftRoute("/", [], { abilities: [] }, null)).toEqual({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web test -- lib/draft/route-resolve.test.ts`
Expected: FAIL — `resolveDraftRoute` takes 4 args / no blogIndex kind.

- [ ] **Step 3: Implement**

In `apps/web/lib/draft/route-resolve.ts`:

Extend the imports (line 1) and the resolution union:

```ts
import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";
import { postTypeMapEntriesFromPages } from "@/lib/jab/compose-site-emit";
import { BLOG_INDEX_POST_TYPE } from "@/lib/jab/homepage-emit";
```

```ts
export type DraftRouteResolution =
  | { kind: "page"; target: DraftRouteTarget }
  | { kind: "blogIndex"; listAbility: string; wrapperKey: string; postType: string }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" };
```

Change the signature + add the posts branch at the very top of the `path === ""` handling:

```ts
export function resolveDraftRoute(
  rawPath: string,
  pages: DraftPageRow[],
  manifest: ManifestShape,
  frontPageSlug: string | null,
  showOnFront?: "page" | "posts" | null,
): DraftRouteResolution {
  const path = normalize(rawPath);

  const toTarget = (slug: string, postType: string, paradigms: string[]): DraftRouteResolution => {
    const meta = abilityMetaFor(postType, manifest);
    if (!meta) return { kind: "not_found" };
    return {
      kind: "page",
      target: { slug, postType, paradigms, abilityName: meta.abilityName, wrapperKey: meta.wrapperKey },
    };
  };

  if (path === "") {
    // Posts-front (show_on_front='posts'): the homepage is a latest-posts list,
    // not a by-slug record. Mirror resolveHomepageEmit's posts branch. A missing
    // posts list ability is not_found (the deployed path throws loudly; the draft
    // surfaces it as a loud error result one layer up).
    if (showOnFront === "posts") {
      const meta = listAbilityMetaFor(BLOG_INDEX_POST_TYPE, manifest);
      if (!meta) return { kind: "not_found" };
      return {
        kind: "blogIndex",
        listAbility: meta.abilityName,
        wrapperKey: meta.wrapperKey,
        postType: BLOG_INDEX_POST_TYPE,
      };
    }
    const front =
      pages.find((p) => normalize(p.route_path) === "") ??
      (frontPageSlug ? pages.find((p) => p.slug === frontPageSlug) : undefined);
    if (!front) return { kind: "not_found" };
    return toTarget(front.slug, front.post_type, front.paradigms);
  }
```

(The rest of the function — single-segment redirect, mapped lookup, fallback registry — is unchanged.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web test -- lib/draft/route-resolve.test.ts`
Expected: PASS (including the pre-existing tests — `showOnFront` is optional).
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/route-resolve.ts apps/web/lib/draft/route-resolve.test.ts
git commit -m "feat(draft): blogIndex route resolution for posts-front sites"
```

---

### Task 3: Blog-index data path in `loadDraftPageData`

**Files:**
- Modify: `apps/web/lib/draft/page-data.ts`
- Test: `apps/web/lib/draft/page-data.test.ts`

**Interfaces:**
- Consumes: the Task 2 `blogIndex` resolution; `normalizeRecord`, `type JabListItem` (from `@/lib/jab/dynamic-lists-runtime`); `BLOG_INDEX_LIMIT`, `BLOG_INDEX_HEADING` (Task 1).
- Produces:
  - new `DraftPageDeps.loadShowOnFront(buildId): Promise<"page" | "posts" | null>`.
  - new `DraftPageDataResult` variant `{ kind: "blogIndex"; path: string; heading: string; items: JabListItem[] }`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/lib/draft/page-data.test.ts`, extend the `deps()` factory with `loadShowOnFront: vi.fn(async () => null)` and append:

```ts
import { BLOG_INDEX_HEADING } from "@/lib/jab/homepage-emit";

describe("loadDraftPageData — posts-front blog index", () => {
  const POSTS_MANIFEST = {
    abilities: [
      { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
      { name: "jab/get-post-by-slug" },
    ],
  };
  function postsDeps(over: Partial<DraftPageDeps> = {}): DraftPageDeps {
    return deps({
      loadManifest: vi.fn(async () => POSTS_MANIFEST),
      loadShowOnFront: vi.fn(async () => "posts" as const),
      loadFrontPageSlug: vi.fn(async () => null),
      callAbility: vi.fn(async () => ({
        posts: [
          { id: 7, title: "First", slug: "first", excerpt: "x", date: "2026-06-01", acf: {} },
          { id: 8, title: "Second", slug: "second", excerpt: "y", date: "2026-06-02", acf: {} },
        ],
      })),
      ...over,
    });
  }

  it("returns a blogIndex result with normalized items for '/' on a posts-front site", async () => {
    const d = postsDeps();
    const result = await loadDraftPageData({ buildId: "b1", path: "/" }, d);
    expect(result.kind).toBe("blogIndex");
    if (result.kind === "blogIndex") {
      expect(result.heading).toBe(BLOG_INDEX_HEADING);
      expect(result.items.map((i) => i.title)).toEqual(["First", "Second"]);
      // local card URLs, mirroring normalizeRecord(postType:"post")
      expect(result.items[0].url).toBe("/post/first");
    }
    expect(d.callAbility).toHaveBeenCalledWith("jab/get-posts", { numberposts: 12, orderby: "date", order: "desc" });
  });

  it("is a loud error (never throws) when the list ability call fails", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/" },
      postsDeps({ callAbility: vi.fn(async () => { throw new Error("WP unreachable"); }) }),
    );
    expect(result.kind).toBe("error");
  });

  it("leaves a static front page unaffected when show_on_front is not posts", async () => {
    const result = await loadDraftPageData({ buildId: "b1", path: "/visit-us" }, deps());
    expect(result.kind).toBe("page");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web test -- lib/draft/page-data.test.ts`
Expected: FAIL — `loadShowOnFront` not on deps / no blogIndex branch.

- [ ] **Step 3: Implement**

In `apps/web/lib/draft/page-data.ts`:

Add imports:

```ts
import { normalizeRecord, type JabListItem } from "@/lib/jab/dynamic-lists-runtime";
import { BLOG_INDEX_LIMIT, BLOG_INDEX_HEADING } from "@/lib/jab/homepage-emit";
```

Extend the result type + deps:

```ts
export type DraftPageDataResult =
  | { kind: "page"; path: string; blocks: RenderableBlock[] }
  | { kind: "blogIndex"; path: string; heading: string; items: JabListItem[] }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };
```

```ts
export interface DraftPageDeps {
  loadPages(buildId: string): Promise<DraftPageRow[]>;
  loadManifest(buildId: string): Promise<ManifestShape>;
  loadFrontPageSlug(buildId: string): Promise<string | null>;
  loadShowOnFront(buildId: string): Promise<"page" | "posts" | null>;
  loadAcfFlexFields(buildId: string): Promise<Record<string, string[]>>;
  loadDynamicListSpecs(buildId: string): Promise<Record<string, DynamicListSpec>>;
  callAbility: CallAbility;
  resolveMedia?: MediaResolver;
}
```

In `loadDraftPageData`, load `showOnFront` alongside the others and pass it to `resolveDraftRoute`, then handle the `blogIndex` resolution before the existing `page` path:

```ts
  try {
    const [pages, manifest, frontPageSlug, showOnFront] = await Promise.all([
      deps.loadPages(args.buildId),
      deps.loadManifest(args.buildId),
      deps.loadFrontPageSlug(args.buildId),
      deps.loadShowOnFront(args.buildId),
    ]);
    const resolution = resolveDraftRoute(args.path, pages, manifest, frontPageSlug, showOnFront);
    if (resolution.kind === "not_found" || resolution.kind === "redirect") return resolution;

    if (resolution.kind === "blogIndex") {
      // Mirror emitBlogIndexTsx EXACTLY: same list ability call, same
      // normalizeRecord options, same limit. Items carry local /<postType>/<slug>
      // links + resolved featured images.
      const response = (await deps.callAbility(resolution.listAbility, {
        numberposts: BLOG_INDEX_LIMIT,
        orderby: "date",
        order: "desc",
      })) as Record<string, unknown> | null;
      const raw = response?.[resolution.wrapperKey];
      const records = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      const items = await Promise.all(
        records.map((rec) =>
          normalizeRecord(rec, { dateField: null, resolveMedia: deps.resolveMedia, postType: resolution.postType }),
        ),
      );
      return { kind: "blogIndex", path: args.path, heading: BLOG_INDEX_HEADING, items };
    }

    const t = resolution.target;
    // ... existing by-slug page path unchanged ...
```

(Keep the rest of the `page` branch exactly as it was; only the guard above changed from `if (resolution.kind !== "page") return resolution;` to the explicit handling so `blogIndex` is processed rather than returned raw.)

Wire the dep in `defaultDraftPageDeps` (next to `loadFrontPageSlug`):

```ts
    async loadShowOnFront(buildId) {
      const { data } = await admin
        .from("site_builds")
        .select("config")
        .eq("id", buildId)
        .single();
      const cfg = (data?.config ?? {}) as { show_on_front?: unknown };
      return cfg.show_on_front === "posts" ? "posts" : cfg.show_on_front === "page" ? "page" : null;
    },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web test -- lib/draft/page-data.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/page-data.ts apps/web/lib/draft/page-data.test.ts
git commit -m "feat(draft): blog-index data path — list ability + normalizeRecord, mirrors deployed"
```

---

### Task 4: Render the blog index in the draft runtime + route status

**Files:**
- Modify: `apps/web/app/api/draft/[projectId]/page/route.ts:57-59`
- Modify: `apps/web/lib/draft/runtime/entry.tsx`
- Test: none unit (browser bundle); verified by `tsc` + the bundle test + full suite. Keep the renderer a faithful mirror of `emitBlogIndexTsx`'s JSX.

**Interfaces:**
- Consumes: the `{ kind: "blogIndex", heading, items }` JSON from the page route.

- [ ] **Step 1: Map the result kind to HTTP 200**

In `apps/web/app/api/draft/[projectId]/page/route.ts`, the status ternary currently treats only `page` as success implicitly. Make `blogIndex` a 200 too:

```ts
  return NextResponse.json(result, {
    status:
      result.kind === "not_found" ? 404 : result.kind === "error" ? 500 : 200,
    headers,
  });
```

(This already yields 200 for both `page` and `blogIndex` since only `not_found`/`error` are special-cased — confirm no other branch hard-codes `result.kind === "page"`. If it does, widen it.)

- [ ] **Step 2: Extend the runtime's fetch union + state**

In `apps/web/lib/draft/runtime/entry.tsx`, add to the `fetchPage` body's parsed-body union and the `PageState` type:

```ts
interface BlogIndexItem {
  id: number;
  title: string;
  url: string;
  excerpt: string;
  image: { url: string; alt: string } | null;
  date: string | null;
}

type PageState =
  | { phase: "loading"; path: string }
  | { phase: "ready"; path: string; blocks: RenderableBlockLike[] }
  | { phase: "blogIndex"; path: string; heading: string; items: BlogIndexItem[] }
  | { phase: "error"; path: string; message: string };
```

In `fetchPage`, extend the body union + handling:

```ts
    const body = (await res.json()) as
      | { kind: "page"; blocks: RenderableBlockLike[] }
      | { kind: "blogIndex"; heading: string; items: BlogIndexItem[] }
      | { kind: "redirect"; to: string }
      | { kind: "not_found" }
      | { kind: "error"; message: string };
    if (body.kind === "redirect") return fetchPage(body.to);
    if (body.kind === "page") return { phase: "ready", path, blocks: body.blocks };
    if (body.kind === "blogIndex") return { phase: "blogIndex", path, heading: body.heading, items: body.items };
    if (body.kind === "not_found") return { phase: "error", path, message: `No page at ${path} (404 on the published site too).` };
    return { phase: "error", path, message: body.kind === "error" ? body.message : `Unexpected response (${res.status})` };
```

- [ ] **Step 3: Render the list (mirror `emitBlogIndexTsx`)**

Add a `BlogIndexView` component and a render branch inside `<main>` in `DraftApp` (same classNames as `emitBlogIndexTsx` so the draft's theme/Tailwind CSS styles it identically to the deployed homepage):

```tsx
function formatDate(d: string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function BlogIndexView({ heading, items }: { heading: string; items: BlogIndexItem[] }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">{heading}</h1>
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <article key={item.id} className="flex flex-col">
            <a href={item.url} className="group block">
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image.url} alt={item.image.alt} className="mb-4 aspect-video w-full rounded object-cover" />
              ) : null}
              <h2 className="text-xl font-semibold group-hover:underline">{item.title}</h2>
            </a>
            {item.date ? <time className="mt-1 text-sm opacity-70">{formatDate(item.date)}</time> : null}
            {item.excerpt ? <p className="mt-2 opacity-80">{item.excerpt}</p> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
```

In `DraftApp`'s `<main>`, add the branch alongside the existing phases:

```tsx
        {page.phase === "blogIndex" && (
          <BlogIndexView heading={page.heading} items={page.items} />
        )}
```

(The same-site link interception already routes card clicks `/post/<slug>` through `navigate`, so the blog-index cards are fully navigable in the draft.)

- [ ] **Step 4: Typecheck + bundle test + full suite**

Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.
Run: `pnpm --filter @jab/web test -- lib/draft/bundle.test.ts`
Expected: PASS (the runtime still bundles).
Run: `pnpm --filter @jab/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/api/draft/[projectId]/page/route.ts" apps/web/lib/draft/runtime/entry.tsx
git commit -m "feat(draft): render the posts-front blog index in the draft runtime"
```

---

### Task 5: Synthesized blog-index page-row helper (Half B, pure)

**Files:**
- Modify: `apps/web/lib/jab/homepage-emit.ts`
- Test: `apps/web/lib/jab/homepage-emit.test.ts`

**Interfaces:**
- Produces:
  - `BLOG_INDEX_SLUG = "__home__"` — reserved, stable slug for the synthesized row (carry-forward keys on slug; must not collide with a real post/page slug).
  - `synthesizeBlogIndexPage(homeUrl: string): { descriptor: { slug: string; post_type: string; url: string }; row: { slug: string; post_type: string; title: string; route_path: string; block_count: number; paradigms: string[]; sourceModifiedGmt: null; blockTree: never[]; link: string } }` — the capture descriptor (navigates to the WP home URL) + the persist row (`route_path="/"`).

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/homepage-emit.test.ts`:

```ts
import { synthesizeBlogIndexPage, BLOG_INDEX_SLUG } from "./homepage-emit";

describe("synthesizeBlogIndexPage", () => {
  it("builds a capture descriptor at the WP home URL and a '/' page row", () => {
    const { descriptor, row } = synthesizeBlogIndexPage("https://example.com");
    expect(descriptor).toEqual({ slug: BLOG_INDEX_SLUG, post_type: "post", url: "https://example.com" });
    expect(row.route_path).toBe("/");
    expect(row.slug).toBe(BLOG_INDEX_SLUG);
    expect(row.post_type).toBe("post");
    expect(row.block_count).toBe(0);
    expect(row.paradigms).toEqual([]);
    expect(row.blockTree).toEqual([]);
    expect(row.link).toBe("https://example.com");
    expect(row.sourceModifiedGmt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- lib/jab/homepage-emit.test.ts`
Expected: FAIL — exports undefined.

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/homepage-emit.ts`:

```ts
/**
 * Reserved slug for the synthesized blog-index homepage row. Carry-forward and
 * discovery key on slug; this must never collide with a real post/page slug
 * (WP slugs can't contain underscores at both ends like this sentinel).
 */
export const BLOG_INDEX_SLUG = "__home__";

/**
 * Build the discovery capture descriptor + the page_inventory row for a
 * posts-front site's synthesized homepage. The descriptor navigates Playwright
 * to the WP home URL (the live blog index) for the SOURCE screenshot; the row's
 * route_path="/" makes verify-fidelity capture the deployed "/" and the review
 * screen list it. The row carries no blocks (the homepage is a list, composed
 * deterministically by emitBlogIndexTsx — there is nothing to edit per-block).
 */
export function synthesizeBlogIndexPage(homeUrl: string): {
  descriptor: { slug: string; post_type: string; url: string };
  row: {
    slug: string;
    post_type: string;
    title: string;
    route_path: string;
    block_count: number;
    paradigms: string[];
    sourceModifiedGmt: null;
    blockTree: never[];
    link: string;
  };
} {
  return {
    descriptor: { slug: BLOG_INDEX_SLUG, post_type: BLOG_INDEX_POST_TYPE, url: homeUrl },
    row: {
      slug: BLOG_INDEX_SLUG,
      post_type: BLOG_INDEX_POST_TYPE,
      title: BLOG_INDEX_HEADING,
      route_path: "/",
      block_count: 0,
      paradigms: [],
      sourceModifiedGmt: null,
      blockTree: [],
      link: homeUrl,
    },
  };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test -- lib/jab/homepage-emit.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/homepage-emit.ts apps/web/lib/jab/homepage-emit.test.ts
git commit -m "feat(discovery): synthesizeBlogIndexPage helper for posts-front review coverage"
```

---

### Task 6: Wire the synthesized row into discovery

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`
- Test: none unit (the worker news up clients); verified by `tsc` + the Task 5 pure-helper test + the discovery smoke. Keep the wiring thin.

**Interfaces:**
- Consumes: `synthesizeBlogIndexPage`, `showOnFront` (already computed at discover-site.ts:244), the WP home URL (`siteManifest?.home_url ?? project wp_url`), `capturePage`.

- [ ] **Step 1: Capture the WP home as the blog-index source**

In `discover-site.ts`, the `capture-screenshots` step builds `pageDescriptors` from `pageBlocks` (lines 496-499). When `showOnFront === "posts"`, append the synthesized descriptor so Playwright captures the live blog index. Add near the descriptor construction (use the home URL resolved from the site manifest, falling back to the project `wp_url`):

```ts
      const pageDescriptors: PageDescriptor[] = pageBlocks.map((p) => ({
        slug: p.slug,
        post_type: p.post_type,
        url: p.url,
      }));
      const blogIndexHomeUrl =
        showOnFront === "posts" ? (siteManifest?.home_url ?? wpUrl ?? null) : null;
      if (blogIndexHomeUrl) {
        pageDescriptors.push(synthesizeBlogIndexPage(blogIndexHomeUrl).descriptor);
      }
```

Add the import: `import { synthesizeBlogIndexPage } from "@/lib/jab/homepage-emit";` and ensure `wpUrl` is in scope at this point (it is read for design tokens at ~line 794; if it is not yet loaded here, read `project.wp_url` in the same step or thread it forward — the executing agent must confirm scope and load it if needed).

- [ ] **Step 2: Persist the synthesized page row**

In the `persist-pages` step (lines 709-741), append the synthesized row to the `pages` array when posts-front. The discovery result for `BLOG_INDEX_SLUG` (captured in Step 1) provides its `source_screenshot_paths`:

```ts
          pages: [
            ...pageBlocks.map((p) => { /* unchanged */ }),
            ...carriedPages,
            ...(blogIndexHomeUrl
              ? [(() => {
                  const { row } = synthesizeBlogIndexPage(blogIndexHomeUrl);
                  const discovery =
                    discoveryResults.find((d) => d.slug === row.slug && d.post_type === row.post_type) ?? {
                      slug: row.slug,
                      post_type: row.post_type,
                      screenshotPaths: {},
                      blockCapturesByViewport: {},
                    };
                  return { ...row, discovery };
                })()]
              : []),
          ],
```

(`blogIndexHomeUrl` must be in scope in the persist step — it is computed in the capture step above; lift it to the worker body or recompute it identically in persist. The executing agent picks whichever matches the file's structure; recomputing from `showOnFront` + `siteManifest`/`wpUrl` is safe and side-effect-free.)

- [ ] **Step 3: Typecheck + full suite**

Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.
Run: `pnpm --filter @jab/web test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(discovery): synthesize a '/' page_inventory row for posts-front sites (review/fidelity coverage)"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the recommendations doc**

Mark finding #1's draft + review/fidelity gap as FIXED: the Live Draft preview now renders the posts-front homepage (mirroring the deployed `emitBlogIndexTsx`), and discovery synthesizes a `route_path="/"` `page_inventory` row (slug `__home__`, post_type `post`, WP home as the capture source) so the homepage is captured, fidelity-scored, and reviewable. Note the residual: **pagination** of the draft/deployed blog index is still latest-N only (no `/page/2`) — a tracked follow-up, unchanged by this plan.

- [ ] **Step 2: Add the CLAUDE.md snapshot line**

Add a dated paragraph (same style as the existing campaign entries) summarizing: posts-front blog-index now covered in Live Draft + review/fidelity (branch `feat/posts-front-draft-review-coverage`), what shipped, no migration, residual = pagination.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-17-independent-review-recommendations.md CLAUDE.md
git commit -m "docs(blog-index): mark finding #1 draft + review coverage closed"
```

---

## Self-Review

**1. Spec coverage (both halves of the High finding):**
- Half A — draft preview renders posts homepage → Tasks 2 (resolution) + 3 (data) + 4 (render). ✓
- Half B — synthesized `/` page_inventory row → source captured + fidelity-scored + reviewable → Tasks 5 (pure row/descriptor) + 6 (discovery wiring). ✓
- Draft mirrors deployed exactly (list ability, normalizeRecord, local links, limit 12, heading "Latest Posts") → shared constants (Task 1), identical JSX/classNames (Task 4). ✓
- Loud on missing posts list ability → Task 2 not_found + Task 3 error wrapping. ✓
- No migration → uses existing `config.show_on_front` + `page_inventory` columns. ✓

**2. Placeholder scan:** Real code in every code step. The two discovery-wiring steps (Task 6) flag a scope confirmation (`wpUrl`/`blogIndexHomeUrl` in scope) rather than guessing line numbers — that is a conscious instruction for the worker against a worker file with no unit harness, not a placeholder; the code to write is shown.

**3. Type consistency:**
- `blogIndex` resolution kind defined in Task 2, consumed in Task 3. ✓
- `DraftPageDataResult` `blogIndex` variant (Task 3) → JSON → `entry.tsx` `BlogIndexItem`/`phase:"blogIndex"` (Task 4). The runtime re-declares a structural `BlogIndexItem` (the bundle can't import server types) — it is a subset of `JabListItem` (id/title/url/excerpt/image/date), matching the fields the JSX reads. ✓
- `BLOG_INDEX_LIMIT`/`BLOG_INDEX_HEADING` (Task 1) used by compose (Task 1), page-data (Task 3); `BLOG_INDEX_SLUG`/`synthesizeBlogIndexPage` (Task 5) used by discovery (Task 6). ✓
- `loadShowOnFront` added to `DraftPageDeps` (Task 3) and `defaultDraftPageDeps` (Task 3) and the test factory (Task 3). ✓

**Risk notes for the executing agent:**
- The draft runtime (`entry.tsx`) and the two worker files (`discover-site.ts`) have no unit harness; their correctness rests on the pure helpers they consume (Tasks 1/2/3/5, all tested) + `tsc` + the bundle test + full suite. Keep them thin.
- Draft visual fidelity of the list depends on the draft's existing theme/Tailwind CSS pipeline (same mechanism every generated component relies on) — out of scope here; mirror `emitBlogIndexTsx`'s classNames verbatim and inherit whatever that pipeline provides.
- Edit builds need no change: they clone `page_inventory` (including the `__home__` row + its carried `source_screenshot_paths`) from the source build, and `resolveHomepageEmit` reads `config.show_on_front` (carried by the edit config). Confirm during execution that an edit build's config carries `show_on_front` — if not, that is a pre-existing plan-#1 residual to track, not new work here.
- `BLOG_INDEX_SLUG="__home__"` must not collide: WP slugs are lowercase alnum+hyphen and cannot be `__home__`; the sentinel is safe as a synthesized key.
