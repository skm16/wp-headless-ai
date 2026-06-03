# Incremental Skip-Unchanged Carry-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a re-build skip block-fetch + Playwright capture for pages whose WP `modified_gmt` is unchanged since the prior `ready` build, while producing a `block_inventory` / `page_inventory` that is byte-identical to a full build — by persisting each page's raw block tree and re-aggregating from the union of (freshly-fetched changed pages + carried-forward unchanged pages).

**Architecture:** Today `discoverSite` ([apps/web/lib/inngest/functions/discover-site.ts](apps/web/lib/inngest/functions/discover-site.ts)) detects the changed set but always runs full discovery, because the site-wide `block_inventory` aggregate can only be rebuilt by re-walking *every* page's `BlockNode[]` tree — and those trees are never persisted. This plan (1) persists each page's tree on `page_inventory.block_tree` (migration 0027), (2) adds a pure `carry-forward.ts` module that partitions current pages into changed-vs-carriable, reconstructs `PageBlocksInput[]` for carried pages from stored trees, and fills `computed_styles` / `source_dom_sample` for block types that appear *only* on carried pages from the prior build's `block_inventory`, and (3) wires the skip path into the worker **behind `JAB_INCREMENTAL_SKIP=1`, off by default**. With the flag off, behavior is byte-identical to today.

**Tech Stack:** TypeScript (NodeNext) · Next.js 15 server modules · Drizzle ORM + Supabase Postgres · Inngest workers · Vitest.

**Scope & safety calls (deliberate):**

- **Flag-gated, off by default.** The skip path only runs when `process.env.JAB_INCREMENTAL_SKIP === "1"` AND a prior `ready` build with persisted trees exists AND it is not a full sync. Production default is unchanged full discovery. Real-site integration coverage (a live WP + Inngest + Supabase run that proves a carried build equals a full build) is the gate to flip the default — tracked as a follow-up, not in this plan.
- **`block_tree` is always persisted** (even with the flag off) so a *later* build can bootstrap the skip path. It is additive + nullable; a build whose prior build predates the column simply has no trees to carry and falls back to re-fetch.
- **Carried screenshots are referenced, not copied.** A carried `page_inventory` row reuses the prior build's Storage screenshot paths. This couples the new build to the prior build's Storage objects (a retention sweep that deletes old screenshots would break a carried build's verify/review screens). Storage-copy-on-carry is explicitly out of scope here and is part of the real-site-coverage follow-up; the coupling is why the flag stays off by default.
- **Composite `(post_type, slug)` keys throughout the new module.** The existing `selectChangedPages` keys by slug only; two CPTs sharing a slug would collide. The carry-forward path must be correct, so it keys by `pageKey(postType, slug)`. `selectChangedPages` is left as-is (it only drives a log line).

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `apps/web/drizzle/migrations/0027_page_inventory_block_tree.sql` | Add `page_inventory.block_tree jsonb` | Create |
| `apps/web/lib/db/schema.ts` | Drizzle mirror — add `blockTree` column | Modify |
| `apps/web/lib/jab/persist-discovery.ts` | Persist `block_tree` per page | Modify |
| `apps/web/lib/jab/carry-forward.ts` | Pure carry-forward engine (partition, reconstruct, fill, row-map) | Create |
| `apps/web/lib/jab/carry-forward.test.ts` | Unit tests for the engine | Create |
| `apps/web/lib/jab/load-prior-build.ts` | Load prior trees + block samples | Modify |
| `apps/web/lib/jab/load-prior-build.test.ts` | Unit test the pure mappers | Create |
| `apps/web/lib/jab/persist-discovery.test.ts` | Extend `toPageInventoryRow` test for `block_tree` | Modify (or create) |
| `apps/web/lib/inngest/functions/discover-site.ts` | Flag-gated skip wiring | Modify |
| `CLAUDE.md` / memory / roadmap | Doc the flag + remaining gate | Modify |

---

### Task 1: Migration 0027 — persist per-page block trees

**Files:**
- Create: `apps/web/drizzle/migrations/0027_page_inventory_block_tree.sql`
- Modify: `apps/web/lib/db/schema.ts:279-307` (pageInventory table)

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0027_page_inventory_block_tree.sql — incremental skip-unchanged carry-forward
-- (2026-06-03 follow-up to the v0.7.x alignment epic, Phase 7 incremental sync).
--
-- Persists each page's raw WP block tree (the BlockNode[] returned by
-- jab/get-<cpt>-by-slug with include.blocks=true) so a later re-build can
-- re-aggregate block_inventory from the union of freshly-fetched changed pages
-- and carried-forward unchanged pages WITHOUT re-fetching the unchanged ones.
-- NULL for rows written before this column existed (those pages fall back to a
-- full re-fetch on the next incremental build).

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS block_tree JSONB;

COMMENT ON COLUMN public.page_inventory.block_tree IS
  'Raw WP BlockNode[] for this page at discovery time. Source of truth for incremental carry-forward re-aggregation. NULL when unknown (pre-0027 rows).';

