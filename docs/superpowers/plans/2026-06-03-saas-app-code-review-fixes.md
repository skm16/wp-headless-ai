# SaaS-app Code Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five code-review findings on `apps/web` (2 High concurrency/auth bugs + 3 Medium publish/state-machine bugs) without regressing the 36-file / 454-test suite.

**Architecture:** Push the two High-severity invariants down to the database (partial unique indexes for "one active build per project" and "one ready production deployment per project"; SECURITY DEFINER RPC for the atomic publish sequence). Pull `loadWorkspaceEditHistory` out of the `"use server"` action file into a `server-only` data module that uses the RLS-scoped user client instead of admin. Wire the workspace_edits terminal state to the downstream build state machine (verify-fidelity success + markBuildFailed) so an edit cannot show "completed" while its result build is still in flight.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Drizzle migrations (hand-written SQL under `apps/web/drizzle/migrations/`), Supabase Postgres + RLS, Inngest workers (`apps/web/lib/inngest/functions/`), Vitest unit tests.

---

## Findings → Tasks Map

| # | Severity | Finding | Tasks |
| --- | --- | --- | --- |
| F1 | High | Active-build concurrency not enforced — `trigger-build.ts:73` is check-then-insert; `edit-site.ts:65` bypasses too | T1 → T2 → T3 |
| F2 | High | `loadWorkspaceEditHistory` is an exported server action with admin client + no auth check | T4 → T5 |
| F3 | Medium | Publish gate passes with missing fidelity rows | T6 → T7 → T8 |
| F4 | Medium | Production publish writes are not transactional/idempotent | T9 → T10 |
| F5 | Medium | Workspace edit marks completed before downstream build completes | T11 → T12 → T13 |

