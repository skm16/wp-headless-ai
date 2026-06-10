# Senior-Review Fix Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed blocker/high finding from the 2026-06-09 multi-agent senior review so the chat-edit → preview → promote loop (the four scenarios in `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md`) can actually pass end to end, plus the selected mediums and hygiene items — updating documentation as we go.

**Architecture:** All fixes land on the existing branch `feat/saas-e2e-loop` in `apps/web` (Next.js App Router + Inngest workers + Supabase) and `packages/core` (the emitted SDK template). The repo convention is: pure functions get colocated `*.test.ts` vitest coverage; DB/queue-coupled worker steps are covered by typecheck + the manual smoke runbook. Each task follows that convention — pure seams get real TDD, worker wiring gets the seam extracted where cheap.

**Tech Stack:** TypeScript, Next.js 15 server actions, Inngest, Supabase (supabase-js + hand-written SQL migrations applied via `mcp__supabase__apply_migration`), vitest, pnpm workspaces.

---

## Context — the findings being fixed (from the 2026-06-09 review)

| # | Task | Severity | Finding |
|---|------|----------|---------|
| 1 | T1 | **blocker** | Every `mode='edit'` build fails compose: `EditConfig` has no `front_page_slug`, edit-site never copies it from the source build, and the `route_path='/'` fallback is dead |
| 2 | T2 | **blocker** | `computeChangedPages` diffs raw WP `block_tree`, which never contains synthesized `acf_flex/*` / `cpt_template/*` names → confidently-EMPTY changed set → carry-forward auto-approves genuinely-changed pages → publish gate passes without review |
| 3 | T3 | high | edit-site's `page_inventory` clone drops `block_tree` + `source_modified_gmt` → every second-and-later edit fail-closes to all-pages re-review |
| 4 | T4 | high | `loadWorkspaceEditHistory` is an exposed `"use server"` action doing service-role reads with zero auth — cross-tenant disclosure |
| 5 | T5 | high | `inngest.send` after row insert with no failure write → stranded `queued` build/edit permanently blocks the project |
| 6 | T6 | high | Wedged active build (crashed worker, `retries:0`) has no recovery short of operator SQL |
| 7 | T7 | high | Cancel guards only run at worker entry — a discard mid-compose resurrects the cancelled build and deploys it; `markBuildFailed` can overwrite `cancelled`; deploy on-failure omits `error_text`/`finished_at` |
| 8 | T8 | high | Workspace gates chat/edits/preview on the *single latest* build being `ready` — a failed/discarded edit locks the whole edit surface; edit chip renders raw `workspace_edits.status` |
| 9 | T9 | medium | `JAB_CHAT_EDIT` gates only the UI; no input length caps; budget guard runs service-role queries before the tenant check |
| 10 | T10 | medium | `ensureConversation` check-then-insert race splits chat history; user-message insert error ignored; missing hot-path + FK indexes (migration 0032) |
| 11 | T11 | medium | The real 23505 raise site (queued→active UPDATE in discover-site) surfaces raw Postgres text; the insert-site catches are dead code with misleading comments |
| 12 | T12 | medium | `resolveCptAbilityMeta` + `abilityMetaFor` read snake_case `output_schema` off a camelCase persisted manifest — both refinements are dead code masked by wrong-shaped fixtures |
| 13 | T13 | high | Emitted SDK client never recovers from MCP session expiry (HTTP 404) — deployed sites 500/stale until the lambda recycles; core `McpClient` same gap |
| 14 | T14 | medium | `/api/cron/prune` is blocked by the auth middleware — Vercel Cron can never call it |
| 15 | T15 | medium | The smoke runbook + operator scripts are untracked; debris dirs not gitignored |
| 16 | T16 | medium | `.env.local.example` missing `VERCEL_TOKEN`/`VERCEL_TEAM_ID` and every `JAB_*` flag |
| 17 | T17 | low | Dead code: `triggerDiscovery` (re-introduces the wedged-build class), `createConversationAction` (zero callers) |
| 18 | T18 | low | `apps/web/lib/jab/semver.ts` duplicates `@jab/core` semver with behavioral drift |
| 19 | T19 | low | `packages/cli` has no test script — `pnpm --filter` silently exits 0 (CI false-green) |
| 20 | T20 | low | `JAB_COMPOSE_TYPECHECK` semantics documented inverted in CLAUDE.md + conversion-pipeline.md; runbook prereqs incomplete |
| 21 | T21 | — | Final verification: full suites + typecheck + runbook handoff |

