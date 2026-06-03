---
# Phase 0 — Migration Batch + Shared Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four-migration batch (0028–0031), mirror every new column/table in the Drizzle schema, define the shared TypeScript contracts (`BuildConfig`, the `site/edit.requested` payload type, the `WorkspaceEditScope` enum already in place), and wire the `23505 → active_build` friendly-error translation into both `triggerBuildAction` and `requestWorkspaceEditAction` so the new one-active-build index hardens the **existing** full-build path.

**Architecture:** This phase is the serialization gate for the whole e2e-loop epic — no other subsystem may write SQL or touch `site_builds.config` until it is done. It is additive: four hand-written SQL migrations applied via the Supabase `apply_migration` MCP tool to BOTH projects, mirrored in `lib/db/schema.ts`; two new pure TS modules (`build-config.ts`, `edit-request-event.ts`) carrying the canonical shapes other phases import by name; one new pure translation helper (`pg-error.ts`) unit-tested in isolation then wired into the two server actions. No user-facing feature ships — the only observable change is that a rebuild attempted while a build is active now returns a friendly `active_build` error instead of a raw Postgres `23505`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM + Supabase (postgres), Inngest workers, Vitest, Tailwind, Anthropic SDK, Vercel REST.

**Spec:** docs/superpowers/specs/2026-06-03-saas-e2e-loop-design.md (this plan implements §2.3 migration sequence, §2.4 `BuildConfig`, §2.5 `site/edit.requested` payload, §2.6 `WorkspaceEditScope`, §2.7 chat tables, §3.4 concurrency index + 23505 translation, §4 Phase 0).
---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/web/drizzle/migrations/0028_build_perf_metrics.sql` | Create | `site_builds`: `ttfb_ms int`, `load_ms int`, `transfer_bytes bigint` (additive, nullable). |
| `apps/web/drizzle/migrations/0029_chat_conversations.sql` | Create | `conversations` + `chat_messages` tables + RLS + indexes (verbatim spec §2.7). |
| `apps/web/drizzle/migrations/0030_workspace_edit_provenance.sql` | Create | `workspace_edits`: 6 provenance cols + status CHECK rewrite adding `'discarded'`; `message_id` FK → `chat_messages` (so 0029 precedes it). |
| `apps/web/drizzle/migrations/0031_one_active_build_per_project.sql` | Create | Partial unique index on `site_builds(project_id)` WHERE status in active phases, EXCLUDING `'queued'`. |
| `apps/web/lib/db/schema.ts` | Modify | Drizzle mirror of every new column/table. |
| `apps/web/lib/jab/build-config.ts` | Create | Canonical `BuildConfig` discriminated union (§2.4) + `isEditConfig()` type guard. |
| `apps/web/lib/jab/build-config.test.ts` | Create | Unit tests for `isEditConfig`. |
| `apps/web/lib/inngest/edit-request-event.ts` | Create | Canonical `SiteEditRequestedData` payload type (§2.5) + `EDIT_REQUESTED_EVENT` name constant. |
| `apps/web/lib/jab/workspace-edit-validation.ts` | (no change) | `WorkspaceEditScope = "component" \| "shell"` already present — verify only. |
| `apps/web/lib/db/pg-error.ts` | Create | Pure `isUniqueViolation(err)` + `UNIQUE_VIOLATION` SQLSTATE constant. |
| `apps/web/lib/db/pg-error.test.ts` | Create | Unit tests for `isUniqueViolation`. |
| `apps/web/lib/actions/trigger-build.ts` | Modify | Catch `23505` from 0031 index on insert → `TriggerBuildError("active_build")`. |
| `apps/web/lib/actions/workspace-edit.ts` | Modify | Catch `23505` from 0031 index on insert → `WorkspaceEditError("active_build")`. |
| `apps/web/lib/jab/workspace-edit-validation.ts` | Modify | Add `"active_build"` to the `WorkspaceEditError` code union. |
| `CLAUDE.md` | Modify | Record 0028–0031 applied to both Supabase projects (the migrations log). |

---

## Task 1: Migration 0028 — `site_builds` perf metric columns

**Files:**
- Create: `apps/web/drizzle/migrations/0028_build_perf_metrics.sql`
- Modify: `apps/web/lib/db/schema.ts` (the `siteBuilds` table block, after `fidelityAvg` at line 182)

This is SQL DDL + a Drizzle mirror. There is no pure-logic unit to TDD here; verification is `pnpm --filter @jab/web typecheck` (proves the Drizzle mirror compiles) plus the apply in Task 6.

- [ ] **Step 1: Write the migration SQL**

  Create `apps/web/drizzle/migrations/0028_build_perf_metrics.sql`:

  ```sql
  -- 0028_build_perf_metrics.sql — S1 (Dashboard & Project Data), e2e-loop design §2.3.
  --
  -- Measured navigation-timing perf for the home route of each build, captured
  -- inside the existing verify-fidelity Playwright pass (Phase 2 coordinated
  -- change to verify-fidelity.ts). Additive, nullable, no backfill: builds that
  -- predate this migration leave these columns NULL and the dashboard simply
  -- omits the corresponding stats (build-quick-stats omits null-valued stats).
  --
  -- NO perf_score composite (deliberately dropped — see spec §3.1 / §7). We ship
  -- measured TTFB / Load / transfer only, each labeled as raw timing.

  ALTER TABLE public.site_builds
    ADD COLUMN IF NOT EXISTS ttfb_ms      INTEGER,
    ADD COLUMN IF NOT EXISTS load_ms      INTEGER,
    ADD COLUMN IF NOT EXISTS transfer_bytes BIGINT;

  COMMENT ON COLUMN public.site_builds.ttfb_ms IS
    'Home-route time-to-first-byte in ms (navigation timing responseStart - requestStart). NULL for pre-0028 builds or when perf capture failed (fail-soft).';
  COMMENT ON COLUMN public.site_builds.load_ms IS
    'Home-route load time in ms (navigation timing loadEventEnd - startTime). NULL when uncaptured.';
  COMMENT ON COLUMN public.site_builds.transfer_bytes IS
    'Home-route transfer size in bytes (navigation timing transferSize). BIGINT — large pages exceed INT range. NULL when uncaptured.';

  -- ============================================================================
  -- End 0028_build_perf_metrics.sql
  -- ============================================================================
  ```

- [ ] **Step 2: Mirror in `lib/db/schema.ts`**

  In `apps/web/lib/db/schema.ts`, inside the `siteBuilds` `pgTable` column object, immediately after the `fidelityAvg` column (the line `fidelityAvg: text("fidelity_avg"),` at line 182) and before `startedAt`, add:

  ```ts
    // Measured home-route navigation-timing perf (migration 0028). Captured
    // inside the verify-fidelity Playwright pass; NULL for pre-0028 builds or
    // when perf capture fails (fail-soft). transferBytes is BIGINT — postgres.js
    // returns it as a string, so parse at the call site if you need a JS number.
    ttfbMs: integer("ttfb_ms"),
    loadMs: integer("load_ms"),
    transferBytes: text("transfer_bytes"),
  ```

  > Note: `transfer_bytes` is `BIGINT` in SQL but typed as Drizzle `text` (not `integer`) for the same reason `fidelityAvg` is typed `text` — when read through Drizzle/postgres.js, `BIGINT` is coerced to a **string** to avoid JS `Number` precision loss, so a postgres.js read site must parse with `Number(...)`.
  >
  > **Read-client caveat (reconciles with Phase 3's `BuildSummary.transferBytes: number | null`):** `load-project-builds.ts` does **not** read through Drizzle/postgres.js — it uses the `@supabase/supabase-js` REST (PostgREST) client. Over that JSON transport, an **in-range** `BIGINT` deserializes to a JS **number** (the same way `page_count`/`block_type_count` already arrive as numbers and are cast `as number | null` there). Transfer sizes for a single home route are far below `Number.MAX_SAFE_INTEGER`, so Phase 3's `(raw.transfer_bytes as number | null) ?? null` mapping in `toBuildSummary` is safe and requires no `Number(...)` coercion. The string-coercion warning above applies to Drizzle/postgres.js read sites; the supabase-js REST read site is the number path. The two plan files are aligned on this: Phase 3 maps it as a number; this note documents why that is correct over the REST client.

- [ ] **Step 3: Verify the Drizzle mirror compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. (The migration is applied to the live DB in Task 6, batched with 0029–0031.)

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/drizzle/migrations/0028_build_perf_metrics.sql apps/web/lib/db/schema.ts
  git commit -m "feat(saas): migration 0028 — site_builds perf metric columns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2: Migration 0029 — `conversations` + `chat_messages` tables

**Files:**
- Create: `apps/web/drizzle/migrations/0029_chat_conversations.sql`
- Modify: `apps/web/lib/db/schema.ts` (add two new `pgTable`s after `shellGenerations`, the last table, ending at line 421)

SQL DDL + Drizzle mirror. The SQL is verbatim from spec §2.7. Verification is typecheck + the apply in Task 6.

- [ ] **Step 1: Write the migration SQL**

  Create `apps/web/drizzle/migrations/0029_chat_conversations.sql`:

  ```sql
  -- 0029_chat_conversations.sql — S3 (Chat Targeted-Edit), e2e-loop design §2.7.
  --
  -- The workspace chat panel persists every turn so a free-form edit request,
  -- the planner's EditPlan (audit), and the edit it produced are all durable and
  -- audit-linked. Reads go through the RLS user client (the SELECT policies below
  -- are load-bearing — see spec §3.3); writes go through the server action's
  -- service-role admin client after an explicit tenant-membership check, so there
  -- is deliberately NO client INSERT policy.

  CREATE TABLE public.conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_by_user_id uuid NOT NULL,
    title text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX conversations_project_idx ON public.conversations (project_id, created_at DESC);

  CREATE TABLE public.chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    plan jsonb,                         -- the EditPlan (audit), null for user rows
    needs_clarification boolean NOT NULL DEFAULT false,
    edit_id uuid REFERENCES public.workspace_edits(id) ON DELETE SET NULL,
    build_id uuid REFERENCES public.site_builds(id) ON DELETE SET NULL,
    input_tokens_cached int NOT NULL DEFAULT 0,
    input_tokens_uncached int NOT NULL DEFAULT 0,
    output_tokens int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX chat_messages_conversation_idx ON public.chat_messages (conversation_id, created_at);

  ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

  -- Reads go through the RLS user client (the policies are load-bearing — §3.3).
  CREATE POLICY conv_select ON public.conversations FOR SELECT
    USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid()));
  CREATE POLICY msg_select ON public.chat_messages FOR SELECT
    USING (project_id IN (
      SELECT p.id FROM public.projects p
      JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id
      WHERE tm.user_id = auth.uid()));
  -- No client INSERT policy: all writes go through the server action (service-role
  -- admin client) which performs its own tenant-membership check first.

  COMMENT ON TABLE public.conversations IS
    'One row per workspace chat thread (v1: one active thread per project). RLS SELECT by tenant membership; writes via service-role server action.';
  COMMENT ON TABLE public.chat_messages IS
    'User + assistant chat turns. plan jsonb carries the EditPlan audit on assistant rows; edit_id/build_id link a turn to the edit it triggered.';

  -- ============================================================================
  -- End 0029_chat_conversations.sql
  -- ============================================================================
  ```

- [ ] **Step 2: Mirror in `lib/db/schema.ts`**

  At the END of `apps/web/lib/db/schema.ts` (after the `shellGenerations` table block that closes at line 421), append:

  ```ts

  /**
   * conversations — workspace chat threads (migration 0029, e2e-loop §2.7).
   * v1: one active thread per project. RLS SELECT by tenant membership; all
   * writes go through the server action's service-role admin client.
   */
  export const conversations = pgTable(
    "conversations",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      projectId: uuid("project_id")
        .notNull()
        .references(() => projects.id, { onDelete: "cascade" }),
      tenantId: uuid("tenant_id")
        .notNull()
        .references(() => tenants.id, { onDelete: "cascade" }),
      createdByUserId: uuid("created_by_user_id").notNull(),
      title: text("title"),
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => ({
      projectIdx: index("conversations_project_idx").on(t.projectId, t.createdAt),
    }),
  );

  /**
   * chat_messages — user + assistant turns (migration 0029, e2e-loop §2.7).
   * `plan` carries the EditPlan audit on assistant rows; edit_id / build_id link
   * a turn to the edit + result build it produced.
   */
  export const chatMessages = pgTable(
    "chat_messages",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      conversationId: uuid("conversation_id")
        .notNull()
        .references(() => conversations.id, { onDelete: "cascade" }),
      projectId: uuid("project_id")
        .notNull()
        .references(() => projects.id, { onDelete: "cascade" }),
      role: text("role").$type<"user" | "assistant">().notNull(),
      content: text("content").notNull(),
      plan: jsonb("plan"),
      needsClarification: text("needs_clarification"), // boolean in SQL; see note
      editId: uuid("edit_id").references(() => workspaceEdits.id, { onDelete: "set null" }),
      buildId: uuid("build_id").references(() => siteBuilds.id, { onDelete: "set null" }),
      inputTokensCached: integer("input_tokens_cached").notNull().default(0),
      inputTokensUncached: integer("input_tokens_uncached").notNull().default(0),
      outputTokens: integer("output_tokens").notNull().default(0),
      createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => ({
      conversationIdx: index("chat_messages_conversation_idx").on(t.conversationId, t.createdAt),
    }),
  );
  ```

  > **Boolean note:** Drizzle's `pg-core` import list at the top of this file (line 12) does **not** include `boolean`. To keep this task additive and avoid an import churn that risks an unrelated diff, `needsClarification` is mirrored as `text` here (the SQL CHECK-free `boolean` column is authoritative; postgres.js returns it as a JS boolean at read time regardless of the Drizzle column kind, and no Phase-0 code reads it). When S3 (Phase 2) first reads `needs_clarification`, switch this to a real `boolean("needs_clarification").notNull().default(false)` and add `boolean` to the line-12 import — that is a Phase-2 concern, called out here so the Drizzle type is honest about being a placeholder. Do **not** widen the import in Phase 0.

- [ ] **Step 3: Verify the Drizzle mirror compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. The forward reference to `workspaceEdits` (defined earlier in the file at line 351) and `siteBuilds`/`projects`/`tenants` all resolve because they are declared above these new blocks.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/drizzle/migrations/0029_chat_conversations.sql apps/web/lib/db/schema.ts
  git commit -m "feat(saas): migration 0029 — conversations + chat_messages tables

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3: Migration 0030 — `workspace_edits` provenance columns + `'discarded'` status

**Files:**
- Create: `apps/web/drizzle/migrations/0030_workspace_edit_provenance.sql`
- Modify: `apps/web/lib/db/schema.ts` (the `workspaceEdits` table block, lines 351–391)

This migration depends on 0029 (the `message_id` FK references `chat_messages(id)`). It rewrites the `status` CHECK exactly once to add `'discarded'`. It does **not** touch the `scope` CHECK (the scope enum is unchanged this round — spec §2.6). SQL DDL + Drizzle mirror; verification is typecheck + the apply in Task 6.

- [ ] **Step 1: Write the migration SQL**

  Create `apps/web/drizzle/migrations/0030_workspace_edit_provenance.sql`:

  ```sql
  -- 0030_workspace_edit_provenance.sql — S3 + S4 MERGED, e2e-loop design §2.3.
  --
  -- This is the SINGLE ALTER of workspace_edits for the e2e-loop epic. Both
  -- subsystems' columns land here so the status CHECK is rewritten exactly once:
  --   S3: regeneration_prompt (guidance threaded into the generator),
  --       message_id (the chat_messages row that triggered the edit).
  --   S4: action (planner's human summary), changed_slugs (computed by
  --       edit-site's compute-changed-pages step), change_reason,
  --       result_promoted_deployment_id (closes the audit chain on promote).
  --
  -- Status gains 'discarded' (discardEditAction sets it; see §3.4). The scope
  -- CHECK is UNCHANGED — scope stays ('component','shell','page') from 0024; the
  -- validator + planner never produce 'page' (spec §2.6, no unreachable enum
  -- widening). message_id FK references chat_messages(id) so 0029 MUST precede
  -- this migration.

  ALTER TABLE public.workspace_edits
    ADD COLUMN IF NOT EXISTS regeneration_prompt text,
    ADD COLUMN IF NOT EXISTS action text,
    ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS changed_slugs text[],
    ADD COLUMN IF NOT EXISTS change_reason text,
    ADD COLUMN IF NOT EXISTS result_promoted_deployment_id uuid REFERENCES public.deployments(id) ON DELETE SET NULL;

  -- Rewrite the status CHECK exactly once to add 'discarded' (discardEditAction
  -- terminal). The 0024 constraint name is the table+column+"check" default;
  -- drop-if-exists then re-add so this is idempotent across both projects.
  ALTER TABLE public.workspace_edits
    DROP CONSTRAINT IF EXISTS workspace_edits_status_check;
  ALTER TABLE public.workspace_edits
    ADD CONSTRAINT workspace_edits_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'discarded'));

  COMMENT ON COLUMN public.workspace_edits.regeneration_prompt IS
    'Guidance threaded into the component/shell generator. Manual-form path falls back to prompt.';
  COMMENT ON COLUMN public.workspace_edits.message_id IS
    'The chat_messages row that triggered this edit. NULL for the manual-form path.';
  COMMENT ON COLUMN public.workspace_edits.changed_slugs IS
    'Page slugs the edit actually changed (computed from the SOURCE build block_tree). Drives the scoped review filter + approval carry-forward.';
  COMMENT ON COLUMN public.workspace_edits.change_reason IS
    'component_pages | shell_all | null — why changed_slugs is what it is.';
  COMMENT ON COLUMN public.workspace_edits.result_promoted_deployment_id IS
    'Production deployments.id this edit was promoted to. NULL until promote. Closes the audit chain.';

  -- ============================================================================
  -- End 0030_workspace_edit_provenance.sql
  -- ============================================================================
  ```

  > **Constraint-name caveat:** 0024 declared the status CHECK inline (`CHECK (status IN (...))`) without an explicit name, so Postgres auto-named it `workspace_edits_status_check` (table + column + `_check`). The `DROP CONSTRAINT IF EXISTS workspace_edits_status_check` above targets that auto-name. If `apply_migration` reports the constraint was not found on either project (the auto-name can differ if the column ordering differed), recover by listing constraints first: run via the Supabase `execute_sql` MCP tool `SELECT conname FROM pg_constraint WHERE conrelid = 'public.workspace_edits'::regclass AND contype = 'c';` and re-run the DROP with the reported name. Then re-run the ADD. This is the only migration in the batch with a non-trivial recovery path.

- [ ] **Step 2: Mirror in `lib/db/schema.ts`**

  In the `workspaceEdits` `pgTable` column object, the `status` column (lines 372–375) currently reads:

  ```ts
      status: text("status")
        .$type<"queued" | "running" | "completed" | "failed">()
        .notNull()
        .default("queued"),
  ```

  Replace it with (adds `"discarded"` to the `$type` union):

  ```ts
      status: text("status")
        .$type<"queued" | "running" | "completed" | "failed" | "discarded">()
        .notNull()
        .default("queued"),
  ```

  Then, immediately after the `errorText: text("error_text"),` line (line 376) and before `createdAt`, insert the six new provenance columns:

  ```ts
      // Provenance columns (migration 0030, e2e-loop §2.3). Guidance threaded
      // into the generator; the chat message that triggered the edit; the
      // computed changed-page set + reason; and the promoted production
      // deployment that closes the audit chain.
      regenerationPrompt: text("regeneration_prompt"),
      action: text("action"),
      messageId: uuid("message_id").references(() => chatMessages.id, { onDelete: "set null" }),
      changedSlugs: text("changed_slugs").array(),
      changeReason: text("change_reason").$type<"component_pages" | "shell_all" | null>(),
      resultPromotedDeploymentId: uuid("result_promoted_deployment_id").references(
        () => deployments.id,
        { onDelete: "set null" },
      ),
  ```

  > **Forward-reference note:** `chatMessages` is declared at the END of the file (Task 2), AFTER `workspaceEdits` (line 351). Drizzle column `.references()` takes a thunk `() => chatMessages.id`, which is lazily evaluated, so the forward reference is fine at module-eval time. `deployments` is declared earlier (line 197), no issue. Confirm with the typecheck in Step 3.

- [ ] **Step 3: Verify the Drizzle mirror compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/drizzle/migrations/0030_workspace_edit_provenance.sql apps/web/lib/db/schema.ts
  git commit -m "feat(saas): migration 0030 — workspace_edits provenance cols + discarded status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4: Migration 0031 — one-active-build-per-project partial unique index

**Files:**
- Create: `apps/web/drizzle/migrations/0031_one_active_build_per_project.sql`
- Modify: `apps/web/lib/db/schema.ts` (the `siteBuilds` table's index object, lines 188–191)

This is the load-bearing concurrency backstop. The partial unique index is on `site_builds(project_id)` WHERE the status is in an active phase, **excluding `'queued'`** (spec §3.4: racing inserts both land as `queued` so the app-level check arbitrates, avoiding a permanent wedge). Verification is typecheck + the apply in Task 6; the behavioral proof lands in Task 8.

- [ ] **Step 1: Write the migration SQL**

  Create `apps/web/drizzle/migrations/0031_one_active_build_per_project.sql`:

  ```sql
  -- 0031_one_active_build_per_project.sql — S4, e2e-loop design §3.4.
  --
  -- The hard backstop against two genuinely-concurrent ACTIVE builds for one
  -- project. A partial unique index on project_id, scoped to the active phases
  -- EXCLUDING 'queued'. Excluding queued is deliberate (spec §3.4):
  --   - Two racing inserts both land as 'queued' (no constraint violation), so
  --     the app-level isActiveBuildStatus check arbitrates the FRIENDLY path
  --     instead of one insert throwing a raw 23505 at the user.
  --   - A crashed worker (retries:0 + process death) can leave a row stuck in an
  --     active phase; excluding 'queued' plus a documented operator-recovery path
  --     (UPDATE the wedged row to 'failed') avoids a permanently un-buildable
  --     project.
  -- The index is the hard backstop; the app check is the friendly fast path.
  --
  -- triggerBuildAction and requestWorkspaceEditAction both catch 23505 from this
  -- index and translate to a friendly 'active_build' error.

  CREATE UNIQUE INDEX IF NOT EXISTS site_builds_one_active_per_project_idx
    ON public.site_builds (project_id)
    WHERE status IN ('discovering', 'components', 'composing', 'building', 'verifying');

  COMMENT ON INDEX public.site_builds_one_active_per_project_idx IS
    'At most one ACTIVE (non-queued, non-terminal) build per project. Excludes queued so racing inserts arbitrate at the app level (spec §3.4). Recovery for a wedged active row: operator UPDATE site_builds SET status=''failed'' WHERE id=<wedged>.';

  -- ============================================================================
  -- End 0031_one_active_build_per_project.sql
  -- ============================================================================
  ```

  > **Why this index never blocks the queued insert:** both `triggerBuildAction` and `editSite`'s `create-result-build` insert `status: 'queued'`, which is outside the index's WHERE predicate — so the partial index does not even index those rows and a 23505 cannot fire at insert time on the queued path. The 23505 only fires if some code path tries to UPDATE a build INTO an active phase while another active build already exists for the same project. The worker phase-transition UPDATEs are the realistic trigger. The app-level `isActiveBuildStatus` fast path in both actions short-circuits before insert; the catch is the backstop for the rare race where two requests pass the read-check concurrently and a downstream worker transition collides. Task 8 documents how to demo this against the existing full-build path.

- [ ] **Step 2: Mirror the index in `lib/db/schema.ts`**

  The `siteBuilds` table's index object (lines 188–191) currently reads:

  ```ts
    (t) => ({
      projectIdx: index("site_builds_project_id_idx").on(t.projectId),
      statusIdx: index("site_builds_status_idx").on(t.status),
    }),
  ```

  Replace it with (adds the partial unique index mirror; Drizzle supports `.where()` on `uniqueIndex`):

  ```ts
    (t) => ({
      projectIdx: index("site_builds_project_id_idx").on(t.projectId),
      statusIdx: index("site_builds_status_idx").on(t.status),
      // At most one ACTIVE (non-queued) build per project (migration 0031).
      // Partial: only indexes rows whose status is an active phase, excluding
      // 'queued' (spec §3.4). The hard backstop behind the app-level check.
      oneActivePerProjectIdx: uniqueIndex("site_builds_one_active_per_project_idx")
        .on(t.projectId)
        .where(sql`status IN ('discovering', 'components', 'composing', 'building', 'verifying')`),
    }),
  ```

  Then add `sql` to the `drizzle-orm` imports. At the top of the file the only `drizzle-orm` import is from `drizzle-orm/pg-core` (line 12). Add a new import line immediately after line 12:

  ```ts
  import { sql } from "drizzle-orm";
  ```

- [ ] **Step 3: Verify the Drizzle mirror compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. (`uniqueIndex(...).where(sql\`...\`)` is the Drizzle partial-unique-index API; `sql` resolves from the new import.)

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/drizzle/migrations/0031_one_active_build_per_project.sql apps/web/lib/db/schema.ts
  git commit -m "feat(saas): migration 0031 — one-active-build-per-project partial unique index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5: Apply 0028→0031 in order to BOTH Supabase projects + record in the migrations log