Tasks within a phase are sequential; the five phases are independent except F1 → F5 (F5's "infer terminal state from result build" expects the result build row to actually exist, which the F1 partial unique index now reliably enforces).

---

## File Structure

**New files**

- `apps/web/drizzle/migrations/0025_concurrency_guards.sql` — two partial unique indexes (active site_builds, ready-production deployments).
- `apps/web/drizzle/migrations/0026_publish_build_promote_rpc.sql` — `promote_build_to_production` SECURITY DEFINER RPC.
- `apps/web/lib/data/workspace-edit-history.ts` — `server-only`, user-client RLS-scoped reader.
- `apps/web/lib/data/workspace-edit-history.test.ts` — vitest unit test for the new reader.
- `apps/web/lib/jab/postgres-errors.ts` — `isUniqueViolation(err): boolean` helper (Postgres SQLSTATE 23505).
- `apps/web/lib/jab/postgres-errors.test.ts` — unit test for the helper.

**Modified files**

- `apps/web/lib/jab/publish-gate.ts` — takes `pageInventoryCount`; new `missing_fidelity_rows` reject code.
- `apps/web/lib/jab/publish-gate.test.ts` — add coverage for the new code path.
- `apps/web/lib/actions/trigger-build.ts` — translate 23505 in `site_builds` insert to `TriggerBuildError("active_build")`.
- `apps/web/lib/actions/trigger-build.test.ts` — add coverage for the translation.
- `apps/web/lib/inngest/functions/edit-site.ts` — translate 23505 in `create-result-build`; **remove `mark-edit-completed` step**.
- `apps/web/lib/actions/workspace-edit.ts` — remove `loadWorkspaceEditHistory` export.
- `apps/web/app/(app)/projects/[id]/workspace/page.tsx` — re-point import to `lib/data/workspace-edit-history`.
- `apps/web/lib/actions/build-review.ts` — load `pageInventoryCount`; call new RPC instead of two separate writes.
- `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx` — pass `pageInventoryCount` to gate; render "missing fidelity — re-verify" banner on rows without a fidelity row.
- `apps/web/lib/inngest/functions/verify-fidelity.ts` — add `sync-workspace-edit` step after `finalize-ready`.
- `apps/web/lib/inngest/shared-failure.ts` — also mark matching `workspace_edits` row failed.

---

## Phase 1 — DB-level concurrency guard (F1)

Goal: one active build per project, enforced atomically by the DB. Both the full-build path and the workspace-edit path insert into `site_builds`; both must respect the same constraint.

### Task 1: Migration 0025 — partial unique indexes

**Files:**
- Create: `apps/web/drizzle/migrations/0025_concurrency_guards.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0025_concurrency_guards.sql — Code-review fix F1 + F4.
--
-- Two partial unique indexes:
--
--   1. site_builds: one active build per project. Closes the check-then-
--      insert race in triggerBuildAction (lib/actions/trigger-build.ts) and
--      the parallel bypass in editSite.create-result-build (lib/inngest/
--      functions/edit-site.ts). The application-level "latest is active"
--      query remains as a friendly pre-check; this index is the source of
--      truth and turns a race into a 23505 unique violation the actions
--      can translate to "active_build".
--
--   2. deployments: one production+ready deployment per project. Sets up
--      F4's idempotent publish path — the RPC in 0026 supersedes prior
--      ready rows in the same transaction as the insert, and this index
--      catches concurrent publishes that would otherwise commit two
--      "ready" production rows.
--
-- Both are partial — terminal site_builds rows (ready, failed, cancelled)
-- and non-ready / non-production deployment rows are unconstrained, so the
-- historical table doesn't collapse under the new constraint.

CREATE UNIQUE INDEX site_builds_active_project_idx
  ON public.site_builds (project_id)
  WHERE status IN (
    'queued', 'discovering', 'components', 'composing', 'building', 'verifying'
  );

COMMENT ON INDEX public.site_builds_active_project_idx IS
  'F1: one active build per project. Insert raises 23505 if another active row exists; actions translate to TriggerBuildError("active_build").';

CREATE UNIQUE INDEX deployments_production_ready_project_idx
  ON public.deployments (project_id)
  WHERE environment = 'production' AND status = 'ready';

COMMENT ON INDEX public.deployments_production_ready_project_idx IS
  'F4: one ready production deployment per project. The 0026 RPC supersedes prior rows inside the same transaction as the insert; concurrent publishes race on this index and the second commit fails.';

-- ============================================================================
-- End 0025_concurrency_guards.sql
-- ============================================================================
```

- [ ] **Step 2: Apply locally and verify the indexes exist**

Run (from `apps/web`):
```bash
pnpm drizzle-kit push
```
Then in a psql session against the local DB:
```sql
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename IN ('site_builds', 'deployments')
   AND indexname LIKE '%project_idx';
```
Expected: both new indexes show up with the partial `WHERE` clause intact.

- [ ] **Step 3: Sanity-check the constraint with a hand-crafted duplicate**

In psql (use any existing project + build IDs in your dev DB, or insert a throwaway project first):
```sql
-- Should succeed
INSERT INTO site_builds (project_id, status, config)
VALUES ('<existing-project-uuid>', 'queued', '{}'::jsonb);
-- Should fail with 23505
INSERT INTO site_builds (project_id, status, config)
VALUES ('<same-project-uuid>', 'queued', '{}'::jsonb);
```
Expected: second INSERT fails with `duplicate key value violates unique constraint "site_builds_active_project_idx"`. Clean up the test row afterward.

- [ ] **Step 4: Commit**

```bash
git add apps/web/drizzle/migrations/0025_concurrency_guards.sql
git commit -m "feat(saas-app): F1 + F4 partial unique indexes for build + publish concurrency

site_builds_active_project_idx: one active build per project. Closes the
check-then-insert race in triggerBuildAction and the parallel bypass in
editSite. Application-level pre-check stays as a friendly error; this
index is the source of truth.

deployments_production_ready_project_idx: one ready production deployment
per project. Sets up F4's idempotent publish path (RPC in 0026)."
```

---

### Task 2: Translate 23505 in trigger-build

**Files:**
- Create: `apps/web/lib/jab/postgres-errors.ts`
- Create: `apps/web/lib/jab/postgres-errors.test.ts`
- Modify: `apps/web/lib/actions/trigger-build.ts` (the `site_builds` insert error branch)
- Modify: `apps/web/lib/actions/trigger-build.test.ts` (add the new translation case)

- [ ] **Step 1: Write the helper test (failing)**

Create `apps/web/lib/jab/postgres-errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./postgres-errors";

describe("isUniqueViolation", () => {
  it("returns true for Postgres SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("returns false for other Postgres codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "PGRST116" })).toBe(false);
  });

  it("returns false for null / non-object inputs", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

```bash
pnpm --filter @jab/web vitest run lib/jab/postgres-errors.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/web/lib/jab/postgres-errors.ts`:
```ts
/**
 * postgres-errors — narrow helpers for distinguishing Postgres error
 * shapes that the Supabase client surfaces as plain objects with a
 * `code` string. Used by the trigger-build + edit-site paths to
 * translate unique-violation (23505) on the new partial indexes from
 * 0025 into application-level errors.
 */

export function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
```

- [ ] **Step 4: Run the test, expect PASS**

```bash
pnpm --filter @jab/web vitest run lib/jab/postgres-errors.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Add the translation test for trigger-build (failing)**

Open `apps/web/lib/actions/trigger-build.test.ts` and add this test case at the bottom of the existing `describe` block (the test file already mocks the supabase client; use its harness):

```ts
it("translates Postgres 23505 from the site_builds insert into TriggerBuildError('active_build')", async () => {
  // Inside the existing harness: arrange so that
  // - project select returns a ready project
  // - latest-build select returns no active row
  // - site_builds insert returns { error: { code: "23505" } }
  // and assert that triggerBuildAction throws with .code === "active_build".
  //
  // The exact mock-shape lookup lives in the existing tests above —
  // mirror their setup verbatim, then override only the insert response.
});
```

(Author note: the existing test file already covers `not_found` and `not_ready` cases; copy the harness setup, point the `.insert(...).select("id").single()` mock to return `{ data: null, error: { code: "23505", message: "..." } }`, and assert the thrown error.)

- [ ] **Step 6: Run the test, expect FAIL**

```bash
pnpm --filter @jab/web vitest run lib/actions/trigger-build.test.ts
```
Expected: FAIL — current behavior throws `Error("triggerBuildAction: site_builds insert failed: ...")`.

- [ ] **Step 7: Update trigger-build.ts**

In `apps/web/lib/actions/trigger-build.ts`, change the insert error branch around line 105:

```ts
import { isUniqueViolation } from "@/lib/jab/postgres-errors";
// ...
  if (insertErr || !inserted) {
    if (isUniqueViolation(insertErr)) {
      throw new TriggerBuildError(
        "active_build",
        "An active build is already in flight for this project. Wait for it to finish or fail before retriggering.",
      );
    }
    throw new Error(
      `triggerBuildAction: site_builds insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
  }
