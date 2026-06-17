# Planner Inventory Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat planner's editable-unit inventory reflect what the site actually renders — so it stops falsely refusing real shells, stops offering blocks it cannot edit, and stops stating fabricated blast-radius counts.

**Architecture:** All three defects live in one function pair: `buildSiteMap` (DB read) → `reduceSiteMap` (pure reducer) in [apps/web/lib/jab/site-map.ts](../../../apps/web/lib/jab/site-map.ts), whose output (`SiteMap`) is the *only* thing the planner ([edit-planner.ts](../../../apps/web/lib/ai/edit-planner.ts)) and the plan validator ([edit-plan.ts](../../../apps/web/lib/jab/edit-plan.ts)) see. We fix the three derivations at the source: (1) derive shell presence from the **emitted Storage artifact** instead of the `shell_generations` cost-telemetry table, failing *closed to "present"* on a Storage error; (2) exclude non-renderable blocks (`passthrough` tier / `compile_status != 'ok'`) using the exact predicate the dispatcher already uses; (3) surface the real distinct-page count so blast-radius messaging is grounded. The pure reducer keeps the same input contract shape so its existing unit tests stay green.

**Tech Stack:** TypeScript, Next.js 15 App Router, Supabase JS (admin client + Storage), Vitest. Server-only modules.

## Global Constraints