-- ============================================================================
-- End 0027_page_inventory_block_tree.sql
-- ============================================================================
```

- [ ] **Step 2: Mirror the column in the Drizzle schema**

In `apps/web/lib/db/schema.ts`, inside the `pageInventory` table object, add the `blockTree` column immediately after `sourceModifiedGmt` (keep `createdAt` last):

```ts
    sourceModifiedGmt: timestamp("source_modified_gmt", { withTimezone: true }),
    // Raw WP BlockNode[] captured at discovery (migration 0027). Source of
    // truth for incremental carry-forward — a re-build re-aggregates
    // block_inventory from stored trees instead of re-fetching unchanged
    // pages. NULL for pre-0027 rows.
    blockTree: jsonb("block_tree"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
```

- [ ] **Step 3: Typecheck the schema change**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS (additive column, no consumers reference it yet).

- [ ] **Step 4: Commit**

```bash
git add apps/web/drizzle/migrations/0027_page_inventory_block_tree.sql apps/web/lib/db/schema.ts
git commit -m "feat(saas-app): migration 0027 — persist per-page block_tree for incremental carry-forward"
```

---

### Task 2: Persist `block_tree` from the discovery writer

**Files:**
- Modify: `apps/web/lib/jab/persist-discovery.ts`
- Test: `apps/web/lib/jab/persist-discovery.test.ts`

- [ ] **Step 1: Write the failing test for the pure mapper**

Append to (or create) `apps/web/lib/jab/persist-discovery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toPageInventoryRow, type PersistPagesPage } from "./persist-discovery";

const basePage: PersistPagesPage = {
  slug: "about",
  post_type: "page",
  title: "About",
  route_path: "/about",
  block_count: 3,
  paradigms: [],
  discovery: { slug: "about", post_type: "page", screenshotPaths: {}, blockCapturesByViewport: {} },
};