```

- [ ] **Step 8: Run the test, expect PASS**

```bash
pnpm --filter @jab/web vitest run lib/actions/trigger-build.test.ts
```
Expected: PASS — all existing cases plus the new 23505 translation.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/jab/postgres-errors.ts \
        apps/web/lib/jab/postgres-errors.test.ts \
        apps/web/lib/actions/trigger-build.ts \
        apps/web/lib/actions/trigger-build.test.ts
git commit -m "fix(saas-app): F1 translate site_builds 23505 to TriggerBuildError(active_build)

Pairs with 0025's site_builds_active_project_idx. The DB now refuses a
second active row; the action translates the Postgres unique violation
into the same TriggerBuildError code the application-level pre-check
already returns, so the UI surface is unchanged but the race is closed."
```

---

### Task 3: Translate 23505 in edit-site worker

**Files:**
- Modify: `apps/web/lib/inngest/functions/edit-site.ts` (the `create-result-build` step)

The `edit-site` worker has no dedicated vitest harness (the Inngest workers are exercised by smoke:build, not unit tests in this project — see `apps/web/lib/inngest/functions/` — no `*.test.ts` files alongside). So this task does not have a unit test; it ships as a guarded code change that the F1 partial index makes correct, with the smoke runner as the regression check.

- [ ] **Step 1: Update create-result-build**

In `apps/web/lib/inngest/functions/edit-site.ts`, change the `create-result-build` step (around line 65) to detect 23505 and surface a friendly message:

```ts
import { isUniqueViolation } from "@/lib/jab/postgres-errors";
// ...
      resultBuildId = await step.run("create-result-build", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .insert({
            project_id: projectId,
            status: "queued",
            config: {
              mode: "edit",
              source_build_id: sourceBuildId,
              scope,
              target,
              prompt,
            },
          })
          .select("id")
          .single<{ id: string }>();
        if (error || !data) {
          if (isUniqueViolation(error)) {
            throw new Error(
              `edit-site: create-result-build refused — another active build exists for project ${projectId} (DB partial unique index site_builds_active_project_idx). Wait for it to finish or fail before re-issuing the edit.`,
            );
          }
          throw new Error(`edit-site: create-result-build failed: ${error?.message ?? "no row"}`);
        }
        return data.id;
      });
```

The worker's outer catch already marks `workspace_edits` failed with the thrown message (see edit-site.ts:219+), so the user-facing surface is correct without further changes.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @jab/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Run the full test suite to confirm no regression**

```bash
pnpm --filter @jab/web test
```
Expected: PASS (all previous tests still green).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/edit-site.ts
git commit -m "fix(saas-app): F1 close edit-site concurrency bypass via 23505 translation

editSite.create-result-build now detects the partial-unique-index
violation from 0025 and throws a clear 'another active build exists'
error instead of the generic 'create-result-build failed' surface. The
outer catch already marks workspace_edits failed with the message, so
the workspace UI shows the right reason without any UI change."
```

---

## Phase 2 — `loadWorkspaceEditHistory` auth posture (F2)

Goal: stop exporting an admin-client read as a Next.js server action. Move to a `server-only` data module that uses the RLS-scoped user client, since the `workspace_edits` table already has a tenant-scoped SELECT policy (migration 0024).

### Task 4: Create the new data module

**Files:**
- Create: `apps/web/lib/data/workspace-edit-history.ts`
- Create: `apps/web/lib/data/workspace-edit-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/data/workspace-edit-history.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { loadWorkspaceEditHistory } from "./workspace-edit-history";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

function makeChain(rows: Record<string, unknown>[]) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
}

describe("loadWorkspaceEditHistory", () => {
  it("uses the RLS-scoped user client, never createAdminClient", async () => {
    const chain = makeChain([]);
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);
    await loadWorkspaceEditHistory("project-1", 5);
    expect(createClient).toHaveBeenCalled();
    expect(chain.from).toHaveBeenCalledWith("workspace_edits");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it("maps DB rows to the camelCased shape callers expect", async () => {
    const chain = makeChain([
      {
        id: "e1",
        scope: "component",
        target: "core/heading",
        prompt: "p",
        status: "completed",
        result_build_id: "b2",
        error_text: null,
        created_at: "2026-06-03T00:00:00Z",
        finished_at: "2026-06-03T00:01:00Z",
      },
    ]);
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);
    const out = await loadWorkspaceEditHistory("project-1");
    expect(out).toEqual([
      {
        id: "e1",
        scope: "component",
        target: "core/heading",
        prompt: "p",
        status: "completed",
        resultBuildId: "b2",
        errorText: null,
        createdAt: "2026-06-03T00:00:00Z",
        finishedAt: "2026-06-03T00:01:00Z",
      },
    ]);
  });

  it("rethrows the supabase error", async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    };
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);
    await expect(loadWorkspaceEditHistory("p")).rejects.toMatchObject({ message: "boom" });
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

```bash
pnpm --filter @jab/web vitest run lib/data/workspace-edit-history.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the data module**

Create `apps/web/lib/data/workspace-edit-history.ts`:
```ts
import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * workspace-edit-history — server-only reader for the workspace UI.
 *
 * Moved out of `lib/actions/workspace-edit.ts` to fix the F2 finding:
 * the prior module was a "use server" file, so every exported function
 * was a Next.js server action that could be invoked from any client
 * with an arbitrary projectId. The previous implementation used
 * `createAdminClient()` and never verified caller membership, so a
 * crafted RSC payload would have leaked any project's edit history.
 *
 * This module uses the RLS-scoped user client (`createClient()`); the
 * `workspace_edits_tenant_select` policy in migration 0024 already
 * scopes reads to projects the caller's tenant owns. The cross-tenant
 * request therefore returns 0 rows, not the data of another tenant.
 *
 * Marked `server-only` so a misclick that imports this from a client
 * component fails at build time, not at runtime.
 */

export interface WorkspaceEditHistoryRow {
  id: string;
  scope: string;
  target: string;
  prompt: string;
  status: string;
  resultBuildId: string | null;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export async function loadWorkspaceEditHistory(
  projectId: string,
  limit = 10,
): Promise<WorkspaceEditHistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_edits")
    .select(
      "id, scope, target, prompt, status, result_build_id, error_text, created_at, finished_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    scope: String(row.scope),
    target: String(row.target),
    prompt: String(row.prompt),
    status: String(row.status),
    resultBuildId: (row.result_build_id as string | null) ?? null,
    errorText: (row.error_text as string | null) ?? null,
    createdAt: String(row.created_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }));
}
```

- [ ] **Step 4: Run the test, expect PASS**

```bash
pnpm --filter @jab/web vitest run lib/data/workspace-edit-history.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/data/workspace-edit-history.ts \
        apps/web/lib/data/workspace-edit-history.test.ts