**Files:**
- Modify: `CLAUDE.md` (the migrations-applied line at ~line 114)

This task has no test code — it applies the four migrations via the Supabase `apply_migration` MCP tool to both projects, in order, and records the apply. The standing rule (CLAUDE.md memory `two-supabase-projects-local-prod`): apply EVERY migration to both `ajfurojjxthhzkjqttri` (local/"JAB WP") and `celzwcxkrmsbwiswkxug` ("jab-prod").

- [ ] **Step 1: Confirm both projects are at 0027 before applying**

  Use the Supabase MCP `list_migrations` tool against each project to confirm the last applied version is `0027` (or its recorded name). Run once per project:
  - `list_migrations` with `project_id: "ajfurojjxthhzkjqttri"` → expect 0027 present.
  - `list_migrations` with `project_id: "celzwcxkrmsbwiswkxug"` → expect 0027 present.

  If either is behind 0027, STOP — the prior batch was not fully applied; resolve that first (the e2e-loop epic assumes 0027 is live on both, per the b6a987b commit).

- [ ] **Step 2: Apply 0028 to both projects**

  Use the Supabase MCP `apply_migration` tool. Pass the exact SQL from `apps/web/drizzle/migrations/0028_build_perf_metrics.sql`:
  - `apply_migration` with `project_id: "ajfurojjxthhzkjqttri"`, `name: "build_perf_metrics"`, `query: <0028 SQL>`.
  - `apply_migration` with `project_id: "celzwcxkrmsbwiswkxug"`, `name: "build_perf_metrics"`, `query: <0028 SQL>`.

  Both must succeed before proceeding.