- **Fleet-agnostic.** Every change must work across arbitrary WordPress sites/themes — no hardcoded slugs, hosts, colors, or per-site assumptions. Two Roads is a test target, not the spec.
- **No DB migration.** All columns used (`block_inventory.compile_status`, `block_inventory.page_slugs`) already exist and are already selected elsewhere ([artifacts.ts:180](../../../apps/web/lib/draft/artifacts.ts#L180), [inventory.ts:151](../../../apps/web/lib/jab/inventory.ts#L151)). This plan touches zero schema.
- **Errors are loud; no swallowed failures** (CLAUDE.md). The one deliberate fail-soft is shell-presence-on-Storage-error, which fails *toward offering the edit* (the safe direction) and is documented inline.
- **Keep `reduceSiteMap` pure and unit-tested.** All IO stays in `buildSiteMap`; all decisions that need testing are extracted into pure functions.
- Tests run with `pnpm --filter @jab/web test`; typecheck with `pnpm --filter @jab/web exec tsc --noEmit`. Run from repo root `c:\Projects\wp-headless`.

---

## Background — the three confirmed defects

Confirmed by code map + live DB evidence + a 35/57 adversarial review (workflow `wo17mzyzw`, 2026-06-16):

1. **Shell presence reads a telemetry table, not the artifact.** `buildSiteMap` derives `shell.header`/`shell.footer` from rows in `shell_generations` ([site-map.ts:82](../../../apps/web/lib/jab/site-map.ts#L82)) — a *cost-telemetry* table written only when a build (re)generates a shell ([persist-shell-generation.ts:104](../../../apps/web/lib/ai/persist-shell-generation.ts#L104), sole writer). Edit builds, `JAB_SKIP_SHELL_REGEN` reuse builds, and any clone-without-recompose path leave a shell's `Footer.tsx` in Storage but write no row. **Live proof:** Two Roads' latest `ready` build `394e1456` is a shell-*header* edit build cloned from `8ca94b28`; it has a `header:ok` row and **no footer row**, yet `Footer.tsx` exists in its tree. The planner reads the latest ready build → `footer:false` → `validateEditPlan` returns `"This site has no footer."` ([edit-plan.ts:87-93](../../../apps/web/lib/jab/edit-plan.ts#L87-L93)). The render/deploy path consumes the `Footer.tsx` artifact and never reads `shell_generations`, so the table is provably the wrong source of truth for "does this site have a footer."

2. **The planner offers blocks it cannot edit.** `reduceSiteMap` includes every `block_inventory` row except `__null__` regardless of tier/compile status ([site-map.ts:51-62](../../../apps/web/lib/jab/site-map.ts#L51-L62)); `buildSiteMap` doesn't even select `compile_status`. But the dispatcher and the draft artifacts builder render *only* `tier !== 'passthrough' && compile_status === 'ok'` blocks ([compose-site-emit.ts:1197-1203](../../../apps/web/lib/jab/compose-site-emit.ts#L1197-L1203), [artifacts.ts:124-126](../../../apps/web/lib/draft/artifacts.ts#L124-L126)). So when a user targets a passthrough/failed block, the draft-edit worker patches the orphaned `passthroughFallback` stub, marks the edit `completed`, and the user sees **zero change with no error**. Fleet-wide: `assignTier` makes every `occurrence_count <= 2` block and every third-party/builder block passthrough — these dominate real WP sites.

   **`core/image` is a second class of no-op target that passes the tier/compile predicate.** `emitDispatcherTsx` *always* registers `"core/image": MediaImage` (the platform shim) and **deliberately suppresses** the LLM-generated `CoreImage` import ([compose-site-emit.ts:1219-1235](../../../apps/web/lib/jab/compose-site-emit.ts#L1219-L1235)), and the draft artifacts builder *already excludes* `core/image` from the component sources it loads/overrides ([artifacts.ts:63](../../../apps/web/lib/draft/artifacts.ts#L63)). So a `core/image` row with `tier='visual', compile_status='ok'` passes `tier !== 'passthrough' && compile_status === 'ok'` yet patching its `CoreImage` file is a guaranteed no-op — the dispatcher renders `MediaImage`, never the patched component. `core/image` must be excluded too, until a real platform-shim edit path exists. (This is fleet-wide — `core/image` is a WordPress core block on nearly every site. It is the *only* always-shimmed block today; the exclusion is a single named block, not a category.)

3. **Blast-radius count is fabricated.** The planner is told only `occurrenceCount` (total block instances) ([edit-planner.ts:58-59](../../../apps/web/lib/ai/edit-planner.ts#L58-L59)) but the tool schema asks it to state `"affects 3 pages"` ([edit-plan.ts:44-48](../../../apps/web/lib/jab/edit-plan.ts#L44-L48)) — a *distinct-page* number it was never given. `occurrenceCount` diverges from page count whenever a block appears twice on one page. The real distinct-page set lives in `block_inventory.page_slugs` but is never selected. The user-visible assistant reply (`plan.action`) therefore states a number the model guessed.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| [apps/web/lib/jab/site-map.ts](../../../apps/web/lib/jab/site-map.ts) | Build + reduce the planner's inventory | Add pure `decideShellPresence` + `shellFileName`; replace shell_generations read with a Storage `list`; add `compile_status` + `page_slugs` to the SELECT; filter non-renderable blocks; add `pageCount` to `SiteMapBlockType` |
| [apps/web/lib/jab/site-map.test.ts](../../../apps/web/lib/jab/site-map.test.ts) | Unit tests for the pure reducer + helpers | New tests for `decideShellPresence`, block filtering, `pageCount` |
| [apps/web/lib/ai/edit-planner.ts](../../../apps/web/lib/ai/edit-planner.ts) | Build the planner system prompt | Emit `pageCount` instead of `occurrenceCount` for blast radius |
| [apps/web/lib/jab/edit-plan.ts](../../../apps/web/lib/jab/edit-plan.ts) | Plan tool schema + validation | Drop the fabricated `"affects 3 pages"` literal from the `action` schema description |
| [apps/web/lib/ai/edit-planner.test.ts](../../../apps/web/lib/ai/edit-planner.test.ts) | Planner prompt tests | Assert the prompt states a page count, not an instance count (create if absent) |

---

### Task 1: Shell presence from the emitted artifact (fail closed to "present")

**Files:**
- Modify: `apps/web/lib/jab/site-map.ts`
- Test: `apps/web/lib/jab/site-map.test.ts`

**Interfaces:**
- Produces: `shellFileName(kind: "header" | "footer"): string` and `decideShellPresence(kind: "header" | "footer", listing: { ok: true; names: string[] } | { ok: false }): boolean` (pure). `buildSiteMap(sourceBuildId: string): Promise<SiteMap>` keeps its signature; `reduceSiteMap`'s `hasHeader`/`hasFooter` inputs are unchanged.
- Consumes: `SITE_SCREENSHOTS_BUCKET` from `@/lib/storage/bucket`; the admin Storage client's `.list(dir)`.

- [ ] **Step 1: Write the failing test** (append to `site-map.test.ts`)

```ts
import { reduceSiteMap, humanLabelForBlock, decideShellPresence, shellFileName, type SiteMap } from "./site-map";

describe("shell presence (artifact-derived, fail-closed)", () => {
  it("maps kind → emitted filename", () => {
    expect(shellFileName("header")).toBe("Header.tsx");
    expect(shellFileName("footer")).toBe("Footer.tsx");
  });

  it("is present when the file is in the listing", () => {
    expect(decideShellPresence("footer", { ok: true, names: ["Header.tsx", "Footer.tsx", "layout.tsx"] })).toBe(true);
  });

  it("is absent when the listing succeeded but the file is missing", () => {
    expect(decideShellPresence("footer", { ok: true, names: ["Header.tsx", "layout.tsx"] })).toBe(false);
  });

  it("FAILS CLOSED to present when the Storage listing itself failed", () => {
    // A transient Storage error must NOT hide a real shell — compose always
    // emits both Header.tsx and Footer.tsx, so "present" is the safe prior.
    expect(decideShellPresence("footer", { ok: false })).toBe(true);
    expect(decideShellPresence("header", { ok: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- site-map`
Expected: FAIL — `decideShellPresence` / `shellFileName` are not exported.

- [ ] **Step 3: Implement the pure helpers + swap the IO** (`site-map.ts`)

Add the imports + pure helpers near the top (after the existing `import { createAdminClient }`):

```ts
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

export function shellFileName(kind: "header" | "footer"): string {
  return kind === "header" ? "Header.tsx" : "Footer.tsx";
}

/**
 * Pure shell-presence decision. Shell presence MUST reflect the emitted
 * artifact (builds/<id>/project/components/site/<Kind>.tsx), not the
 * shell_generations cost-telemetry table — edit/skip-regen/clone builds leave
 * the file in Storage without writing a telemetry row (proven on build
 * 394e1456). When the Storage listing itself fails we fail CLOSED to "present":
 * compose always emits both shells, so a transient blip must not make the
 * planner falsely refuse a real shell. The rare genuinely-missing file is then
 * caught loudly downstream by the draft-edit loader.
 */
export function decideShellPresence(
  kind: "header" | "footer",
  listing: { ok: true; names: string[] } | { ok: false },
): boolean {
  if (!listing.ok) return true;
  return listing.names.includes(shellFileName(kind));
}

async function listShellDir(
  sourceBuildId: string,
): Promise<{ ok: true; names: string[] } | { ok: false }> {
  try {
    const supabase = createAdminClient();
    const dir = `builds/${sourceBuildId}/project/components/site`;
    const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).list(dir);
    if (error) return { ok: false };
    return { ok: true, names: (data ?? []).map((f) => f.name) };
  } catch {
    return { ok: false };
  }
}
```

Then change `buildSiteMap` to use the shell directory listing instead of the `shell_generations` read. Replace the third Promise.all entry and the shell-kind derivation:

```ts
export async function buildSiteMap(sourceBuildId: string): Promise<SiteMap> {
  const supabase = createAdminClient();
  const [blocksRes, pagesRes, shellListing] = await Promise.all([
    supabase
      .from("block_inventory")
      .select("block_name, tier, occurrence_count, compile_status, page_slugs")
      .eq("site_build_id", sourceBuildId),
    supabase
      .from("page_inventory")
      .select("slug, route_path, post_type")
      .eq("site_build_id", sourceBuildId),
    listShellDir(sourceBuildId),
  ]);
  // Hard-fail the inventory reads. A swallowed DB error here would silently
  // collapse the planner's candidate set to empty, making it refuse every real
  // target — the loud-error rule (Global Constraints) applies. The ONLY
  // deliberate fail-soft is shell presence: listShellDir → decideShellPresence
  // fails CLOSED to "present", never to a false refusal.
  if (blocksRes.error) throw new Error(`buildSiteMap: block_inventory read failed: ${blocksRes.error.message}`);
  if (pagesRes.error) throw new Error(`buildSiteMap: page_inventory read failed: ${pagesRes.error.message}`);
  return reduceSiteMap({
    blockRows: (blocksRes.data ?? []) as ReduceSiteMapInput["blockRows"],
    pageRows: (pagesRes.data ?? []) as ReduceSiteMapInput["pageRows"],
    hasHeader: decideShellPresence("header", shellListing),
    hasFooter: decideShellPresence("footer", shellListing),
  });
}
```

(The added `compile_status` + `page_slugs` columns are consumed by Tasks 2 and 3; selecting them now keeps the SELECT in one place. The `blocksRes`/`pagesRes` shape — capturing `.error`, not just `.data` — is required so the two inventory reads can hard-fail per the Global Constraints loud-error rule; the previous `{ data }`-only destructure silently returned an empty map on a DB error.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- site-map`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean (note `ReduceSiteMapInput.blockRows` gains fields in Task 2 — if tsc flags the extra selected columns now, proceed to Task 2 before committing, or widen the type in this step).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts
git commit -m "fix(planner): derive shell presence from emitted artifact, not shell_generations telemetry"
```

---

### Task 2: Exclude non-renderable blocks from the candidate set

**Files:**
- Modify: `apps/web/lib/jab/site-map.ts`
- Test: `apps/web/lib/jab/site-map.test.ts`

**Interfaces:**
- Consumes: the `compile_status` column added to the SELECT in Task 1.
- Produces: `ReduceSiteMapInput.blockRows[]` gains `compile_status: string | null`; `reduceSiteMap` excludes `tier === 'passthrough' || compile_status !== 'ok' || block_name === 'core/image'` (in addition to `__null__`). `SiteMapBlockType` is unchanged by this task.

- [ ] **Step 1: Write the failing test** (append to the `reduceSiteMap` describe block)

```ts
it("excludes passthrough/non-ok blocks AND core/image (only individually-renderable units are editable)", () => {
  const map = reduceSiteMap({
    blockRows: [
      { block_name: "core/cover", tier: "visual", occurrence_count: 3, compile_status: "ok", page_slugs: ["a", "b"] },
      { block_name: "kadence/rowlayout", tier: "passthrough", occurrence_count: 5, compile_status: "skipped", page_slugs: ["a"] },
      { block_name: "core/table", tier: "standard", occurrence_count: 2, compile_status: "failed", page_slugs: ["c"] },
      // core/image passes tier/compile but the dispatcher always routes it to the
      // MediaImage shim (the generated CoreImage is suppressed), so patching it
      // is a no-op — it MUST be excluded too.
      { block_name: "core/image", tier: "visual", occurrence_count: 9, compile_status: "ok", page_slugs: ["a", "b", "c"] },
      { block_name: "__null__", tier: "passthrough", occurrence_count: 1, compile_status: "skipped", page_slugs: ["a"] },
    ],
    pageRows: [],
    hasHeader: true,
    hasFooter: true,
  });
  expect(map.blockTypes.map((b) => b.blockName)).toEqual(["core/cover"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- site-map`
Expected: FAIL — `kadence/rowlayout` and `core/table` are still present; the test also won't compile until `compile_status`/`page_slugs` are added to `ReduceSiteMapInput`.

- [ ] **Step 3: Implement** (`site-map.ts`)

Widen the input type and the filter. Update `ReduceSiteMapInput`:

```ts
export interface ReduceSiteMapInput {
  blockRows: Array<{
    block_name: string;
    tier: string | null;
    occurrence_count: number | null;
    compile_status: string | null;
    page_slugs: string[] | null;
  }>;
  pageRows: Array<{ slug: string; route_path: string; post_type: string }>;
  hasHeader: boolean;
  hasFooter: boolean;
}
```

Update the filter inside `reduceSiteMap` (the `.filter(...)` before `.map(...)`):

```ts
  const blockTypes: SiteMapBlockType[] = input.blockRows
    // Only units that render AS THEIR OWN PATCHABLE COMPONENT are editable.
    // The dispatcher + draft artifacts builder render exactly
    // tier!=='passthrough' && compile_status==='ok' (compose-site-emit.ts:1197-1203,
    // artifacts.ts:124-126); offering anything else makes the draft-edit worker
    // patch an orphaned passthrough stub, mark the edit completed, and show the
    // user zero change with no error.
    // core/image ALSO passes that predicate but is always routed to the
    // MediaImage platform shim (emitDispatcherTsx suppresses the generated
    // CoreImage, compose-site-emit.ts:1219-1235; the draft builder excludes
    // core/image from component sources, artifacts.ts:63) — so patching it is a
    // no-op. Exclude it by name until a platform-shim edit path exists.
    .filter(
      (r) =>
        r.block_name !== "__null__" &&
        r.block_name !== "core/image" &&
        r.tier !== "passthrough" &&
        r.compile_status === "ok",
    )
    .map((r) => ({
      blockName: r.block_name,
      label: humanLabelForBlock(r.block_name),
      tier: r.tier,
      occurrenceCount: r.occurrence_count ?? 0,
    }))
    .sort((a, b) => {
      if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
      return a.blockName.localeCompare(b.blockName);
    });
```

Update the existing `reduceSiteMap` tests' fixtures (the two pre-existing cases) to include `compile_status: "ok"` and `page_slugs: []` on each block row, so they still pass.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- site-map`
Expected: PASS (new test + the two updated pre-existing cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts
git commit -m "fix(planner): exclude passthrough/failed blocks from editable candidate set"
```

> **Note (no TDD step):** [regenerate-unit.ts:144-146](../../../apps/web/lib/ai/regenerate-unit.ts#L144-L146) carries a now-false comment claiming `skipped` is unreachable because "the planner's siteMap only offers real block types." After this task that claim becomes true, so the comment is no longer wrong — but verify the file still exists in the live-draft path and, if the comment still asserts unreachability for a *different* reason, correct it in the same commit. Do not invent code; only adjust the comment if its premise is stale.

---

### Task 3: Honest blast-radius — distinct page count, not instance count

**Files:**
- Modify: `apps/web/lib/jab/site-map.ts`, `apps/web/lib/ai/edit-planner.ts`, `apps/web/lib/jab/edit-plan.ts`
- Test: `apps/web/lib/jab/site-map.test.ts`, `apps/web/lib/ai/edit-planner.test.ts`

**Interfaces:**
- Produces: `SiteMapBlockType` gains `pageCount: number` (= distinct `page_slugs.length`). `buildSystemPrompt(siteMap)` emits the page count for blast radius.
- Consumes: `page_slugs` added to the SELECT in Task 1.

- [ ] **Step 1: Write the failing reducer test** (append to the `reduceSiteMap` describe block)

```ts
import { MAX_PAGE_SLUGS_PER_BLOCK } from "@/lib/jab/inventory";

it("derives pageCount from distinct page_slugs (not occurrence_count) and flags non-floor counts", () => {
  const map = reduceSiteMap({
    blockRows: [
      // appears twice on ONE page → occurrenceCount 2 but pageCount 1
      { block_name: "core/cover", tier: "visual", occurrence_count: 2, compile_status: "ok", page_slugs: ["home"] },
      { block_name: "core/heading", tier: "trivial", occurrence_count: 4, compile_status: "ok", page_slugs: ["home", "about", "contact"] },
    ],
    pageRows: [],
    hasHeader: true,
    hasFooter: true,
  });
  const cover = map.blockTypes.find((b) => b.blockName === "core/cover")!;
  const heading = map.blockTypes.find((b) => b.blockName === "core/heading")!;
  expect(cover.occurrenceCount).toBe(2);
  expect(cover.pageCount).toBe(1);
  expect(cover.pageCountIsFloor).toBe(false);
  expect(heading.pageCount).toBe(3);
  expect(heading.pageCountIsFloor).toBe(false);
});

it("marks pageCount as a FLOOR when page_slugs hit the inventory cap (50+)", () => {
  // The inventory builder caps page_slugs at MAX_PAGE_SLUGS_PER_BLOCK (50), so a
  // block on 80 pages persists exactly 50 slugs. pageCount must be flagged as a
  // floor so the planner says "at least 50 pages", never a fabricated "50 pages".
  const slugs = Array.from({ length: MAX_PAGE_SLUGS_PER_BLOCK }, (_, i) => `p${i}`);
  const map = reduceSiteMap({
    blockRows: [{ block_name: "core/cover", tier: "visual", occurrence_count: 90, compile_status: "ok", page_slugs: slugs }],
    pageRows: [],
    hasHeader: true,
    hasFooter: true,
  });
  const cover = map.blockTypes[0];
  expect(cover.pageCount).toBe(MAX_PAGE_SLUGS_PER_BLOCK);
  expect(cover.pageCountIsFloor).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- site-map`
Expected: FAIL — `pageCount` is `undefined` / not on `SiteMapBlockType`.

- [ ] **Step 3: Implement the reducer change** (`site-map.ts`)

Add `pageCount` to the interface and the map:

```ts
export interface SiteMapBlockType {
  blockName: string;
  label: string;
  tier: string | null;
  occurrenceCount: number;
  /**
   * Distinct pages the block renders on. NOTE: block_inventory.page_slugs is
   * CAPPED at MAX_PAGE_SLUGS_PER_BLOCK (=50) by the inventory builder
   * (inventory.ts:151), so this is a FLOOR, not an exact count, once it hits
   * the cap — `pageCountIsFloor` says which. edit-impact.ts:7-9 already warns
   * that page_slugs is not trustworthy as an exact changed-page count.
   */
  pageCount: number;
  /** True when pageCount === MAX_PAGE_SLUGS_PER_BLOCK (the real count may be higher). */
  pageCountIsFloor: boolean;
}
```

Add the cap import at the top of `site-map.ts` (alongside the other imports):

```ts
import { MAX_PAGE_SLUGS_PER_BLOCK } from "@/lib/jab/inventory";
```

In the `.map(...)` inside `reduceSiteMap`:

```ts
    .map((r) => {
      const pageCount = (r.page_slugs ?? []).length;
      return {
        blockName: r.block_name,
        label: humanLabelForBlock(r.block_name),
        tier: r.tier,
        occurrenceCount: r.occurrence_count ?? 0,
        // page_slugs is capped at MAX_PAGE_SLUGS_PER_BLOCK; at the cap this is a
        // floor ("at least N"), so the planner must not state it as an exact count.
        pageCount,
        pageCountIsFloor: pageCount >= MAX_PAGE_SLUGS_PER_BLOCK,
      };
    })
```

Update the earlier tests' expected `blockTypes` objects to include `pageCount` + `pageCountIsFloor` (compute each from the fixture's `page_slugs` length vs the cap).

- [ ] **Step 4: Write the failing planner-prompt test** (`apps/web/lib/ai/edit-planner.test.ts`, create if absent)

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPromptForTest } from "./edit-planner";
import type { SiteMap } from "@/lib/jab/site-map";

const MAP: SiteMap = {
  blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 5, pageCount: 3, pageCountIsFloor: false }],
  pageSlugs: ["home", "about", "contact"],
  shell: { header: true, footer: true },
};

describe("buildSystemPrompt blast radius", () => {
  it("states the distinct page count, never the raw instance count", () => {
    const prompt = buildSystemPromptForTest(MAP);
    expect(prompt).toMatch(/Cover.*3 page/s);
    expect(prompt).not.toMatch(/appears 5 times/);
  });

  it("says 'at least N' when the page count is a floor (capped inventory)", () => {
    const capped: SiteMap = {
      blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 200, pageCount: 50, pageCountIsFloor: true }],
      pageSlugs: [],
      shell: { header: true, footer: true },
    };
    expect(buildSystemPromptForTest(capped)).toMatch(/at least 50 pages/);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- edit-planner`
Expected: FAIL — `buildSystemPromptForTest` is not exported; the prompt currently emits `occurrenceCount`.

- [ ] **Step 6: Implement the planner prompt change** (`edit-planner.ts`)

Export `buildSystemPrompt` under a test-friendly alias (or export it directly) and change the block line. Replace the `blockLines` builder:

```ts
  const blockLines = siteMap.blockTypes
    .map((b) => {
      // page_slugs is capped at 50, so pageCountIsFloor blocks render "at least N"
      // — never a fabricated exact count for a block on 50+ pages.
      const pages = `${b.pageCountIsFloor ? "at least " : ""}${b.pageCount} page${b.pageCount === 1 ? "" : "s"}`;
      return `- ${b.blockName} ("${b.label}", on ${pages})`;
    })
    .join("\n");
```

Add (or confirm) an export for the test:

```ts
// Exported for unit testing the prompt's blast-radius phrasing.
export function buildSystemPromptForTest(siteMap: SiteMap): string {
  return buildSystemPrompt(siteMap);
}
```

- [ ] **Step 7: Soften the tool-schema example** (`edit-plan.ts`)

In `EDIT_PLAN_TOOL_SCHEMA`, change the `action` property description so it no longer hands the model a fabricated number to imitate. Replace the example:

```ts
      action: {
        type: "string",
        description:
          "One sentence stating exactly what changes and the blast radius using the page count EXACTLY as shown for the target in the unit list — copy its wording verbatim, INCLUDING the 'at least N' phrasing when the list uses it (that count is capped and the true number may be higher). e.g. 'Regenerate the Cover block — this changes it on every page that uses it (3 pages).' NEVER invent, round, or drop the 'at least' from a number the list does not state plainly.",
      },
```

- [ ] **Step 8: Run both tests**

Run: `pnpm --filter @jab/web test -- "site-map|edit-planner"`
Expected: PASS.

- [ ] **Step 9: Typecheck + full suite**

Run: `pnpm --filter @jab/web exec tsc --noEmit` then `pnpm --filter @jab/web test`
Expected: clean tsc; full suite green.

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts apps/web/lib/jab/edit-plan.ts
git commit -m "fix(planner): state real distinct-page blast radius instead of fabricated count"
```

---

## Self-Review

**Spec coverage:**
- Defect 1 (shell presence from telemetry) → Task 1. ✓
- Defect 2 (non-renderable blocks offered) → Task 2. ✓
- Defect 3 (fabricated blast radius) → Task 3. ✓
- Adversarial acceptance criterion "fail CLOSED to present on Storage error" → Task 1 Step 1 test + Step 3 doc. ✓

**Review-driven refinements (2026-06-17, all confirmed against code):**
- **Loud inventory reads (Task 1):** `buildSiteMap` now captures `.error` on the `block_inventory`/`page_inventory` reads and throws — a swallowed DB error would otherwise collapse the candidate set to empty and refuse every target. Only shell presence stays fail-soft (closed to "present"). ✓
- **`core/image` excluded (Task 2):** it passes `tier !== 'passthrough' && compile_status === 'ok'` but the dispatcher always routes it to the `MediaImage` shim (the generated `CoreImage` is suppressed, [compose-site-emit.ts:1219-1235](../../../apps/web/lib/jab/compose-site-emit.ts#L1219-L1235); excluded from draft sources at [artifacts.ts:63](../../../apps/web/lib/draft/artifacts.ts#L63)), so patching it is a no-op. The filter excludes it by name + a test asserts exclusion. ✓
- **Capped blast radius (Task 3):** `block_inventory.page_slugs` is capped at `MAX_PAGE_SLUGS_PER_BLOCK` (=50, [inventory.ts:126/151](../../../apps/web/lib/jab/inventory.ts#L126); [edit-impact.ts:7-9](../../../apps/web/lib/jab/edit-impact.ts#L7-L9) warns it is not a trustworthy exact count), so `pageCount` is flagged `pageCountIsFloor` at the cap and the prompt says "at least N pages" — never a fabricated exact "50 pages". A more-accurate (but heavier) alternative is to derive the count from `page_inventory.block_tree` like `computeChangedPages`; the floor flag is the cheap, honest fix and sufficient for a planner-prompt hint. ✓

**Type consistency:** `decideShellPresence`, `shellFileName`, `ReduceSiteMapInput.blockRows` (now 5 fields), `SiteMapBlockType` (now `pageCount` + `pageCountIsFloor`), `buildSystemPromptForTest`, and the imported `MAX_PAGE_SLUGS_PER_BLOCK` are used consistently across tasks. `reduceSiteMap`'s `hasHeader`/`hasFooter` booleans are unchanged, preserving its pure-reducer contract.

**Placeholder scan:** every step contains real code or an exact command. The one non-TDD note (regenerate-unit comment) is explicitly marked optional and conditional on the file's current state.

## Out of scope (tracked elsewhere)

- Making Classic-editor `__null__` body content editable (needs a new editable artifact — see the fleet gap register).
- Per-instance / per-page / nested-block targeting (deliberate architecture boundary — register).
- A global-token (`scope="tokens"`) edit path — register.
- Steering the draft preview to a page where a CPT/ACF-flex edit actually renders — register.
These are real fleet gaps but each is its own design effort; this plan is the correctness floor that makes the planner's existing capabilities honest.