git commit -m "feat(saas-app): F2 server-only workspace-edit-history reader with RLS

Replaces the loadWorkspaceEditHistory export from the use-server action
file. The new module uses the user client + RLS policy from 0024 instead
of createAdminClient with no auth check, closing the cross-tenant read
hole the original module's docstring 'reuses createAdminClient
deliberately' admitted to."
```

---

### Task 5: Delete old export + repoint caller

**Files:**
- Modify: `apps/web/lib/actions/workspace-edit.ts` (remove the `loadWorkspaceEditHistory` function and its `createAdminClient` import)
- Modify: `apps/web/app/(app)/projects/[id]/workspace/page.tsx:9` (import path change)

- [ ] **Step 1: Remove the old export**

In `apps/web/lib/actions/workspace-edit.ts`, delete lines 128–171 (the full `loadWorkspaceEditHistory` function). Also remove the `createAdminClient` import on line 5 if it has no remaining callers in this file (it doesn't — the action above uses the user client). Verify the docstring atop the file no longer claims to expose the reader.

- [ ] **Step 2: Repoint the workspace page import**

In `apps/web/app/(app)/projects/[id]/workspace/page.tsx`, change the import:
```ts
// Before
import {
  // ...
  loadWorkspaceEditHistory,
} from "@/lib/actions/workspace-edit";

// After
import {
  // ... (other names that genuinely belong in the actions module)
} from "@/lib/actions/workspace-edit";
import { loadWorkspaceEditHistory } from "@/lib/data/workspace-edit-history";
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @jab/web typecheck
```
Expected: PASS — the page imports from the new module; the action module's exports are all `async function` (Next.js requirement).

- [ ] **Step 4: Run the full test suite**

```bash
pnpm --filter @jab/web test
```
Expected: PASS — the existing workspace-edit.test.ts only covers `requestWorkspaceEditAction`, so removing the history reader doesn't break tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/actions/workspace-edit.ts \
        "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "fix(saas-app): F2 remove loadWorkspaceEditHistory from \"use server\" file

The reader has moved to lib/data/workspace-edit-history.ts (server-only,
RLS-scoped). This commit deletes the old export and re-points the only
caller, the workspace page. No remaining \"use server\" module exposes
an admin-client read with no auth check."
```

---

## Phase 3 — Publish gate completeness (F3)

Goal: a build is publishable only when every page in the inventory has a fidelity row, and every fidelity row is approved. Today the gate only inspects the rows that exist, so a partial verification looks publishable on the subset.

### Task 6: Extend publish-gate to require fidelity coverage

**Files:**
- Modify: `apps/web/lib/jab/publish-gate.ts`
- Modify: `apps/web/lib/jab/publish-gate.test.ts`

- [ ] **Step 1: Add failing test**

In `apps/web/lib/jab/publish-gate.test.ts`, add at the bottom of the existing `describe` block:

```ts
it("rejects when pageInventoryCount exceeds the fidelity row count", () => {
  const result = evaluatePublishGate({
    buildStatus: "ready",
    pageInventoryCount: 4,
    fidelityReports: [
      { approval_status: "approved" },
      { approval_status: "approved" },
      { approval_status: "approved" },
    ],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("missing_fidelity_rows");
    expect(result.reason).toMatch(/1 page/);
  }
});

it("treats undefined pageInventoryCount as 'use the row count' (backwards-compatible)", () => {
  const result = evaluatePublishGate({
    buildStatus: "ready",
    fidelityReports: [
      { approval_status: "approved" },
      { approval_status: "approved" },
    ],
  });
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm --filter @jab/web vitest run lib/jab/publish-gate.test.ts
```
Expected: FAIL — current type rejects unknown property `pageInventoryCount` / code `missing_fidelity_rows` doesn't exist.

- [ ] **Step 3: Update publish-gate.ts**

Replace `apps/web/lib/jab/publish-gate.ts`:

```ts
/**
 * publish-gate — pure rules that decide whether a build is publishable.
 *
 * Phase 5 of the 2026-06-02 SaaS-app completion plan, hardened by F3
 * (code-review 2026-06-03): the gate now requires the fidelity row count
 * to match the page inventory count so a partial verification can't
 * pass on the subset of pages that happen to have a row.
 *
 * pageInventoryCount is optional for backwards compatibility with the
 * existing unit-test surface — when omitted the gate's previous behavior
 * is preserved (only existing rows are evaluated). Production callers
 * (publishBuildAction + the review page) ALWAYS pass the count.
 */

export interface PublishGateInput {
  buildStatus: string | null | undefined;
  fidelityReports: ReadonlyArray<{ approval_status: string }>;
  /**
   * Expected number of fidelity rows. When provided and the actual row
   * count is lower, the gate rejects with `missing_fidelity_rows`.
   */
  pageInventoryCount?: number;
}

export type PublishGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "build_not_ready"
        | "no_fidelity_rows"
        | "missing_fidelity_rows"
        | "unapproved_pages"
        | "rejected_pages";
      reason: string;
      unapprovedCount?: number;
      rejectedCount?: number;
      missingCount?: number;
    };

const ACCEPTING_STATUSES = new Set(["approved", "approved_with_issues"]);

export function evaluatePublishGate(
  input: PublishGateInput,
): PublishGateResult {
  if (input.buildStatus !== "ready") {
    return {
      ok: false,
      code: "build_not_ready",
      reason: `Build is in status='${input.buildStatus ?? "unknown"}'. Only 'ready' builds can be published.`,
    };
  }
  if (input.fidelityReports.length === 0) {
    return {
      ok: false,
      code: "no_fidelity_rows",
      reason:
        "No fidelity reports were written for this build. Re-trigger verification before publishing.",
    };
  }
  if (
    typeof input.pageInventoryCount === "number" &&
    input.pageInventoryCount > input.fidelityReports.length
  ) {
    const missingCount = input.pageInventoryCount - input.fidelityReports.length;
    return {
      ok: false,
      code: "missing_fidelity_rows",
      reason: `${missingCount} page(s) have no fidelity row. Re-trigger verification so every page is scored before publishing.`,
      missingCount,
    };
  }
  const rejectedCount = input.fidelityReports.filter(
    (r) => r.approval_status === "rejected",
  ).length;
  if (rejectedCount > 0) {
    return {
      ok: false,
      code: "rejected_pages",
      reason: `${rejectedCount} page(s) are still rejected. Resolve them (approve, approve-with-issues, or re-run the build) before publishing.`,
      rejectedCount,
    };
  }
  const unapprovedCount = input.fidelityReports.filter(
    (r) => !ACCEPTING_STATUSES.has(r.approval_status),
  ).length;
  if (unapprovedCount > 0) {
    return {
      ok: false,
      code: "unapproved_pages",
      reason: `${unapprovedCount} page(s) are still pending review. Approve each page (approve or approve-with-issues) before publishing.`,
      unapprovedCount,
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the test, expect PASS**

```bash
pnpm --filter @jab/web vitest run lib/jab/publish-gate.test.ts
```
Expected: PASS — both new tests plus all existing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/publish-gate.ts apps/web/lib/jab/publish-gate.test.ts
git commit -m "feat(saas-app): F3 publish gate requires fidelity row per page

evaluatePublishGate accepts pageInventoryCount; when supplied and lower
than the fidelity row count, returns missing_fidelity_rows. Backwards-
compatible: the count is optional, so the existing unit-test cases that
omit it stay green."
```

---

### Task 7: Pass pageInventoryCount from the publish action

**Files:**
- Modify: `apps/web/lib/actions/build-review.ts` (the `publishBuildAction` body — fidelity load + gate eval)

- [ ] **Step 1: Update publishBuildAction**

In `apps/web/lib/actions/build-review.ts`, change the block around lines 119–131 to also load the page count and pass it to the gate:

```ts
  const { data: fidelityRows, error: fidelityErr } = await userClient
    .from("fidelity_reports")
    .select("approval_status")
    .eq("site_build_id", input.buildId);
  if (fidelityErr) throw fidelityErr;

  const { count: pageInventoryCount, error: pageCountErr } = await userClient
    .from("page_inventory")
    .select("id", { count: "exact", head: true })
    .eq("site_build_id", input.buildId);
  if (pageCountErr) throw pageCountErr;

  const gate = evaluatePublishGate({
    buildStatus: build.status,
    fidelityReports: (fidelityRows ?? []) as Array<{ approval_status: string }>,
    pageInventoryCount: pageInventoryCount ?? 0,
  });
  if (!gate.ok) {
    throw new BuildReviewError("publish_gate_failed", gate.reason);
  }
```

- [ ] **Step 2: Run typecheck + tests**

```bash
pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/build-review.ts
git commit -m "fix(saas-app): F3 publishBuildAction passes pageInventoryCount to gate

Loads the page_inventory count with the same RLS-scoped user client and
hands it to evaluatePublishGate. Builds with missing fidelity rows now
fail the gate with the new missing_fidelity_rows code instead of
publishing on the subset that happens to be present."
```

---

### Task 8: Review page passes count + improves missing-row UI

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx`

- [ ] **Step 1: Pass pageInventoryCount to the gate call**

In the review page, after computing `pageRows.length`, update the `evaluatePublishGate` call:

```ts
const gate = evaluatePublishGate({
  buildStatus: build.status,
  pageInventoryCount: pageRows.length,
  fidelityReports: fidelityRows.map((r) => ({
    approval_status: r.approval_status,
  })),
});
```

- [ ] **Step 2: Improve the "no fidelity row" UI**

In `PageReviewRow`, replace the existing `<span>no fidelity row</span>` branch (around line 312–317) with a louder amber pill so reviewers can't miss the page that needs re-verification:

```tsx
          ) : (
            <>
              <span>·</span>
              <span className="inline-flex h-5 items-center rounded-sm border border-amb/40 bg-amb/[0.08] px-1.5 font-mono text-[10px] text-amb">
                missing fidelity — re-verify
              </span>
            </>
          )}
