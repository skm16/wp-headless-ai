# Faithful Clone — Routing Contract + URL Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two verified clone-fidelity blockers — (BUG-A) generated nav/content links point at the original WP origin, (BUG-B) secondary pages / posts / CPT entries 404 on the Vercel preview — and make the pipeline able to *see* this defect class.

**Architecture:** Track 1 replaces the static per-slug `ROUTE_MAP` allowlist contract with a two-level resolver in the emitted catch-all (per-slug fast path + per-post-type `POST_TYPE_MAP` fallback, leaf-slug fetch contract) — render-time ISR resolution, the proven New-Ink-Site pattern. Track 2 adds a deterministic origin-aware href rewriter applied to ALL generated TSX at compose time, plus an emitted runtime helper for URLs that only materialize at request time (Passthrough innerHTML, dynamic-list items), grounded by persisting the source permalink (`page_inventory.link`, migration 0033) to build an exact sourcePath→route_path map. Track 3 makes verify-fidelity record HTTP status (404 ⇒ score 0 + high-severity issue), adds the catch-all files to the deploy gate, and adds a route smoke.

**Tech Stack:** Next.js 15 App Router (emitted tree), TypeScript, Vitest, Supabase (Postgres + Storage), Inngest workers, Playwright.

---

## Context for implementers (read once)

The SaaS pipeline (apps/web) converts a connected WordPress site into a deployed Next.js clone: `discover-site.ts` → `generate-components.ts` → `compose-site.ts` → `deploy-site.ts` → `verify-fidelity.ts` (all in `apps/web/lib/inngest/functions/`). Compose emits a project tree to Supabase Storage at `builds/<buildId>/project/**` via pure emitters in `apps/web/lib/jab/compose-site-emit.ts`; deploy downloads it and POSTs to Vercel. The deployed app fetches all content **live from the client's WP at request time** (ISR `revalidate = 60`) through the JAB MCP abilities.

**Verified root causes this plan fixes:**

1. **Leaf-slug contract bug (BUG-B, fatal for ALL CPT detail routes):** the emitted catch-all does `const path = slug.join("/")` then calls the by-slug ability with `{ slug: path }` (e.g. `"beer/lil-heaven-ipa"`). The WP plugin (`PostTypeBySlugAbility.php`) runs `get_posts(['name' => $slug])` which matches the leaf `post_name` exactly — a `post_name` can never contain `/` — so every prefixed route returns null → `notFound()`. (`compose-site-emit.ts:1286`)
2. **No dynamic detail-route concept (BUG-B):** the whole routing universe is `app/page.tsx` + one catch-all gated by a static `ROUTE_MAP` built 1:1 from `page_inventory`. Discovery (`selectSeedPages`, `apps/web/lib/jab/seed-pages.ts`) deliberately admits only ONE sample row per non-page CPT (template-inventory economics), so at most one detail URL per CPT can ever exist, and any page published after discovery 404s.
3. **No URL-rewrite layer exists anywhere (BUG-A):** the shell LLM's only nav source is the captured source-site `<header>` outerHTML (absolute WP-origin hrefs); menus are fetched in discovery but only their COUNT survives; `extractPrimaryMenu(project.manifest)` reads a `menus` key that structurally cannot exist on the `@jab/core` Manifest type, so it's always null. Nothing post-processes hrefs. Ground truth (deployed build `ecf4cf6b`): `Header.tsx` nav links are `https://tworoadsbrewing.com/...` marked `external: false`; Footer column links were LLM-*invented* relative paths (`/careers/` vs the real slug `jobs`) — proving prompting-only relativization is insufficient; the fix must be deterministic.
4. **The pipeline can't see any of this:** `playwright-verify.ts` discards the `goto()` response (no HTTP status check); a 404 page pixel-scores ~0.5 and the build still flips `ready`; `REQUIRED_DEPLOY_FILES` doesn't include the catch-all files; no automated check ever requests a secondary route.

**Known bounds (documented, NOT fixed here — do not silently expand scope):**
- Hierarchical pages flatten to leaf slugs (`routePathFor`); two nested pages sharing a leaf hard-fail compose today via the duplicate-route throw. Site-agnostic closure needs a plugin by-path lookup — follow-up plugin release.
- Fallback-resolved long-tail pages have no `page_inventory` row → no screenshot, no fidelity row, not on the review screen. Documented residual; review-UI note is a follow-up.
- Host aliases (e.g. the wpengine staging host found in the Two Roads footer) won't match `wp_url`'s host and survive rewriting until `/jab/v1/site`'s `home_url` is persisted — documented residual.
- WP nav-menu persistence (structured nav for the shell LLM) — deferred follow-up; the rewriter + routePathMap fixes the reported defect without it.

**Repo conventions:** pure functions get colocated `*.test.ts` vitest files; Inngest worker bodies are smoke-covered, not unit-tested — keep logic in pure modules. Hand-written SQL migrations in `apps/web/drizzle/migrations/NNNN_*.sql`; **every migration must be applied to BOTH Supabase projects** (local/dev "JAB WP" `ajfurojjxthhzkjqttri`, prod "jab-prod" `celzwcxkrmsbwiswkxug`) via `mcp__supabase__apply_migration`. Conventional commits. Run web tests with `pnpm --filter @jab/web exec vitest run <path>`; typecheck with `pnpm --filter @jab/web exec tsc --noEmit`.

**⚠ Migration sequencing:** Task 10 adds `page_inventory.link` and persistence code that writes it. Until migration 0033 is applied to the dev project, a local discovery run will fail loudly at `persist-pages` (unknown column). The Supabase MCP is currently unauthorized — applying 0033 (and the already-pending 0032) is a flagged handoff step. Code-side work is not blocked.

**File structure (new/modified):**

| File | Responsibility |
|---|---|
| `apps/web/lib/jab/compose-site-emit.ts` | + leaf-slug fix, `POST_TYPE_MAP` emitter + entries builder, catch-all fallback, Passthrough rewrite import, rewrite-links emitter, sitemap/robots runtime base |
| `apps/web/lib/jab/rewrite-origin-links.ts` (NEW) | Pure compose-time TSX href rewriter + host/path helpers + routePathMap builder |
| `apps/web/lib/jab/rewrite-links-runtime.ts` (NEW) | Self-contained EMITTED runtime module (→ `lib/jab/rewrite-links.ts` in the generated tree) for request-time HTML href rewriting |
| `apps/web/lib/ai/generate-shell.ts`, `shell-prompts.ts` | Apply rewriter to shell TSX; prompt hardening |
| `apps/web/lib/ai/component-generator.ts` | Apply rewriter to component TSX; prompt hardening |
| `apps/web/lib/inngest/functions/compose-site.ts` | Wire POST_TYPE_MAP emit, sourceHosts/routePathMap threading, load `link` |
| `apps/web/lib/inngest/functions/generate-components.ts` | Thread sourceHosts into generateComponent |
| `apps/web/lib/jab/dynamic-lists-runtime.ts` | List items get local `/{postType}/{slug}` URLs |
| `apps/web/drizzle/migrations/0033_page_inventory_link.sql` (NEW) + `lib/db/schema.ts` + `lib/jab/persist-discovery.ts` + `discover-site.ts` + clone columns/carry-forward | Persist source permalink |
| `apps/web/lib/jab/playwright-verify.ts`, `lib/ai/fidelity-score.ts`, `verify-fidelity.ts` | HTTP-status capture + zero-score on 4xx/5xx |
| `apps/web/lib/jab/download-project-tree.ts` | Deploy gate covers catch-all files |
| `apps/web/lib/jab/smoke-routes.ts` (NEW) + `apps/web/scripts/smoke-deployed-routes.ts` (NEW) | Post-deploy route smoke |

---

## Track 1 — Routing contract (BUG-B)

### Task 1: Leaf-slug blocker fix in the emitted catch-all