- [ ] **Step 3: Apply 0029 to both projects**

  - `apply_migration` `project_id: "ajfurojjxthhzkjqttri"`, `name: "chat_conversations"`, `query: <0029 SQL>`.
  - `apply_migration` `project_id: "celzwcxkrmsbwiswkxug"`, `name: "chat_conversations"`, `query: <0029 SQL>`.

  0029 MUST land before 0030 (the `message_id` FK references `chat_messages`).

- [ ] **Step 4: Apply 0030 to both projects**

  - `apply_migration` `project_id: "ajfurojjxthhzkjqttri"`, `name: "workspace_edit_provenance"`, `query: <0030 SQL>`.
  - `apply_migration` `project_id: "celzwcxkrmsbwiswkxug"`, `name: "workspace_edit_provenance"`, `query: <0030 SQL>`.

  If the `DROP CONSTRAINT IF EXISTS workspace_edits_status_check` reports no-op and the subsequent `ADD CONSTRAINT` fails with "constraint already exists" or "check violation", apply the recovery in Task 3 Step 1's caveat (list constraints via `execute_sql`, drop by the reported name, re-add).

- [ ] **Step 5: Apply 0031 to both projects**

  - `apply_migration` `project_id: "ajfurojjxthhzkjqttri"`, `name: "one_active_build_per_project"`, `query: <0031 SQL>`.
  - `apply_migration` `project_id: "celzwcxkrmsbwiswkxug"`, `name: "one_active_build_per_project"`, `query: <0031 SQL>`.