```

The Publish button is already disabled when the gate is not ok, so no further UI change is required there.

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx"
git commit -m "feat(saas-app): F3 review page surfaces missing-fidelity rows

Passes pageInventoryCount to the gate so the Publish button is disabled
when any page lacks a fidelity row, and turns the inline 'no fidelity
row' label into an amber 'missing fidelity — re-verify' pill so the
reviewer can't approve the present rows and ignore the missing ones."
```

---

## Phase 4 — Transactional publish (F4)

Goal: the publish path's two DB writes (insert new production deployment, supersede prior ready production rows) happen in one transaction, with the partial unique index from 0025 making concurrent publishes idempotent.

### Task 9: Migration 0026 — `promote_build_to_production` RPC

**Files:**
- Create: `apps/web/drizzle/migrations/0026_publish_build_promote_rpc.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0026_publish_build_promote_rpc.sql — Code-review fix F4.
--
-- The publishBuildAction (Phase 5 in the 2026-06-02 SaaS-app completion
-- plan) does three writes after the Vercel promote network call:
--
--   1. INSERT a production 'ready' deployments row.
--   2. UPDATE prior production 'ready' rows to 'superseded'.
--   3. revalidatePath() on the project + review.
--
-- Step 1 and step 2 used to run as two separate Supabase round-trips.
-- A double-submit or a transient network failure between them would
-- leave the table with two ready production rows for one project, or
-- a fresh row plus no supersede sweep.
--
-- This RPC bundles steps 1 and 2 into one Postgres transaction. The
-- partial unique index from 0025 (deployments_production_ready_project_idx)
-- is the backstop against concurrent invocations: two parallel callers
-- both run UPDATE (no-op for the second), then INSERT — the second
-- commit fails with 23505 and the caller sees a clear error rather than
-- a divergent table state.
--
-- The Vercel network call (vercel.requestPromote) still happens BEFORE
-- this RPC. Vercel's promote is idempotent: re-promoting the same
-- preview deployment id to production is a no-op, so a publish that
-- fails on the RPC and is retried is safe.
--
-- Auth: SECURITY DEFINER + the same tenant_members membership check
-- pattern the approve_fidelity_report RPC (migration 0023) uses.

CREATE OR REPLACE FUNCTION public.promote_build_to_production(
  p_build_id UUID,
  p_provider_deployment_id TEXT,
  p_url TEXT,
  p_promoted_from_deployment_id UUID
) RETURNS TABLE (
  deployment_id UUID,
  superseded_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID;
  v_project_id UUID;
  v_tenant_id UUID;
  v_new_id UUID;
  v_superseded INTEGER;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'promote_build_to_production: not authenticated';
  END IF;

  IF p_provider_deployment_id IS NULL OR length(p_provider_deployment_id) = 0 THEN
    RAISE EXCEPTION 'promote_build_to_production: provider_deployment_id is required';
  END IF;

  -- Resolve project + tenant for membership check. The RPC is SECURITY
  -- DEFINER, so this read bypasses RLS, but we filter by the caller-
  -- supplied build id so an attacker can only resolve projects via
  -- their own build ids.
  SELECT sb.project_id, p.tenant_id
    INTO v_project_id, v_tenant_id
    FROM public.site_builds sb
    JOIN public.projects p ON p.id = sb.project_id
   WHERE sb.id = p_build_id;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'promote_build_to_production: build % not found', p_build_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members
     WHERE tenant_id = v_tenant_id
       AND user_id = v_caller_uid
  ) THEN
    RAISE EXCEPTION 'promote_build_to_production: caller is not a member of the project tenant';
  END IF;

  -- Step 1 (intra-transaction): supersede prior ready production rows.
  -- Must run BEFORE the INSERT so the partial unique index doesn't
  -- raise 23505 against a row this transaction is about to retire.
  UPDATE public.deployments
     SET status = 'superseded'
   WHERE project_id = v_project_id
     AND environment = 'production'
     AND status = 'ready';
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  -- Step 2: insert the new ready production row.
  INSERT INTO public.deployments (
    site_build_id,
    project_id,
    environment,
    status,
    provider,
    provider_deployment_id,
    url,
    promoted_from_deployment_id,
    ready_at
  ) VALUES (
    p_build_id,
    v_project_id,
    'production',
    'ready',
    'vercel',
    p_provider_deployment_id,
    p_url,
    p_promoted_from_deployment_id,
    NOW()
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_superseded;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) IS
  'F4: atomic publish — supersedes prior ready production deployments and inserts the new one in one transaction. Partial unique index deployments_production_ready_project_idx (0025) is the backstop against concurrent calls.';

-- ============================================================================
-- End 0026_publish_build_promote_rpc.sql
-- ============================================================================
```

- [ ] **Step 2: Apply and sanity-check**

Run from `apps/web`:
```bash
pnpm drizzle-kit push
```
Then verify the RPC exists:
```sql
SELECT proname FROM pg_proc WHERE proname = 'promote_build_to_production';
```
Expected: one row.

- [ ] **Step 3: Commit**

```bash
git add apps/web/drizzle/migrations/0026_publish_build_promote_rpc.sql
git commit -m "feat(saas-app): F4 promote_build_to_production RPC for atomic publish

SECURITY DEFINER RPC: supersedes prior ready production deployments and
inserts the new one in one Postgres transaction. Mirrors the auth
posture of approve_fidelity_report (0023) — tenant_members membership
check, SET search_path, REVOKE PUBLIC + GRANT authenticated."
```

---

### Task 10: Wire publishBuildAction to the RPC

**Files:**
- Modify: `apps/web/lib/actions/build-review.ts`

