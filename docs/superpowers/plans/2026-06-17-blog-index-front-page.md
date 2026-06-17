# Blog-Index Front Page (`show_on_front="posts"`) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build WordPress sites whose front page is the blog index (`show_on_front="posts"`, the WP-default Reading setting) instead of hard-failing compose — emit a deterministic latest-posts homepage that reuses the existing dynamic-list runtime.

**Architecture:** The WP plugin's `/jab/v1/site` manifest already exposes `front_page.show_on_front: "page"|"posts"`; discovery currently *drops* it. We persist `show_on_front` into the existing `site_builds.config` JSONB, then branch compose on it: `"posts"` emits a new deterministic `emitBlogIndexTsx` homepage (fetch latest posts via the resolved list ability → normalize via the existing `normalizeRecord` runtime → render a responsive card grid linking to local `/post/<slug>` routes); `"page"`/undefined keeps the existing static path verbatim. No new LLM call, no WP plugin change, no DB migration.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind 3, Vitest. Package: `apps/web` (`@jab/web`).

## Global Constraints

- **Errors are loud** — every failure produces a clear, actionable message (CLAUDE.md). The blog-index branch hard-fails with a specific message if the posts list ability is missing.
- **Fleet-agnostic** — works for any WP site, not just Two Roads. Nothing hard-codes a site, theme, or slug.
- **Reuse, don't rebuild** — the blog index reuses `normalizeRecord` / `JabListItem` / `createWpMediaResolver` from the emitted runtime. No new LLM generation.
- **No WP plugin change** — `show_on_front` / `static_front` / `posts_page` already ship from `packages/wp-plugin/includes/Rest/SiteManifest.php`.
- **No DB migration** — `show_on_front` rides the existing `site_builds.config` JSONB column. (If that changes, apply to BOTH Supabase projects — local `ajfurojjxthhzkjqttri` + prod `celzwcxkrmsbwiswkxug`.)
- **Verification gates** — every task ends green on `pnpm --filter @jab/web typecheck` AND `pnpm --filter @jab/web test`. Use the package's `typecheck` script (NOT `exec tsc`, which no-ops).
- **Images use `<img>`, not the MediaImage shim** — the shim is block-dispatcher-only; list cards hotlink WP media via plain `<img>`.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/web/lib/jab/ability-meta.ts` | Resolve ability names from the manifest | **Modify** — add `listAbilityMetaFor` (list-ability twin of `abilityMetaFor`) |
| `apps/web/lib/jab/ability-meta.test.ts` | Unit tests for ability resolution | **Create/Modify** — cover `listAbilityMetaFor` |
| `apps/web/lib/jab/build-config.ts` | Canonical `site_builds.config` shape + helpers | **Modify** — `show_on_front` on edit variant + carry-forward; new `buildFrontPageConfigPatch` |
| `apps/web/lib/jab/build-config.test.ts` | Unit tests for config helpers | **Modify** — carry-forward + patch-builder cases |
| `apps/web/lib/jab/compose-site-emit.ts` | Pure emitters for the generated project | **Modify** — add `emitBlogIndexTsx` + `BlogIndexInput` |
| `apps/web/lib/jab/compose-site-emit.test.ts` | Unit tests for emitters | **Create/Modify** — cover `emitBlogIndexTsx` |
| `apps/web/lib/jab/homepage-emit.ts` | Pure homepage-emit decision (static vs blog-index) | **Create** — `resolveHomepageEmit` + types |
| `apps/web/lib/jab/homepage-emit.test.ts` | Unit tests for the decision helper | **Create** |
| `apps/web/lib/inngest/functions/discover-site.ts` | Phase A discovery worker | **Modify** — persist `show_on_front` via the patch builder |
| `apps/web/lib/inngest/functions/compose-site.ts` | Phase C compose worker | **Modify** — branch homepage emit via `resolveHomepageEmit` |
| `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md` | Review status | **Modify** — mark #1 FIXED |
| `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` | Fleet gap register | **Modify** — close A10 (deployed build) + residuals |
| `CLAUDE.md` | Project status | **Modify** — status note |

**Design decision — scope boundary:** this plan fixes the **deployed build** (the actual hard failure). It deliberately EXCLUDES (documented as follow-ups in Task 8):
1. **Live-Draft preview of the blog-index homepage** — `apps/web/lib/draft/page-data.ts:147` resolves the draft homepage via `config.front_page_slug`, which is `null` for posts sites. The deployed `/` is correct; the in-app draft preview of `/` is a separate surface.
2. **Pagination** — the blog index shows the latest N posts; no `/page/2`.
3. **Per-page review coverage of the synthesized homepage** — no `page_inventory` row is created for `/`, so the blog-index homepage doesn't appear on the pre-publish review screen or get fidelity-scored (same class as the already-documented "fallback-resolved long-tail pages bypass review" residual).

---

## Task 1: `listAbilityMetaFor` — resolve the posts LIST ability from the manifest

**Files:**
- Modify: `apps/web/lib/jab/ability-meta.ts`
- Test: `apps/web/lib/jab/ability-meta.test.ts` (create if absent)

**Interfaces:**
- Consumes: `ManifestShape`, `ManifestAbility`, `abilityWrapperKeyFromSchema` (existing in `ability-meta.ts` / `ability-client.ts`).
- Produces: `export function listAbilityMetaFor(postType: string, manifest: ManifestShape): { abilityName: string; wrapperKey: string } | null` — used by `resolveHomepageEmit` (Task 5).

Context: `abilityMetaFor` (existing) resolves the **by-slug** ability (`jab/get-{post}-by-slug`). The blog index needs the **list** ability (`jab/get-{plural}`, e.g. `jab/get-posts`). The plugin convention is `jab/get-{rest_base}` with `rest_base` plural; we only have `post_type` at compose time, so try the pluralized candidate first, then the verbatim post type (covers already-plural types). Wrapper key from the ability's output schema (`abilityWrapperKeyFromSchema` returns `outputSchema.required[0]`), snake_case-plural fallback.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/ability-meta.test.ts
import { describe, it, expect } from "vitest";
import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";

const manifest: ManifestShape = {
  abilities: [
    { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
    { name: "jab/get-post-by-slug", outputSchema: { required: ["post"] } },
    { name: "jab/get-food-truck-events", outputSchema: { required: ["food_truck_events"] } },
  ],
};

describe("listAbilityMetaFor", () => {
  it("resolves the built-in posts list ability + wrapper from the schema", () => {
    expect(listAbilityMetaFor("post", manifest)).toEqual({
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
    });
  });

  it("resolves a kebab CPT by pluralizing the post type", () => {
    expect(listAbilityMetaFor("food-truck-event", manifest)).toEqual({
      abilityName: "jab/get-food-truck-events",
      wrapperKey: "food_truck_events",
    });
  });

  it("falls back to the snake-cased plural wrapper when no output schema is present", () => {
    const m: ManifestShape = { abilities: [{ name: "jab/get-posts" }] };
    expect(listAbilityMetaFor("post", m)).toEqual({
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
    });
  });

  it("returns null when no matching list ability is registered", () => {
    expect(listAbilityMetaFor("post", { abilities: [] })).toBeNull();
  });

  it("does not match a by-slug ability as a list ability", () => {
    const m: ManifestShape = { abilities: [{ name: "jab/get-post-by-slug", outputSchema: { required: ["post"] } }] };
    expect(listAbilityMetaFor("post", m)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- ability-meta`