describe("toPageInventoryRow block_tree", () => {
  it("writes the block tree when present", () => {
    const tree = [{ blockName: "core/heading", attrs: {}, innerBlocks: [] }];
    const row = toPageInventoryRow({ ...basePage, blockTree: tree }, "build-1", "proj-1");
    expect(row.block_tree).toEqual(tree);
  });

  it("writes null when the tree is absent", () => {
    const row = toPageInventoryRow(basePage, "build-1", "proj-1");
    expect(row.block_tree).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/persist-discovery.test.ts`
Expected: FAIL — `block_tree` is `undefined`/missing on the row (property not written).

- [ ] **Step 3: Implement the column write + type field**

In `apps/web/lib/jab/persist-discovery.ts`:

Add the `BlockNode` import at the top (alongside the existing imports):

```ts
import type { BlockNode } from "./ability-client";
```

Extend `PersistPagesPage` with the optional tree field (after `sourceModifiedGmt`):

```ts
  /** WP modified_gmt of the source post (v0.7.0 row field). NULL when unknown. */
  sourceModifiedGmt?: string | null;
  /**
   * Raw WP BlockNode[] for this page (migration 0027). Persisted so a later
   * incremental build can re-aggregate block_inventory from stored trees
   * instead of re-fetching this page. Optional — older callers omit it.
   */
  blockTree?: BlockNode[] | null;
```

Write the column in `toPageInventoryRow` (after `source_modified_gmt`):

```ts
    source_modified_gmt: page.sourceModifiedGmt ?? null,
    block_tree: page.blockTree ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/persist-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the worker to pass the tree (and typecheck)**

In `apps/web/lib/inngest/functions/discover-site.ts`, the `persist-pages` step maps `pageBlocks`. Add `blockTree: p.blocks` to the returned object (after `sourceModifiedGmt`):

```ts
              sourceModifiedGmt: p.modifiedGmt ?? null,
              blockTree: p.blocks,
            };
```

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/persist-discovery.ts apps/web/lib/jab/persist-discovery.test.ts apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): persist per-page block_tree at discovery time"
```

---

### Task 3: Pure carry-forward engine — partition + tree availability

**Files:**
- Create: `apps/web/lib/jab/carry-forward.ts`
- Test: `apps/web/lib/jab/carry-forward.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/carry-forward.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  pageKey,
  partitionPages,
  splitByTreeAvailability,
  type CurrentPageRef,
} from "./carry-forward";
import type { BlockNode } from "./ability-client";

const ref = (slug: string, postType: string, modifiedGmt: string | null): CurrentPageRef => ({
  slug,
  postType,
  modifiedGmt,
});

describe("pageKey", () => {
  it("composes a collision-safe key from post type + slug", () => {
    expect(pageKey("page", "about")).not.toBe(pageKey("event", "about"));
  });
});

describe("partitionPages", () => {
  it("with no window, everything is changed (first/full sync)", () => {
    const current = [ref("a", "page", "2026-01-01T00:00:00Z")];
    const { changed, unchanged } = partitionPages(current, [], {});
    expect(changed).toHaveLength(1);
    expect(unchanged).toHaveLength(0);
  });

  it("touched-since-window and brand-new pages are changed; the rest are unchanged", () => {
    const current = [
      ref("touched", "page", "2026-02-10T00:00:00Z"),
      ref("stale", "page", "2026-01-01T00:00:00Z"),
      ref("brand-new", "page", "2026-02-20T00:00:00Z"),
    ];
    const prior = [
      { slug: "touched", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" },
      { slug: "stale", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" },
    ];
    const { changed, unchanged } = partitionPages(current, prior, {
      modifiedAfter: "2026-02-01T00:00:00Z",
    });
    expect(changed.map((c) => c.slug).sort()).toEqual(["brand-new", "touched"]);
    expect(unchanged.map((c) => c.slug)).toEqual(["stale"]);
  });

  it("treats a missing modifiedGmt as changed (cannot prove unchanged)", () => {
    const current = [ref("unknown", "page", null)];
    const prior = [{ slug: "unknown", postType: "page", modifiedGmt: "2026-01-01T00:00:00Z" }];
    const { changed } = partitionPages(current, prior, { modifiedAfter: "2026-02-01T00:00:00Z" });
    expect(changed.map((c) => c.slug)).toEqual(["unknown"]);
  });
});

describe("splitByTreeAvailability", () => {
  it("demotes unchanged pages with no stored tree to must-refetch", () => {
    const tree: BlockNode[] = [{ blockName: "core/heading", attrs: {} }];
    const trees = new Map<string, BlockNode[]>([[pageKey("page", "has-tree"), tree]]);
    const unchanged = [ref("has-tree", "page", null), ref("no-tree", "page", null)];
    const { carriable, mustRefetch } = splitByTreeAvailability(unchanged, trees);
    expect(carriable.map((c) => c.slug)).toEqual(["has-tree"]);
    expect(mustRefetch.map((c) => c.slug)).toEqual(["no-tree"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: FAIL — module `./carry-forward` does not exist.

- [ ] **Step 3: Implement partition + tree availability**

Create `apps/web/lib/jab/carry-forward.ts`:

```ts
import "server-only";
import type { BlockNode } from "./ability-client";
import type { PriorPage } from "./incremental";

/**
 * carry-forward.ts — pure incremental carry-forward engine.
 *
 * All functions here are deterministic and DB-free. The discover-site worker
 * loads prior-build artifacts, calls these to decide what to re-fetch and what
 * to carry, then re-aggregates block_inventory from the UNION of fresh +
 * carried trees so the result is identical to a full build. Keyed by
 * (post_type, slug) — two CPTs can share a slug, so a slug-only key would
 * cross-wire carries.
 */

export interface CurrentPageRef {
  slug: string;
  postType: string;
  modifiedGmt: string | null;
}

/** Collision-safe key. WP sanitizes slugs + post types to never contain a
 *  space, so the space separator can't be forged across the two segments. */
export function pageKey(postType: string, slug: string): string {
  return `${postType} ${slug}`;
}

/**
 * Split current pages into those that must be re-fetched (new or touched since
 * the window) and those that are unchanged (carry-forward candidates). With no
 * window (first build / no prior watermark) everything is changed.
 */
export function partitionPages(
  current: CurrentPageRef[],
  prior: PriorPage[],
  window: { modifiedAfter?: string },
): { changed: CurrentPageRef[]; unchanged: CurrentPageRef[] } {
  if (!window.modifiedAfter) {
    return { changed: [...current], unchanged: [] };
  }
  const after = window.modifiedAfter;
  const priorKeys = new Set(prior.map((p) => pageKey(p.postType, p.slug)));
  const changed: CurrentPageRef[] = [];
  const unchanged: CurrentPageRef[] = [];
  for (const c of current) {
    const isNew = !priorKeys.has(pageKey(c.postType, c.slug));
    const isTouched = typeof c.modifiedGmt === "string" && c.modifiedGmt >= after;
    // A null modifiedGmt cannot be proven unchanged → treat as changed.
    const unknown = typeof c.modifiedGmt !== "string";
    if (isNew || isTouched || unknown) changed.push(c);
    else unchanged.push(c);
  }
  return { changed, unchanged };
}

/**
 * An unchanged page can only be carried if its tree was persisted by a prior
 * build. Pages whose prior build predates migration 0027 have no tree and must
 * be re-fetched.
 */
export function splitByTreeAvailability(
  unchanged: CurrentPageRef[],
  priorTreesByKey: Map<string, BlockNode[]>,
): { carriable: CurrentPageRef[]; mustRefetch: CurrentPageRef[] } {
  const carriable: CurrentPageRef[] = [];
  const mustRefetch: CurrentPageRef[] = [];
  for (const c of unchanged) {
    if (priorTreesByKey.has(pageKey(c.postType, c.slug))) carriable.push(c);
    else mustRefetch.push(c);
  }
  return { carriable, mustRefetch };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/carry-forward.ts apps/web/lib/jab/carry-forward.test.ts
git commit -m "feat(saas-app): carry-forward partition + tree-availability split (pure)"
```

---

### Task 4: Reconstruct inventory input + fill carried block samples

**Files:**
- Modify: `apps/web/lib/jab/carry-forward.ts`
- Modify: `apps/web/lib/jab/carry-forward.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/carry-forward.test.ts`:

```ts
import {
  carriedInventoryInput,
  blockNamesInTrees,
  fillCarriedSamples,
  type PriorBlockSample,
} from "./carry-forward";

describe("carriedInventoryInput", () => {
  it("rebuilds PageBlocksInput from stored trees for carriable pages", () => {
    const tree: BlockNode[] = [{ blockName: "core/cover", attrs: { x: 1 } }];
    const trees = new Map<string, BlockNode[]>([[pageKey("page", "home"), tree]]);
    const input = carriedInventoryInput([ref("home", "page", null)], trees);
    expect(input).toEqual([{ slug: "home", post_type: "page", blocks: tree }]);
  });

  it("skips pages whose tree is missing (defensive)", () => {
    const input = carriedInventoryInput([ref("ghost", "page", null)], new Map());
    expect(input).toEqual([]);
  });
});

describe("blockNamesInTrees", () => {
  it("collects names recursively, mapping null to __null__", () => {
    const pages = [
      {
        slug: "p",
        post_type: "page",
        blocks: [
          { blockName: "core/group", attrs: {}, innerBlocks: [{ blockName: "core/heading", attrs: {} }] },
          { blockName: null, attrs: {} },
        ] as BlockNode[],
      },
    ];
    expect([...blockNamesInTrees(pages)].sort()).toEqual(["__null__", "core/group", "core/heading"]);
  });
});

describe("fillCarriedSamples", () => {
  const prior: PriorBlockSample[] = [
    { blockName: "core/cover", computedStyles: { viewports: {} }, sourceDomSample: "<div>cover</div>" },
    { blockName: "core/heading", computedStyles: { viewports: {} }, sourceDomSample: "<h2>h</h2>" },
  ];

  it("fills computed + dom for blocks absent from the fresh capture", () => {
    const { computed, dom } = fillCarriedSamples(
      {}, // fresh computed — nothing captured this run
      new Map<string, string | null>(),
      prior,
      new Set(["core/cover"]),
    );
    expect(computed["core/cover"]).toEqual({ viewports: {} });
    expect(dom.get("core/cover")).toBe("<div>cover</div>");
  });

  it("fresh values always win over carried", () => {
    const freshComputed = { "core/cover": { viewports: { "1280": { fontSize: ["40px"] } } } };
    const freshDom = new Map<string, string | null>([["core/cover", "<div>FRESH</div>"]]);
    const { computed, dom } = fillCarriedSamples(freshComputed, freshDom, prior, new Set(["core/cover"]));
    expect(computed["core/cover"]).toEqual(freshComputed["core/cover"]);
    expect(dom.get("core/cover")).toBe("<div>FRESH</div>");
  });

  it("does not overwrite a fresh null-dom entry that exists (keeps the deliberate omission)", () => {
    // A fresh capture that resolved to null (ambiguous correlation) is a real
    // decision — only fill when the key is ABSENT, not when it's present-null.
    const freshDom = new Map<string, string | null>([["core/heading", null]]);
    const { dom } = fillCarriedSamples({}, freshDom, prior, new Set(["core/heading"]));
    // present-null fresh is left as null per "absent only" fill rule
    expect(dom.get("core/heading")).toBeNull();
  });
});
```

> NOTE the last test pins the fill rule: **fill only when the key is ABSENT from the fresh map**, not when it is present-but-null. A fresh `null` is a deliberate "ambiguous correlation" decision and must not be silently replaced by a stale carried sample. The computed-fill rule differs (fill when absent OR null) because a missing computed style carries no such deliberate-null semantics. Implement exactly as the tests assert.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: FAIL — `carriedInventoryInput` / `blockNamesInTrees` / `fillCarriedSamples` not exported.

- [ ] **Step 3: Implement the three functions**

Append to `apps/web/lib/jab/carry-forward.ts`:

```ts
import type { PageBlocksInput } from "./inventory";

/** Rebuild buildInventory() input for carriable pages from their stored trees. */
export function carriedInventoryInput(
  carriable: CurrentPageRef[],
  priorTreesByKey: Map<string, BlockNode[]>,
): PageBlocksInput[] {
  const out: PageBlocksInput[] = [];
  for (const c of carriable) {
    const tree = priorTreesByKey.get(pageKey(c.postType, c.slug));
    if (tree) out.push({ slug: c.slug, post_type: c.postType, blocks: tree });
  }
  return out;
}

/** All block names appearing in the given trees (null → "__null__"), recursive. */
export function blockNamesInTrees(pages: PageBlocksInput[]): Set<string> {
  const names = new Set<string>();
  const walk = (blocks: BlockNode[]): void => {
    for (const b of blocks) {
      names.add(b.blockName ?? "__null__");
      if (b.innerBlocks && b.innerBlocks.length > 0) walk(b.innerBlocks);
    }
  };
  for (const p of pages) walk(p.blocks);
  return names;
}

/** Prior block_inventory sample for a single block name (de-keyed). */
export interface PriorBlockSample {
  blockName: string;
  computedStyles: unknown | null;
  sourceDomSample: string | null;
}

/**
 * For block names that appear on carried (unchanged) pages, fill computed_styles
 * / source_dom_sample from the prior build when the fresh capture didn't produce
 * them. Fresh always wins.
 *
 * Fill rules (asserted by the tests):
 *   - computed: fill when the key is absent OR present-null.
 *   - dom:      fill ONLY when the key is absent. A present-null fresh dom is a
 *               deliberate "ambiguous correlation" decision and is preserved.
 */
export function fillCarriedSamples(
  freshComputedByName: Record<string, unknown>,
  freshDomByName: Map<string, string | null>,
  priorBlocks: PriorBlockSample[],
  blockNamesNeedingFill: Set<string>,
): { computed: Record<string, unknown>; dom: Map<string, string | null> } {
  const computed: Record<string, unknown> = { ...freshComputedByName };
  const dom = new Map(freshDomByName);
  const priorByName = new Map(priorBlocks.map((b) => [b.blockName, b]));
  for (const name of blockNamesNeedingFill) {
    const p = priorByName.get(name);
    if (!p) continue;
    if ((!(name in computed) || computed[name] == null) && p.computedStyles != null) {
      computed[name] = p.computedStyles;
    }
    if (!dom.has(name) && p.sourceDomSample != null) {
      dom.set(name, p.sourceDomSample);
    }
  }
  return { computed, dom };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: PASS (all carry-forward tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/carry-forward.ts apps/web/lib/jab/carry-forward.test.ts
git commit -m "feat(saas-app): carry-forward inventory reconstruction + block-sample fill (pure)"
```

---

### Task 5: Carried page-row mapper

**Files:**
- Modify: `apps/web/lib/jab/carry-forward.ts`
- Modify: `apps/web/lib/jab/carry-forward.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/carry-forward.test.ts`:

```ts
import { carriedPageRow, type PriorPageRow } from "./carry-forward";

describe("carriedPageRow", () => {
  it("maps a prior page_inventory row into a PersistPagesPage carrying screenshots forward", () => {
    const prior: PriorPageRow = {
      slug: "about",
      post_type: "page",
      title: "About",
      route_path: "/about",
      block_count: 4,
      paradigms: ["acf_flex"],
      source_screenshot_paths: { source: { desktop: "builds/old/about-desktop.png" } },
      source_modified_gmt: "2026-01-01T00:00:00Z",
      block_tree: [{ blockName: "core/heading", attrs: {} }],
    };
    const page = carriedPageRow(prior);
    expect(page.slug).toBe("about");
    expect(page.route_path).toBe("/about");
    expect(page.block_count).toBe(4);
    expect(page.paradigms).toEqual(["acf_flex"]);
    expect(page.discovery.screenshotPaths).toEqual({ desktop: "builds/old/about-desktop.png" });
    expect(page.sourceModifiedGmt).toBe("2026-01-01T00:00:00Z");
    expect(page.blockTree).toEqual(prior.block_tree);
  });

  it("tolerates a null title and missing screenshot wrapper", () => {
    const prior: PriorPageRow = {
      slug: "x",
      post_type: "page",
      title: null,
      route_path: "/x",
      block_count: 0,
      paradigms: [],
      source_screenshot_paths: null,
      source_modified_gmt: null,
      block_tree: null,
    };
    const page = carriedPageRow(prior);
    expect(page.title).toBe("");
    expect(page.discovery.screenshotPaths).toEqual({});
    expect(page.blockTree).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: FAIL — `carriedPageRow` / `PriorPageRow` not exported.

- [ ] **Step 3: Implement the mapper**

Append to `apps/web/lib/jab/carry-forward.ts`:

```ts
import type { PersistPagesPage } from "./persist-discovery";
import type { Paradigm } from "./paradigm-detection";
import type { PageDiscoveryResult } from "./discovery-types";

/** Shape of a prior page_inventory row needed to carry it forward. */
export interface PriorPageRow {
  slug: string;
  post_type: string;
  title: string | null;
  route_path: string;
  block_count: number;
  paradigms: string[];
  source_screenshot_paths: { source?: Record<string, unknown> } | null;
  source_modified_gmt: string | null;
  block_tree: BlockNode[] | null;
}

/**
 * Map a prior page_inventory row into the PersistPagesPage the new build will
 * re-upsert. Screenshots are carried by REFERENCE (the prior build's Storage
 * paths) — see the plan's safety note on Storage coupling. blockCapturesByViewport
 * is transient (computed-styles aggregation input) and not persisted, so it is
 * empty here; carried block samples are filled from prior block_inventory instead.
 */
export function carriedPageRow(prior: PriorPageRow): PersistPagesPage {
  const screenshotPaths = (prior.source_screenshot_paths?.source ?? {}) as PageDiscoveryResult["screenshotPaths"];
  return {
    slug: prior.slug,
    post_type: prior.post_type,
    title: prior.title ?? "",
    route_path: prior.route_path,
    block_count: prior.block_count,
    paradigms: prior.paradigms as Paradigm[],
    discovery: {
      slug: prior.slug,
      post_type: prior.post_type,
      screenshotPaths,
      blockCapturesByViewport: {},
    },
    sourceModifiedGmt: prior.source_modified_gmt,
    blockTree: prior.block_tree ?? null,
  };
}
```

> Verify `PageDiscoveryResult` actually has `screenshotPaths` + `blockCapturesByViewport` fields with these names before relying on the cast — read `apps/web/lib/jab/discovery-types.ts` first. If the field names differ, match them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/carry-forward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/carry-forward.ts apps/web/lib/jab/carry-forward.test.ts
git commit -m "feat(saas-app): carried page-row mapper (prior page_inventory → PersistPagesPage)"
```

---

### Task 6: Extend the prior-build loader

**Files:**
- Modify: `apps/web/lib/jab/load-prior-build.ts`
- Create: `apps/web/lib/jab/load-prior-build.test.ts`

- [ ] **Step 1: Write the failing test for the pure mappers**

The loader's DB call is integration-tested elsewhere; here we unit-test the two pure mappers we add (`toPriorTreesByKey`, `toPriorBlockSamples`). Create `apps/web/lib/jab/load-prior-build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toPriorTreesByKey, toPriorBlockSamples } from "./load-prior-build";
import { pageKey } from "./carry-forward";

describe("toPriorTreesByKey", () => {
  it("keys stored trees by (post_type, slug), skipping null trees", () => {
    const rows = [
      { slug: "home", post_type: "page", block_tree: [{ blockName: "core/cover", attrs: {} }] },
      { slug: "empty", post_type: "page", block_tree: null },
    ];
    const map = toPriorTreesByKey(rows);
    expect(map.has(pageKey("page", "home"))).toBe(true);
    expect(map.has(pageKey("page", "empty"))).toBe(false);
  });
});

describe("toPriorBlockSamples", () => {
  it("de-keys __null__ back to a null block name and carries computed + dom", () => {
    const rows = [
      { block_name: "core/cover", computed_styles: { viewports: {} }, source_dom_sample: "<div/>" },
      { block_name: "__null__", computed_styles: null, source_dom_sample: null },
    ];
    const samples = toPriorBlockSamples(rows);
    expect(samples.find((s) => s.blockName === "core/cover")?.sourceDomSample).toBe("<div/>");
    // __null__ is preserved as the literal key — buildInventory uses the same
    // sentinel, so the fill lookup matches on "__null__".
    expect(samples.some((s) => s.blockName === "__null__")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/load-prior-build.test.ts`
Expected: FAIL — `toPriorTreesByKey` / `toPriorBlockSamples` not exported.

- [ ] **Step 3: Implement the loader extension**

Rewrite `apps/web/lib/jab/load-prior-build.ts` to add the two pure mappers and extend `loadPriorReadyBuild`'s return. Full file:

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PriorPage } from "./incremental";
import type { BlockNode } from "./ability-client";
import { pageKey, type PriorBlockSample, type PriorPageRow } from "./carry-forward";

export function toPriorPages(
  rows: Array<{ slug: string; post_type: string; source_modified_gmt: string | null }>,
): PriorPage[] {
  return rows.map((r) => ({ slug: r.slug, postType: r.post_type, modifiedGmt: r.source_modified_gmt }));
}

/** Build the (post_type, slug) → tree map, skipping rows with no stored tree. */
export function toPriorTreesByKey(
  rows: Array<{ slug: string; post_type: string; block_tree: BlockNode[] | null }>,
): Map<string, BlockNode[]> {
  const map = new Map<string, BlockNode[]>();
  for (const r of rows) {
    // A present-but-empty tree ([]) is still carriable — the page genuinely
    // has zero blocks. Only a null/non-array tree (pre-0027 rows) is skipped.
    if (r.block_tree != null && Array.isArray(r.block_tree)) {
      map.set(pageKey(r.post_type, r.slug), r.block_tree);
    }
  }
  return map;
}

/** Map prior block_inventory rows to the sample shape the fill step consumes. */
export function toPriorBlockSamples(
  rows: Array<{ block_name: string; computed_styles: unknown | null; source_dom_sample: string | null }>,
): PriorBlockSample[] {
  return rows.map((r) => ({
    blockName: r.block_name,
    computedStyles: r.computed_styles ?? null,
    sourceDomSample: r.source_dom_sample ?? null,
  }));
}

export interface PriorBuildArtifacts {
  buildId: string;
  watermark: string | null;
  priorPages: PriorPage[];
  priorRowsByKey: Map<string, PriorPageRow>;
  priorTreesByKey: Map<string, BlockNode[]>;
  priorBlockSamples: PriorBlockSample[];
}

/**
 * Load the most recent `ready` build for a project: its sync watermark, the
 * per-page modified map, the per-page stored trees + full rows (for carry-
 * forward), and the prior block_inventory samples (for filling computed/dom of
 * blocks that appear only on carried pages). Returns null when no prior ready
 * build exists (first build → full sync).
 *
 * tenantId is accepted for signature symmetry but unused: site_builds has no
 * tenant_id column; RLS rides project_id → projects.tenant_id, and this runs
 * under the service role.
 */
export async function loadPriorReadyBuild(
  projectId: string,
  _tenantId: string,
): Promise<PriorBuildArtifacts | null> {
  const supabase = createAdminClient();
  const { data: build } = await supabase
    .from("site_builds")
    .select("id, config, status")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; config: Record<string, unknown> | null; status: string }>();
  if (!build) return null;

  const { data: pages } = await supabase
    .from("page_inventory")
    .select(
      "slug, post_type, title, route_path, block_count, paradigms, source_screenshot_paths, source_modified_gmt, block_tree",
    )
    .eq("site_build_id", build.id);
  const pageRows = (pages ?? []) as PriorPageRow[];

  const { data: blocks } = await supabase
    .from("block_inventory")
    .select("block_name, computed_styles, source_dom_sample")
    .eq("site_build_id", build.id);

  const priorRowsByKey = new Map<string, PriorPageRow>();
  for (const r of pageRows) priorRowsByKey.set(pageKey(r.post_type, r.slug), r);

  return {
    buildId: build.id,
    watermark: (build.config?.last_sync_watermark as string | undefined) ?? null,
    priorPages: toPriorPages(pageRows),
    priorRowsByKey,
    priorTreesByKey: toPriorTreesByKey(pageRows),
    priorBlockSamples: toPriorBlockSamples(
      (blocks ?? []) as Array<{ block_name: string; computed_styles: unknown | null; source_dom_sample: string | null }>,
    ),
  };
}
```

> The previous `loadPriorReadyBuild` returned `{ buildId, watermark, priorPages }`. The discover-site worker reads `prior?.watermark` and `prior?.priorPages` — both still present, so the existing call site keeps compiling. The new fields are additive.

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/load-prior-build.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/load-prior-build.ts apps/web/lib/jab/load-prior-build.test.ts
git commit -m "feat(saas-app): prior-build loader returns trees + block samples for carry-forward"
```

---

### Task 7: Wire the flag-gated skip path into the worker

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`

This is the integration task. The skip path must be a **superset-correct** replacement: with the flag on and a usable prior build, the worker fetches blocks + captures screenshots for changed + must-refetch pages only, then re-aggregates from the union of fresh + carried trees and persists carried page rows alongside fresh ones. With the flag off (or no prior trees, or full sync), the code path is exactly today's.

- [ ] **Step 1: Add the import**

Alongside the existing carry-forward-adjacent imports in `discover-site.ts`:

```ts
import {
  pageKey,
  partitionPages,
  splitByTreeAvailability,
  carriedInventoryInput,
  blockNamesInTrees,
  fillCarriedSamples,
  carriedPageRow,
  type CurrentPageRef,
} from "@/lib/jab/carry-forward";
```

- [ ] **Step 2: Compute the carry-forward plan right after the existing change-detection block**

Locate the existing `// ── Incremental change detection ──` block (around lines 266-286). Immediately after the `if (!changed.isFullSync) { console.log(...) }`, add:

```ts
      // ── Incremental skip-unchanged carry-forward (flag-gated) ──
      // Default OFF: full discovery runs unchanged. When JAB_INCREMENTAL_SKIP=1
      // AND we have a prior ready build with persisted trees AND this is not a
      // full sync, we skip block-fetch + Playwright for unchanged pages and
      // re-aggregate from stored trees. See the plan's safety note: carried
      // screenshots are referenced (not copied), which is why this stays
      // opt-in until real-site integration coverage lands.
      const skipEnabled = process.env.JAB_INCREMENTAL_SKIP === "1";
      const currentRefs: CurrentPageRef[] = perCptLists.flatMap((p) =>
        p.rows.map((r) => ({ slug: r.slug, postType: p.cpt.slug, modifiedGmt: r.modified_gmt ?? null })),
      );
      // Signature is partitionPages(current, prior, window) — current first.
      const { unchanged } = partitionPages(currentRefs, prior?.priorPages ?? [], syncWindow);
      const treeSplit = skipEnabled && !changed.isFullSync && prior
        ? splitByTreeAvailability(unchanged, prior.priorTreesByKey)
        : { carriable: [] as CurrentPageRef[], mustRefetch: unchanged };
      const carriableKeySet = new Set(
        treeSplit.carriable.map((c) => pageKey(c.postType, c.slug)),
      );
      if (skipEnabled && treeSplit.carriable.length > 0) {
        console.log(
          `[discoverSite ${buildId}] carry-forward active: ${treeSplit.carriable.length} unchanged pages carried, ${treeSplit.mustRefetch.length} demoted to re-fetch (no stored tree).`,
        );
      }
```

- [ ] **Step 3: Filter the per-page block-fetch jobs to skip carriable pages**

In the `flatJobs` construction (around line 329-335), skip rows whose key is in `carriableKeySet`. Change the inner push to:

```ts
      for (let depth = 0; depth < maxDepth; depth++) {
        for (const { cpt, meta, rows } of seedCptLists) {
          if (depth < rows.length) {
            const r = rows[depth];
            if (carriableKeySet.has(pageKey(cpt.slug, r.slug))) continue; // carried — don't re-fetch blocks
            flatJobs.push({ cpt, meta, row: r });
          }
        }
      }
```

> With the flag off, `carriableKeySet` is empty, so every row is pushed — identical to today.

- [ ] **Step 4: Build carried inventory input + carried page rows**

After the `pageBlocks` loop completes (after the smoke-cap log, before `// ── Capture screenshots ──`), add:

```ts
      // Reconstruct carried pages' inventory input from stored trees and map
      // their prior rows forward. Empty unless the carry-forward path is active.
      const carriedInput = prior
        ? carriedInventoryInput(treeSplit.carriable, prior.priorTreesByKey)
        : [];
      const carriedPages = prior
        ? treeSplit.carriable
            .map((c) => prior.priorRowsByKey.get(pageKey(c.postType, c.slug)))
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .map((row) => carriedPageRow(row))
        : [];
```

- [ ] **Step 5: Feed carried input into the inventory reducers**

The `inventoryInput` (around line 407) and the enrich step (`collectablePages`, line 416) must include carried pages so block_inventory is complete. Change `inventoryInput`:

```ts
      const freshInventoryInput: PageBlocksInput[] = pageBlocks.map((p) => ({
        slug: p.slug,
        post_type: p.post_type,
        blocks: p.blocks,
      }));
      const inventoryInput: PageBlocksInput[] = [...freshInventoryInput, ...carriedInput];
```

For the enrich step's `collectablePages`, carried pages have no `acf`/`paradigms` captured this run; reconstruct minimal collectable entries from the carried trees (acf omitted — flex-layout collection for carried pages relies on the prior build having already contributed; this is acceptable because carried pages are unchanged). Append carried entries:

```ts
        const collectablePages: CollectablePage[] = [
          ...pageBlocks.map((p) => ({
            slug: p.slug,
            post_type: p.post_type,
            blocks: p.blocks,
            acf: p.acf,
            paradigms: p.paradigms,
          })),
          ...carriedInput.map((c) => ({
            slug: c.slug,
            post_type: c.post_type,
            blocks: c.blocks,
            acf: undefined,
            paradigms: [] as Paradigm[],
          })),
        ];
```

> `buildInventory(inventoryInput)` now walks the union, so occurrence_count / page_slugs / attr_samples / tier are complete and identical to a full build. Verify `CollectablePage` allows `acf?: ... | undefined` and `paradigms: Paradigm[]` — read `apps/web/lib/jab/content-detection.ts` if unsure.

- [ ] **Step 6: Fill computed/dom for carried-only blocks before persisting inventory**

The `persist-inventory` step uses `computedStylesByBlockName` (a Record) and `domSamplesByBlockName` (a Map). Before that step, compute the filled versions:

```ts
      // Blocks that appear on carried pages may have had no fresh capture this
      // run (their page wasn't screenshotted). Fill their computed/dom from the
      // prior build so block_inventory rows aren't blanked on a carried build.
      const carriedBlockNames = blockNamesInTrees(carriedInput);
      const filled = prior
        ? fillCarriedSamples(
            computedStylesByBlockName,
            domSamplesByBlockName,
            prior.priorBlockSamples,
            carriedBlockNames,
          )
        : { computed: computedStylesByBlockName, dom: domSamplesByBlockName };
```

Then change the `persist-inventory` step to use `filled.computed` / `filled.dom`:

```ts
      await step.run("persist-inventory", () => {
        return persistInventory({
          buildId,
          projectId,
          entries: enrichedInventory,
          computedStylesByBlockName: filled.computed,
          domSamplesByBlockName: filled.dom,
        });
      });
```

> Remove the now-unused Map re-materialization that previously sat inside the step IF `domSamplesByBlockName` is already a Map at this scope. Check: in the current worker, `domSamplesByBlockName` is the step output Record and is re-materialized to a Map inside `persist-inventory`. Adjust: build the Map once at the outer scope (`const domSamplesMap = new Map(Object.entries(domSamplesByBlockName))`) and pass `domSamplesMap` into `fillCarriedSamples`. Keep the data flow correct — `fillCarriedSamples` takes a Map for dom and a Record for computed.

- [ ] **Step 7: Persist carried page rows alongside fresh ones**

Change the `persist-pages` step's `pages` array to concatenate carried rows:

```ts
      await step.run("persist-pages", () =>
        persistPages({
          buildId,
          projectId,
          pages: [
            ...pageBlocks.map((p) => {
              const discovery = discoveryResults.find((d) => d.slug === p.slug && d.post_type === p.post_type) ?? {
                slug: p.slug,
                post_type: p.post_type,
                screenshotPaths: {},
                blockCapturesByViewport: {},
              };
              return {
                slug: p.slug,
                post_type: p.post_type,
                title: p.title,
                route_path: routePathFor(p.post_type, p.slug),
                block_count: p.blocks.length,
                paradigms: p.paradigms,
                discovery,
                sourceModifiedGmt: p.modifiedGmt ?? null,
                blockTree: p.blocks,
              };
            }),
            ...carriedPages,
          ],
        }),
      );
```

- [ ] **Step 8: Keep the page/block counts honest**

`finalize-counts` writes `page_count: pageBlocks.length`. With carry-forward, the build's true page count is `pageBlocks.length + carriedPages.length`. Update:

```ts
          .update({
            page_count: pageBlocks.length + carriedPages.length,
            block_type_count: inventory.length,
          })
```

> `inventory.length` already reflects the union (Step 5), so block_type_count is correct.

- [ ] **Step 9: Typecheck + full app test suite**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS.
Run: `pnpm --filter @jab/web exec vitest run`
Expected: PASS — all prior tests green + the new carry-forward/loader/persist tests.

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): flag-gated incremental skip-unchanged carry-forward in discoverSite"
```

---

### Task 8: Documentation + memory

**Files:**
- Modify: `CLAUDE.md` (the alignment-epic open-items paragraph)
- Modify: `docs/saas-v2-component-pipeline.md` or the Stage 7 roadmap note (whichever tracks incremental sync)
- Modify: memory `app-pinned-to-v060-plugin-contract.md` follow-up line + `MEMORY.md`

- [ ] **Step 1: Update CLAUDE.md open-items**

Change the open-items line that reads "incremental sync currently detects + logs the changed set but still runs full discovery (skip-unchanged needs block_inventory carry-forward + real-site coverage)" to reflect that carry-forward is now **built and flag-gated** (`JAB_INCREMENTAL_SKIP=1`), persisting `page_inventory.block_tree` (migration 0027), with **real-site integration coverage + Storage-copy-on-carry the remaining gate before default-on**.

- [ ] **Step 2: Update the memory file**

Update `C:\Users\srskm\.claude\projects\c--Projects-wp-headless\memory\app-pinned-to-v060-plugin-contract.md`'s skip-unchanged follow-up sentence to: built + flag-gated behind `JAB_INCREMENTAL_SKIP`, migration 0027 adds `block_tree`, remaining gate = real-site coverage + screenshot Storage-copy. Update the matching `MEMORY.md` pointer hook.

- [ ] **Step 3: Note migration 0027 in the pending-apply list**

Wherever migrations 0025/0026 are listed as pending Supabase apply, add 0027.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs(saas-app): document flag-gated incremental carry-forward + migration 0027"
```

---

## Self-Review

(Completed inline after authoring — see the session notes. Key checks: spec coverage of every audit item; no placeholders; type consistency of `CurrentPageRef`, `PriorPageRow`, `PriorBlockSample`, `PageBlocksInput` across tasks; the deliberate arg-order trap in Task 7 Step 2 is flagged for correction.)

## Open follow-ups (NOT in this plan)

1. **Real-site integration coverage** — a live WP + Inngest + Supabase run proving a carried build's `block_inventory` + `page_inventory` equals a full build. This is the gate to flip `JAB_INCREMENTAL_SKIP` on by default.
2. **Storage-copy-on-carry** — copy carried pages' screenshot objects into the new build's Storage prefix so a carried build doesn't depend on the prior build's objects surviving a retention sweep.
3. **Deletion handling** — pages present in the prior build but absent now (deleted in WP) are already dropped naturally (they're not in `currentRefs`), but a future pass could surface them in the review screen.