- [ ] **Step 1: Replace the recordDeployment + supersede calls with the RPC**

In `publishBuildAction` (around lines 173–192), replace:

```ts
  const vercel = loadVercelClient();
  await vercel.requestPromote(
    projectRow.vercel_project_id,
    previewRow.provider_deployment_id,
  );

  const recorded = await recordDeployment(admin, { ... });
  const supersede = await supersedePreviousProductionDeployments(admin, { ... });
```

with:

```ts
  const vercel = loadVercelClient();
  await vercel.requestPromote(
    projectRow.vercel_project_id,
    previewRow.provider_deployment_id,
  );

  // Atomic publish (F4). The RPC supersedes prior ready production rows
  // and inserts the new one in one Postgres transaction. The user
  // client carries the caller's JWT so SECURITY DEFINER + auth.uid()
  // inside the RPC sees the right tenant member.
  const { data: rpcRows, error: rpcErr } = await userClient.rpc(
    "promote_build_to_production",
    {
      p_build_id: input.buildId,
      p_provider_deployment_id: previewRow.provider_deployment_id,
      p_url: previewRow.url,
      p_promoted_from_deployment_id: previewRow.id,
    },
  );
  if (rpcErr) {
    throw new Error(`promote_build_to_production RPC failed: ${rpcErr.message}`);
  }
  const rpcRow = (rpcRows as Array<{ deployment_id: string; superseded_count: number }> | null)?.[0];
  if (!rpcRow) {
    throw new Error("promote_build_to_production RPC returned no row");
  }
```

Then update the return statement and revalidatePath calls:

```ts
  revalidatePath(`/projects/${build.project_id}`);
  revalidatePath(`/projects/${build.project_id}/builds/${input.buildId}/review`);

  return {
    productionDeploymentId: rpcRow.deployment_id,
    productionUrl: previewRow.url ?? "",
    supersededCount: rpcRow.superseded_count,
  };
```

Also remove the now-unused `recordDeployment` / `supersedePreviousProductionDeployments` imports from the top of the file. (Both helpers stay in `deployments-recorder.ts` — `deploy-site.ts` still calls `recordDeployment` for preview rows.)

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @jab/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Run the test suite**

```bash
pnpm --filter @jab/web test
```
Expected: PASS — the existing build-review tests (if any) mock the supabase client; the new code path is a single `.rpc(...)` call, which uses the same mock chain.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/actions/build-review.ts
git commit -m "fix(saas-app): F4 publishBuildAction uses promote_build_to_production RPC

Replaces the recordDeployment + supersedePreviousProductionDeployments
two-step with one atomic RPC call. The Vercel promote network call
still runs first (idempotent on Vercel's side, so retry-safe), then the
RPC commits the new production row + supersede sweep in one Postgres
transaction. Concurrent publishes race on the partial unique index
from 0025 and the second caller gets a clear error."
```

---

## Phase 5 — Workspace edit terminal state (F5)

Goal: `workspace_edits.status='completed'` only after the resulting build reaches `ready`. Today it flips to `completed` the moment the worker dispatches compose — so a downstream verify failure leaves the edit row claiming success while the result build row says failed.

### Task 11: Stop marking the edit completed in edit-site

**Files:**
- Modify: `apps/web/lib/inngest/functions/edit-site.ts`

- [ ] **Step 1: Delete `mark-edit-completed` and adjust docstring**

In `apps/web/lib/inngest/functions/edit-site.ts`, delete lines 200–210 (the entire `await step.run("mark-edit-completed", ...)` block). The workspace_edits row remains in `status='running'` after dispatch; verify-fidelity (Task 12) will flip it to `completed` and markBuildFailed (Task 13) will flip it to `failed`.

Update the worker's top docstring to reflect the new lifecycle. Replace the existing "Notes" paragraph (around lines 23–30) with:

```ts
 * Notes:
 *   - retries: 0 — same posture as the other workers; recovery is a fresh
 *     site/edit.requested dispatch.
 *   - workspace_edits terminal state is owned by the downstream pipeline,
 *     not this worker (F5). On compose dispatch the row stays in
 *     status='running'; verifyFidelity flips it to 'completed' on ready,
 *     and markBuildFailed (shared-failure.ts) flips it to 'failed' on any
 *     downstream phase failure.
 *   - On any throw INSIDE this worker (e.g. clone failures), the catch
 *     marks workspace_edits.status='failed' directly because no downstream
 *     run was dispatched.
```

- [ ] **Step 2: Run typecheck + tests**

```bash
pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test
```
Expected: PASS — no unit test for edit-site exists in this project.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/edit-site.ts
git commit -m "fix(saas-app): F5 stop marking workspace_edits completed on compose dispatch

Removes the mark-edit-completed step from edit-site. The edit row now
stays in status='running' after dispatch; downstream workers
(verify-fidelity success in T12, markBuildFailed in T13) own the
terminal transition. This closes the bug where a verify failure left
the edit row claiming completed while the result build row said failed."
```

---

### Task 12: Sync workspace edit to completed in verify-fidelity

**Files:**
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts` (after the existing `finalize-ready` step around line 241)

- [ ] **Step 1: Add the sync step**

After the `finalize-ready` step, add a new step:

```ts
      await step.run("sync-workspace-edit-completed", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("workspace_edits")
          .update({
            status: "completed",
            finished_at: new Date().toISOString(),
          })
          .eq("result_build_id", buildId)
          .eq("status", "running");
        if (error) {
          // Non-fatal: the build is already ready; a missing workspace_edits
          // link just means this was a full build, not an edit. Log and move on.
          console.warn(
            `[verify-fidelity] sync-workspace-edit-completed update failed: ${error.message}`,
          );
        }
      });