Expected: FAIL — `listAbilityMetaFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/web/lib/jab/ability-meta.ts` (import `abilityWrapperKeyFromSchema` is already imported at the top of the file):

```typescript
/**
 * Resolves the registered LIST ability for a post type's archive fetch.
 * JAB convention is jab/get-{rest_base} where rest_base is plural
 * (jab/get-posts, jab/get-beers). We only have post_type at compose time,
 * so try the pluralized candidate first, then the post_type verbatim
 * (covers already-plural types). Wrapper key from the ability's output
 * schema, snake-cased-plural fallback. Returns null if none registered —
 * the blog-index caller treats absence as a hard error.
 */
export function listAbilityMetaFor(
  postType: string,
  manifest: ManifestShape,
): { abilityName: string; wrapperKey: string } | null {
  const abilities = manifest.abilities ?? [];
  const plural = postType.endsWith("s") ? postType : postType + "s";
  for (const candidate of [`jab/get-${plural}`, `jab/get-${postType}`]) {
    const ability = abilities.find((a) => a.name === candidate);
    if (ability) {
      const wrapperKey =
        abilityWrapperKeyFromSchema(ability) ?? plural.replace(/-/g, "_");
      return { abilityName: candidate, wrapperKey };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test -- ability-meta`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-meta.ts apps/web/lib/jab/ability-meta.test.ts