- [ ] **Step 6: Verify the apply on both projects**

  Use the Supabase MCP `execute_sql` tool against EACH project to confirm the schema landed:

  ```sql
  -- 0028 columns present on site_builds:
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'site_builds'
     AND column_name IN ('ttfb_ms', 'load_ms', 'transfer_bytes')
   ORDER BY column_name;
  -- expect 3 rows: load_ms, transfer_bytes, ttfb_ms

  -- 0029 tables present:
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('conversations', 'chat_messages')
   ORDER BY table_name;
  -- expect 2 rows

  -- 0030 columns + status check:
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'workspace_edits'
     AND column_name IN ('regeneration_prompt','action','message_id','changed_slugs','change_reason','result_promoted_deployment_id')
   ORDER BY column_name;
  -- expect 6 rows
  SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = 'public.workspace_edits'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%';
  -- expect the def to include 'discarded'

  -- 0031 index present:
  SELECT indexname FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'site_builds'
     AND indexname = 'site_builds_one_active_per_project_idx';
  -- expect 1 row
  ```

  Run the full block once per `project_id`. All assertions must hold on both projects (the verifier's "byte-identical across both projects" invariant).

- [ ] **Step 7: Record the apply in the migrations log (CLAUDE.md)**

  In `CLAUDE.md`, find the migrations-applied sentence near line 114 that reads (current state, recording 0023–0027):

  > **Migrations applied (2026-06-03):** **0023–0027** are live on **both** Supabase projects.

  Update the version range to `0023–0031` and append a sentence noting the e2e-loop Phase-0 batch. Replace `0023–0027` with `0023–0031` in that sentence, and append after the existing sentence about column-set parity:

  > The e2e-loop Phase-0 batch (**0028** build perf metrics, **0029** chat conversations + messages, **0030** workspace_edits provenance + `'discarded'` status, **0031** one-active-build-per-project partial unique index) was applied in order to both projects on 2026-06-03; column sets remain byte-identical across the two projects. See [[two-supabase-projects-local-prod]].

  (Match the exact surrounding wording in the file; the goal is that the migrations log reflects 0028–0031 live on both projects.)

- [ ] **Step 8: Commit**

  ```bash
  git add CLAUDE.md
  git commit -m "docs(saas): record migrations 0028-0031 applied to both Supabase projects

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6: `BuildConfig` canonical type + `isEditConfig` guard

**Files:**
- Create: `apps/web/lib/jab/build-config.ts`
- Create (test): `apps/web/lib/jab/build-config.test.ts`

This is the §2.4 canonical `site_builds.config` shape — the **only** shape written to `config`, defined once and imported by Phase 2's `edit-site.ts`, Phase 3's deploy-history label, and S4's carry-forward. It depends on `WorkspaceEditScope` (already `"component" | "shell"` in `workspace-edit-validation.ts`). Pure logic → TDD.

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/build-config.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";

  describe("isEditConfig", () => {
    const editConfig: BuildConfig = {
      mode: "edit",
      source_build_id: "src-build-1",
      scope: "component",
      target: "core/heading",
      prompt: "make the hero bolder",
      regeneration_prompt: "Increase the hero heading weight to 800 and size up.",
      action: "Regenerated the Hero block",
      edit_id: "edit-1",
      message_id: "msg-1",
      changed_slugs: ["/", "/about"],
      change_reason: "component_pages",
    };

    it("returns true for an edit config", () => {
      expect(isEditConfig(editConfig)).toBe(true);
    });

    it("returns false for a full config", () => {
      const full: BuildConfig = { mode: "full" };
      expect(isEditConfig(full)).toBe(false);
    });

    it("narrows the type so edit-only fields are accessible", () => {
      // The guard must narrow so source_build_id is reachable without a cast.
      const cfg: BuildConfig = editConfig;
      if (isEditConfig(cfg)) {
        expect(cfg.source_build_id).toBe("src-build-1");
        expect(cfg.scope).toBe("component");
        expect(cfg.changed_slugs).toEqual(["/", "/about"]);
      } else {
        throw new Error("expected edit config to narrow");
      }
    });

    it("returns false for null / undefined / non-object input", () => {
      expect(isEditConfig(null)).toBe(false);
      expect(isEditConfig(undefined)).toBe(false);
      expect(isEditConfig("edit")).toBe(false);
      expect(isEditConfig(42)).toBe(false);
      expect(isEditConfig({})).toBe(false);
      expect(isEditConfig({ mode: "other" })).toBe(false);
    });

    it("accepts message_id: null and change_reason: null (manual-form path)", () => {
      const manual: BuildConfig = {
        mode: "edit",
        source_build_id: "src-build-2",
        scope: "shell",
        target: "footer",
        prompt: "tighten the footer",
        regeneration_prompt: "tighten the footer",
        action: "Regenerated the footer",
        edit_id: "edit-2",
        message_id: null,
        changed_slugs: ["/", "/about", "/contact"],
        change_reason: "shell_all",
      };
      expect(isEditConfig(manual)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/jab/build-config"` (the module doesn't exist yet).

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/build-config.ts`:

  ```ts
  /**
   * build-config — the canonical `site_builds.config` shape (e2e-loop §2.4).
   *
   * This is the ONLY shape written to site_builds.config. Defined once here and
   * imported by:
   *   - edit-site.ts (Phase 2) — writes the full edit shape on create-result-build.
   *   - the deploy-history label (Phase 3) — reads config.mode / config.prompt.
   *   - approval carry-forward (Phase 2/S4) — reads config.source_build_id /
   *     config.changed_slugs.
   *
   * Non-async pure module — safe to import from server actions, workers, and the
   * client-bundled label helpers alike.
   */

  import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

  export type BuildConfig =
    | { mode: "full" }
    | {
        mode: "edit";
        source_build_id: string;
        scope: WorkspaceEditScope; // §2.6 — "component" | "shell"
        target: string; // block_name | shell kind ('header'|'footer')
        prompt: string; // raw user/plan text (human-readable)
        regeneration_prompt: string; // guidance threaded into the generator
        action: string; // planner's human summary, e.g. "Regenerated the Hero block"
        edit_id: string; // workspace_edits.id
        message_id: string | null; // chat_messages.id that triggered it (null for the manual form path)
        changed_slugs: string[]; // computed by edit-site's compute-changed-pages step
        change_reason: "component_pages" | "shell_all" | null;
      };

  /**
   * Narrowing type guard. Returns true only for a well-formed edit config
   * (mode === "edit"). Defensive against arbitrary jsonb read back from the DB:
   * null / undefined / non-object / wrong-mode all return false.
   */
  export function isEditConfig(
    config: unknown,
  ): config is Extract<BuildConfig, { mode: "edit" }> {
    return (
      typeof config === "object" &&
      config !== null &&
      (config as { mode?: unknown }).mode === "edit"
    );
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts
  git commit -m "feat(saas): canonical BuildConfig type + isEditConfig guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7: `site/edit.requested` payload type extension

**Files:**
- Create: `apps/web/lib/inngest/edit-request-event.ts`

The Inngest events in this repo are untyped (`inngest.send({ name, data })` with inline object literals; `client.ts` declares no event registry). The `site/edit.requested` payload is currently expressed twice as inline shapes — the `data` object in `workspace-edit.ts` (lines 112–123) and the `event.data as {...}` cast in `edit-site.ts` (lines 36–52). Phase 0 introduces the **canonical type** for that payload (§2.5) in one module so Phase 2 and Phase 3 can import it instead of re-casting. This task only creates the type module; the **wiring** (importing it into `workspace-edit.ts` and `edit-site.ts`) is owned by Phase 2 per the cross-plan ownership rule (Phase 2 owns the `site/edit.requested` payload extension and the `edit-site.ts` seam). Phase 0 makes the type available; it does not edit `edit-site.ts`.

This is a type-only module — no runtime logic to TDD. Verification is the typecheck (proves the type compiles and `WorkspaceEditScope` resolves).

- [ ] **Step 1: Create the type module**

  Create `apps/web/lib/inngest/edit-request-event.ts`:

  ```ts
  /**
   * edit-request-event — the canonical `site/edit.requested` Inngest payload
   * (e2e-loop §2.5). The repo's Inngest events are otherwise untyped (plain
   * `inngest.send({ name, data })`); this module is the single source of truth
   * for the edit-request shape so the producer (requestWorkspaceEditAction) and
   * the consumer (the edit-site worker) agree without re-casting inline.
   *
   * Phase 0 defines the type only. Phase 2 (sole owner of the edit-site seam +
   * the payload extension) wires it into workspace-edit.ts's send and
   * edit-site.ts's event.data parse.
   *
   * Back-compat: regenerationPrompt / action / messageId are optional so the
   * manual-form path (no planner) can omit them — the worker falls back to
   * `prompt` for regenerationPrompt.
   */

  import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

  /** The Inngest event name, as a typed constant to avoid string drift. */
  export const EDIT_REQUESTED_EVENT = "site/edit.requested" as const;

  /** The `data` payload for `site/edit.requested` (§2.5). */
  export interface SiteEditRequestedData {
    editId: string;
    projectId: string;
    tenantId: string;
    sourceBuildId: string;
    scope: WorkspaceEditScope;
    target: string;
    prompt: string;
    /** NEW — planner guidance threaded into the generator; manual form omits (falls back to `prompt`). */
    regenerationPrompt?: string;
    /** NEW — planner's human summary, e.g. "Regenerated the Hero block". */
    action?: string;
    /** NEW — the chat_messages.id that triggered the edit; null for the manual-form path. */
    messageId?: string | null;
  }
  ```

- [ ] **Step 2: Verify it compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. (`WorkspaceEditScope` resolves from `workspace-edit-validation.ts`; the module has no runtime logic so there is nothing to unit-test in Phase 0 — its consumers in Phase 2 carry the behavioral tests.)

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/lib/inngest/edit-request-event.ts
  git commit -m "feat(saas): canonical site/edit.requested payload type (SiteEditRequestedData)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8: `isUniqueViolation` pure helper + wire `23505 → active_build` into both actions

**Files:**
- Create: `apps/web/lib/db/pg-error.ts`
- Create (test): `apps/web/lib/db/pg-error.test.ts`
- Modify: `apps/web/lib/jab/workspace-edit-validation.ts` (add `"active_build"` to the `WorkspaceEditError` code union, lines 11–18)
- Modify: `apps/web/lib/actions/trigger-build.ts` (the `site_builds` insert, lines 96–109)
- Modify: `apps/web/lib/actions/workspace-edit.ts` (the `workspace_edits` insert is unaffected by 0031; the 23505 from the index can only fire on the `site_builds` path — but per spec §3.4 + §4 the translation is wired into `requestWorkspaceEditAction` too, because it shares the active-build guard. See Step 5.)

This is the load-bearing Phase-0 verification: the 0031 index changes behavior for the **existing full-build path**, so the `23505 → active_build` translation must ship here and be proven on that path. The translation logic is extracted into a pure, unit-tested helper (`isUniqueViolation`) — matching the repo pattern where pure logic is TDD'd and the action wiring is typecheck-verified (the existing action tests only cover the pure validators).

`@supabase/supabase-js` surfaces Postgres DB errors as a `PostgrestError` with a `.code` field carrying the SQLSTATE (`"23505"` for a unique violation). The helper keys on that.

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/db/pg-error.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { isUniqueViolation, UNIQUE_VIOLATION } from "@/lib/db/pg-error";

  describe("UNIQUE_VIOLATION", () => {
    it("is the Postgres unique-violation SQLSTATE", () => {
      expect(UNIQUE_VIOLATION).toBe("23505");
    });
  });

  describe("isUniqueViolation", () => {
    it("returns true for a PostgrestError with code 23505", () => {
      expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
    });

    it("returns false for a different Postgres code (PGRST116 not-found)", () => {
      expect(isUniqueViolation({ code: "PGRST116", message: "no rows" })).toBe(false);
    });

    it("returns false for a foreign-key violation (23503)", () => {
      expect(isUniqueViolation({ code: "23503", message: "fk violation" })).toBe(false);
    });

    it("returns false for null / undefined", () => {
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation(undefined)).toBe(false);
    });

    it("returns false for an error without a code field", () => {
      expect(isUniqueViolation(new Error("boom"))).toBe(false);
      expect(isUniqueViolation({ message: "no code here" })).toBe(false);
    });

    it("returns false for a non-object", () => {
      expect(isUniqueViolation("23505")).toBe(false);
      expect(isUniqueViolation(23505)).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/db/pg-error.test.ts
  ```
  Expected failure: `Failed to resolve import "@/lib/db/pg-error"`.

- [ ] **Step 3: Minimal implementation of the helper**

  Create `apps/web/lib/db/pg-error.ts`:

  ```ts
  /**
   * pg-error — narrow helpers over Postgres error codes as surfaced by
   * @supabase/supabase-js. DB-level errors arrive as a PostgrestError whose
   * `.code` carries the five-character SQLSTATE; a unique-violation is "23505".
   *
   * Used by triggerBuildAction + requestWorkspaceEditAction to translate the
   * 0031 one-active-build index's 23505 into a friendly 'active_build' error
   * instead of leaking a raw Postgres code to the user (e2e-loop §3.4 / §4).
   */

  /** Postgres SQLSTATE for a unique-constraint / unique-index violation. */
  export const UNIQUE_VIOLATION = "23505" as const;

  /**
   * True when `err` is a Postgres unique-violation (SQLSTATE 23505) as surfaced
   * by supabase-js (`{ code: "23505", ... }`). Defensive against non-objects,
   * null/undefined, and errors without a `code`.
   */
  export function isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === UNIQUE_VIOLATION
    );
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/db/pg-error.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 5: Add `"active_build"` to the `WorkspaceEditError` code union**

  In `apps/web/lib/jab/workspace-edit-validation.ts`, the `WorkspaceEditError` constructor's `code` union (lines 11–18) currently reads:

  ```ts
    constructor(
      public readonly code:
        | "not_found"
        | "source_not_ready"
        | "invalid_scope"
        | "invalid_target"
        | "prompt_too_short"
        | "page_scope_unsupported",
      message: string,
    ) {
  ```

  Add `"active_build"` to the union:

  ```ts
    constructor(
      public readonly code:
        | "not_found"
        | "source_not_ready"
        | "invalid_scope"
        | "invalid_target"
        | "prompt_too_short"
        | "page_scope_unsupported"
        | "active_build",
      message: string,
    ) {
  ```

  > `TriggerBuildError` already supports `"active_build"` — it is thrown by the existing app-level guard at `trigger-build.ts:90`. Confirm by reading `lib/jab/trigger-build-validation.ts`'s `TriggerBuildError` code union; if `"active_build"` is missing there, add it the same way. (The existing `trigger-build.ts:90` `new TriggerBuildError("active_build", ...)` call would not compile otherwise, so it is already present — but verify.)

- [ ] **Step 6: Wire the 23505 catch into `triggerBuildAction`**

  In `apps/web/lib/actions/trigger-build.ts`, add the import at the top (after the existing imports, around line 10):

  ```ts
  import { isUniqueViolation } from "@/lib/db/pg-error";
  ```

  The current `site_builds` insert block (lines 96–109) reads:

  ```ts
    const { data: inserted, error: insertErr } = await admin
      .from("site_builds")
      .insert({
        project_id: input.projectId,
        status: "queued",
        config: { mode: "full" },
      })
      .select("id")
      .single<{ id: string }>();
    if (insertErr || !inserted) {
      throw new Error(
        `triggerBuildAction: site_builds insert failed: ${insertErr?.message ?? "no row returned"}`,
      );
    }
  ```

  Replace the `if (insertErr || !inserted)` block with one that translates a 23505 from the 0031 index into the friendly `active_build` error before the generic throw:

  ```ts
    if (insertErr || !inserted) {
      // The 0031 one-active-build index throws 23505 if a phase-transition race
      // produced a second active build for this project. Translate to the same
      // friendly error the app-level guard above returns, rather than leaking a
      // raw Postgres code. (The queued insert itself is outside the partial
      // index's predicate; this catch is the backstop for the concurrent-race
      // path — see migration 0031 + spec §3.4.)
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

  (`TriggerBuildError` is already imported at the top of the file from `@/lib/jab/trigger-build-validation`.)

- [ ] **Step 7: Wire the 23505 catch into `requestWorkspaceEditAction`**

  In `apps/web/lib/actions/workspace-edit.ts`, add the import (after the existing imports, around line 9):

  ```ts
  import { isUniqueViolation } from "@/lib/db/pg-error";
  ```

  The current `workspace_edits` insert block (lines 92–110) ends with:

  ```ts
    if (insertErr || !inserted) {
      throw new Error(
        `workspace_edits insert failed: ${insertErr?.message ?? "no row returned"}`,
      );
    }
  ```

  Replace that block with the friendly translation:

  ```ts
    if (insertErr || !inserted) {
      // The 0031 one-active-build index can surface 23505 if a concurrent edit
      // produced a second active build for this project. Translate to the
      // friendly 'active_build' error rather than leaking a raw Postgres code.
      // (workspace_edits itself is not the indexed table — the 23505 originates
      // from the result-build phase transition — but the edit path shares the
      // active-build guard, so we translate here for a consistent UX; spec §3.4.)
      if (isUniqueViolation(insertErr)) {
        throw new WorkspaceEditError(
          "active_build",
          "An active build is already in flight for this project. Wait for it to finish before requesting another edit.",
        );
      }
      throw new Error(
        `workspace_edits insert failed: ${insertErr?.message ?? "no row returned"}`,
      );
    }
  ```

  (`WorkspaceEditError` is already imported at the top from `@/lib/jab/workspace-edit-validation`.)

  > **Phase-0 latent-branch note (do not skip):** in Phase 0 this `requestWorkspaceEditAction` catch is **forward-wiring, not a Phase-0 behavior change** — and it cannot fire from the 0031 index this phase. The 0031 partial unique index is on `site_builds`, but the insert this block guards targets `workspace_edits`; in the current Phase-0 code `requestWorkspaceEditAction` never inserts or transitions a `site_builds` row (the result build is inserted later, in the `edit-site` worker). The catch only becomes **reachable** once Phase 2 rewrites `requestWorkspaceEditAction` to do a `site_builds` active-build read/insert (per spec §3.4/§4's full S4 design). We wire it now — per spec §4, which directs the translation into both actions — so the friendly-error contract is in place and Phase 2 inherits it; we do **not** claim it is exercised in Phase 0. The load-bearing Phase-0 proof (Step 10) is therefore **scoped to the `triggerBuildAction` / `site_builds` path only** — that is the one path the 0031 index actually changes this phase. Do not attempt to demonstrate this `requestWorkspaceEditAction` branch in Phase 0; it is unprovable here by design, and that is expected.

- [ ] **Step 8: Typecheck the wiring**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. (`WorkspaceEditError("active_build", ...)` compiles because Step 5 widened the union; the imports resolve; both action files still satisfy their `Promise<...>` return types.)

- [ ] **Step 9: Run the existing action tests to confirm no regression**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/actions/workspace-edit.test.ts lib/actions/trigger-build.test.ts
  ```
  Expected: all existing tests still pass (they cover the pure validators, which are unchanged).

- [ ] **Step 10: Manual verification on the EXISTING full-build path (the load-bearing Phase-0 proof)**

  This proof is **scoped to the `triggerBuildAction` / `site_builds` path only** — the one path the 0031 index changes this phase. The `requestWorkspaceEditAction` catch wired in Step 7 is latent forward-wiring (see the Step-7 latent-branch note) and is deliberately **not** exercised here; do not try to demonstrate it in Phase 0.

  This is the verification the spec calls out (§4): "a normal rebuild while one is active now returns a friendly error, not a raw 23505". Because the friendly path is normally caught by the app-level `isActiveBuildStatus` check *before* the insert, prove the index + translation against a row that is genuinely in an active phase:

  1. In the local dev DB (project `ajfurojjxthhzkjqttri`), pick a project that has a `ready` build, and use the Supabase MCP `execute_sql` tool to force a second active build into a phase the index covers, simulating the race:
     ```sql
     -- Insert a build already in an active (indexed) phase for some project P.
     INSERT INTO public.site_builds (project_id, status, config)
       VALUES ('<PROJECT_ID>', 'composing', '{"mode":"full"}'::jsonb);
     -- Now attempt a SECOND active build for the SAME project, directly, to
     -- prove the index rejects it with 23505:
     INSERT INTO public.site_builds (project_id, status, config)
       VALUES ('<PROJECT_ID>', 'building', '{"mode":"full"}'::jsonb);
     ```
     The second INSERT must fail with `ERROR: duplicate key value violates unique constraint "site_builds_one_active_per_project_idx"` (SQLSTATE 23505). This proves the index is live and the predicate matches active phases.
  2. Clean up the forced rows:
     ```sql
     DELETE FROM public.site_builds
      WHERE project_id = '<PROJECT_ID>' AND status IN ('composing', 'building')
        AND config = '{"mode":"full"}'::jsonb;
     ```
  3. Confirm the app-level friendly path still works end-to-end: with one active build present, calling `triggerBuildAction` returns a `TriggerBuildError("active_build")` (caught by the `isActiveBuildStatus` fast path at `trigger-build.ts:89`) — observe via the dashboard "rebuild" button, which surfaces the friendly message rather than a stack trace. (The `isUniqueViolation` catch is the backstop for the rarer concurrent-race insert; step 1 proved the index that backstop guards.)

  Record the outcome (the 23505 fired on the duplicate active insert; the friendly error surfaced on the rebuild attempt) in the task notes. No automated test is added for the live-DB race (it is environment-coupled); the pure `isUniqueViolation` unit tests + this manual proof are the verification.

- [ ] **Step 11: Commit**

  ```bash
  git add apps/web/lib/db/pg-error.ts apps/web/lib/db/pg-error.test.ts apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/actions/trigger-build.ts apps/web/lib/actions/workspace-edit.ts
  git commit -m "feat(saas): translate 23505 from one-active-build index to friendly active_build error

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9: Full-suite + typecheck gate for the phase

**Files:** none (verification only).

A final gate proving the whole batch is internally consistent before handing off to Phases 1–3.

- [ ] **Step 1: Run the full app test suite**

  ```bash
  pnpm --filter @jab/web test
  ```
  Expected: all tests pass (the two new pure-module suites `build-config.test.ts` + `pg-error.test.ts` included; no regression in the existing 498+ tests).

- [ ] **Step 2: Run the typecheck**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: no errors. The schema mirror, the two new type modules, and the two wired actions all compile.

- [ ] **Step 3: Confirm migration files are committed and the apply is recorded**

  ```bash
  git status --short apps/web/drizzle/migrations/ CLAUDE.md
  ```
  Expected: clean (0028–0031 committed in Tasks 1–4; CLAUDE.md migrations log committed in Task 5).

---

## Definition of done

This phase ships the schema + shared contracts and the latent-concurrency-bug fix on the existing build path. No user-facing feature. Per spec §4 Phase 0, the phase is done when:

- [ ] Migrations **0028, 0029, 0030, 0031** exist under `apps/web/drizzle/migrations/`, authored as one ordered batch, and are **applied in order to BOTH Supabase projects** (`ajfurojjxthhzkjqttri` local/"JAB WP" and `celzwcxkrmsbwiswkxug` "jab-prod"), verified by the `execute_sql` schema assertions in Task 5 Step 6 passing identically on both projects.
- [ ] The apply is **recorded in the migrations log** (CLAUDE.md updated to 0028–0031 live on both projects).
- [ ] `lib/db/schema.ts` mirrors every new column (`site_builds` perf trio; `workspace_edits` 6 provenance cols + `'discarded'` status) and both new tables (`conversations`, `chat_messages`), and the 0031 partial unique index — and `pnpm --filter @jab/web typecheck` is clean.
- [ ] The shared contracts are in place and importable by name: `BuildConfig` + `isEditConfig` (`lib/jab/build-config.ts`), `SiteEditRequestedData` + `EDIT_REQUESTED_EVENT` (`lib/inngest/edit-request-event.ts`), and `WorkspaceEditScope = "component" | "shell"` (confirmed already present in `lib/jab/workspace-edit-validation.ts`).
- [ ] The **0031 error translation is wired into BOTH `triggerBuildAction` and `requestWorkspaceEditAction`** (`23505 → active_build`), backed by the unit-tested pure `isUniqueViolation` helper, and **proven on the existing full-build path**: a duplicate active-build insert raises 23505 from the index, and a normal rebuild while a build is active returns the friendly `active_build` error rather than a raw Postgres code (Task 8 Step 10).
- [ ] `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck` both pass (Task 9).
- [ ] No edit to `edit-site.ts`, `verify-fidelity.ts`, the workspace preview slot, `deriveProjectStatusLabel`, or any other downstream-phase-owned file (those belong to Phases 1–3 per the cross-plan ownership rules).