```

The `.eq("status", "running")` filter makes the update a no-op for builds that aren't edit builds (the workspace_edits link doesn't exist) and idempotent if the worker is replayed.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @jab/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/verify-fidelity.ts
git commit -m "fix(saas-app): F5 verify-fidelity flips workspace_edits to completed on ready

After finalize-ready marks site_builds.status='ready', a new
sync-workspace-edit-completed step updates the matching workspace_edits
row (by result_build_id) to status='completed' + finished_at. Filtered
on status='running' so it's a no-op for full (non-edit) builds and
idempotent on Inngest retry."
```

---

### Task 13: markBuildFailed cascades to workspace_edits

**Files:**
- Modify: `apps/web/lib/inngest/shared-failure.ts`

- [ ] **Step 1: Extend markBuildFailed**

Add the workspace_edits update after the existing site_builds update:

```ts
export async function markBuildFailed(
  input: MarkBuildFailedInput,
): Promise<void> {
  const errorText = formatErrorText(input.error);
  const supabase = createAdminClient();
  await supabase
    .from("site_builds")
    .update({
      status: "failed",
      failed_phase: input.phase,
      error_text: errorText,
      finished_at: new Date().toISOString(),
    })
    .eq("id", input.buildId)
    .eq("project_id", input.projectId);

  // F5: cascade to workspace_edits. If this build was the result of a
  // targeted edit, mark the originating edit row failed with the same
  // error text. Filtered on status='running' so non-edit builds are a
  // no-op and replays are idempotent.
  await supabase
    .from("workspace_edits")
    .update({
      status: "failed",
      error_text: errorText,
      finished_at: new Date().toISOString(),
    })
    .eq("result_build_id", input.buildId)
    .eq("status", "running");

  // Intentionally swallow update errors. The caller is already throwing;
  // logging the secondary failure here would just bury the original cause
  // in Inngest's error trace.
}
```

- [ ] **Step 2: Run typecheck + tests**

```bash
pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/shared-failure.ts
git commit -m "fix(saas-app): F5 markBuildFailed cascades failure to workspace_edits

Any downstream worker (compose, deploy, verify) that calls markBuildFailed
on an edit-build's result row now also flips the workspace_edits row to
status='failed' with the same error_text. Combined with T12's verify
success-sync, workspace_edits terminal state is fully owned by the
downstream pipeline."
```

---

## Phase 6 — Final verification

### Task 14: Whole-suite typecheck + tests

- [ ] **Step 1: Run typecheck**

```bash
pnpm --filter @jab/web typecheck
```
Expected: PASS.

- [ ] **Step 2: Run the full vitest suite**

```bash
pnpm --filter @jab/web test
```
Expected: PASS — 38+ files, 460+ tests (we added 3 new test files in T2 + T4 + T6 with a combined ~8 new tests).

- [ ] **Step 3: Run smoke:build (the test the reviewer skipped)**

If a seeded project is available and the local stack (Inngest, Next, Supabase, Vercel) is running per `apps/web/scripts/smoke-build.ts`'s preconditions:

```bash
pnpm --filter @jab/web smoke:build
```
Expected: green end-to-end run against the seeded project. If the stack isn't available, note it in the final commit message as deferred to the next pilot smoke.

- [ ] **Step 4: Commit the verification record (if smoke ran)**

```bash
git commit --allow-empty -m "chore(saas-app): code-review fixes verified end-to-end

typecheck + vitest green. smoke:build green against <pilot-project-id>
on <date>. F1 verified by hand: two concurrent triggerBuildAction calls,
the second raises TriggerBuildError('active_build') via 23505. F4
verified by hand: a double-submit publish call returns the original
production deployment id, no duplicate rows in deployments."
```

If smoke wasn't run, skip this step and note it in the PR description instead.

---

## Self-Review

**Spec coverage:**

| Finding | Tasks | Notes |
| --- | --- | --- |
| F1 — concurrency race in trigger-build + edit-site | T1 + T2 + T3 | Partial unique index covers both insert sites; both translate 23505 to a clear surface |
| F2 — loadWorkspaceEditHistory unsafe action | T4 + T5 | Moved + uses user client + relies on existing 0024 RLS policy |
| F3 — gate ignores missing fidelity rows | T6 + T7 + T8 | Gate takes count; action passes it; review UI flags missing rows |
| F4 — non-transactional publish | T1 (partial unique index) + T9 (RPC) + T10 (action wires it up) | Vercel promote is idempotent, so the residual "promote succeeded, RPC failed" case is retry-safe |
| F5 — edit completion timing | T11 (remove premature complete) + T12 (sync on ready) + T13 (cascade on failure) | Terminal state is now owned by the downstream pipeline |

**Placeholder scan:** No "TBD", no "implement later", no "similar to Task N". Every code block is the actual content. The one exception — T2 Step 5 — points the engineer at the existing test file's harness rather than re-printing it; that's intentional because the harness is 60+ lines of vitest mocks and duplicating it here adds noise without adding signal.

**Type consistency:** `pageInventoryCount` is consistent across publish-gate.ts, publish-gate.test.ts, build-review.ts, and the review page. `WorkspaceEditHistoryRow` shape matches what the workspace page already destructures. `promote_build_to_production` RPC name + parameter names match between the migration, the action, and the rpc() call. `isUniqueViolation` signature is consistent across postgres-errors.ts, trigger-build.ts, and edit-site.ts.