git commit -m "feat(saas): listAbilityMetaFor — resolve a CPT's list ability from the manifest"
```

---

## Task 2: `show_on_front` on the config contract + carry-forward

**Files:**
- Modify: `apps/web/lib/jab/build-config.ts`
- Test: `apps/web/lib/jab/build-config.test.ts`

**Interfaces:**
- Consumes: existing `CarriedSourceConfig`, `carryForwardSourceConfig`, `BuildConfig`.
- Produces: `CarriedSourceConfig.show_on_front?: "page" | "posts"`; `carryForwardSourceConfig` carries it; edit-variant `BuildConfig` gains `show_on_front?: "page" | "posts"`.

Context: `front_page_slug` is the exact precedent — carried for edit/publish builds and read by compose. `show_on_front` must ride the same path so a blog-index site's edit/publish build keeps its homepage mode. (The full-build path re-runs discovery, which re-persists it via Task 3; this keeps the typed contract correct and forward-compatible for the Live-Draft publish-build path.)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/build-config.test.ts` inside the `carryForwardSourceConfig` describe block:

```typescript
  it("carries show_on_front when valid", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", show_on_front: "page" }),
    ).toStrictEqual({ front_page_slug: "home", show_on_front: "page" });
    expect(
      carryForwardSourceConfig({ mode: "full", show_on_front: "posts" }),
    ).toStrictEqual({ front_page_slug: null, show_on_front: "posts" });
  });

  it("omits show_on_front when absent or invalid", () => {
    expect(carryForwardSourceConfig({ mode: "full", show_on_front: "garbage" })).toStrictEqual({
      front_page_slug: null,
    });
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "home" })).toStrictEqual({
      front_page_slug: "home",
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- build-config`
Expected: FAIL — `show_on_front` not carried (extra/missing key).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/lib/jab/build-config.ts`:

(a) Add to the **edit** variant of `BuildConfig` (after `front_page_slug: string | null;`):

```typescript
      /**
       * Front-page mode carried from the SOURCE build's config so an edit /
       * publish build of a blog-index site (show_on_front='posts') keeps
       * emitting the blog index. Full builds re-derive this from the /site
       * manifest at discovery. Absent on pre-blog-index builds → compose
       * treats it as the static path (back-compat).
       */
      show_on_front?: "page" | "posts";
```

(b) Add to `CarriedSourceConfig`:

```typescript
  show_on_front?: "page" | "posts";
```

(c) In `carryForwardSourceConfig`, after the `front_page_slug` assignment and before the `last_sync_watermark` block, add:

```typescript
  if (cfg.show_on_front === "page" || cfg.show_on_front === "posts") {
    out.show_on_front = cfg.show_on_front;
  }