**Deliberately out of scope (separate plans):**
- All `packages/wp-plugin` PHP findings (AcfValueWalker scalar coercion, ACF location-rule matcher, diagnostics over/under-reporting, hierarchical by-slug ambiguity) — different language/test harness; needs its own plan.
- Menus persistence (compose reads `manifest.menus` which never exists) — a pipeline feature, not a fix.
- `verify-fidelity`'s front-page-vs-404 capture mismatch and the never-populated 0028 per-page perf metrics — entangled with the fidelity-scoring follow-up (Phase 7.1 vision-LLM work); fix together there.
- Chat panel live refresh/polling, real Lighthouse stats on the project page (deliberate phase-2 mocks), full IP rate limiting (T9's length caps + the existing per-project budget windows are the v1 guard).

**Branch:** work directly on `feat/saas-e2e-loop` (these are fixes to that branch's feature). Run all commands from `c:\Projects\wp-headless`.

**Verification commands used throughout:**
- App tests: `pnpm --filter @jab/web test` (vitest run; 771 passing at plan time)
- App typecheck: `pnpm --filter @jab/web typecheck`
- Core tests/typecheck: `pnpm --filter @jab/core test` / `pnpm --filter @jab/core typecheck`

---

## File map (what gets touched)

**Created:**
- `apps/web/lib/db/auto-fail-stale-build.ts` — stale-build auto-recovery (T6)
- `apps/web/lib/jab/build-status.test.ts` — tests for `isStaleActiveBuild` (T6; create only if no such file exists)
- `apps/web/lib/jab/workspace-edit-validation.test.ts` — tests for the new prompt cap (T9)
- `apps/web/drizzle/migrations/0032_chat_indexes_and_one_thread.sql` — conversation uniqueness + indexes (T10)
- `packages/cli/src/util/credentials.test.ts` — first CLI test (T19)

**Modified (load-bearing):**
- `apps/web/lib/jab/build-config.ts` + `.test.ts` (T1)
- `apps/web/lib/inngest/functions/edit-site.ts` (T1, T3)
- `apps/web/lib/jab/edit-impact.ts` + `.test.ts` (T2)
- `apps/web/lib/inngest/functions/edit-site.helpers.ts` + `.test.ts` (T3)
- `apps/web/lib/actions/workspace-edit.ts` (T4, T5)
- `apps/web/lib/actions/trigger-build.ts`, `apps/web/lib/jab/trigger-build-validation.ts`, `apps/web/lib/jab/workspace-edit-validation.ts` (T5, T9)
- `apps/web/lib/jab/build-status.ts` (T6)
- `apps/web/lib/inngest/functions/{compose-site,deploy-site,generate-components,discover-site}.ts`, `apps/web/lib/inngest/shared-failure.ts` (T7, T11)
- `apps/web/lib/jab/load-project-builds.ts`, `apps/web/lib/jab/workspace-preview-state.ts` + `.test.ts`, `apps/web/app/(app)/projects/[id]/workspace/page.tsx`, `.../builds/[buildId]/progress/page.tsx` (T6, T8)
- `apps/web/lib/actions/workspace-chat.ts`, `apps/web/lib/ai/edit-cost-guard.ts`, `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx` (T9, T10)
- `apps/web/lib/db/schema.ts` (T10)
- `apps/web/lib/jab/ability-client.ts` + `.test.ts` (T12)
- `packages/core/src/emit/client.ts`, `packages/core/src/mcp/client.ts` + core tests (T13)
- `apps/web/middleware.ts` (T14)
- `.gitignore`, `apps/web/.env.local.example`, `apps/web/lib/jab/probe.ts`, `packages/cli/package.json`, `CLAUDE.md`, `docs/conversion-pipeline.md`, `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md` (T15–T20)

**Deleted:**
- `apps/web/lib/actions/trigger-discovery.ts` (T17)
- `apps/web/lib/jab/semver.ts` + `apps/web/lib/jab/semver.test.ts` (T18)

---

# Phase 1 — Blockers

### Task 1: Carry `front_page_slug` (+ `last_sync_watermark`) from the source build into edit-build configs

Every `mode='edit'` build currently fails at compose-site's front-page resolution ([compose-site.ts:285-307]) because the edit config never carries `front_page_slug` and no `page_inventory` row has `route_path='/'`. Fix: a pure carry-forward helper in `build-config.ts`, wired into edit-site's `create-result-build`. Compose needs **no change** — its existing `legacyConfig.front_page_slug` cast reads the new typed field.

**Files:**
- Modify: `apps/web/lib/jab/build-config.ts`
- Modify: `apps/web/lib/jab/build-config.test.ts`
- Modify: `apps/web/lib/inngest/functions/edit-site.ts` (create-result-build step, ~lines 65-89)

- [ ] **Step 1: Write the failing tests** — append to `apps/web/lib/jab/build-config.test.ts`:

```typescript
import { carryForwardSourceConfig } from "./build-config";

describe("carryForwardSourceConfig", () => {
  it("extracts front_page_slug from a full build's legacy untyped config", () => {
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "home" })).toEqual({
      front_page_slug: "home",
    });
  });

  it("extracts front_page_slug from an edit config (edit-on-edit chains keep it)", () => {
    expect(
      carryForwardSourceConfig({ mode: "edit", source_build_id: "b1", front_page_slug: "home" }),
    ).toEqual({ front_page_slug: "home" });
  });

  it("carries last_sync_watermark when present (incremental window survives edits)", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" }),
    ).toEqual({ front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" });
  });

  it("returns null front_page_slug for null / non-object / missing / empty-string configs", () => {
    expect(carryForwardSourceConfig(null)).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig("garbage")).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full" })).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "" })).toEqual({ front_page_slug: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web test -- build-config`
Expected: FAIL — `carryForwardSourceConfig` is not exported.

- [ ] **Step 3: Implement in `build-config.ts`** — add `front_page_slug` to the edit variant of `BuildConfig` and the helper:

In the `BuildConfig` edit-variant object type, after `change_reason: "component_pages" | "shell_all" | null;` add:

```typescript
      /**
       * Static front page slug carried forward from the SOURCE build's config
       * (full builds write it via discover-site's persist-front-page-slug as a
       * legacy untyped key). compose-site's front-page resolution reads it —
       * without it every edit build dies at compose ("no static front-page
       * configured"); the route_path='/' fallback is dead (routePathFor never
       * emits '/'). Null when the source never detected one (compose then
       * fail-louds exactly like a full build without a front page).
       */
      front_page_slug: string | null;
      /** Incremental-sync watermark carried from the source so JAB_INCREMENTAL_SKIP survives an edit. */
      last_sync_watermark?: string;
```

At the end of the file add:

```typescript
export interface CarriedSourceConfig {
  front_page_slug: string | null;
  last_sync_watermark?: string;
}

/**
 * Extract the config keys an edit build must inherit from its source build.
 * Tolerates both shapes: full builds carry front_page_slug as a legacy
 * untyped key; edit builds carry the typed field (edit-on-edit chains).
 */
export function carryForwardSourceConfig(sourceConfig: unknown): CarriedSourceConfig {
  if (typeof sourceConfig !== "object" || sourceConfig === null) {
    return { front_page_slug: null };
  }
  const cfg = sourceConfig as { front_page_slug?: unknown; last_sync_watermark?: unknown };
  const out: CarriedSourceConfig = {
    front_page_slug:
      typeof cfg.front_page_slug === "string" && cfg.front_page_slug.length > 0
        ? cfg.front_page_slug
        : null,
  };
  if (typeof cfg.last_sync_watermark === "string") {
    out.last_sync_watermark = cfg.last_sync_watermark;
  }
  return out;
}
```

- [ ] **Step 4: Run tests; then typecheck to find every edit-config construction site**

Run: `pnpm --filter @jab/web test -- build-config` → PASS.
Run: `pnpm --filter @jab/web typecheck` → expect errors at every place that constructs a `mode: "edit"` config without `front_page_slug` (at minimum `edit-site.ts` create-result-build; possibly test fixtures). Fix each in Step 5 — do NOT silence with casts.

- [ ] **Step 5: Wire edit-site's create-result-build** — replace the step body (`edit-site.ts` ~lines 65-89) with:

```typescript
      resultBuildId = await step.run("create-result-build", async () => {
        const supabase = createAdminClient();
        // Read the SOURCE build's config: front_page_slug lives there (legacy
        // untyped key on full builds / typed field on edit builds). Without
        // carrying it, compose-site's front-page resolution throws for every
        // edit build (the route_path='/' fallback is dead — see build-config.ts).
        const { data: sourceRow, error: sourceErr } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", sourceBuildId)
          .eq("project_id", projectId)
          .single<{ config: unknown }>();
        if (sourceErr || !sourceRow) {
          throw new Error(
            `edit-site: source build ${sourceBuildId} config read failed: ${sourceErr?.message ?? "no row"}`,
          );
        }
        const carried = carryForwardSourceConfig(sourceRow.config);
        const config: BuildConfig = {
          mode: "edit",
          source_build_id: sourceBuildId,
          scope,
          target,
          prompt,
          regeneration_prompt: guidance,
          action: planAction,
          edit_id: editId,
          message_id: messageId ?? null,
          changed_slugs: [],
          change_reason: null,
          front_page_slug: carried.front_page_slug,
          ...(carried.last_sync_watermark
            ? { last_sync_watermark: carried.last_sync_watermark }
            : {}),
        };
        const { data, error } = await supabase
          .from("site_builds")
          .insert({ project_id: projectId, status: "queued", config })
          .select("id")
          .single<{ id: string }>();
        if (error || !data) {
          throw new Error(`edit-site: create-result-build failed: ${error?.message ?? "no row"}`);
        }
        return data.id;
      });
```

Add to the imports at the top of `edit-site.ts`: change `import type { BuildConfig } from "@/lib/jab/build-config";` to `import { carryForwardSourceConfig, type BuildConfig } from "@/lib/jab/build-config";`

Fix any remaining typecheck errors at edit-config fixture sites by adding `front_page_slug: null` (or a real slug where the fixture mimics a carried config).

- [ ] **Step 6: Verify everything green**

Run: `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck`
Expected: all tests pass (771 + the 4 new), zero type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts apps/web/lib/inngest/functions/edit-site.ts
git commit -m "fix(saas): edit builds inherit front_page_slug from the source build - compose no longer deterministically fails for mode=edit"
```

---

### Task 2: `computeChangedPages` fails closed on an empty component diff

The persisted `block_tree` is the RAW WP tree; synthesized `acf_flex/*` / `cpt_template/*` block names exist only in `block_inventory` and at render time. The planner's target was already validated against `block_inventory` before dispatch, so a zero-match diff proves the diff source is blind — today that returns `{ changedSlugs: [], reason: "component_pages" }`, carry-forward inherits all source approvals, and the publish gate passes with **zero human review of the changed pages**. Widen to all pages instead, like the other uncertainty branches.

**Files:**
- Modify: `apps/web/lib/jab/edit-impact.ts`
- Modify: `apps/web/lib/jab/edit-impact.test.ts`

- [ ] **Step 1: Invert the existing empty-set test and add the acf_flex regression** — in `edit-impact.test.ts`, REPLACE the test named `returns an empty changed set (component_pages) when no page contains the target` with:

```typescript
  it("FAIL-CLOSED: zero matches widens to all pages (diff source is blind to synthesized targets)", () => {
    const r = computeChangedPages({
      scope: "component",
      target: "core/cover",
      sourcePages: [
        page("home", [node("core/heading")]),
        page("about", [node("core/paragraph")]),
      ],
    });
    expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
    expect(r.reason).toBeNull();
  });

  it("FAIL-CLOSED: an acf_flex target absent from the raw trees widens to all pages", () => {
    // acf_flex/* names are synthesized from page.acf at inventory/render time
    // (content-detection.ts) and NEVER appear in the persisted raw block_tree —
    // this is the exact Two Roads 'make the hero bolder' shape.
    const r = computeChangedPages({
      scope: "component",
      target: "acf_flex/page/builder/hero",
      sourcePages: [
        page("home", [node("core/group", [node("core/paragraph")])]),
        page("beers", [node("core/columns")]),
      ],
    });
    expect(r.changedSlugs.sort()).toEqual(["beers", "home"]);
    expect(r.reason).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web test -- edit-impact`
Expected: both new tests FAIL (current code returns `[]` with reason `"component_pages"`).

- [ ] **Step 3: Implement** — in `edit-impact.ts`, in `computeChangedPages`, after the `for` loop and before the `> MAX_CONFIDENT_CHANGED_PAGES` check, insert:

```typescript
  if (changed.length === 0) {
    // The target was validated against block_inventory before dispatch, so an
    // empty diff means the persisted RAW tree cannot represent it (synthesized
    // acf_flex/* and cpt_template/* names exist only in the inventory and at
    // render time — content-detection.ts / compose-block-tree-runtime.ts).
    // A blind diff source must fail closed, or carry-forward inherits source
    // approvals onto genuinely-changed pages and the publish gate passes with
    // no human review (2026-06-09 review, blocker #2).
    return { changedSlugs: allSlugs(input.sourcePages), reason: null };
  }
```

Also update the module doc header's fail-closed list: change `Any uncertainty (null/non-array tree, or >50 changed pages)` to `Any uncertainty (null/non-array tree, >50 changed pages, or a zero-match diff — synthesized targets never appear in the raw tree)`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @jab/web test -- edit-impact` → PASS (all, including the untouched shell/recursion/50-cap tests).
Run: `pnpm --filter @jab/web test` → full suite green (no other suite asserts the empty-confident behavior; if one does, align it with the fail-closed contract).

- [ ] **Step 5: Update the runbook's Scenario 1 expectation** — in `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md`, after the Scenario 1 assertion paragraph ("Assert on the top row: `scope = component`, …"), add:

```markdown
> **Note (2026-06-09):** on sites whose targeted blocks are synthesized
> (`acf_flex/*` / `cpt_template/*` — i.e. Two Roads), the raw-tree diff cannot
> see the target and `computeChangedPages` deliberately fail-closes:
> `changed_slugs` = **every** page and `change_reason` = NULL. That still
> passes this scenario (non-empty set, changed pages pending) but the
> carry-forward assertion degenerates to all-pages-pending. Precision returns
> when synthesized nodes are persisted into `block_tree` (tracked follow-up).
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/edit-impact.ts apps/web/lib/jab/edit-impact.test.ts "docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md"
git commit -m "fix(saas): computeChangedPages fail-closes on a zero-match component diff - synthesized targets can no longer skip review"
```

# Phase 2 — Quick highs

### Task 3: edit-site's `page_inventory` clone carries `block_tree` + `source_modified_gmt`

The clone SELECT omits both columns, so the NEXT edit sourced from an edit build sees all-NULL trees → `computeChangedPages` fail-closes to all pages forever, and `JAB_INCREMENTAL_SKIP` degrades to full sync. Found independently by three reviewers. Fix is one select-string change; pin it with an exported column-list contract so it can't silently regress.

**Files:**
- Modify: `apps/web/lib/inngest/functions/edit-site.helpers.ts`
- Modify: `apps/web/lib/inngest/functions/edit-site.helpers.test.ts`
- Modify: `apps/web/lib/inngest/functions/edit-site.ts` (clone-page-inventory step, ~lines 134-155)

- [ ] **Step 1: Write the failing contract test** — append to `edit-site.helpers.test.ts`:

```typescript
import { PAGE_INVENTORY_CLONE_COLUMNS } from "./edit-site.helpers";

describe("PAGE_INVENTORY_CLONE_COLUMNS", () => {
  const cols = PAGE_INVENTORY_CLONE_COLUMNS.split(",").map((c) => c.trim());

  it("carries block_tree — without it the NEXT edit fail-closes to all-pages re-review", () => {
    expect(cols).toContain("block_tree");
  });

  it("carries source_modified_gmt — without it JAB_INCREMENTAL_SKIP degrades to full sync", () => {
    expect(cols).toContain("source_modified_gmt");
  });

  it("carries every column loadSourcePagesForImpact reads (slug, block_tree)", () => {
    expect(cols).toEqual(expect.arrayContaining(["slug", "block_tree"]));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web test -- edit-site.helpers`
Expected: FAIL — `PAGE_INVENTORY_CLONE_COLUMNS` is not exported.

- [ ] **Step 3: Implement** — in `edit-site.helpers.ts` add:

```typescript
/**
 * Columns an edit build's page_inventory clone must copy from the source
 * build. block_tree (0027) and source_modified_gmt (0026) are load-bearing:
 * without them the NEXT edit sourced from this build fail-closes
 * computeChangedPages to ALL pages (full re-review, carry-forward dead) and
 * incremental sync loses its watermark substrate. 2026-06-09 review, high #3.
 */
export const PAGE_INVENTORY_CLONE_COLUMNS =
  "slug, post_type, title, route_path, block_count, source_screenshot_paths, rendering, paradigms, block_tree, source_modified_gmt";
```

In `edit-site.ts` clone-page-inventory, replace the inline select string with the constant:

```typescript
        const { data: src, error: readErr } = await supabase
          .from("page_inventory")
          .select(PAGE_INVENTORY_CLONE_COLUMNS)
          .eq("site_build_id", sourceBuildId)
          .eq("project_id", projectId);
```

and add `PAGE_INVENTORY_CLONE_COLUMNS` to the existing `from "@/lib/inngest/functions/edit-site.helpers"` import. The row mapper (`...r` spread) already passes every selected column through — no other change.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @jab/web test -- edit-site.helpers` → PASS. Run `pnpm --filter @jab/web typecheck` → clean (note: the select's inferred row type widens with the new columns; if TS complains at the `rows` map, type `src` rows as `Record<string, unknown>[]` like the existing pattern).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/inngest/functions/edit-site.helpers.ts apps/web/lib/inngest/functions/edit-site.helpers.test.ts apps/web/lib/inngest/functions/edit-site.ts
git commit -m "fix(saas): edit-build page_inventory clone carries block_tree + source_modified_gmt so edit-on-edit keeps a real diff substrate"
```

---

### Task 4: `loadWorkspaceEditHistory` goes through the RLS user client

It's exported from a `"use server"` module (= public POST endpoint) and reads `workspace_edits` (prompts, error_text, build ids) with the service-role client keyed only on a caller-supplied projectId. `workspace_edits` already has `workspace_edits_tenant_select` (migration 0024) and the joined `result_build:result_build_id(status)` read is covered by `site_builds`' tenant SELECT policy — so the fix is one client swap. Unauthorized callers then get `[]`.

**Files:**
- Modify: `apps/web/lib/actions/workspace-edit.ts` (~lines 197-224)

- [ ] **Step 1: Swap the client** — in `loadWorkspaceEditHistory`, replace:

```typescript
  const admin = createAdminClient();
  const { data, error } = await admin
```

with:

```typescript
  // RLS-scoped read. This is an exported "use server" function — a public
  // POST endpoint — so it must NOT use the admin client unguarded:
  // workspace_edits carries workspace_edits_tenant_select (migration 0024)
  // and the result_build join is covered by site_builds' tenant SELECT
  // policy, so unauthorized callers get [] instead of another tenant's
  // prompts/errors. (2026-06-09 review, high #6 — cross-tenant disclosure.)
  const supabase = await createClient();
  const { data, error } = await supabase
```

Delete the old "Reuses createAdminClient deliberately…" doc comment above the function. `createClient` is already imported at the top of the file.

- [ ] **Step 2: Verify**

Run: `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck` → green. Manual check happens in T21's runbook pass (the workspace page's edit-history list must still populate — the page's own RLS project query already proved membership).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/workspace-edit.ts
git commit -m "fix(saas): loadWorkspaceEditHistory reads via RLS user client - closes cross-tenant edit-history disclosure"
```

---

# Phase 3 — Stuck state & cancellation

### Task 5: Dispatch-failure cleanup in `triggerBuildAction` + `requestWorkspaceEditAction`

Both insert their row (`queued`) and only then `inngest.send`. A failed send (Inngest dev server down, missing event key, network blip) strands the row: `queued` counts as active for both guards but sits outside the 0031 index — the project is wedged until operator SQL. Flip the just-inserted row to `failed` and rethrow a friendly error.

**Files:**
- Modify: `apps/web/lib/jab/trigger-build-validation.ts` (add `"dispatch_failed"` to the `TriggerBuildError` code union)
- Modify: `apps/web/lib/jab/workspace-edit-validation.ts` (add `"dispatch_failed"` to the `WorkspaceEditError` code union)
- Modify: `apps/web/lib/actions/trigger-build.ts`
- Modify: `apps/web/lib/actions/workspace-edit.ts`

- [ ] **Step 1: Extend both error-code unions.** In `workspace-edit-validation.ts`, the `WorkspaceEditError` code union (shown at lines 11-19) gains `| "dispatch_failed"`. In `trigger-build-validation.ts`, locate the `TriggerBuildError` code union the same way and add `| "dispatch_failed"`.

- [ ] **Step 2: Wrap trigger-build's send.** In `trigger-build.ts`, replace the bare `await inngest.send({ name: "site/discover.requested", ... });` with:

```typescript
  try {
    await inngest.send({
      name: "site/discover.requested",
      data: {
        projectId: input.projectId,
        tenantId: (project as ProjectGateRow).tenant_id,
        buildId: inserted.id,
      },
    });
  } catch (err) {
    // Inngest unreachable: without this cleanup the row sticks at 'queued'
    // forever — 'queued' is active for both concurrency guards but OUTSIDE
    // the 0031 partial index, so nothing ever clears it (2026-06-09 review,
    // high #5; the 9 orphaned rows cleared on 2026-06-03 were this class).
    await admin
      .from("site_builds")
      .update({
        status: "failed",
        error_text: `build dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    throw new TriggerBuildError(
      "dispatch_failed",
      "The build couldn't be handed to the worker queue (is Inngest running?). The build was marked failed — retry when the queue is back.",
    );
  }
```

- [ ] **Step 3: Wrap workspace-edit's send.** In `workspace-edit.ts`, replace the bare `await inngest.send({ name: EDIT_REQUESTED_EVENT, data: payload });` with:

```typescript
  try {
    await inngest.send({ name: EDIT_REQUESTED_EVENT, data: payload });
  } catch (err) {
    // Same stranded-'queued' class as triggerBuildAction — here it's the
    // workspace_edits row that would stick at 'queued' and hold the
    // edit_in_review slot logic hostage.
    await guardAdmin
      .from("workspace_edits")
      .update({
        status: "failed",
        error_text: `edit dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);
    throw new WorkspaceEditError(
      "dispatch_failed",
      "The edit couldn't be handed to the worker queue (is Inngest running?). Retry when the queue is back.",
    );
  }
```

(`guardAdmin` is already in scope from the concurrency guard. The chat path needs nothing: `sendChatMessageAction` already catches `WorkspaceEditError` and converts it into an assistant reply, so `dispatch_failed` surfaces in the chat.)

- [ ] **Step 4: Verify** — `pnpm --filter @jab/web test` + `typecheck` green. No new unit test: both paths are DB+queue-coupled with no pure seam (repo convention: smoke coverage); the friendly-code plumbing is type-enforced by the union change.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/trigger-build-validation.ts apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/actions/trigger-build.ts apps/web/lib/actions/workspace-edit.ts
git commit -m "fix(saas): failed Inngest dispatch flips the just-inserted build/edit row to failed instead of stranding it at queued"
```

---

### Task 6: Stale-active-build auto-recovery

A crashed worker (`retries: 0`) leaves `site_builds` stuck in an active phase forever; the only documented recovery is operator SQL (migration 0031 comment), and the progress page polls every 5s indefinitely with no stuck signal. Add a pure staleness predicate, an auto-fail helper invoked from both entry guards, and a stuck notice on the progress page.

**Files:**
- Modify: `apps/web/lib/jab/build-status.ts`
- Create: `apps/web/lib/jab/build-status.test.ts` (first check: `Glob apps/web/lib/jab/build-status.test.ts` — if it already exists, append instead)
- Create: `apps/web/lib/db/auto-fail-stale-build.ts`
- Modify: `apps/web/lib/actions/trigger-build.ts`, `apps/web/lib/actions/workspace-edit.ts`
- Modify: `apps/web/app/(app)/projects/[id]/builds/[buildId]/progress/page.tsx`

- [ ] **Step 1: Write the failing tests** for the pure predicate:

```typescript
import { describe, it, expect } from "vitest";
import { isStaleActiveBuild, STALE_ACTIVE_BUILD_MS } from "./build-status";

describe("isStaleActiveBuild", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  const old = new Date(now - STALE_ACTIVE_BUILD_MS - 60_000).toISOString();
  const fresh = new Date(now - 60_000).toISOString();

  it("true for an active build older than the ceiling", () => {
    expect(isStaleActiveBuild("composing", old, now)).toBe(true);
    expect(isStaleActiveBuild("queued", old, now)).toBe(true);
  });

  it("false for a fresh active build", () => {
    expect(isStaleActiveBuild("composing", fresh, now)).toBe(false);
  });

  it("false for terminal statuses regardless of age", () => {
    expect(isStaleActiveBuild("ready", old, now)).toBe(false);
    expect(isStaleActiveBuild("failed", old, now)).toBe(false);
    expect(isStaleActiveBuild("cancelled", old, now)).toBe(false);
  });

  it("false for null/garbage inputs", () => {
    expect(isStaleActiveBuild(null, old, now)).toBe(false);
    expect(isStaleActiveBuild("composing", null, now)).toBe(false);
    expect(isStaleActiveBuild("composing", "not-a-date", now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @jab/web test -- build-status` → FAIL (not exported).

- [ ] **Step 3: Implement the predicate** in `build-status.ts`:

```typescript
/**
 * Active builds older than this are presumed wedged (crashed worker under
 * retries:0, or a lost dispatch). The longest healthy Two Roads full build is
 * well under 30 minutes; 45 gives slow installs headroom. (2026-06-09 review.)
 */
export const STALE_ACTIVE_BUILD_MS = 45 * 60 * 1000;

export function isStaleActiveBuild(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!isActiveBuildStatus(status) || !createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > STALE_ACTIVE_BUILD_MS;
}
```

Run the test → PASS.

- [ ] **Step 4: Create `apps/web/lib/db/auto-fail-stale-build.ts`:**

```typescript
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  FAILED_PHASES,
  isStaleActiveBuild,
  type FailedPhase,
} from "@/lib/jab/build-status";

/**
 * If the project's LATEST build is active but stale (wedged worker / lost
 * dispatch), flip it to failed so the user can build/edit again without the
 * operator SQL documented on migration 0031. Compare-and-set on status so a
 * build that just progressed is never clobbered. The linked workspace_edit
 * (if any) needs no write — its UI state derives from the build status
 * (deriveEditUiState). Returns true when a row was auto-failed.
 */
export async function autoFailStaleActiveBuild(projectId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("site_builds")
    .select("id, status, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = (data ?? [])[0] as
    | { id: string; status: string; created_at: string }
    | undefined;
  if (!latest || !isStaleActiveBuild(latest.status, latest.created_at, Date.now())) {
    return false;
  }
  const failedPhase = (FAILED_PHASES as readonly string[]).includes(latest.status)
    ? (latest.status as FailedPhase)
    : null;
  const { error } = await admin
    .from("site_builds")
    .update({
      status: "failed",
      failed_phase: failedPhase,
      error_text: `auto-failed: stuck in '${latest.status}' for over 45 minutes (wedged worker or lost dispatch)`,
      finished_at: new Date().toISOString(),
    })
    .eq("id", latest.id)
    .eq("status", latest.status);
  if (error) {
    console.error(`[auto-fail-stale-build] update failed for ${latest.id}: ${error.message}`);
    return false;
  }
  return true;
}
```

- [ ] **Step 5: Call it from both entry guards.** In `trigger-build.ts`, immediately before the latest-build concurrency lookup (`const { data: latestBuilds, ... }`), add:

```typescript
  // Self-heal a wedged active build before the guard refuses on it.
  await autoFailStaleActiveBuild(input.projectId);
```

with import `import { autoFailStaleActiveBuild } from "@/lib/db/auto-fail-stale-build";`. In `workspace-edit.ts`, add the same call immediately before the `const [{ data: latestBuilds }, { data: openEdits }] = await Promise.all([...])` concurrency block, same import.

- [ ] **Step 6: Progress-page stuck notice.** In `progress/page.tsx`, the page already loads the build row and computes `terminal`. Under the meta-refresh block, add (reusing the row variable the page already has — adapt the variable name to the file, it renders `failed_phase`/`error_text` from the same row):

```tsx
      {!terminal && isStaleActiveBuild(build.status, build.created_at, Date.now()) && (
        <div className="mx-8 mt-4 rounded-md border border-bord bg-elev px-4 py-3 text-[13px] text-gry">
          This build appears stuck (no progress for 45+ minutes). Starting a new
          build or edit from the project page will automatically clear it.
        </div>
      )}
```

with import `import { isStaleActiveBuild } from "@/lib/jab/build-status";`. Confirm the page's build select includes `created_at` (add it to the select if missing).

- [ ] **Step 7: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green.

```bash
git add apps/web/lib/jab/build-status.ts apps/web/lib/jab/build-status.test.ts apps/web/lib/db/auto-fail-stale-build.ts apps/web/lib/actions/trigger-build.ts apps/web/lib/actions/workspace-edit.ts "apps/web/app/(app)/projects/[id]/builds/[buildId]/progress/page.tsx"
git commit -m "feat(saas): auto-fail stale active builds at the entry guards + stuck notice on progress - no more operator SQL for wedged builds"
```

---

### Task 7: Cancellation conditioning on every status-advancing UPDATE (+ deploy on-failure shape)

`discardEditAction` sets the result build `cancelled` at any time, but only verify-fidelity's writes carry `.neq("status","cancelled")`. A discard mid-compose gets overwritten to `building`, deploys, and re-occupies the one-active-build slot. Apply verify-fidelity's precedent everywhere a status advances, treat 0-rows-updated as "cancelled — stop", guard `markBuildFailed` the same way, and fix deploy's on-failure to write `error_text` + `finished_at`.

**Files:**
- Modify: `apps/web/lib/inngest/shared-failure.ts`
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (mark-composing-phase ~171, mark-built ~674)
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts` (on-success ~207, on-failure ~288)
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` (mark-components-phase ~78, update-counts ~307)

The shared pattern (status-advance with cancel guard + advancement check):

```typescript
      const advanced = await step.run("<step-name>", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .update({ /* unchanged update payload */ })
          .eq("id", buildId)
          .eq("project_id", projectId)
          .neq("status", "cancelled")
          .select("id");
        if (error) throw new Error(`<step-name> failed: ${error.message}`);
        return (data ?? []).length > 0;
      });
      if (!advanced) {
        console.log(`[<worker>] build ${buildId} was cancelled — stopping.`);
        return { buildId, cancelled: true };
      }
```

- [ ] **Step 1: `markBuildFailed` never overwrites a user cancel.** In `shared-failure.ts`, add `.neq("status", "cancelled")` to the update chain (after the `.eq("project_id", ...)`) with the comment `// A user discard (status='cancelled') must not be relabeled as a system failure.`

- [ ] **Step 2: compose-site.** Convert `mark-composing-phase` and `mark-built` to the shared pattern. For `mark-composing-phase`, the early return is `return { buildId, cancelled: true };` (matching the existing entry-guard return shape). For `mark-built`, the `if (!advanced)` return must run BEFORE `step.sendEvent("dispatch-deploy", ...)` so a build cancelled mid-compose never dispatches deploy. Additionally, `mark-composing-phase` is an edit build's queued→active boundary against the 0031 index — give its error branch a friendly 23505 message:

```typescript
        if (error) {
          if (isUniqueViolation(error)) {
            throw new Error(
              "another build was already active for this project — this build lost the start race and was marked failed",
            );
          }
          throw new Error(`mark-composing-phase failed: ${error.message}`);
        }
```

with `import { isUniqueViolation } from "@/lib/db/pg-error";`.

- [ ] **Step 3: deploy-site.** Convert `on-success` to the pattern; its `if (!advanced)` return runs BEFORE `record-preview-deployment` and `dispatch-verify` (return `{ buildId, cancelled: true, outcome: "cancelled" }` — match the function's return-shape union; if TS complains, widen the declared return type accordingly). Then fix `on-failure`: add `.neq("status", "cancelled")` to its site_builds update, and extend the payload —

```typescript
      const outcomeDetail =
        pollResult.outcome === "TIMEOUT" ? ` (lastReadyState=${pollResult.lastReadyState})` : "";
      const { error } = await supabase
        .from("site_builds")
        .update({
          status: "failed",
          failed_phase: "building",
          error_text: `deploy ${pollResult.outcome}${outcomeDetail} — see build log`,
          finished_at: new Date().toISOString(),
          vercel_deployment_id: deployment.id,
          build_log_storage_path: lastError ? null : buildLogPath,
        })
```

(declare `outcomeDetail` before the `.update(...)` so TS narrows the TIMEOUT variant correctly).

- [ ] **Step 4: generate-components.** Convert `mark-components-phase` (early return before any LLM spend) and `update-counts` to the pattern; if `update-counts` reports `!advanced`, skip the worker's subsequent compose-dispatch `sendEvent` (locate it directly after update-counts) and return `{ buildId, cancelled: true }`.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green (these steps have no unit harness — the cancel behavior is exercised by the runbook's discard flow in T21).

```bash
git add apps/web/lib/inngest/shared-failure.ts apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/inngest/functions/deploy-site.ts apps/web/lib/inngest/functions/generate-components.ts
git commit -m "fix(saas): status advances are cancel-guarded (.neq cancelled + zero-rows=stop) so discard mid-pipeline sticks; deploy on-failure writes error_text/finished_at"
```

---

### Task 8: Workspace derives from the latest READY build (+ derived edit chip)

`sourceBuildId` and the preview pane key off the SINGLE latest build being `ready`, so any failed/discarded edit build locks chat + edits + preview until a full rebuild. Derive from the latest *ready* build, fall back the preview to the last good one, and render the edit-history chip from `deriveEditUiState` instead of raw `workspace_edits.status`.

**Files:**
- Modify: `apps/web/lib/jab/load-project-builds.ts`
- Modify: `apps/web/lib/jab/workspace-preview-state.ts` + `apps/web/lib/jab/workspace-preview-state.test.ts`
- Modify: `apps/web/app/(app)/projects/[id]/workspace/page.tsx`

- [ ] **Step 1: Extend `ProjectBuildState`.** In `load-project-builds.ts`:
  - Add to the interface: `latestReadyBuild: BuildSummary | null;` and `latestReadyPreview: DeploymentSummary | null;`
  - Add a third query to the existing `Promise.all` (same select string as the latest-build query, plus `.eq("status", "ready")`):

```typescript
    supabase
      .from("site_builds")
      .select(
        "id, status, failed_phase, preview_url, page_count, block_type_count, component_count, fidelity_avg, created_at, finished_at",
      )
      .eq("project_id", projectId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1),
```

  - Normalize it through the existing `toBuildSummary` exactly like `latestBuild`, compute:

```typescript
  const latestReadyPreview = latestReadyBuildSummary
    ? history.find(
        (d) =>
          d.siteBuildId === latestReadyBuildSummary.id &&
          d.environment === "preview" &&
          d.status === "ready",
      ) ?? null
    : null;
```

  - Return both new fields.

- [ ] **Step 2: Write the failing preview-state tests** — append to `workspace-preview-state.test.ts` (and add `latestReadyBuild: null, latestReadyPreview: null` to every existing fixture so the suite typechecks):

```typescript
  it("FALLBACK: a cancelled latest build with a prior ready preview shows that preview", () => {
    const s = baseState({
      latestBuild: build({ id: "b2", status: "cancelled" }),
      latestPreview: null,
      latestReadyBuild: build({ id: "b1", status: "ready" }),
      latestReadyPreview: deployment({ id: "d1", siteBuildId: "b1", url: "https://prior.example" }),
    });
    expect(deriveWorkspacePreviewState(s)).toEqual({
      kind: "ready",
      url: "https://prior.example",
      buildId: "b1",
      deploymentId: "d1",
    });
  });

  it("FALLBACK: a failed latest build with a prior ready preview shows that preview (failure surfaces on the edit chip, not a blank pane)", () => {
    const s = baseState({
      latestBuild: build({ id: "b2", status: "failed" }),
      latestPreview: null,
      latestReadyBuild: build({ id: "b1", status: "ready" }),
      latestReadyPreview: deployment({ id: "d1", siteBuildId: "b1", url: "https://prior.example" }),
    });
    expect(deriveWorkspacePreviewState(s).kind).toBe("ready");
  });

  it("a failed latest build with NO prior ready build still reports failed", () => {
    const s = baseState({
      latestBuild: build({ id: "b1", status: "failed", failedPhase: "composing" }),
      latestReadyBuild: null,
      latestReadyPreview: null,
    });
    expect(deriveWorkspacePreviewState(s)).toEqual({
      kind: "failed",
      buildId: "b1",
      failedPhase: "composing",
    });
  });
```

(Reuse the test file's existing `baseState`/`build`/`deployment` fixture helpers; if they're named differently, match the file's local helpers.)

- [ ] **Step 3: Run to verify failure**, then implement in `workspace-preview-state.ts` — replace the `failed` branch and the final fallthrough:

```typescript
  // Prior-good-state fallback: the latest build is terminal-non-ready
  // (failed/cancelled edit), but an earlier ready build still has a working
  // preview. Discarding an edit must return the user to that state instead
  // of locking the workspace empty (2026-06-09 review, high #7).
  const priorGood =
    s.latestReadyBuild && s.latestReadyPreview && s.latestReadyPreview.url
      ? {
          kind: "ready" as const,
          url: s.latestReadyPreview.url,
          buildId: s.latestReadyBuild.id,
          deploymentId: s.latestReadyPreview.id,
        }
      : null;

  if (build.status === "failed") {
    if (priorGood) return priorGood;
    return {
      kind: "failed",
      buildId: build.id,
      failedPhase: build.failedPhase ?? "failed",
    };
  }

  // cancelled / anything else with nothing viewable.
  return priorGood ?? { kind: "none" };
```

Run: `pnpm --filter @jab/web test -- workspace-preview-state` → all pass (existing RACE/STALE tests must stay green untouched).

- [ ] **Step 4: Re-key the workspace page.** In `workspace/page.tsx`:
  - `const sourceBuildId = buildState.latestReadyBuild?.id ?? null;` (replaces the `latestBuild?.status === "ready"` derivation).
  - Replace `<EditStatusChip status={edit.status} />` with a derived label:

```tsx
                <EditStatusChip
                  label={
                    deriveEditUiState({
                      editStatus: edit.status,
                      buildStatus: edit.resultBuildStatus,
                      promoted: edit.promoted,
                    }).label
                  }
                />
```

  importing `deriveEditUiState, type EditUiLabel` from `@/lib/jab/workspace-edit-state` (`loadWorkspaceEditHistory` already returns `resultBuildStatus` + `promoted`). Update the local `EditStatusChip` component to take `{ label: EditUiLabel }` and key its tone classes on the label values (`"Live" | "Review ready"` → teal, `"Failed"` → red, `"Discarded" | "Submitting…" | "Building…"` → muted), preserving its existing chip classes.
  - Check the page's `canReview` / `canDiscard` derivations: if they key on raw `edit.status`, re-derive via `deriveEditUiState(...).awaitingReview` (review allowed when `awaitingReview`; discard allowed when `awaitingReview` or label is `"Building…"`/`"Submitting…"`).

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green.

```bash
git add apps/web/lib/jab/load-project-builds.ts apps/web/lib/jab/workspace-preview-state.ts apps/web/lib/jab/workspace-preview-state.test.ts "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "fix(saas): workspace keys chat/edits/preview off the latest READY build - a failed or discarded edit no longer locks the edit surface"
```

# Phase 4 — Guardrails & correctness

### Task 9: Server-side `JAB_CHAT_EDIT` gate, input length caps, budget-guard reorder

The flag only hides the UI — `sendChatMessageAction` (Anthropic spend + dispatch) is invokable with the flag off; chat content and edit prompts have no length cap; and `assertEditBudget` burns service-role queries on caller-supplied projectIds before the tenant check.

**Files:**
- Modify: `apps/web/lib/jab/workspace-edit-validation.ts`
- Create: `apps/web/lib/jab/workspace-edit-validation.test.ts`
- Modify: `apps/web/lib/ai/edit-cost-guard.ts`
- Modify: `apps/web/lib/actions/workspace-chat.ts`
- Modify: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx`

- [ ] **Step 1: Write the failing validation tests** — create `apps/web/lib/jab/workspace-edit-validation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  validateEditInput,
  WorkspaceEditError,
  MAX_PROMPT_CHARS,
} from "./workspace-edit-validation";

describe("validateEditInput — prompt length cap", () => {
  const base = { scope: "component" as const, target: "core/cover" };

  it("accepts a prompt at the cap", () => {
    expect(() =>
      validateEditInput({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS) }),
    ).not.toThrow();
  });

  it("rejects a prompt over the cap with prompt_too_long", () => {
    try {
      validateEditInput({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS + 1) });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("prompt_too_long");
    }
  });
});
```

Run: `pnpm --filter @jab/web test -- workspace-edit-validation` → FAIL (`MAX_PROMPT_CHARS` not exported).

- [ ] **Step 2: Implement the cap.** In `workspace-edit-validation.ts`: add `| "prompt_too_long"` to the `WorkspaceEditError` code union; add `export const MAX_PROMPT_CHARS = 4000;` above `validateEditInput`; append inside `validateEditInput` (after the existing prompt checks):

```typescript
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    throw new WorkspaceEditError(
      "prompt_too_long",
      `Prompt is too long (${input.prompt.length} chars; max ${MAX_PROMPT_CHARS}). Unbounded input flows into DB rows and the planner LLM.`,
    );
  }
```

Run the test → PASS.

- [ ] **Step 3: Gate + cap + reorder the chat action.** In `edit-cost-guard.ts` add alongside the other consts: `export const MAX_CHAT_CONTENT_CHARS = 4000;`. In `workspace-chat.ts`, replace the top of `sendChatMessageAction` (everything up to and including the current budget-guard try/catch and `resolveProject` call) with:

```typescript
  // Server-side flag gate — the UI gate alone left the action (Anthropic
  // spend + edit dispatch) callable with the flag off (2026-06-09 review).
  if (process.env.JAB_CHAT_EDIT !== "1") {
    throw new Error("Chat edits are disabled on this deployment (JAB_CHAT_EDIT).");
  }
  const content = args.content.trim();
  if (!content) throw new Error("Message is empty.");
  if (content.length > MAX_CHAT_CONTENT_CHARS) {
    throw new Error(
      `Message is too long (${content.length} chars; max ${MAX_CHAT_CONTENT_CHARS}).`,
    );
  }

  // 1. RLS membership SELECT FIRST — the budget guard runs service-role
  // queries and must not be reachable for arbitrary project ids.
  const { tenantId, userId } = await resolveProject(args.projectId);
  const admin = createAdminClient();

  // 2. Budget guard (admin reads now happen only after proven membership).
  try {
    await assertEditBudget({ projectId: args.projectId });
  } catch (err) {
    if (err instanceof EditBudgetError) {
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: err.message,
        needsClarification: true,
      });
    }
    throw err;
  }
```

and use the trimmed `content` variable for the user-message insert (`content,` instead of `content: args.content,`). Import `MAX_CHAT_CONTENT_CHARS` from `@/lib/ai/edit-cost-guard` (the file already imports from it).

- [ ] **Step 4: UI cap.** In `ChatPanel.tsx`, add `maxLength={4000}` to the chat `<input>`.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green. (Any chat-turn test that calls `sendChatMessageAction` directly now needs `process.env.JAB_CHAT_EDIT = "1"` in its setup — vitest: `vi.stubEnv("JAB_CHAT_EDIT", "1")`.)

```bash
git add apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/jab/workspace-edit-validation.test.ts apps/web/lib/ai/edit-cost-guard.ts apps/web/lib/actions/workspace-chat.ts "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx"
git commit -m "fix(saas): JAB_CHAT_EDIT enforced server-side, chat/edit input length caps, budget guard runs after the tenant check"
```

---

### Task 10: Migration 0032 — one thread per project + hot-path/FK indexes; `ensureConversation` race fix

`ensureConversation`'s check-then-insert races under concurrent sends, splitting history across threads (`loadConversation` only reads the latest — earlier turns vanish from the planner's context). `assertEditBudget` seq-scans `chat_messages` by `(project_id, created_at)` on every turn; the 0029/0030 FK columns are unindexed (every `ON DELETE SET NULL` sweep is a full scan). The user-message insert ignores its error.

**Files:**
- Create: `apps/web/drizzle/migrations/0032_chat_indexes_and_one_thread.sql`
- Modify: `apps/web/lib/db/schema.ts`
- Modify: `apps/web/lib/actions/workspace-chat.ts`

- [ ] **Step 1: Write the migration** — `apps/web/drizzle/migrations/0032_chat_indexes_and_one_thread.sql`:

```sql
-- 0032_chat_indexes_and_one_thread.sql — 2026-06-09 senior-review fix campaign.
--
-- (a) v1's "one chat thread per project" (0029 comment) becomes DB-enforced:
--     ensureConversation's check-then-insert raced under concurrent sends and
--     split history across threads (loadConversation only reads the latest
--     thread, so earlier turns silently vanish from the UI and the planner).
--     Dedupe first: keep the OLDEST conversation per project (stable thread),
--     repoint chat_messages, then delete the extras.
-- (b) hot-path + FK indexes: assertEditBudget scans chat_messages by
--     (project_id, created_at) on EVERY chat turn; edit_id / build_id /
--     message_id / result_promoted_deployment_id are FK columns whose
--     ON DELETE SET NULL sweeps were full-table scans.

-- 1. Repoint every message to its project's oldest conversation.
UPDATE public.chat_messages m
SET conversation_id = keeper.id
FROM public.conversations cur,
     LATERAL (
       SELECT id FROM public.conversations
       WHERE project_id = cur.project_id
       ORDER BY created_at ASC
       LIMIT 1
     ) keeper
WHERE m.conversation_id = cur.id
  AND cur.id <> keeper.id;

-- 2. Delete the now-empty duplicate threads (cascade is safe: messages moved).
DELETE FROM public.conversations c
WHERE c.id NOT IN (
  SELECT DISTINCT ON (project_id) id
  FROM public.conversations
  ORDER BY project_id, created_at ASC
);

-- 3. Enforce one thread per project.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_per_project_idx
  ON public.conversations (project_id);
COMMENT ON INDEX public.conversations_one_per_project_idx IS
  'v1: one chat thread per project (e2e-loop §2.7). ensureConversation inserts against this and re-selects on 23505.';

-- 4. Hot-path + FK indexes.
CREATE INDEX IF NOT EXISTS chat_messages_project_created_idx
  ON public.chat_messages (project_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_edit_id_idx ON public.chat_messages (edit_id);
CREATE INDEX IF NOT EXISTS chat_messages_build_id_idx ON public.chat_messages (build_id);
CREATE INDEX IF NOT EXISTS workspace_edits_message_id_idx ON public.workspace_edits (message_id);
CREATE INDEX IF NOT EXISTS workspace_edits_result_promoted_deployment_id_idx
  ON public.workspace_edits (result_promoted_deployment_id);
```

- [ ] **Step 2: Mirror in `schema.ts`.** In the `conversations` table's index callback add `onePerProjectIdx: uniqueIndex("conversations_one_per_project_idx").on(t.projectId),` (`uniqueIndex` is already imported for site_builds). In `chat_messages` add `projectCreatedIdx: index("chat_messages_project_created_idx").on(t.projectId, t.createdAt), editIdx: index("chat_messages_edit_id_idx").on(t.editId), buildIdx: index("chat_messages_build_id_idx").on(t.buildId),`. In `workspace_edits` add `messageIdx: index("workspace_edits_message_id_idx").on(t.messageId), promotedDeploymentIdx: index("workspace_edits_result_promoted_deployment_id_idx").on(t.resultPromotedDeploymentId),`.

- [ ] **Step 3: Apply to BOTH Supabase projects** (the two-project rule — see `two-supabase-projects-local-prod` memory): via `mcp__supabase__apply_migration`, name `0032_chat_indexes_and_one_thread`, first to **local/dev "JAB WP"** (`ajfurojjxthhzkjqttri`), then to **prod "jab-prod"** (`celzwcxkrmsbwiswkxug`). Verify on each with `mcp__supabase__execute_sql`: `SELECT indexname FROM pg_indexes WHERE indexname IN ('conversations_one_per_project_idx','chat_messages_project_created_idx');` → 2 rows.

- [ ] **Step 4: Race-proof `ensureConversation` + check the user insert.** In `workspace-chat.ts`, replace `ensureConversation`'s insert error handling:

```typescript
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("conversations")
    .insert({ project_id: projectId, tenant_id: tenantId, created_by_user_id: userId })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    if (isUniqueViolation(error)) {
      // Lost the race — the winner's row IS the thread (0032 unique index).
      const { data: winner } = await admin
        .from("conversations")
        .select("id")
        .eq("project_id", projectId)
        .maybeSingle<{ id: string }>();
      if (winner) return winner.id;
    }
    throw new Error(`ensureConversation failed: ${error.message}`);
  }
  if (!data) throw new Error("ensureConversation failed: no row");
  return data.id;
```

with `import { isUniqueViolation } from "@/lib/db/pg-error";`. Then make the user-message insert loud:

```typescript
  const { error: userMsgErr } = await admin.from("chat_messages").insert({
    conversation_id: conversationId,
    project_id: args.projectId,
    role: "user",
    content,
  });
  if (userMsgErr) {
    // A silently-dropped user turn corrupts durable history AND the planner's
    // context — fail the action instead.
    throw new Error(`chat: failed to persist user message: ${userMsgErr.message}`);
  }
```

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green.

```bash
git add apps/web/drizzle/migrations/0032_chat_indexes_and_one_thread.sql apps/web/lib/db/schema.ts apps/web/lib/actions/workspace-chat.ts
git commit -m "fix(saas): one chat thread per project enforced in DB (migration 0032 + race-safe ensureConversation), chat hot-path + FK indexes, loud user-message insert"
```

---

### Task 11: Friendly 23505 at discover's queued→active boundary; honest comments at the dead catches

The 0031 index can only raise on the queued→active UPDATE (entering the partial-index predicate) — discover-site for full builds (compose-site for edit builds was handled in T7). The losing build currently fails with raw `duplicate key value violates unique constraint…` in `error_text`. The insert-site catches in trigger-build/workspace-edit can never fire (inserts land as `queued`, outside the predicate) — keep them as belt-and-braces but say so.

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (mark-discovering, ~lines 127-135)
- Modify: `apps/web/lib/actions/trigger-build.ts`, `apps/web/lib/actions/workspace-edit.ts` (comments only)

- [ ] **Step 1: discover-site.** In `mark-discovering`, replace the error branch:

```typescript
        if (error) {
          if (isUniqueViolation(error)) {
            // Lost the 0031 one-active-build race at the queued→active
            // boundary — the raw constraint text was landing in error_text
            // on the progress UI (2026-06-09 review).
            throw new Error(
              "another build was already active for this project — this build lost the start race and was marked failed",
            );
          }
          throw new Error(`site_builds → discovering update failed: ${error.message}`);
        }
```

with `import { isUniqueViolation } from "@/lib/db/pg-error";`. The worker's existing catch → `markBuildFailed` then records the friendly text.

- [ ] **Step 2: Re-comment the dead catches.** In `trigger-build.ts`, above the insert's `isUniqueViolation` check, replace the misleading `// 23505 catch: translate unique violation to friendly error` with:

```typescript
    // Belt-and-braces only: inserts land as 'queued', which is OUTSIDE the
    // 0031 partial-index predicate, so this can't fire today. The real raise
    // site is the queued→active UPDATE in discover-site / compose-site.
```

Same replacement in `workspace-edit.ts` above its `isUniqueViolation` check (workspace_edits isn't even the indexed table).

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green.

```bash
git add apps/web/lib/inngest/functions/discover-site.ts apps/web/lib/actions/trigger-build.ts apps/web/lib/actions/workspace-edit.ts
git commit -m "fix(saas): friendly active-build error at the real 23505 raise site (mark-discovering); honest comments at the unreachable insert catches"
```

---

### Task 12: Manifest wrapper-key resolvers read the real camelCase key

`projects.manifest` is persisted from `@jab/core`'s `Manifest` (camelCase: `outputSchema`), but both refinement resolvers read `output_schema` — dead code masked by snake_case fixtures cast `as unknown as Manifest`. The BUG-2 collision-suffix refinement (e.g. wrapper key `beers_2`) silently never applies.

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts` (`resolveCptAbilityMeta`, ~line 705)
- Modify: `apps/web/lib/jab/ability-client.test.ts` (fixture ~lines 310-341)
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (`abilityMetaFor`, ~lines 129-149 + local `ManifestShape` type)

- [ ] **Step 1: Write the failing test** — in `ability-client.test.ts`, FIRST fix the fixture to the real persisted shape: rename `input_schema` → `inputSchema` and `output_schema` → `outputSchema` in the manifest fixture (drop the `as unknown as` cast if the shape now satisfies `Manifest`; keep `plugin_version`/`generated_at` extras out — use `schemaVersion: 1, source: "...", fetchedAt: "...", server: { namespace: "jab/v1", route: "/mcp" }` to satisfy the type). Then add:

```typescript
  it("refines the wrapper key from the manifest's camelCase outputSchema (BUG-2 collision suffix)", () => {
    const collisionManifest: Manifest = {
      schemaVersion: 1,
      source: "https://wp.example",
      fetchedAt: "2026-01-01T00:00:00Z",
      server: { namespace: "jab/v1", route: "/mcp" },
      abilities: [
        {
          name: "jab/get-beers",
          label: "Get Beers",
          description: "",
          inputSchema: {},
          outputSchema: { type: "object", required: ["beers_2"], properties: {} },
        },
      ],
    };
    const meta = resolveCptAbilityMeta(collisionManifest, { slug: "beer", rest_base: "beers" });
    expect(meta.listWrapperKey).toBe("beers_2"); // NOT the derived "beers"
  });
```

Run: `pnpm --filter @jab/web test -- ability-client` → the new test FAILS (lookup reads `output_schema`, returns null, falls back to the derivation `"beers"`).

- [ ] **Step 2: Implement the shared helper** — in `ability-client.ts`, add (exported, above `resolveCptAbilityMeta`):

```typescript
/**
 * First `required` key of an ability's output schema. The persisted manifest
 * (projects.manifest, written from @jab/core's Manifest) uses camelCase
 * `outputSchema`; tolerate legacy snake_case rows defensively. Null when the
 * ability/schema/required is absent — callers fall back to the derivation.
 */
export function abilityWrapperKeyFromSchema(ability: unknown): string | null {
  const a = ability as {
    outputSchema?: { required?: unknown };
    output_schema?: { required?: unknown };
  };
  const schema = a.outputSchema ?? a.output_schema;
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;
  const first = schema.required[0];
  return typeof first === "string" ? first : null;
}
```

In `resolveCptAbilityMeta`, replace the body of the local `lookup` with:

```typescript
  const lookup = (name: string): string | null => {
    const ability = manifest.abilities.find((a) => a.name === name);
    return ability ? abilityWrapperKeyFromSchema(ability) : null;
  };
```

- [ ] **Step 3: Fix compose-site's `abilityMetaFor`** — import `abilityWrapperKeyFromSchema` from `@/lib/jab/ability-client` and replace the `required`-reading lines:

```typescript
    const ability = abilities.find((a) => a.name === candidate);
    if (ability) {
      const wrapperKey =
        abilityWrapperKeyFromSchema(ability) ?? postType.replace(/-/g, "_");
      return { abilityName: candidate, wrapperKey };
    }
```

Update the local `ManifestShape` type so its ability entries declare `outputSchema?: { required?: unknown }` instead of `output_schema` (search the file for other `output_schema` reads and align them the same way — `abilityWrapperKeyFromSchema` tolerates both, but the type should state the truth).

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green (the fixture rename will surface any OTHER test relying on the wrong shape — fix those the same way; they were masking dead code).

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.test.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "fix(saas): wrapper-key refinement reads the persisted camelCase outputSchema - collision-suffix manifests resolve correctly; fixtures match reality"
```

---

### Task 13: MCP session-expiry recovery in the emitted SDK client + core `McpClient`

Deployed sites bind a module-scoped client; the emitted template caches the handshake forever, so when mcp-adapter expires the session (HTTP 404 per the MCP spec), every ISR render 500s until the lambda recycles. Same gap in core's `McpClient`. Recover: on 404 with a session in hand, reset + re-init + retry exactly once.

**Files:**
- Modify: `packages/core/src/emit/client.ts` (the `renderClientFile` template literal — the patch goes INSIDE the emitted string)
- Modify: `packages/core/src/mcp/client.ts` (`rpc`, ~lines 284-307)
- Modify: core tests (string assertions in the suite that exercises `emitSdk` — `packages/core/src/sdk.test.ts` pattern; plus a fetch-stub test for `McpClient`)

- [ ] **Step 1: Confirm the emitted filename key.** Run: `grep -n "client.ts" packages/core/src/sdk.ts` (or wherever `emitSdk` assembles its file map) — expected key `"client.ts"`. Use whatever key is real in the tests below.

- [ ] **Step 2: Write the failing emit tests** — append to `packages/core/src/sdk.test.ts`:

```typescript
describe("emitSdk — client.ts session-expiry recovery", () => {
  it("emits resetSession and a 404 retry path in callAbility", async () => {
    const files = await emitSdk(minimalManifest);
    const client = files.get("client.ts")!;
    expect(client).toContain("function resetSession()");
    expect(client).toContain("err.code === 404");
    // retry-once guard: the recovery block re-runs the call exactly once
    expect(client).toContain("await ensureInitialized();");
  });
});
```

Run: `pnpm --filter @jab/core test` → FAIL.

- [ ] **Step 3: Patch the template.** Inside `renderClientFile`'s template string:
  - After the `ensureInitialized` function definition, add (escaping per the template's existing conventions — `\`` for backticks, `\${}` for emitted interpolations):

```
  function resetSession(): void {
    initialized = false;
    initPromise = undefined;
    sessionId = null;
  }
```

  - Restructure `callAbility` so the rpc + envelope-unwrap lives in an inner closure, then wrap with the recovery:

```
    async callAbility<TInput extends object, TOutput>(
      abilityName: string,
      input?: TInput,
      requestOptions?: JabRequestOptions,
    ): Promise<TOutput> {
      const doCall = async (): Promise<TOutput> => {
        const result = await rpc<ToolCallResult<TOutput>>(
          "tools/call",
          {
            name: "mcp-adapter-execute-ability",
            arguments: {
              ability_name: abilityName,
              parameters: input ?? {},
            },
          },
          requestOptions,
        );
        /* ...existing isError / structuredContent / success unwrap, unchanged... */
        return wrapped.data;
      };
      await ensureInitialized();
      try {
        return await doCall();
      } catch (err) {
        // mcp-adapter invalidated the session (HTTP 404 per the MCP spec's
        // session management). Module-scoped singletons (lib/sdk via proxy)
        // otherwise stay broken until the serverless instance recycles —
        // re-initialize once and retry.
        if (err instanceof JabClientError && err.code === 404) {
          resetSession();
          await ensureInitialized();
          return await doCall();
        }
        throw err;
      }
    },
```

(The existing unwrap block moves verbatim into `doCall`; `rpc` already throws `JabClientError` with `code = response.status` on HTTP errors, so 404 is detectable.)

- [ ] **Step 4: Patch core `McpClient.rpc`** — in `packages/core/src/mcp/client.ts`, change the signature to `private async rpc<T>(method: string, params: Record<string, unknown> = {}, retriedAfterSessionLoss = false): Promise<T>` and replace the `if (!response.ok)` block:

```typescript
    if (!response.ok) {
      if (response.status === 404 && this.sessionId && !retriedAfterSessionLoss) {
        // Session expired server-side (MCP spec: 404 on unknown Mcp-Session-Id).
        // Re-initialize once and retry; a second 404 falls through to the throw.
        this.initialized = false;
        this.sessionId = null;
        await this.ensureInitialized();
        return this.rpc<T>(method, params, true);
      }
      const text = await safeReadText(response);
      throw new McpClientError(
        `HTTP ${response.status} from ${this.endpoint}${text ? `: ${text}` : ""}`,
        undefined,
        response.status,
      );
    }
```

- [ ] **Step 5: Behavioral test for `McpClient`** — add a test (new `packages/core/src/mcp/client.test.ts` or alongside existing core tests; mirror the constructor options from `mcp/client.ts` itself) using `vi.stubGlobal("fetch", ...)` with a scripted response sequence: initialize OK (with `mcp-session-id` header) → notifications 202 → tools/call **404** → initialize OK (new session id) → notifications 202 → tools/call OK. Assert the call resolves and fetch was hit 6 times. If the existing core tests already stub HTTP another way, follow that pattern instead.

- [ ] **Step 6: Verify + commit + note the regen requirement**

Run: `pnpm --filter @jab/core test` + `pnpm --filter @jab/core typecheck` → green. Then `pnpm --filter @jab/web test` (compose-site emits via `emitSdk` — its pinned-output tests may assert template content; update any that diff the old callAbility body).

```bash
git add packages/core/src/emit/client.ts packages/core/src/mcp/client.ts packages/core/src/sdk.test.ts packages/core/src/mcp/client.test.ts
git commit -m "fix(core): emitted SDK client + McpClient recover from MCP session expiry (404 -> re-init -> retry once) instead of 500ing until restart"
```

**Doc note (same commit or amend):** deployed/pilot sites pick this up only on their next build/regen — the next Phase B+C rebuild redeploys with the fixed template. Add one line to the runbook prereqs: "Builds deployed before 2026-06-09 predate the session-recovery client; rebuild before judging live-site stability."

---

### Task 14: Middleware exempts `/api/cron` (self-authenticated)

Vercel Cron calls `/api/cron/prune` with `Authorization: Bearer <CRON_SECRET>` and no session cookie — the middleware redirects it to `/sign-in`, so the scheduled prune can never run. The route already fails closed on its own secret.

**Files:**
- Modify: `apps/web/middleware.ts`

- [ ] **Step 1: Add the route** to `PUBLIC_ROUTES`:

```typescript
const PUBLIC_ROUTES = [
  "/",
  "/sign-in",
  "/sign-up",
  "/pricing",
  "/auth/callback",
  "/api/inngest",
  // Self-authenticated by CRON_SECRET (Bearer); Vercel Cron has no session —
  // the route 503s when the secret is unset and 401s on a bad token.
  "/api/cron",
];
```

- [ ] **Step 2: Verify + commit** — `pnpm --filter @jab/web typecheck` green; manual probe in T21 (`curl -H "Authorization: Bearer wrong" http://localhost:3000/api/cron/prune` → 401, not a redirect).

```bash
git add apps/web/middleware.ts
git commit -m "fix(saas): /api/cron exempt from session middleware - Vercel Cron can reach the self-authenticated prune route"
```

# Phase 5 — Hygiene & docs

### Task 15: Track the load-bearing untracked artifacts; gitignore the debris

The e2e milestone's definition-of-done (the smoke runbook) and the operator-recovery scripts exist only on this machine; `.jab-fix*`/`.jab-inspect`/`.vite`/`_scratch` pollute `git status`.

**Files:**
- Modify: `.gitignore` (repo root)
- Track: `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md`, `docs/superpowers/plans/2026-06-03-saas-app-code-review-fixes.md`, this plan, `apps/web/scripts/jab-check-artifacts.ts`, `apps/web/scripts/jab-fix-build.ts`, `apps/web/scripts/jab-sniff-logo.ts`

- [ ] **Step 1: Secret scan the scripts before tracking.** Run: `grep -niE "sk-ant|service_role|eyJhbGci|password\s*=" apps/web/scripts/jab-check-artifacts.ts apps/web/scripts/jab-fix-build.ts apps/web/scripts/jab-sniff-logo.ts` — expected: no hardcoded secrets (they parse `.env.local` at runtime). If anything real shows up, parameterize it via env before committing.

- [ ] **Step 2: Append to the root `.gitignore`** (after the "Editor / OS noise" block):

```
# Local debugging workspaces + Vite cache (jab-fix-build.ts et al. write here)
.vite/
apps/web/.jab-fix/
apps/web/.jab-fix-src/
apps/web/.jab-inspect/
apps/web/scripts/_scratch/

# Claude Code local session settings (project skills/settings, if added later,
# get un-ignored deliberately)
.claude/settings.local.json
```

- [ ] **Step 3: Decide `.claude/` residue.** Run `git status --short .claude/` — if only `settings.local.json` remains visible it's now ignored; anything else (project skills, shared settings) gets an explicit add-or-ignore decision, stated in the commit message.

- [ ] **Step 4: Track and commit**

```bash
git add .gitignore "docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md" "docs/superpowers/plans/2026-06-03-saas-app-code-review-fixes.md" "docs/superpowers/plans/2026-06-09-senior-review-fix-campaign.md" apps/web/scripts/jab-check-artifacts.ts apps/web/scripts/jab-fix-build.ts apps/web/scripts/jab-sniff-logo.ts
git commit -m "chore: track the e2e smoke runbook + operator-recovery scripts; gitignore local debug workspaces"
```

---

### Task 16: `.env.local.example` documents Vercel creds + every `JAB_*` flag

The deploy worker hard-requires Vercel env that no example documents, and the three headline flags appear nowhere outside source comments.

**Files:**
- Modify: `apps/web/.env.local.example`
- Modify: `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md` (prereqs)

- [ ] **Step 1: Confirm the exact var names.** Run: `grep -n "process.env.VERCEL" apps/web/lib/vercel/load-client.ts` — expected `VERCEL_TOKEN` and `VERCEL_TEAM_ID`; use whatever the file actually reads.

- [ ] **Step 2: Append to `.env.local.example`** (after the Inngest block):

```
# Vercel deploy credentials — REQUIRED for Phase D (deploy-site worker) and
# publish/promote. Token: vercel.com → Settings → Tokens. Team id: the team
# the per-project Vercel projects are created under (Settings → General).
# VERCEL_TOKEN=
# VERCEL_TEAM_ID=

# ── Feature flags (all default to the safe path when unset) ─────────────────
# Chat-edit loop (workspace chat panel + sendChatMessageAction; enforced
# server-side as of 2026-06-09). Off unless exactly "1".
# JAB_CHAT_EDIT=1
# Incremental skip-unchanged carry-forward in discovery. Off unless "1".
# JAB_INCREMENTAL_SKIP=1
# Compose compile gate (tsc --noEmit before deploy dispatch). ON by default;
# set to 0 to skip for local dev speed. Production: leave unset.
# JAB_COMPOSE_TYPECHECK=0
# Reuse the prior build's compiled shells (header/footer). Off unless "1".
# JAB_SKIP_SHELL_REGEN=1
```

- [ ] **Step 3: Make the runbook prereqs explicit.** In the runbook's §0, replace "and the Vercel token/team env the deploy worker reads" with "`VERCEL_TOKEN`, `VERCEL_TEAM_ID`".

- [ ] **Step 4: Commit**

```bash
git add apps/web/.env.local.example "docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md"
git commit -m "docs(saas): .env.local.example documents Vercel creds + all JAB_* flags; runbook prereqs name the exact vars"
```

---

### Task 17: Delete dead code (`triggerDiscovery`, `createConversationAction`)

`triggerDiscovery` has zero callers and reintroduces the exact wedged-build class 0031 guards against if resurrected (no config.mode, no active-build guard, no 23505 handling). `createConversationAction` has zero external callers. **Do NOT delete `loadWorkspacePreviewStateAction`** — it has a live caller (`apps/web/components/workspace-preview-pane.tsx:76`); the review's dead-code list was wrong about that one.

**Files:**
- Delete: `apps/web/lib/actions/trigger-discovery.ts`
- Modify: `apps/web/lib/actions/workspace-chat.ts` (remove `createConversationAction`, ~lines 74-84)
- Modify: `apps/web/scripts/smoke-discover-site.ts` (comment references `triggerDiscovery`)

- [ ] **Step 1: Confirm zero callers (fresh, at execution time):**

Run: `grep -rn "triggerDiscovery\|createConversationAction" apps/web --include="*.ts" --include="*.tsx"`
Expected: only the definitions, the smoke-script comment, and any test of the deleted symbol. If a caller appeared since the review, stop and reassess.

- [ ] **Step 2: Delete** `trigger-discovery.ts`, remove the `createConversationAction` export from `workspace-chat.ts`, and update the `smoke-discover-site.ts` comment to point at `triggerBuildAction` as the canonical entry point.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green.

```bash
git add -A apps/web/lib/actions/trigger-discovery.ts apps/web/lib/actions/workspace-chat.ts apps/web/scripts/smoke-discover-site.ts
git commit -m "chore(saas): delete dead triggerDiscovery (wedged-build foot-gun) and uncalled createConversationAction"
```

---

### Task 18: Deduplicate semver — apps/web imports `@jab/core`

`apps/web/lib/jab/semver.ts` duplicates `@jab/core/src/semver.ts` with drift (the app parser tolerates `"1.2"` → `[1,2,0]`; core's returns null → sorts lowest). Core is canonical (per the `semver-duplicated-core-vs-app` memory and core's own line-45 comment). The only app import site is `probe.ts`, comparing full `x.y.z` plugin versions — the drift is immaterial there.

**Files:**
- Modify: `apps/web/lib/jab/probe.ts` (line 3)
- Delete: `apps/web/lib/jab/semver.ts`, `apps/web/lib/jab/semver.test.ts`

- [ ] **Step 1: Re-point the import.** In `probe.ts`: `import { gteSemver } from "@jab/core";` (replaces `from "./semver"`). Confirm no other importers: `grep -rn "jab/semver\|from \"./semver\"" apps/web --include="*.ts"` → only probe.ts.

- [ ] **Step 2: Delete** `apps/web/lib/jab/semver.ts` and `apps/web/lib/jab/semver.test.ts`. Also update core's `index.ts` line-45 comment (it documents the duplication: "apps/web ships its own lib/jab/semver.ts") to say the app now imports from core.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @jab/web test` + `typecheck` → green (vitest resolves `@jab/core` the same way compose-site's existing imports do).

```bash
git add -A apps/web/lib/jab/semver.ts apps/web/lib/jab/semver.test.ts apps/web/lib/jab/probe.ts packages/core/src/index.ts
git commit -m "refactor(saas): drop apps/web semver duplicate - probe.ts uses canonical @jab/core semver"
```

---

### Task 19: CLI test bootstrap — kill the silent `pnpm --filter` no-op

`packages/cli` has no `test` script, so `pnpm --filter @jab/wp-headless-cli test` exits 0 having run nothing — a CI false-green trap.

**Files:**
- Modify: `packages/cli/package.json`
- Create: `packages/cli/src/util/credentials.test.ts`

- [ ] **Step 1: Mirror core's vitest wiring.** Inspect `packages/core/package.json` devDependencies + any `vitest.config.*` in core; replicate the same in `packages/cli` (add `"test": "vitest run"` to scripts and vitest to devDependencies the same way core declares it; copy core's vitest config if it has one). Run `pnpm install`.

- [ ] **Step 2: Write the first test** — `packages/cli/src/util/credentials.test.ts` (match the package's ESM import style — core uses `./x.js` specifiers):

```typescript
import { describe, it, expect } from "vitest";
import { ensureValue } from "./credentials.js";

describe("ensureValue", () => {
  it("returns the trimmed value when provided", async () => {
    await expect(ensureValue("  secret  ", "password")).resolves.toBe("secret");
  });

  it("returns an already-clean value untouched", async () => {
    await expect(ensureValue("abc", "user")).resolves.toBe("abc");
  });
});
```

(Only the provided-value paths — the missing-value path prompts interactively and would hang a non-TTY runner.)

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @jab/wp-headless-cli test` → 2 passing (no longer a no-op). Run `pnpm --filter @jab/wp-headless-cli typecheck` → clean.

```bash
git add packages/cli/package.json packages/cli/src/util/credentials.test.ts pnpm-lock.yaml
git commit -m "test(cli): bootstrap vitest with a first real test - pnpm --filter test is no longer a silent no-op"
```

---

### Task 20: Docs sweep — flag semantics, CLAUDE.md snapshot

`JAB_COMPOSE_TYPECHECK` is ON by default (set `0` to skip), but CLAUDE.md and conversion-pipeline.md describe it as `=1` opt-in. CLAUDE.md's current-state snapshot should record this campaign.

**Files:**
- Modify: `CLAUDE.md` (~line 138 + the SaaS current-state section)
- Modify: `docs/conversion-pipeline.md` (lines ~27 and ~42)

- [ ] **Step 1: Fix the flag semantics.** In `CLAUDE.md` ~line 138, change `Ships with compile gate (\`JAB_COMPOSE_TYPECHECK=1\` runs \`tsc --noEmit\` before deploy dispatch)` to `Ships with compile gate (on by default — runs \`tsc --noEmit\` before deploy dispatch; set \`JAB_COMPOSE_TYPECHECK=0\` to skip)`. Make the equivalent wording change at `docs/conversion-pipeline.md:27` and `:42`.

- [ ] **Step 2: Record the campaign in CLAUDE.md.** In the SaaS current-state section (near the e2e-loop paragraph), add:

```markdown
**Senior-review fix campaign (landed 2026-06-09, branch `feat/saas-e2e-loop`).** A 40-agent
review found two e2e blockers (edit builds died at compose's front-page resolution; a
zero-match component diff let changed pages skip review) plus stuck-state and auth gaps —
all fixed per [`docs/superpowers/plans/2026-06-09-senior-review-fix-campaign.md`](docs/superpowers/plans/2026-06-09-senior-review-fix-campaign.md):
edit configs carry `front_page_slug`/watermark from the source build, `computeChangedPages`
fail-closes on empty diffs, the page_inventory clone carries `block_tree`/`source_modified_gmt`,
stale active builds auto-fail at the entry guards, every status advance is cancel-guarded,
the workspace keys off the latest READY build, `loadWorkspaceEditHistory` is RLS-scoped,
`JAB_CHAT_EDIT` is enforced server-side, migration **0032** (one chat thread per project +
hot-path/FK indexes) is applied to BOTH Supabase projects, and the emitted SDK client +
`McpClient` recover from MCP session expiry (regenerate deployed sites to pick it up).
Out of scope → separate plans: wp-plugin PHP findings (AcfValueWalker value drops, ACF
location-rule coverage), menus persistence, chat live-refresh.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/conversion-pipeline.md
git commit -m "docs: correct JAB_COMPOSE_TYPECHECK semantics (on by default, =0 skips); record the 2026-06-09 fix campaign in CLAUDE.md"
```

---

### Task 21: Final verification + runbook handoff

- [ ] **Step 1: Full suites + typecheck, all packages**

```bash
pnpm --filter @jab/web test
pnpm --filter @jab/web typecheck
pnpm --filter @jab/core test
pnpm --filter @jab/core typecheck
pnpm --filter @jab/wp-headless-cli test
pnpm --filter @jab/wp-headless-cli typecheck
```

Expected: every suite green (web grows past 771; core past 26; CLI 2+), zero type errors. Paste the counts into the completion report.

- [ ] **Step 2: Sanity-check migration parity.** Via `mcp__supabase__execute_sql` on BOTH projects: `SELECT count(*) FROM pg_indexes WHERE indexname IN ('conversations_one_per_project_idx','chat_messages_project_created_idx','chat_messages_edit_id_idx','chat_messages_build_id_idx','workspace_edits_message_id_idx','workspace_edits_result_promoted_deployment_id_idx');` → 6 on each.

- [ ] **Step 3: Cron probe.** With the dev server up: `curl -s -o NUL -w "%{http_code}" -H "Authorization: Bearer wrong" http://localhost:3000/api/cron/prune` → `401` (not `307`).

- [ ] **Step 4: Hand off to the manual smoke runbook.** The runbook (`docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md`) is the real e2e gate and a HUMAN step (spends Anthropic tokens + real Vercel deploys): Scenarios 1–4 against the Two Roads project on the dev Supabase ("JAB WP"). Blockers #1/#2 specifically predict: S1 now reaches `ready` with a non-empty (likely all-pages) `changed_slugs`; S3's `Header.tsx` differs source→result; S4 creates no build. Report any failing scenario+query per the runbook's last line.

- [ ] **Step 5: Update institutional memory** (assistant-side, not repo): mark the `triggerDiscovery` dead-code memory resolved-by-deletion; note migration 0032 applied to both projects in the two-Supabase-projects memory.

---

## Execution notes

- **Order matters within phases 1–3** (T1 before T2 only for clean rebases — they touch sibling files; T7 before T11 because T11 assumes compose's mark-composing-phase already has T7's shape). Phase 4 tasks are independent of each other; Phase 5 is independent except T15 should land before T16 (both touch the runbook).
- **Migration discipline:** 0032 (T10) must be applied to BOTH Supabase projects before the chat path is exercised — `ensureConversation`'s 23505 re-select depends on the unique index existing.
- **Every task ends with the full app suite green**, not just the targeted file — several tasks (T1, T8, T9, T12) intentionally cause typecheck ripples that surface hidden construction sites; fixing those ripples is part of the task, not collateral damage.