The one-line fix that revives every currently-mapped CPT detail route. Ships alone.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (function `emitCatchAllPageTsx`, ~line 1268)
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/compose-site-emit.test.ts` (import `emitCatchAllPageTsx` if not already imported):

```ts
describe("compose-site-emit — catch-all leaf-slug contract", () => {
  it("calls the by-slug ability with the LEAF segment, never the joined path", () => {
    const src = emitCatchAllPageTsx();
    // The WP plugin matches post_name exactly; post_name can never contain "/".
    expect(src).toContain("const leaf = slug[slug.length - 1];");
    expect(src).toContain("{ slug: leaf, include: { blocks: true } }");
    expect(src).not.toContain("{ slug: path, include: { blocks: true } }");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts -t "leaf-slug"`
Expected: FAIL (emitted source still contains `{ slug: path, ... }`).

- [ ] **Step 3: Implement**

In `emitCatchAllPageTsx` in `apps/web/lib/jab/compose-site-emit.ts`, change the emitted body:

```ts
  const { slug } = await params;
  const path = slug.join("/");
  // ROUTE_MAP keys are full route paths ("beer/lil-heaven-ipa"), but the WP
  // by-slug ability matches the leaf post_name exactly (post_name can never
  // contain "/"). Passing the joined path returned null for EVERY prefixed
  // route — the 2026-06-10 BUG-B blocker.
  const leaf = slug[slug.length - 1];
  const entry = ROUTE_MAP[path];
  if (!entry) notFound();
  const response = await jabClient.callAbility(entry.abilityName, { slug: leaf, include: { blocks: true } });
```

(Only the `leaf` const + the `callAbility` argument change; everything else in the emitted template stays byte-identical.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS (whole file — confirms no other emitter test regressed).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "fix(saas): catch-all fetches by LEAF slug — prefixed CPT routes no longer 404"
```

---

### Task 2: `POST_TYPE_MAP` emitter + entries builder (pure)

A per-post-type registry the catch-all falls back to when a path isn't in `ROUTE_MAP`. One entry per discovered post type (including `page`), carrying the by-slug ability meta + representative paradigms.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (add below `emitRouteMapTs`, ~line 1331)
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import {
  emitPostTypeMapTs,
  postTypeMapEntriesFromPages,
  modalParadigms,
} from "./compose-site-emit";

describe("compose-site-emit — POST_TYPE_MAP", () => {
  const resolve = (postType: string) =>
    postType === "ghost"
      ? null
      : { abilityName: `jab/get-${postType}-by-slug`, wrapperKey: postType };

  it("groups pages by post_type, one entry each, sorted", () => {
    const entries = postTypeMapEntriesFromPages(
      [
        { post_type: "page", paradigms: ["gutenberg"] },
        { post_type: "page", paradigms: ["gutenberg"] },
        { post_type: "beer", paradigms: ["acf_flex"] },
      ],
      resolve,
    );
    expect(entries.map((e) => e.postType)).toEqual(["beer", "page"]);
    expect(entries[0]).toEqual({
      postType: "beer",
      abilityName: "jab/get-beer-by-slug",
      wrapperKey: "beer",
      paradigms: ["acf_flex"],
    });
  });

  it("omits post types with no resolvable by-slug ability", () => {
    const entries = postTypeMapEntriesFromPages(
      [{ post_type: "ghost", paradigms: [] }],
      resolve,
    );
    expect(entries).toEqual([]);
  });

  it("modalParadigms picks the most common set; ties go to first-seen", () => {
    expect(
      modalParadigms([["a"], ["b"], ["b"]]),
    ).toEqual(["b"]);
    expect(modalParadigms([["a"], ["b"]])).toEqual(["a"]);
    expect(modalParadigms([])).toEqual([]);
  });

  it("emits a typed record keyed by postType", () => {
    const src = emitPostTypeMapTs([
      { postType: "beer", abilityName: "jab/get-beer-by-slug", wrapperKey: "beer", paradigms: ["acf_flex"] },
    ]);
    expect(src).toContain(
      `"beer": { abilityName: "jab/get-beer-by-slug", wrapperKey: "beer", postType: "beer", paradigms: ["acf_flex"] },`,
    );
    expect(src).toContain(
      "export const POST_TYPE_MAP: Record<string, { abilityName: string; wrapperKey: string; postType: string; paradigms: string[] }>",
    );
  });

  it("emits an empty record for no entries", () => {
    expect(emitPostTypeMapTs([])).toContain("= {};");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts -t "POST_TYPE_MAP"`
Expected: FAIL with "does not provide an export named 'emitPostTypeMapTs'".

- [ ] **Step 3: Implement**

Add to `apps/web/lib/jab/compose-site-emit.ts` directly below `emitRouteMapTs`:

```ts
export interface PostTypeMapEntry {
  postType: string;
  abilityName: string;
  wrapperKey: string;
  paradigms: string[];
}

/**
 * Most common paradigms-set across a post type's sampled rows (ties → the
 * first-seen set). Discovery's seed-sampling premise is "one sample reveals
 * the CPT's template", so the modal set is the correct value for entries of
 * that CPT that were never individually sampled. Known bound: a CPT with
 * genuinely heterogeneous templates renders its minority entries with the
 * majority component set.
 */
export function modalParadigms(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  const counts = new Map<string, { count: number; first: number; value: string[] }>();
  sets.forEach((s, i) => {
    const key = JSON.stringify([...s].sort());
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { count: 1, first: i, value: s });
  });
  let best: { count: number; first: number; value: string[] } | null = null;
  for (const c of counts.values()) {
    if (!best || c.count > best.count || (c.count === best.count && c.first < best.first)) {
      best = c;
    }
  }
  return best ? best.value : [];
}

/**
 * One POST_TYPE_MAP entry per post type present in page_inventory.
 * `resolveAbility` is injected (the worker passes abilityMetaFor bound to the
 * manifest) so this stays pure. Post types with no by-slug ability are
 * omitted with a warn — same posture as the ROUTE_MAP emission.
 */
export function postTypeMapEntriesFromPages(
  pages: Array<{ post_type: string; paradigms: string[] }>,
  resolveAbility: (postType: string) => { abilityName: string; wrapperKey: string } | null,
): PostTypeMapEntry[] {
  const byType = new Map<string, string[][]>();
  for (const p of pages) {
    const sets = byType.get(p.post_type) ?? [];
    sets.push(p.paradigms ?? []);
    byType.set(p.post_type, sets);
  }
  const entries: PostTypeMapEntry[] = [];
  for (const [postType, paradigmSets] of byType) {
    const ability = resolveAbility(postType);
    if (!ability) {
      console.warn(
        `[compose-site] no by-slug ability for post_type '${postType}' — omitted from POST_TYPE_MAP`,
      );
      continue;
    }
    entries.push({
      postType,
      abilityName: ability.abilityName,
      wrapperKey: ability.wrapperKey,
      paradigms: modalParadigms(paradigmSets),
    });
  }
  return entries.sort((a, b) => a.postType.localeCompare(b.postType));
}

/**
 * app/[...slug]/post-type-map.ts emitter — the per-POST-TYPE fallback
 * registry behind ROUTE_MAP. Entry shape is identical to ROUTE_MAP values
 * so the catch-all can use either interchangeably.
 */
export function emitPostTypeMapTs(entries: PostTypeMapEntry[]): string {
  const body =
    entries.length === 0
      ? ""
      : "\n" +
        entries
          .map(
            (e) =>
              `  ${JSON.stringify(e.postType)}: { abilityName: ${JSON.stringify(e.abilityName)}, wrapperKey: ${JSON.stringify(e.wrapperKey)}, postType: ${JSON.stringify(e.postType)}, paradigms: ${JSON.stringify(e.paradigms)} },`,
          )
          .join("\n") +
        "\n";
  return `export const POST_TYPE_MAP: Record<string, { abilityName: string; wrapperKey: string; postType: string; paradigms: string[] }> = {${body}};
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): POST_TYPE_MAP emitter — per-post-type by-slug registry for catch-all fallback"
```

---

### Task 3: Catch-all fallback resolution (ROUTE_MAP miss → POST_TYPE_MAP)

On a `ROUTE_MAP` miss, resolve `/<postType>/<leaf>` via the CPT registry and bare `/<leaf>` via the `page` entry. `notFound()` only when WP itself returns null. Every published WP entry then resolves at request time, ISR-cached.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (`emitCatchAllPageTsx`)
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("compose-site-emit — catch-all POST_TYPE_MAP fallback", () => {
  it("falls back to the post-type registry on ROUTE_MAP miss", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toContain(`import { POST_TYPE_MAP } from "./post-type-map";`);
    expect(src).toContain("const mapped = ROUTE_MAP[path];");
    // multi-segment → CPT prefix lookup; single-segment → page fallback
    expect(src).toContain(
      `slug.length >= 2 ? POST_TYPE_MAP[slug.slice(0, -1).join("/")] : POST_TYPE_MAP["page"]`,
    );
    expect(src).toContain("const entry = mapped ?? fallback;");
    expect(src).toContain("if (!entry) notFound();");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts -t "POST_TYPE_MAP fallback"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `emitCatchAllPageTsx`, add the import line after the `ROUTE_MAP` import and replace the lookup block:

```ts
import { ROUTE_MAP } from "./route-map";
import { POST_TYPE_MAP } from "./post-type-map";
```

```ts
  const { slug } = await params;
  const path = slug.join("/");
  // ROUTE_MAP keys are full route paths ("beer/lil-heaven-ipa"), but the WP
  // by-slug ability matches the leaf post_name exactly (post_name can never
  // contain "/"). Passing the joined path returned null for EVERY prefixed
  // route — the 2026-06-10 BUG-B blocker.
  const leaf = slug[slug.length - 1];
  const mapped = ROUTE_MAP[path];
  // Discovery samples ONE row per non-page CPT (template economics), so
  // ROUTE_MAP can never enumerate every entry. Fall back to the per-post-type
  // registry: /<postType>/<leaf> via its CPT entry, bare /<leaf> via the page
  // entry. WP answering null is the only true 404.
  const fallback = mapped
    ? undefined
    : (slug.length >= 2 ? POST_TYPE_MAP[slug.slice(0, -1).join("/")] : POST_TYPE_MAP["page"]);
  const entry = mapped ?? fallback;
  if (!entry) notFound();
```

(The rest of the emitted body — `callAbility(entry.abilityName, { slug: leaf, ... })` onward — is unchanged from Task 1.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS (including Task 1's leaf-slug tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(saas): catch-all falls back to POST_TYPE_MAP — long-tail posts/CPTs resolve at request time"
```

---

### Task 4: Compose wiring — emit `post-type-map.ts`

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (emit steps block, after `emit-route-map` ~line 441)
- Verify: typecheck only (worker bodies are smoke-covered; the logic is pure and tested in Task 2)

- [ ] **Step 1: Wire the emit step**

In `apps/web/lib/inngest/functions/compose-site.ts`, extend the `compose-site-emit` import with `emitPostTypeMapTs, postTypeMapEntriesFromPages`, then add after the `emit-route-map` push:

```ts
    // Fallback registry behind ROUTE_MAP: one entry per discovered post type
    // (incl. "page"). The catch-all resolves un-enumerated detail URLs through
    // this at request time — see 2026-06-10 faithful-clone plan, Track 1.
    uploads.push(
      step.run("emit-post-type-map", () =>
        uploadToProject(
          buildId,
          "app/[...slug]/post-type-map.ts",
          emitPostTypeMapTs(
            postTypeMapEntriesFromPages(
              pageRows.map((p) => ({ post_type: p.post_type, paradigms: p.paradigms })),
              (postType) => abilityMetaFor(postType, manifest),
            ),
          ),
        ),
      ),
    );
```

(`uploadToProject` already routes through `PROJECT_PATH` → `encodeNextDynamicSegments`, so the `[...slug]` directory encodes to `__catchall_slug__` in Storage exactly like `route-map.ts` does.)

- [ ] **Step 2: Typecheck + full web suite**

Run: `pnpm --filter @jab/web exec tsc --noEmit` then `pnpm --filter @jab/web exec vitest run`
Expected: clean / all green.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(saas): compose emits app/[...slug]/post-type-map.ts"
```

---

## Track 2 — URL identity (BUG-A)

### Task 5: Pure origin-aware href rewriter

The deterministic guarantee for BUG-A. Rewrites absolute URLs on the source host(s) to root-relative paths inside generated TSX source — skipping asset URLs, which MUST stay absolute (the clone hotlinks WP media and `next.config` whitelists the WP host).

**Files:**
- Create: `apps/web/lib/jab/rewrite-origin-links.ts`
- Test: `apps/web/lib/jab/rewrite-origin-links.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  rewriteWpOriginUrls,
  hostVariants,
  isAssetPath,
  normalizePathname,
  buildRoutePathMap,
} from "./rewrite-origin-links";

const HOSTS = ["tworoadsbrewing.com"];

describe("rewriteWpOriginUrls", () => {
  it("rewrites source-host hrefs in TSX string literals to root-relative paths", () => {
    const src = `const nav = [{ href: "https://tworoadsbrewing.com/visit-us/", label: "Visit" }];`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(
      `const nav = [{ href: "/visit-us", label: "Visit" }];`,
    );
  });

  it("is www- and case-insensitive on host match", () => {
    const src = `<a href="https://WWW.TwoRoadsBrewing.com/beers">Beers</a>`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toContain(`href="/beers"`);
  });

  it("leaves foreign-host URLs untouched", () => {
    const src = `<a href="https://instagram.com/tworoads">IG</a>`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(src);
  });

  it("preserves asset URLs on the source host (wp-content + extensions)", () => {
    const a = `src="https://tworoadsbrewing.com/wp-content/uploads/logo.png"`;
    const b = `url("https://tworoadsbrewing.com/some/path/font.woff2")`;
    expect(rewriteWpOriginUrls(a, { sourceHosts: HOSTS })).toBe(a);
    expect(rewriteWpOriginUrls(b, { sourceHosts: HOSTS })).toBe(b);
  });

  it("rewrites the bare origin to /", () => {
    const src = `href="https://tworoadsbrewing.com"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(`href="/"`);
  });

  it("preserves query + hash", () => {
    const src = `href="https://tworoadsbrewing.com/events?cat=live#list"`;
    expect(rewriteWpOriginUrls(src, { sourceHosts: HOSTS })).toBe(`href="/events?cat=live#list"`);
  });

  it("maps source pathnames through routePathMap when provided", () => {
    const src = `href="https://tworoadsbrewing.com/beers/lil-heaven/"`;
    const out = rewriteWpOriginUrls(src, {
      sourceHosts: HOSTS,
      routePathMap: { "/beers/lil-heaven": "/beer/lil-heaven" },
    });
    expect(out).toBe(`href="/beer/lil-heaven"`);
  });
});

describe("helpers", () => {
  it("hostVariants returns bare + www variants", () => {
    expect(hostVariants("https://www.tworoadsbrewing.com/")).toEqual(
      expect.arrayContaining(["tworoadsbrewing.com", "www.tworoadsbrewing.com"]),
    );
  });

  it("isAssetPath catches wp paths and asset extensions", () => {
    expect(isAssetPath("/wp-content/uploads/x.pdf")).toBe(true);
    expect(isAssetPath("/wp-json/jab/v1/manifest")).toBe(true);
    expect(isAssetPath("/images/photo.jpeg")).toBe(true);
    expect(isAssetPath("/visit-us")).toBe(false);
  });

  it("normalizePathname strips a trailing slash except for root", () => {
    expect(normalizePathname("/about/")).toBe("/about");
    expect(normalizePathname("/")).toBe("/");
    expect(normalizePathname("")).toBe("/");
  });

  it("buildRoutePathMap maps source permalink paths to clone routes, skipping null/invalid", () => {
    expect(
      buildRoutePathMap([
        { link: "https://tworoadsbrewing.com/beers/lil-heaven/", route_path: "/beer/lil-heaven" },
        { link: null, route_path: "/about" },
        { link: "not a url", route_path: "/x" },
      ]),
    ).toEqual({ "/beers/lil-heaven": "/beer/lil-heaven" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/rewrite-origin-links.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/web/lib/jab/rewrite-origin-links.ts`:

```ts
/**
 * rewrite-origin-links.ts — deterministic compose-time URL-identity layer.
 *
 * Generated TSX (shell, block components) copies absolute hrefs from the
 * captured source-site DOM, which point at the ORIGINAL WordPress origin.
 * Prompting alone is provably insufficient (the model keeps the origin on
 * links it itself classifies internal, and invents wrong paths when it does
 * relativize — see the 2026-06-10 faithful-clone plan). This pure pass
 * rewrites source-host URLs to root-relative paths so they resolve on the
 * clone, whatever domain it deploys to.
 *
 * Asset URLs are deliberately EXEMPT: the clone hotlinks WP media
 * (next.config whitelists the WP host) — origin-stripping an <img src>
 * or CSS url() would break every image.
 */

const ASSET_PATH_PREFIXES = ["/wp-content/", "/wp-includes/", "/wp-json/"];
const ASSET_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|xml|txt)([?#]|$)/i;

/** Bare + www host variants for a WP base URL (lowercased). */
export function hostVariants(wpUrl: string): string[] {
  const host = new URL(wpUrl).hostname.toLowerCase();
  const bare = host.replace(/^www\./, "");
  return Array.from(new Set([bare, `www.${bare}`, host]));
}

export function isAssetPath(pathname: string): boolean {
  return (
    ASSET_PATH_PREFIXES.some((p) => pathname.startsWith(p)) ||
    ASSET_EXTENSIONS.test(pathname)
  );
}

/** Strip a trailing slash (Next.js 308s them anyway); "" → "/". */
export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

// Absolute http(s) URL inside source text. Terminates on quotes, whitespace,
// backticks, and closing delimiters so it works in string literals, JSX
// attributes, and template strings without swallowing surrounding code.
const ABSOLUTE_URL_RE = /https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>\\)\]}]*)?/g;

export interface RewriteOriginOptions {
  /** Host names (bare and/or www) considered the SOURCE origin. */
  sourceHosts: string[];
  /**
   * Exact sourcePathname → clone route_path overrides (built from
   * page_inventory.link). Looked up with the trailing-slash-normalized
   * pathname; unmapped paths fall back to the origin-stripped pathname.
   */
  routePathMap?: Record<string, string>;
}

export function rewriteWpOriginUrls(source: string, opts: RewriteOriginOptions): string {
  if (opts.sourceHosts.length === 0) return source;
  const hosts = new Set(opts.sourceHosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
  return source.replace(ABSOLUTE_URL_RE, (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!hosts.has(host)) return raw;
    if (isAssetPath(url.pathname)) return raw;
    const normalized = normalizePathname(url.pathname);
    const pathname = opts.routePathMap?.[normalized] ?? normalized;
    return `${pathname}${url.search}${url.hash}`;
  });
}

/**
 * sourcePathname → route_path map from page_inventory rows (migration 0033's
 * `link` column). Rows without a link (pre-0033 builds) are skipped — the
 * rewriter then falls back to plain origin-stripping, which is correct for
 * WP pages (route IS /<slug>) and an at-worst on-site 404 for diverged paths.
 */
export function buildRoutePathMap(
  pages: Array<{ link: string | null; route_path: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pages) {
    if (!p.link) continue;
    try {
      map[normalizePathname(new URL(p.link).pathname)] = p.route_path;
    } catch {
      // invalid permalink — skip
    }
  }
  return map;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/rewrite-origin-links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/rewrite-origin-links.ts apps/web/lib/jab/rewrite-origin-links.test.ts
git commit -m "feat(saas): pure origin-aware href rewriter (sourceHosts + routePathMap, asset-exempt)"
```

---

### Task 6: Shell wiring — rewrite Header/Footer TSX

This alone fixes the *reported* BUG-A (main nav).

**Files:**
- Modify: `apps/web/lib/ai/generate-shell.ts`
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (`baseShellInput`, ~line 602)
- Test: `apps/web/lib/ai/generate-shell.test.ts` (exists — extend)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/generate-shell.test.ts` (follow the file's existing fake-ModelClient pattern for a successful generation):

```ts
it("rewrites source-origin hrefs in generated shell TSX to relative paths", async () => {
  const client = fakeClient(`export function Header() {
  return (
    <nav>
      <a href="https://tworoadsbrewing.com/visit-us/">Visit</a>
      <img src="https://tworoadsbrewing.com/wp-content/uploads/logo.png" />
    </nav>
  );
}`);
  const out = await generateShell({
    kind: "header",
    shellDom: "<header>x</header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Two Roads",
    siteDescription: null,
    client,
    sourceHosts: ["tworoadsbrewing.com"],
    routePathMap: {},
  });
  expect(out.tsx).toContain(`href="/visit-us"`);
  expect(out.tsx).not.toContain(`href="https://tworoadsbrewing.com`);
  // asset URLs must survive
  expect(out.tsx).toContain(`src="https://tworoadsbrewing.com/wp-content/uploads/logo.png"`);
});
```

(If the test file's fake client helper has a different name/shape, adapt the construction — the assertion block is the contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/generate-shell.test.ts`
Expected: FAIL (unknown option `sourceHosts` / hrefs unrewritten).

- [ ] **Step 3: Implement**

In `apps/web/lib/ai/generate-shell.ts`:

```ts
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";
```

Extend the options interface:

```ts
export interface GenerateShellOptions {
  // ... existing fields unchanged ...
  /** Source-WP host variants; when set, generated TSX gets origin-stripped. */
  sourceHosts?: string[];
  /** sourcePathname → clone route_path overrides (see rewrite-origin-links). */
  routePathMap?: Record<string, string>;
}
```

Inside `generateShell`, add a local helper right after destructuring:

```ts
  const relink = (tsx: string): string =>
    opts.sourceHosts && opts.sourceHosts.length > 0
      ? rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap })
      : tsx;
```

Apply it at all three TSX exits:
1. The empty-shellDom short-circuit: `tsx: relink(shellDeterministicFallback(kind, menu, siteName)),`
2. After postprocess, before the size cap: `stripped = relink(stripped);` (rewriting only shortens, so cap/validate order is safe)
3. The final-failure fallback: `tsx: relink(shellDeterministicFallback(kind, menu, siteName)),`

In `apps/web/lib/inngest/functions/compose-site.ts`, import `hostVariants` from `@/lib/jab/rewrite-origin-links` and extend `baseShellInput`:

```ts
    const baseShellInput = {
      themeTokens,
      themeClassNames,
      menu: extractPrimaryMenu(project.manifest),
      logoUrl: bundledLogoUrl,
      siteName: project.name,
      siteDescription: description,
      client: shellClient,
      // BUG-A guarantee: strip the WP origin from every generated shell href.
      sourceHosts: hostVariants(wpUrl),
    };
```

(`routePathMap` joins in Task 11 once `link` is persisted.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/generate-shell.test.ts` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/generate-shell.ts apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/ai/generate-shell.test.ts
git commit -m "fix(saas): shell TSX origin-stripped — main nav links stay on the clone (BUG-A)"
```

---

### Task 7: Component-generation wiring — rewrite block-component TSX

Covers block components (CTA buttons, breadcrumbs, hardcoded fallback domains).

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` (`GenerateComponentOptions` ~line 662; post-postprocess ~line 756)
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` (call site ~line 312 + project load)
- Test: `apps/web/lib/ai/component-generator.test.ts` (exists — extend)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/component-generator.test.ts`, following its existing fake-client success-path pattern:

```ts
it("rewrites source-origin hrefs in generated component TSX", async () => {
  const client = fakeClientReturning(`export function CoreButton({ block }: { block: BlockNode }) {
  return <a href="https://tworoadsbrewing.com/contact/">Contact</a>;
}`);
  const out = await generateComponent({
    entry: minimalEntry("core/button"),
    tokens: null,
    sourceHosts: ["tworoadsbrewing.com"],
    client,           // only if the test harness injects the client this way
  });
  expect(out.tsx).toContain(`href="/contact"`);
  expect(out.tsx).not.toContain("tworoadsbrewing.com/contact");
});
```

(Adapt helper names to the file's existing fixtures — `generateComponent`'s client injection differs from `generateShell`; reuse however the existing success-path test stubs the model call.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/web/lib/ai/component-generator.ts`:

```ts
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";
```

```ts
export interface GenerateComponentOptions {
  // ... existing fields unchanged ...
  /** Source-WP host variants; when set, generated TSX gets origin-stripped. */
  sourceHosts?: string[];
}
```

In the generation loop, immediately after the successful `postprocessGeneratedTsx` call (before the size cap):

```ts
    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      tsx = rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts });
    }
```

In `apps/web/lib/inngest/functions/generate-components.ts`: locate where the worker loads the project (it already loads design tokens; if `wp_url` isn't in that select, add it — or add a small `step.run("load-wp-url")` fetching `projects.wp_url` by `projectId`/`tenantId`). Then:

```ts
import { hostVariants } from "@/lib/jab/rewrite-origin-links";
// ...
const sourceHosts = project.wp_url ? hostVariants(project.wp_url) : [];
```

and thread it into the call at ~line 312:

```ts
const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
```

(`sourceHosts` is computed once outside the per-entry loop. Fail-soft: missing/invalid `wp_url` → empty array → rewriter no-ops.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/inngest/functions/generate-components.ts apps/web/lib/ai/component-generator.test.ts
git commit -m "fix(saas): block-component TSX origin-stripped (BUG-A coverage for body content)"
```

---

### Task 8: Emitted runtime — Passthrough innerHTML + dynamic-list item links

Two URL surfaces only materialize at request time on the deployed clone: Passthrough's WP `innerHTML` and dynamic-list items (`rec.link` = WP `get_permalink()`). Ship a self-contained emitted runtime module + give list items local clone URLs.

**Files:**
- Create: `apps/web/lib/jab/rewrite-links-runtime.ts` (+ test `rewrite-links-runtime.test.ts`)
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (`emitRewriteLinksTs` new; `emitPassthroughTsx`)
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (emit step)
- Modify: `apps/web/lib/jab/dynamic-lists-runtime.ts` (+ its existing test file)

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/jab/rewrite-links-runtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rewriteHtmlOriginLinks, sourceHostsFromEnv } from "./rewrite-links-runtime";

describe("rewriteHtmlOriginLinks", () => {
  const hosts = ["tworoadsbrewing.com"];

  it("rewrites source-host hrefs in HTML to relative paths", () => {
    const html = `<p><a href="https://www.tworoadsbrewing.com/visit-us/">Visit</a></p>`;
    expect(rewriteHtmlOriginLinks(html, hosts)).toBe(`<p><a href="/visit-us">Visit</a></p>`);
  });

  it("leaves foreign hosts and asset URLs alone", () => {
    const html =
      `<a href="https://instagram.com/x">IG</a>` +
      `<a href="https://tworoadsbrewing.com/wp-content/uploads/menu.pdf">Menu</a>`;
    expect(rewriteHtmlOriginLinks(html, hosts)).toBe(html);
  });

  it("no-ops on empty hosts", () => {
    const html = `<a href="https://tworoadsbrewing.com/x">x</a>`;
    expect(rewriteHtmlOriginLinks(html, [])).toBe(html);
  });
});

describe("sourceHostsFromEnv", () => {
  it("derives bare + www variants from WP_URL", () => {
    expect(sourceHostsFromEnv("https://www.tworoadsbrewing.com")).toEqual(
      expect.arrayContaining(["tworoadsbrewing.com", "www.tworoadsbrewing.com"]),
    );
  });
  it("returns [] for missing/invalid input", () => {
    expect(sourceHostsFromEnv(undefined)).toEqual([]);
    expect(sourceHostsFromEnv("not a url")).toEqual([]);
  });
});
```

Add to `apps/web/lib/jab/dynamic-lists-runtime.test.ts` (existing file — follow its `normalizeRecord` fixtures):

```ts
it("items link to the LOCAL clone route when postType + slug are known", async () => {
  const item = await normalizeRecord(
    { id: 1, title: "Movie Night", slug: "movie-night", link: "https://tworoadsbrewing.com/events/movie-night/" },
    { dateField: null, postType: "event" },
  );
  expect(item.url).toBe("/event/movie-night");
});

it("falls back to the WP link when the record has no slug", async () => {
  const item = await normalizeRecord(
    { id: 2, title: "X", link: "https://tworoadsbrewing.com/events/x/" },
    { dateField: null, postType: "event" },
  );
  expect(item.url).toBe("https://tworoadsbrewing.com/events/x/");
});
```

Add to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
describe("compose-site-emit — runtime link rewriting", () => {
  it("emitRewriteLinksTs mirrors rewrite-links-runtime.ts verbatim", () => {
    const src = emitRewriteLinksTs();
    expect(src).toContain("export function rewriteHtmlOriginLinks");
    expect(src).toContain("export function sourceHostsFromEnv");
  });

  it("Passthrough rewrites WP innerHTML hrefs via the runtime helper", () => {
    const src = emitPassthroughTsx();
    expect(src).toContain(
      `import { rewriteHtmlOriginLinks, sourceHostsFromEnv } from "@/lib/jab/rewrite-links";`,
    );
    expect(src).toContain("rewriteHtmlOriginLinks(block.innerHTML ?? \"\", sourceHostsFromEnv(process.env.WP_URL))");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/rewrite-links-runtime.test.ts lib/jab/dynamic-lists-runtime.test.ts lib/jab/compose-site-emit.test.ts`
Expected: FAIL (module/function not found; url assertions fail).

- [ ] **Step 3: Implement the runtime module**

Create `apps/web/lib/jab/rewrite-links-runtime.ts`:

```ts
// EMITTED RUNTIME MODULE. Read verbatim by emitRewriteLinksTs() and written to
// the generated project at lib/jab/rewrite-links.ts. MUST stay self-contained
// (no "@/…" imports). Deliberately duplicates the host-match/asset-skip rules
// from rewrite-origin-links.ts (which is apps-side compose-time code and can't
// ship into the generated tree) — same convention as the toPascalCase copies.
//
// Why this exists: Passthrough innerHTML and any other WP-fetched HTML only
// materialize at REQUEST time on the deployed clone, so compose-time TSX
// rewriting can't reach them. The deployed app derives the source hosts from
// its own WP_URL env (already synced to Vercel by the deploy worker).

const ASSET_PATH_PREFIXES = ["/wp-content/", "/wp-includes/", "/wp-json/"];
const ASSET_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|xml|txt)([?#]|$)/i;

/** Bare + www host variants from a WP base URL; [] on missing/invalid. */
export function sourceHostsFromEnv(wpUrl: string | undefined): string[] {
  if (!wpUrl) return [];
  try {
    const host = new URL(wpUrl).hostname.toLowerCase();
    const bare = host.replace(/^www\./, "");
    return Array.from(new Set([bare, `www.${bare}`, host]));
  } catch {
    return [];
  }
}

/** Rewrite href="<source-origin>/path" attributes in an HTML string to relative paths. */
export function rewriteHtmlOriginLinks(html: string, hosts: string[]): string {
  if (hosts.length === 0) return html;
  const set = new Set(hosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (match, raw: string) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!set.has(host)) return match;
      if (
        ASSET_PATH_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
        ASSET_EXTENSIONS.test(url.pathname)
      ) {
        return match;
      }
      const path =
        url.pathname.length > 1 && url.pathname.endsWith("/")
          ? url.pathname.slice(0, -1)
          : url.pathname || "/";
      return `href="${path}${url.search}${url.hash}"`;
    } catch {
      return match;
    }
  });
}
```

- [ ] **Step 4: Wire the emitter + Passthrough + compose step**

In `apps/web/lib/jab/compose-site-emit.ts`, next to `emitDynamicListsTs`:

```ts
/**
 * lib/jab/rewrite-links.ts emitter — request-time origin-link rewriting,
 * read verbatim from rewrite-links-runtime.ts. Mirrors emitDynamicListsTs.
 */
export function emitRewriteLinksTs(): string {
  return readFileSync(join(process.cwd(), "lib/jab/rewrite-links-runtime.ts"), "utf8");
}
```

In `emitPassthroughTsx`, add the import line to the emitted `lines` array and change the html const:

```ts
    `import type { ReactNode } from "react";`,
    `import type { BlockNode } from "@/lib/sdk/types";`,
    `import { rewriteHtmlOriginLinks, sourceHostsFromEnv } from "@/lib/jab/rewrite-links";`,
    ``,
    `export function Passthrough({ block, children }: { block: BlockNode; children?: ReactNode }) {`,
    `  // WP innerHTML carries absolute source-origin hrefs; rewrite them to`,
    `  // relative so in-content links stay on the clone. Assets stay absolute.`,
    `  const html = rewriteHtmlOriginLinks(block.innerHTML ?? "", sourceHostsFromEnv(process.env.WP_URL));`,
```

(The remaining emitted lines are unchanged.)

In `apps/web/lib/inngest/functions/compose-site.ts`, next to the `emit-dynamic-lists-runtime` push (import `emitRewriteLinksTs`):

```ts
    uploads.push(
      step.run("emit-rewrite-links", () =>
        uploadToProject(buildId, "lib/jab/rewrite-links.ts", emitRewriteLinksTs()),
      ),
    );
```

- [ ] **Step 5: Dynamic-list local URLs**

In `apps/web/lib/jab/dynamic-lists-runtime.ts`, extend `normalizeRecord`'s opts and url derivation:

```ts
export async function normalizeRecord(
  rec: RawRecord,
  opts: { dateField: string | null; resolveMedia?: MediaResolver; postType?: string },
): Promise<JabListItem> {
  const acf = rec.acf && typeof rec.acf === "object" ? (rec.acf as Record<string, unknown>) : {};
  const title = pickString(rec.title) ?? "";
  // Prefer the LOCAL clone route (/<postType>/<slug>, matching routePathFor +
  // POST_TYPE_MAP) so list cards navigate on the clone instead of jumping to
  // the source WP site. WP's absolute permalink is the last-resort fallback.
  const slugVal = typeof (rec as { slug?: unknown }).slug === "string" ? ((rec as { slug: string }).slug) : null;
  const localUrl = opts.postType && slugVal ? `/${opts.postType}/${slugVal}` : null;
  return {
    id: typeof rec.id === "number" ? rec.id : 0,
    title,
    url: localUrl ?? pickString(rec.link) ?? pickString((rec as { permalink?: unknown }).permalink) ?? "#",
    // ... rest unchanged ...
```

Then find the `normalizeRecord(...)` call inside `resolveDynamicLists` (same file, further down) and add `postType: spec.postType` to its opts object.

- [ ] **Step 6: Run all affected tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/rewrite-links-runtime.test.ts lib/jab/dynamic-lists-runtime.test.ts lib/jab/compose-site-emit.test.ts` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/jab/rewrite-links-runtime.ts apps/web/lib/jab/rewrite-links-runtime.test.ts apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/jab/dynamic-lists-runtime.ts apps/web/lib/jab/dynamic-lists-runtime.test.ts
git commit -m "fix(saas): request-time link rewriting — Passthrough innerHTML + local dynamic-list item URLs"
```

---

### Task 9: Emitted sitemap/robots advertise the clone's own origin

`emitRobotsTs(wpUrl)` / `emitSitemapTs(routes, wpUrl)` currently bake the WP origin as the clone's base URL. Vercel injects `VERCEL_PROJECT_PRODUCTION_URL` (system env) — read it at runtime, falling back to the wpUrl literal for non-Vercel local dev.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts` (`emitRobotsTs` ~line 842, `emitSitemapTs` ~line 870)
- Test: `apps/web/lib/jab/compose-site-emit.test.ts` (existing robots/sitemap describes ~line 754)

- [ ] **Step 1: Update the tests (they currently pin the WP-origin literal)**

Replace the existing assertions in the robots/sitemap describes so they pin the new contract:

```ts
// robots
it("derives the base URL from VERCEL_PROJECT_PRODUCTION_URL with wpUrl fallback", () => {
  const src = emitRobotsTs("https://tworoadsbrewing.com");
  expect(src).toContain("process.env.VERCEL_PROJECT_PRODUCTION_URL");
  expect(src).toContain(`"https://tworoadsbrewing.com"`); // the fallback literal
  expect(src).toContain("`${baseUrl}/sitemap.xml`");
});

// sitemap
it("derives the base URL from VERCEL_PROJECT_PRODUCTION_URL with wpUrl fallback", () => {
  const src = emitSitemapTs([{ routePath: "/about" }], "https://tworoadsbrewing.com/");
  expect(src).toContain("process.env.VERCEL_PROJECT_PRODUCTION_URL");
  expect(src).toContain(`"https://tworoadsbrewing.com"`);
  expect(src).toContain("`${baseUrl}/about`");
});
```

(Keep/adjust the trailing-slash-strip test — the fallback literal must still be slash-stripped.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts -t "base URL"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In both emitters, replace the baked `baseUrl` string with an emitted runtime derivation. Pattern (apply analogously in each):

```ts
const stripped = baseUrl.replace(/\/+$/, "");
return `import type { MetadataRoute } from "next";

// The clone's own origin: Vercel injects VERCEL_PROJECT_PRODUCTION_URL as a
// system env var; local/non-Vercel falls back to the source WP URL (the only
// origin known at compose time).
const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? \`https://\${process.env.VERCEL_PROJECT_PRODUCTION_URL}\`
  : ${JSON.stringify(stripped)};
...`;
```

Update the body references to use `` `${baseUrl}/sitemap.xml` `` / `` `${baseUrl}${route}` `` template strings in the emitted code (instead of pre-concatenated literals).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "fix(saas): emitted sitemap/robots use the clone's own origin (VERCEL_PROJECT_PRODUCTION_URL)"
```

---

### Task 10: Migration 0033 — persist the source permalink (`page_inventory.link`)

`row.link` (the true WP permalink) is in hand at discovery and dropped at persist. It's the BUG-A/BUG-B junction: the exact sourcePath→route_path map needs it.

**Files:**
- Create: `apps/web/drizzle/migrations/0033_page_inventory_link.sql`
- Modify: `apps/web/lib/db/schema.ts` (`pageInventory`, ~line 306)
- Modify: `apps/web/lib/jab/persist-discovery.ts` (`PersistPagesPage`, `toPageInventoryRow`)
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (persist-pages mapping ~line 705)
- Modify: `apps/web/lib/inngest/functions/edit-site.helpers.ts` (`PAGE_INVENTORY_CLONE_COLUMNS`)
- Modify: `apps/web/lib/jab/carry-forward.ts` (carried page-row mapper + prior-build loader select)
- Tests: `apps/web/lib/jab/persist-discovery.test.ts`, the schema-completeness test (will fail by design until the clone columns are updated), `apps/web/lib/jab/carry-forward.test.ts`

- [ ] **Step 1: Write the migration**

Create `apps/web/drizzle/migrations/0033_page_inventory_link.sql`:

```sql
-- 0033_page_inventory_link.sql — 2026-06-10 faithful-clone campaign (Track 2).
--
-- The absolute source permalink (WP get_permalink) for each discovered page.
-- Fetched at discovery since v2 Phase A (PostListRow.link) but dropped at
-- persist. Needed to build the compose-time sourcePathname -> route_path map
-- that lets the origin-link rewriter map diverged paths (nested pages,
-- CPT rewrite bases) onto real clone routes instead of guessing.
ALTER TABLE public.page_inventory ADD COLUMN IF NOT EXISTS link text;
COMMENT ON COLUMN public.page_inventory.link IS
  'Absolute source permalink captured at discovery. NULL for pre-0033 rows. Drives buildRoutePathMap (2026-06-10 faithful-clone campaign).';
```

- [ ] **Step 2: Apply to BOTH Supabase projects (flagged — may be blocked)**

Via `mcp__supabase__apply_migration` with name `page_inventory_link`: first `ajfurojjxthhzkjqttri` (JAB WP / dev), then `celzwcxkrmsbwiswkxug` (jab-prod). **If the Supabase MCP is still unauthorized, record this as a blocked handoff item alongside 0032 and continue — but note that local discovery runs will fail at persist-pages until the dev project has the column.**

- [ ] **Step 3: Write the failing tests**

Add to `apps/web/lib/jab/persist-discovery.test.ts` (follow existing `toPageInventoryRow` cases):

```ts
it("persists the source permalink as link, null when absent", () => {
  const base = pageFixture(); // the file's existing minimal PersistPagesPage fixture
  expect(toPageInventoryRow({ ...base, link: "https://x.com/a/" }, "b", "p").link).toBe("https://x.com/a/");
  expect(toPageInventoryRow(base, "b", "p").link).toBeNull();
});
```

Run the schema-completeness test (from the 2026-06-09 campaign, in `edit-site.helpers.test.ts` or colocated) — after the schema change in Step 4 it MUST fail, proving the drift guard works, until Step 5 updates the clone columns.

- [ ] **Step 4: Implement schema + persist threading**

`apps/web/lib/db/schema.ts` — add after `routePath`:

```ts
    // Absolute source permalink captured at discovery (migration 0033).
    // NULL for pre-0033 rows. Drives the compose-time sourcePath→route_path
    // rewrite map (buildRoutePathMap).
    link: text("link"),
```

`apps/web/lib/jab/persist-discovery.ts`:

```ts
export interface PersistPagesPage {
  // ... existing fields ...
  /** Absolute source permalink (WP get_permalink). NULL when unknown. */
  link?: string | null;
}
```

and in `toPageInventoryRow`'s returned object: `link: page.link ?? null,`

`apps/web/lib/inngest/functions/discover-site.ts` — in the persist-pages mapping (the object built per `pageBlocks` entry, ~line 705), add:

```ts
                link: p.url || null,
```

(`p.url` is already populated from `row.link` at ~line 438.)

- [ ] **Step 5: Carry-forward + clone columns**

`apps/web/lib/inngest/functions/edit-site.helpers.ts`:

```ts
export const PAGE_INVENTORY_CLONE_COLUMNS =
  "slug, post_type, title, route_path, block_count, source_screenshot_paths, rendering, paradigms, block_tree, source_modified_gmt, link";
```

`apps/web/lib/jab/carry-forward.ts`: add `link` to the prior-build loader's select + the carried page-row mapper (`carriedPageRow`) so carried rows keep their permalink — mirror exactly how `source_modified_gmt` flows through, and extend the existing carry-forward tests' fixtures/assertions with a `link` value.

- [ ] **Step 6: Run the full web suite + typecheck**

Run: `pnpm --filter @jab/web exec vitest run` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: all green (schema-completeness test passes again now that the clone columns carry `link`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/drizzle/migrations/0033_page_inventory_link.sql apps/web/lib/db/schema.ts apps/web/lib/jab/persist-discovery.ts apps/web/lib/jab/persist-discovery.test.ts apps/web/lib/inngest/functions/discover-site.ts apps/web/lib/inngest/functions/edit-site.helpers.ts apps/web/lib/jab/carry-forward.ts apps/web/lib/jab/carry-forward.test.ts
git commit -m "feat(saas): persist source permalink on page_inventory (migration 0033) + carry-forward"
```

---

### Task 11: Thread the sourcePath→route_path map into shell rewriting

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (load-pages select ~line 224; `PageInventoryRow` type; `baseShellInput`)
- Test: covered by Task 5's `buildRoutePathMap` tests + typecheck; add one compose-emit-level assertion if a pure seam exists

- [ ] **Step 1: Implement**

In `compose-site.ts`:

1. Extend the load-pages select: `.select("slug, post_type, route_path, paradigms, link")` and add `link: string | null` to the worker's `PageInventoryRow` type (defined near the top of the file or in its types import — locate and extend).
2. Import `buildRoutePathMap` from `@/lib/jab/rewrite-origin-links`.
3. Extend `baseShellInput`:

```ts
      sourceHosts: hostVariants(wpUrl),
      // Exact permalink→route mapping (0033). Empty for pre-0033 builds —
      // the rewriter then falls back to plain origin-stripping.
      routePathMap: buildRoutePathMap(
        pageRows.map((p) => ({ link: p.link ?? null, route_path: p.route_path })),
      ),
```

- [ ] **Step 2: Typecheck + full suite**

Run: `pnpm --filter @jab/web exec tsc --noEmit` then `pnpm --filter @jab/web exec vitest run`
Expected: clean / green.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(saas): shell rewriting maps source permalinks onto real clone routes"
```

---

### Task 12: Prompt hardening (defense-in-depth only)

The deterministic rewriter is the guarantee; these lines reduce how often it has work to do and stop the LLM *inventing* relative paths.

**Files:**
- Modify: `apps/web/lib/ai/shell-prompts.ts` (`ShellPromptInput`, `sharedShellSystemPrompt` ~line 150, both prompt builders)
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (`baseShellInput`)
- Modify: `apps/web/lib/ai/component-generator.ts` (system prompt ~line 67 + options threading)
- Modify: `apps/web/lib/ai/generate-shell.ts` (pass `sourceHost` through to prompt input)
- Test: `apps/web/lib/ai/shell-prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("system prompt declares source-host URLs internal and bans the origin in hrefs", () => {
  const prompt = headerPrompt({
    shellDom: `<header><a href="https://tworoadsbrewing.com/visit-us/">Visit</a></header>`,
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Two Roads",
    siteDescription: null,
    sourceHost: "tworoadsbrewing.com",
  });
  expect(prompt).toContain("tworoadsbrewing.com are INTERNAL");
  expect(prompt).toContain("root-relative");
});

it("omits the internal-links rule when no sourceHost provided", () => {
  const prompt = headerPrompt({
    shellDom: "<header>x</header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "X",
    siteDescription: null,
  });
  expect(prompt).not.toContain("are INTERNAL");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/shell-prompts.test.ts`
Expected: FAIL (unknown `sourceHost` field).

- [ ] **Step 3: Implement**

`shell-prompts.ts`:

```ts
export interface ShellPromptInput {
  // ... existing fields ...
  /** Source-WP hostname; when set, the prompt declares its URLs internal. */
  sourceHost?: string | null;
}
```

```ts
function sharedShellSystemPrompt(hasThemeClasses: boolean, sourceHost?: string | null): string {
  // ... existing tailwindRule ...
  const internalLinksRule = sourceHost
    ? `\n- Links whose host is ${sourceHost} are INTERNAL links to THIS site. Emit them as root-relative paths copied EXACTLY from the source URL's path (e.g. https://${sourceHost}/visit-us/ → /visit-us). NEVER emit ${sourceHost} in any href, and NEVER invent a path that is not in the source DOM.`
    : "";
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
${tailwindRule}${internalLinksRule}
- ... rest unchanged ...`;
}
```

Both `headerPrompt`/`footerPrompt` call `sharedShellSystemPrompt(hasThemeClasses, input.sourceHost)`.

`generate-shell.ts`: add `sourceHost?: string | null` to `GenerateShellOptions` and include it in `promptInput`.

`compose-site.ts` `baseShellInput`: `sourceHost: new URL(wpUrl).hostname,`.

`component-generator.ts`: thread `opts.sourceHosts?.[0]` into its system-prompt builder and append the analogous single line to the `## Output contract` block (same wording, "component" context):

```ts
  const internalLinksRule = sourceHost
    ? `\n- Links whose host is ${sourceHost} are INTERNAL. Emit them as root-relative paths copied exactly from the source URL's path. NEVER emit ${sourceHost} in any href.`
    : "";
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/shell-prompts.test.ts lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/component-generator.ts apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/ai/shell-prompts.test.ts
git commit -m "feat(saas): prompts declare source-host URLs internal (defense-in-depth for the rewriter)"
```

---

## Track 3 — Pipeline visibility

### Task 13: verify-fidelity sees HTTP failures (404 ⇒ score 0 + high issue)

Today a 404 page pixel-scores ~0.5 and the build goes `ready` silently. Capture `goto()`'s status; 4xx/5xx pages score 0 with a high-severity issue so the review screen blocks publish on them.

**Files:**
- Modify: `apps/web/lib/jab/playwright-verify.ts` (`VerifyPageResult`, capture loop ~line 141)
- Modify: `apps/web/lib/ai/fidelity-score.ts` (new pure `httpFailureRow`)
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts` (score-pages loop ~line 157)
- Test: `apps/web/lib/ai/fidelity-score.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/ai/fidelity-score.test.ts`:

```ts
import { httpFailureRow } from "./fidelity-score";

describe("httpFailureRow", () => {
  it("returns null for 2xx/3xx and unknown status", () => {
    expect(httpFailureRow(200, "/about")).toBeNull();
    expect(httpFailureRow(308, "/about")).toBeNull();
    expect(httpFailureRow(null, "/about")).toBeNull();
    expect(httpFailureRow(undefined, "/about")).toBeNull();
  });

  it("returns a zero-score high-severity row for 4xx/5xx", () => {
    const row = httpFailureRow(404, "/beer/lil-heaven-ipa");
    expect(row).not.toBeNull();
    expect(row!.score).toBe(0);
    expect(row!.issues[0].severity).toBe("high");
    expect(row!.issues[0].description).toContain("HTTP 404");
    expect(row!.issues[0].description).toContain("/beer/lil-heaven-ipa");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/fidelity-score.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/lib/ai/fidelity-score.ts`:

```ts
/**
 * Zero-score row for a page whose deployed URL answered 4xx/5xx. A 404
 * previously pixel-scored ~0.5 (dimension-mismatch fallback) and sailed
 * through to 'ready' — the most severe fidelity failure was the least
 * visible one. Score 0 + a high issue makes the review screen block it.
 */
export function httpFailureRow(
  status: number | null | undefined,
  routePath: string,
): { score: 0; issues: Array<{ block_name: string; severity: "high"; description: string }> } | null {
  if (typeof status !== "number" || status < 400) return null;
  return {
    score: 0,
    issues: [
      {
        block_name: "_page",
        severity: "high",
        description: `HTTP ${status} loading ${routePath} — the deployed page failed to load. Routing or data fetch is broken for this page.`,
      },
    ],
  };
}
```

`apps/web/lib/jab/playwright-verify.ts`:

```ts
export interface VerifyPageResult {
  // ... existing fields ...
  /** HTTP status of the 1280-viewport navigation; null when unavailable. */
  httpStatus?: number | null;
}
```

In the capture loop, capture the response and record at the 1280 viewport:

```ts
          const response = await browserPage.goto(target, {
            waitUntil: "networkidle",
            timeout: NAV_TIMEOUT_MS,
          });
          if (viewport === 1280) {
            pageResult.httpStatus = response ? response.status() : null;
          }
```

`apps/web/lib/inngest/functions/verify-fidelity.ts` — import `httpFailureRow`; at the top of the per-page scoring loop, right after `const generated = ...`:

```ts
          // HTTP-failure short-circuit: a 4xx/5xx page must not pixel-score.
          const httpFail = httpFailureRow(generated?.httpStatus, page.route_path);
          if (httpFail) {
            rows.push({
              page_inventory_id: page.id,
              score: httpFail.score,
              pixel_diff: null,
              issues: httpFail.issues,
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              skipped: false,
            });
            continue;
          }
```

(The build still reaches `ready` — the mandatory review gate is where a zero-score page blocks publish. Do NOT fail the build here.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/fidelity-score.test.ts` then `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/playwright-verify.ts apps/web/lib/ai/fidelity-score.ts apps/web/lib/inngest/functions/verify-fidelity.ts apps/web/lib/ai/fidelity-score.test.ts
git commit -m "feat(saas): verify-fidelity records HTTP status — 4xx/5xx pages score 0 with a high issue"
```

---

### Task 14: Deploy gate covers the catch-all route files

**Files:**
- Modify: `apps/web/lib/jab/download-project-tree.ts` (`REQUIRED_DEPLOY_FILES`, ~line 189)
- Test: `apps/web/lib/jab/download-project-tree.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing test**

```ts
it("requires the catch-all route files (the entire non-homepage URL space)", () => {
  const complete = [
    "package.json", "tsconfig.json", "next.config.ts", "app/layout.tsx", "app/page.tsx",
    "app/[...slug]/page.tsx", "app/[...slug]/route-map.ts", "app/[...slug]/post-type-map.ts",
  ];
  expect(() => assertRequiredFiles(complete)).not.toThrow();
  expect(() => assertRequiredFiles(complete.filter((f) => f !== "app/[...slug]/post-type-map.ts")))
    .toThrow(/post-type-map/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/download-project-tree.test.ts`
Expected: FAIL (the filtered list passes today).

- [ ] **Step 3: Implement**

```ts
export const REQUIRED_DEPLOY_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "app/layout.tsx",
  "app/page.tsx",
  // Every non-homepage URL resolves through these three. assertRequiredFiles
  // runs on DECODED paths (downloadProjectTree decodes __catchall_slug__ →
  // [...slug] before asserting), hence the bracket form here.
  "app/[...slug]/page.tsx",
  "app/[...slug]/route-map.ts",
  "app/[...slug]/post-type-map.ts",
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/download-project-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/download-project-tree.ts apps/web/lib/jab/download-project-tree.test.ts
git commit -m "feat(saas): deploy gate asserts the catch-all route files"
```

---

### Task 15: Post-deploy route smoke (script + pure helper)

No automated check ever requests a secondary route today. A tiny fetch-based checker, runnable against any deployed preview.

**Files:**
- Create: `apps/web/lib/jab/smoke-routes.ts` + `apps/web/lib/jab/smoke-routes.test.ts`
- Create: `apps/web/scripts/smoke-deployed-routes.ts`
- Modify: `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md` (prerequisites)

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/jab/smoke-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkRoutes } from "./smoke-routes";

const fakeFetch = (statusByPath: Record<string, number>) =>
  (async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname;
    const status = statusByPath[path];
    if (status === undefined) throw new Error("connection refused");
    return { status } as Response;
  }) as typeof fetch;

describe("checkRoutes", () => {
  it("marks 2xx/3xx ok and 4xx/5xx + network errors failed", async () => {
    const results = await checkRoutes(
      "https://preview.example.com/",
      ["/", "beer/lil-heaven", "/missing", "/down"],
      fakeFetch({ "/": 200, "/beer/lil-heaven": 200, "/missing": 404 }),
    );
    expect(results).toEqual([
      { path: "/", status: 200, ok: true },
      { path: "/beer/lil-heaven", status: 200, ok: true },
      { path: "/missing", status: 404, ok: false },
      { path: "/down", status: null, ok: false, error: "connection refused" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/smoke-routes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/web/lib/jab/smoke-routes.ts`:

```ts
/**
 * smoke-routes.ts — minimal deployed-route checker. Pure (fetch injected)
 * so the script wrapper stays untested glue. 2xx/3xx = ok (Next 308s
 * trailing slashes; follow-redirect end status is what matters).
 */
export interface RouteCheckResult {
  path: string;
  status: number | null;
  ok: boolean;
  error?: string;
}

export async function checkRoutes(
  baseUrl: string,
  paths: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RouteCheckResult[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const results: RouteCheckResult[] = [];
  for (const p of paths) {
    const path = p.startsWith("/") ? p : `/${p}`;
    try {
      const res = await fetchImpl(`${base}${path}`, { redirect: "follow" });
      results.push({ path, status: res.status, ok: res.status >= 200 && res.status < 400 });
    } catch (err) {
      results.push({
        path,
        status: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
```

`apps/web/scripts/smoke-deployed-routes.ts`:

```ts
/**
 * Route smoke against a deployed preview.
 *
 * Usage:
 *   pnpm --filter @jab/web exec tsx scripts/smoke-deployed-routes.ts <previewUrl> [path ...]
 *
 * With no paths, checks "/" only. Recommended set after a Two Roads build:
 *   "/" "/visit-us" "/beer/lil-heaven-ipa" "/post/<any-published-post-slug>"
 * (one mapped page, one mapped CPT detail, one FALLBACK route not in
 * ROUTE_MAP — the last one proves POST_TYPE_MAP resolution works live).
 * Exits 1 if any route fails.
 */
import { checkRoutes } from "../lib/jab/smoke-routes";

async function main() {
  const [baseUrl, ...paths] = process.argv.slice(2);
  if (!baseUrl) {
    console.error("usage: smoke-deployed-routes.ts <previewUrl> [path ...]");
    process.exit(2);
  }
  const results = await checkRoutes(baseUrl, paths.length > 0 ? paths : ["/"]);
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.status ?? "ERR"} ${r.path}${r.error ? ` (${r.error})` : ""}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
```

Add to the runbook's §0 prerequisites: after a fresh build deploys, run the route smoke with one mapped page route, one mapped CPT detail route, and one fallback (non-ROUTE_MAP) detail route; all must be 200 before the chat scenarios.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/smoke-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/smoke-routes.ts apps/web/lib/jab/smoke-routes.test.ts apps/web/scripts/smoke-deployed-routes.ts docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md
git commit -m "test(saas): deployed-route smoke — mapped + fallback routes must answer 200"
```

---

### Task 16: Docs + memory sweep, final verification

**Files:**
- Modify: `CLAUDE.md` (current-state snapshot)
- Modify: `docs/conversion-pipeline.md` (routing contract + URL identity sections)
- Modify: memory files (see below)

- [ ] **Step 1: CLAUDE.md**

Add a short campaign paragraph to the current-state section (pattern-match the 2026-06-09 senior-review paragraph): the two verified clone blockers (nav→WP-origin links; secondary 404s), the routing-contract fix (leaf-slug + POST_TYPE_MAP fallback, render-time ISR resolution), the deterministic origin-link rewriter (compose-time TSX + emitted runtime + routePathMap from migration 0033), verify-fidelity HTTP-status capture, and the standing caveats: **deployed sites need a full rebuild to pick any of this up**, migration 0033 (and 0032) pending application to both Supabase projects, known residuals (host aliases, hierarchical-page leaf collisions, long-tail pages bypassing per-page review, menus persistence as follow-up).

- [ ] **Step 2: docs/conversion-pipeline.md**

Document: the catch-all resolution order (ROUTE_MAP fast path → POST_TYPE_MAP fallback → notFound only on WP null; leaf-slug fetch contract), and the URL-identity layer (where the rewriter runs: shell, components, Passthrough/runtime, dynamic-list local URLs, sitemap/robots self-origin; the asset-exemption rule and why).

- [ ] **Step 3: Memory updates**

In `C:\Users\srskm\.claude\projects\c--Projects-wp-headless\memory\`:
- `two-supabase-projects-local-prod.md`: add 0033 to the pending-apply note (alongside 0032).
- `saas-dynamic-list-and-paradigm-fixes.md`: note items now carry LOCAL `/{postType}/{slug}` URLs (2026-06-10), not WP permalinks.
- `new-ink-site-jab-data-patterns.md`: note the render-time by-slug pattern is now productized in the SaaS catch-all (POST_TYPE_MAP fallback).
- Update `MEMORY.md` index lines accordingly.

- [ ] **Step 4: Final verification**

Run: `pnpm --filter @jab/web exec vitest run` and `pnpm --filter @jab/web exec tsc --noEmit` and `pnpm --filter @jab/core test` (core untouched — must stay green). `git status` clean.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/conversion-pipeline.md
git commit -m "docs: faithful-clone campaign — routing contract + URL identity (2026-06-10)"
```

---

## Validation after the campaign (operator steps, not tasks)

1. Apply migrations **0032 + 0033** to BOTH Supabase projects once the Supabase MCP re-authenticates.
2. Trigger a FULL Two Roads rebuild (Phase A → E; `JAB_INCREMENTAL_SKIP` off so `link` backfills every row).
3. Run the route smoke: `/`, one mapped page, one mapped CPT detail, one fallback detail (a beer/post NOT in route-map.ts) — all 200.
4. Inspect deployed `Header.tsx`: zero `tworoadsbrewing.com` hrefs (the wpengine staging-host footer links are a documented residual).
5. Check the review screen: any 4xx page now shows score 0 + the HTTP issue.