```

And widen the `cfg` cast to include the field:

```typescript
  const cfg = sourceConfig as {
    front_page_slug?: unknown;
    last_sync_watermark?: unknown;
    show_on_front?: unknown;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test -- build-config`
Expected: PASS (existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts
git commit -m "feat(saas): carry show_on_front through the build-config contract"
```

---

## Task 3: `buildFrontPageConfigPatch` — discovery's config patch builder

**Files:**
- Modify: `apps/web/lib/jab/build-config.ts`
- Test: `apps/web/lib/jab/build-config.test.ts`

**Interfaces:**
- Produces: `export function buildFrontPageConfigPatch(showOnFront: "page" | "posts" | null | undefined, resolvedFrontPageSlug: string | null): { show_on_front?: "page" | "posts"; front_page_slug?: string }` — used by `discover-site.ts` (Task 6).

Context: discovery must persist `show_on_front` EVEN WHEN there's no static slug (the posts case — previously the persist step was skipped entirely). This pure builder makes that testable without Inngest.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/build-config.test.ts`:

```typescript
import { buildFrontPageConfigPatch } from "@/lib/jab/build-config";

describe("buildFrontPageConfigPatch", () => {
  it("persists show_on_front='posts' even with no static slug", () => {
    expect(buildFrontPageConfigPatch("posts", null)).toStrictEqual({ show_on_front: "posts" });
  });
  it("persists both for a static front page", () => {
    expect(buildFrontPageConfigPatch("page", "home")).toStrictEqual({
      show_on_front: "page",
      front_page_slug: "home",
    });
  });
  it("persists only the slug when mode is unknown (pre-v0.7.0 plugin)", () => {
    expect(buildFrontPageConfigPatch(null, "home")).toStrictEqual({ front_page_slug: "home" });
  });
  it("returns an empty patch when nothing is known", () => {
    expect(buildFrontPageConfigPatch(null, null)).toStrictEqual({});
    expect(buildFrontPageConfigPatch(undefined, "")).toStrictEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- build-config`
Expected: FAIL — `buildFrontPageConfigPatch` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/web/lib/jab/build-config.ts`:

```typescript
/**
 * Build the front-page slice of site_builds.config from the /site manifest's
 * show_on_front mode + the resolved static front-page slug. Returns only the
 * keys that are known, so discovery can read-modify-write without clobbering
 * unrelated config keys. The KEY behavior change: show_on_front is persisted
 * even when there is no static slug (the blog-index case), which is what lets
 * compose emit the blog index instead of hard-failing.
 */
export function buildFrontPageConfigPatch(
  showOnFront: "page" | "posts" | null | undefined,
  resolvedFrontPageSlug: string | null,
): { show_on_front?: "page" | "posts"; front_page_slug?: string } {
  const patch: { show_on_front?: "page" | "posts"; front_page_slug?: string } = {};
  if (showOnFront === "page" || showOnFront === "posts") patch.show_on_front = showOnFront;
  if (typeof resolvedFrontPageSlug === "string" && resolvedFrontPageSlug.length > 0) {
    patch.front_page_slug = resolvedFrontPageSlug;
  }
  return patch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test -- build-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts
git commit -m "feat(saas): buildFrontPageConfigPatch — persist show_on_front from discovery"
```

---

## Task 4: `emitBlogIndexTsx` — the deterministic blog-index homepage emitter

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Test: `apps/web/lib/jab/compose-site-emit.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface BlogIndexInput { listAbility: string; wrapperKey: string; postType: string; limit: number; heading: string }` and `export function emitBlogIndexTsx(input: BlogIndexInput): string` — used by `compose-site.ts` (Task 7).

Context: mirrors `emitHomepageTsx` but renders a posts archive. The emitted `app/page.tsx` imports the runtime helpers that already ship in every generated app (`normalizeRecord`/`JabListItem` from `@/lib/jab/dynamic-lists`, `createWpMediaResolver` from `@/lib/jab/related-posts`), fetches latest posts via the resolved list ability (`orderby:"date"`, `order:"desc"`), normalizes them (which yields `/<postType>/<slug>` local links + featured images), and renders a responsive Tailwind card grid inside the shell's `<main className="jab-theme">`. Images use plain `<img>` (the MediaImage shim is dispatcher-only). Dates format with a fixed `"en-US"` locale for ISR determinism.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/compose-site-emit.test.ts  (add to existing file, or create with this import block)
import { describe, it, expect } from "vitest";
import { emitBlogIndexTsx } from "@/lib/jab/compose-site-emit";

describe("emitBlogIndexTsx", () => {
  const src = emitBlogIndexTsx({
    listAbility: "jab/get-posts",
    wrapperKey: "posts",
    postType: "post",
    limit: 12,
    heading: "Latest Posts",
  });

  it("calls the resolved list ability with date-desc ordering and the limit", () => {
    expect(src).toContain('jabClient.callAbility("jab/get-posts"');
    expect(src).toContain("numberposts: 12");
    expect(src).toContain('orderby: "date"');
    expect(src).toContain('order: "desc"');
    expect(src).toContain('["posts"]');
  });

  it("reuses the emitted dynamic-list runtime for normalization + local links", () => {
    expect(src).toContain('from "@/lib/jab/dynamic-lists"');
    expect(src).toContain("normalizeRecord");
    expect(src).toContain('postType: "post"');
    expect(src).toContain('from "@/lib/jab/related-posts"');
  });

  it("is a valid ISR page rendering inside the themed shell", () => {
    expect(src).toContain("export const revalidate = 60;");
    expect(src).toContain('className="jab-theme"');
    expect(src).toContain("Latest Posts");
    expect(src).toContain("export default async function Page()");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- compose-site-emit`
Expected: FAIL — `emitBlogIndexTsx` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/web/lib/jab/compose-site-emit.ts` (near `emitHomepageTsx`):

```typescript
export interface BlogIndexInput {
  /** List ability for the built-in post type, e.g. "jab/get-posts". */
  listAbility: string;
  /** REST wrapper key the list response is nested under, e.g. "posts". */
  wrapperKey: string;
  /** Post type for local card URLs (/<postType>/<slug>), always "post". */
  postType: string;
  /** Max posts to show on the index (no pagination in v1). */
  limit: number;
  /** Visible heading, e.g. "Latest Posts". */
  heading: string;
}

/**
 * Emits app/page.tsx for a blog-index front page (show_on_front='posts').
 * Deterministic — no LLM. Fetches the latest posts via the resolved list
 * ability and renders them through the same dynamic-list runtime (normalizeRecord)
 * that every generated app already ships, so cards get /<postType>/<slug>
 * local links + resolved featured images. Renders inside the shell layout's
 * themed <main>. Plain <img> (the MediaImage shim is dispatcher-only).
 */
export function emitBlogIndexTsx(input: BlogIndexInput): string {
  return `import { jabClient } from "@/lib/jab/client";
import { normalizeRecord, type JabListItem } from "@/lib/jab/dynamic-lists";
import { createWpMediaResolver } from "@/lib/jab/related-posts";

export const revalidate = 60;

function formatDate(d: string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function Page() {
  const response = await jabClient.callAbility(${JSON.stringify(input.listAbility)}, { numberposts: ${input.limit}, orderby: "date", order: "desc" });
  const raw = (response as Record<string, unknown>)[${JSON.stringify(input.wrapperKey)}];
  const records = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const resolveMedia = createWpMediaResolver();
  const items: JabListItem[] = await Promise.all(
    records.map((rec) => normalizeRecord(rec, { dateField: null, resolveMedia, postType: ${JSON.stringify(input.postType)} })),
  );
  return (
    <main className="jab-theme">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <h1 className="text-3xl font-bold mb-8">${input.heading}</h1>
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
    </main>
  );
}
`;
}
```

Note: the test asserts the substring `["posts"]` — that comes from `JSON.stringify("posts")` rendered as a property access `[...]`; verify the emitted line reads `[${JSON.stringify(input.wrapperKey)}]` so the substring is present. (`JSON.stringify("posts")` → `"posts"`, wrapped in `[...]` → `["posts"]`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test -- compose-site-emit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): emitBlogIndexTsx — deterministic latest-posts homepage"
```

---

## Task 5: `resolveHomepageEmit` — the static-vs-blog-index decision

**Files:**
- Create: `apps/web/lib/jab/homepage-emit.ts`
- Test: `apps/web/lib/jab/homepage-emit.test.ts`

**Interfaces:**
- Consumes: `abilityMetaFor`, `listAbilityMetaFor`, `ManifestShape` (Task 1).
- Produces: `HomepagePageRow`, `HomepageEmitDecision`, `BLOG_INDEX_POST_TYPE`, `resolveHomepageEmit(buildConfig, pageRows, manifest)` — used by `compose-site.ts` (Task 7).

Context: this lifts compose-site.ts's inline front-page resolution (lines 305–327) into a pure, testable function and adds the blog-index branch. The static path is reproduced VERBATIM (including the two existing error messages) so behavior for static sites is byte-identical. Compose becomes a dumb consumer of the decision.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/homepage-emit.test.ts
import { describe, it, expect } from "vitest";
import { resolveHomepageEmit, type HomepagePageRow } from "@/lib/jab/homepage-emit";
import type { ManifestShape } from "@/lib/jab/ability-meta";

const manifest: ManifestShape = {
  abilities: [
    { name: "jab/get-posts", outputSchema: { required: ["posts"] } },
    { name: "jab/get-page-by-slug", outputSchema: { required: ["page"] } },
  ],
};
const homeRow: HomepagePageRow = { slug: "home", post_type: "page", route_path: "/home", paradigms: ["gutenberg"] };

describe("resolveHomepageEmit", () => {
  it("returns a blogIndex decision for show_on_front='posts'", () => {
    const d = resolveHomepageEmit({ mode: "full", show_on_front: "posts" }, [], manifest);
    expect(d).toEqual({
      kind: "blogIndex",
      listAbility: "jab/get-posts",
      wrapperKey: "posts",
      postType: "post",
      frontPageSlug: null,
      sitemapExtraRoutes: ["/"],
    });
  });

  it("hard-fails when the posts list ability is missing", () => {
    expect(() => resolveHomepageEmit({ mode: "full", show_on_front: "posts" }, [], { abilities: [] })).toThrow(
      /requires a posts list ability/,
    );
  });

  it("returns a static decision when front_page_slug matches a page row", () => {
    const d = resolveHomepageEmit({ mode: "full", show_on_front: "page", front_page_slug: "home" }, [homeRow], manifest);
    expect(d).toEqual({
      kind: "static",
      frontPageSlug: "home",
      postType: "page",
      paradigms: ["gutenberg"],
      ability: { abilityName: "jab/get-page-by-slug", wrapperKey: "page" },
      sitemapExtraRoutes: [],
    });
  });

  it("treats missing show_on_front as the static path (back-compat)", () => {
    const d = resolveHomepageEmit({ front_page_slug: "home" }, [homeRow], manifest);
    expect(d.kind).toBe("static");
  });

  it("hard-fails with the configured-but-missing message", () => {
    expect(() => resolveHomepageEmit({ front_page_slug: "nope" }, [homeRow], manifest)).toThrow(
      /no matching page in page_inventory/,
    );
  });

  it("hard-fails with the no-front-page message when nothing resolves", () => {
    expect(() => resolveHomepageEmit({}, [], manifest)).toThrow(/no static front-page configured/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- homepage-emit`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/jab/homepage-emit.ts
import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";

/** Minimal page_inventory row shape the homepage decision needs. */
export interface HomepagePageRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

/** WP's blog index is always the built-in "post" type. */
export const BLOG_INDEX_POST_TYPE = "post";

export type HomepageEmitDecision =
  | {
      kind: "static";
      frontPageSlug: string;
      postType: string;
      paradigms: string[];
      ability: { abilityName: string; wrapperKey: string };
      sitemapExtraRoutes: string[];
    }
  | {
      kind: "blogIndex";
      listAbility: string;
      wrapperKey: string;
      postType: string;
      frontPageSlug: null;
      sitemapExtraRoutes: string[];
    };

/**
 * Decide how compose emits app/page.tsx. show_on_front='posts' → blog index
 * (reuses the dynamic-list runtime); otherwise the existing static-page path,
 * reproduced verbatim (same fallbacks, same loud error messages). Pure +
 * fully tested so the compose worker is a dumb consumer.
 */
export function resolveHomepageEmit(
  buildConfig: unknown,
  pageRows: HomepagePageRow[],
  manifest: ManifestShape,
): HomepageEmitDecision {
  const cfg = (buildConfig ?? {}) as { show_on_front?: unknown; front_page_slug?: unknown };

  if (cfg.show_on_front === "posts") {
    const meta = listAbilityMetaFor(BLOG_INDEX_POST_TYPE, manifest);
    if (!meta) {
      throw new Error(
        "compose-site: blog-index front page (show_on_front='posts') requires a posts list ability (e.g. jab/get-posts) but none is registered in the manifest.",
      );
    }
    return {
      kind: "blogIndex",
      listAbility: meta.abilityName,
      wrapperKey: meta.wrapperKey,
      postType: BLOG_INDEX_POST_TYPE,
      frontPageSlug: null,
      sitemapExtraRoutes: ["/"],
    };
  }

  // Static front page — reproduces compose-site.ts:305-327 verbatim.
  const frontPageSlug = typeof cfg.front_page_slug === "string" ? cfg.front_page_slug : null;
  let frontPage = frontPageSlug
    ? pageRows.find((p) => p.slug === frontPageSlug && p.post_type === "page")
    : undefined;
  if (!frontPage) {
    frontPage = pageRows.find((p) => p.route_path === "/");
  }
  if (!frontPage) {
    throw new Error(
      frontPageSlug
        ? `compose-site: config.front_page_slug='${frontPageSlug}' but no matching page in page_inventory.`
        : "compose-site: no static front-page configured. Set site_builds.config.front_page_slug or ensure Phase A populates a row with route_path='/'.",
    );
  }
  const ability = abilityMetaFor(frontPage.post_type, manifest);
  if (!ability) {
    throw new Error(
      `no jab/get-<rest_base>-by-slug ability registered for front-page post_type '${frontPage.post_type}'`,
    );
  }
  return {
    kind: "static",
    frontPageSlug: frontPage.slug,
    postType: frontPage.post_type,
    paradigms: frontPage.paradigms,
    ability,
    sitemapExtraRoutes: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test -- homepage-emit`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/homepage-emit.ts apps/web/lib/jab/homepage-emit.test.ts
git commit -m "feat(saas): resolveHomepageEmit — pure static-vs-blog-index decision"
```

---

## Task 6: Wire discovery to persist `show_on_front`

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (the persist block at lines 236–255)

**Interfaces:**
- Consumes: `buildFrontPageConfigPatch` (Task 3).

Context: discovery already computes `frontPageSlug` and has `siteManifest` in scope (lines 223–234). Replace the slug-only persist with a patch that ALSO records `show_on_front` — and run it whenever the patch is non-empty (so the posts case, where `frontPageSlug` is null, still persists `show_on_front`). Keep the `step.run` id `"persist-front-page-slug"` to avoid changing the Inngest memoization key.

- [ ] **Step 1: Add the import**

At the top of `discover-site.ts`, add `buildFrontPageConfigPatch` to the existing `@/lib/jab/build-config` import (or add a new import line if none exists):

```typescript
import { buildFrontPageConfigPatch } from "@/lib/jab/build-config";
```

- [ ] **Step 2: Replace the persist block**

Replace lines 236–255 (`if (frontPageSlug) { await step.run("persist-front-page-slug", ...) }`) with:

```typescript
      const frontPageConfigPatch = buildFrontPageConfigPatch(
        siteManifest?.front_page?.show_on_front ?? null,
        frontPageSlug,
      );
      if (Object.keys(frontPageConfigPatch).length > 0) {
        await step.run("persist-front-page-slug", async () => {
          const supabase = createAdminClient();
          // Read-modify-write into the JSONB config column so we don't clobber
          // operator overrides (e.g. maxPages) the dispatcher set earlier.
          const { data: row, error: readErr } = await supabase
            .from("site_builds")
            .select("config")
            .eq("id", buildId)
            .single<{ config: Record<string, unknown> | null }>();
          if (readErr) throw new Error(`persist-front-page config read failed: ${readErr.message}`);
          const nextConfig = { ...(row?.config ?? {}), ...frontPageConfigPatch };
          const { error: writeErr } = await supabase
            .from("site_builds")
            .update({ config: nextConfig })
            .eq("id", buildId)
            .eq("project_id", projectId);
          if (writeErr) throw new Error(`persist-front-page config write failed: ${writeErr.message}`);
        });
      }
```

- [ ] **Step 3: Update the doc comment**

Update the comment block above `const frontPageSlug = ...` (lines 209–222) to reflect that `show_on_front` is now persisted for both modes (replace the "compose hard-fails by design" sentence with a note that posts sites now emit a blog index). Keep it accurate to the new behavior.

- [ ] **Step 4: Verify typecheck + suite**

Run: `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`
Expected: typecheck clean; full suite green (no test asserts the old skip behavior; if one does, update it to expect the patch).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas): discovery persists show_on_front into site_builds.config"
```

---

## Task 7: Wire compose to branch on the decision

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (lines 305–327 resolution, 405–406 route-map filter, 447–460 emit-homepage, 369–371 sitemap)

**Interfaces:**
- Consumes: `resolveHomepageEmit` (Task 5), `emitBlogIndexTsx` (Task 4).

Context: replace the inline front-page resolution with the decision helper, then branch the emit-homepage step. `frontPageSlug` becomes `null` for the blog index (so the ROUTE_MAP exclusion and `FRONT_PAGE_SLUG` are correct — there's no static slug to dedupe), and the blog index's `/` route is appended to the sitemap.

- [ ] **Step 1: Add imports**

Ensure `compose-site.ts` imports `resolveHomepageEmit` from `@/lib/jab/homepage-emit` and `emitBlogIndexTsx` from `@/lib/jab/compose-site-emit` (add to the existing emit import).

```typescript
import { resolveHomepageEmit } from "@/lib/jab/homepage-emit";
// add emitBlogIndexTsx to the existing "@/lib/jab/compose-site-emit" import
```

- [ ] **Step 2: Replace the resolution block (lines 305–327)**

Replace the `legacyConfig` / `frontPage` / `frontPageAbility` block with:

```typescript
    // Homepage emit decision: show_on_front='posts' → blog index; otherwise
    // the static-page path (reproduced verbatim inside resolveHomepageEmit,
    // including the legacy route_path='/' fallback + the two loud errors).
    const homepage = resolveHomepageEmit(
      buildConfig,
      pageRows.map((p) => ({ slug: p.slug, post_type: p.post_type, route_path: p.route_path, paradigms: p.paradigms })),
      manifest,
    );
    const frontPageSlug = homepage.kind === "static" ? homepage.frontPageSlug : null;
```

(Delete the now-unused `legacyConfig`, `frontPage`, and `frontPageAbility` locals.)

- [ ] **Step 3: Branch the emit-homepage step (lines 447–460)**

Replace the `emit-homepage` upload with:

```typescript
    uploads.push(
      step.run("emit-homepage", () =>
        uploadToProject(
          buildId,
          "app/page.tsx",
          homepage.kind === "blogIndex"
            ? emitBlogIndexTsx({
                listAbility: homepage.listAbility,
                wrapperKey: homepage.wrapperKey,
                postType: homepage.postType,
                limit: 12,
                heading: "Latest Posts",
              })
            : emitHomepageTsx({
                slug: homepage.frontPageSlug,
                abilityName: homepage.ability.abilityName,
                wrapperKey: homepage.ability.wrapperKey,
                paradigms: homepage.paradigms,
                postType: homepage.postType,
              }),
        ),
      ),
    );
```

- [ ] **Step 4: Append the blog index to the sitemap (lines 369–371)**

Replace the `emit-sitemap` upload's route list with one that appends the decision's extra routes:

```typescript
    uploads.push(
      step.run("emit-sitemap", () =>
        uploadToProject(
          buildId,
          "app/sitemap.ts",
          emitSitemapTs(
            [
              ...pageRows.map((p) => ({ routePath: p.route_path })),
              ...homepage.sitemapExtraRoutes.map((routePath) => ({ routePath })),
            ],
            wpUrl,
          ),
        ),
      ),
    );
```

(The ROUTE_MAP filter at line 406 and post-type-map at line 441 already read `frontPageSlug`; with `null` for the blog index they correctly exclude nothing / emit `FRONT_PAGE_SLUG = null`. No change needed there beyond `frontPageSlug` now being `string | null`.)

- [ ] **Step 5: Verify typecheck + suite**

Run: `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`
Expected: typecheck clean (confirm no remaining references to the deleted `frontPage`/`frontPageAbility`); full suite green. If a compose-site test asserts the old inline error strings, it still passes — the messages are reproduced verbatim in `resolveHomepageEmit`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(saas): compose emits a blog index for show_on_front='posts' sites"
```

---

## Task 8: Status docs + residuals

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`
- Modify: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Mark finding #1 FIXED** in the recommendations doc — move row #1 to ✅ FIXED with a one-line note ("deployed build; blog-index homepage reuses the dynamic-list runtime") and a pointer to this plan. Update the recommended-sequence section (drop #1, promote Classic-editor body to next).

- [ ] **Step 2: Update fleet-gap register A10** — mark the deployed-build hard-failure resolved, and record the THREE documented residuals under a new sub-bullet:
  - Live-Draft preview of the blog-index homepage (`page-data.ts` resolves via `front_page_slug`, null for posts sites).
  - Pagination (latest-N only, no `/page/2`).
  - The synthesized homepage bypasses the per-page review screen + fidelity scoring (no `page_inventory` `/` row).

- [ ] **Step 3: Add a CLAUDE.md status line** under the fleet-gap section noting blog-index `show_on_front='posts'` support landed (deployed build), with the three residuals.

- [ ] **Step 4: Final full verification**

Run: `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`
Expected: clean + all green.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(saas): blog-index show_on_front='posts' support — status + residuals"
```

---

## Self-Review

**1. Spec coverage (recommendation #1 / fleet-gap A10):**
- "synthesize a blog-index front page (query latest posts → list paradigm) when `show_on_front === 'posts'`, reusing the dynamic-list machinery rather than throwing" → Tasks 4 (emitter, reuses `normalizeRecord`), 5 (decision), 6 (persist mode), 7 (compose branch). ✓
- "fails loud" preserved → Task 5 throws a specific message when the posts list ability is missing; static-path errors reproduced verbatim. ✓

**2. Placeholder scan:** every code step contains complete, runnable code (emitter template, helper bodies, test bodies, exact compose/discovery edits with line anchors). No TBD/TODO. ✓

**3. Type consistency:**
- `listAbilityMetaFor` / `abilityMetaFor` both return `{ abilityName: string; wrapperKey: string } | null` — consumed identically by `resolveHomepageEmit`. ✓
- `HomepageEmitDecision` fields (`listAbility`, `wrapperKey`, `postType`, `frontPageSlug`, `paradigms`, `ability`, `sitemapExtraRoutes`) match exactly what Task 7's emit-homepage/sitemap steps read. ✓
- `BlogIndexInput` (`listAbility`, `wrapperKey`, `postType`, `limit`, `heading`) matches the Task 7 call site. ✓
- `buildFrontPageConfigPatch` return (`show_on_front?`, `front_page_slug?`) spreads cleanly into the `site_builds.config` read-modify-write in Task 6. ✓
- `show_on_front: "page" | "posts"` is the same union in `build-config.ts`, `homepage-emit.ts`, and the `/site` manifest. ✓

**4. Scope boundaries** are explicit (deployed build only; draft preview / pagination / review-coverage are documented follow-ups). No migration (rides existing JSONB). No WP plugin change. ✓
