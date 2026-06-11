# SaaS e2e edit→preview→promote loop — manual smoke runbook

> **Why manual, not a script:** the chat-edit loop's entry points
> (`sendChatMessageAction`, `approvePageAction`, `publishBuildAction`,
> `requestWorkspaceEditAction`) are Next.js **server actions**. They carry
> `import "server-only"` (throws under plain `tsx`) and call `cookies()` via
> `lib/supabase/server.ts` (throws outside a live request scope). So the only
> faithful end-to-end is **through the running app**. The committed
> `apps/web/lib/inngest/functions/edit-site.smoke.ts` is the assertion spec, not
> a runner.
>
> Created 2026-06-04 for the Phase 2 (chat-edit loop) DEMO milestone smoke on
> branch `feat/saas-e2e-loop`. Verification SQL targets the dev Supabase project
> "JAB WP" (`ajfurojjxthhzkjqttri`) that `.env.local` points at.

## 0. Prerequisites

> Builds deployed before 2026-06-09 predate the session-recovery SDK client; rebuild before judging live-site stability.

Three things up, in three terminals / tabs:

```powershell
# Inngest dev server (workers won't fire without it) — http://localhost:8288
npx inngest-cli@latest dev

# Next dev WITH the chat flag on
$env:JAB_CHAT_EDIT = "1"; pnpm --filter @jab/web dev
```

`.env.local` must already carry: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, and `VERCEL_TEAM_ID` (the Vercel deploy credentials the deploy worker reads).

**Seed state — important for a *meaningful* carry-forward result:** start from a
Two Roads project whose source `ready` build was **already reviewed/approved**
(ideally the currently-live/published build). Carry-forward inherits the source
build's per-page approvals and resets only the changed slugs to `pending`. If the
source build was never approved, *every* page starts `pending` and the
carry-forward assertion is vacuously true (you can't tell carried-approved from
reset-to-pending).

**Route smoke (after any fresh build's deploy):** before the chat scenarios, prove
the deployed preview actually serves its URL space — one mapped page route, one
mapped CPT detail route, and one FALLBACK detail route that is NOT in
route-map.ts (proves POST_TYPE_MAP request-time resolution):

```powershell
pnpm --filter @jab/web exec tsx scripts/smoke-deployed-routes.ts https://<preview-url> `
  "/" "/visit-us" "/beer/lil-heaven-ipa" "/beer/<some-beer-not-in-route-map>"
```

All must be 200 (the script follows redirects). Any FAIL = stop, fix routing first.

Grab the **projectId** from the workspace URL: `/projects/<projectId>/workspace`.
Run all SQL below in the Supabase SQL editor (or `mcp__supabase__execute_sql`),
substituting `<PROJECT_ID>` / `<EDIT_ID>` / `<BUILD_ID>` as you go.

---

## Scenario 1 — actionable component edit → ready → carry-forward

1. Sign in → open `/projects/<projectId>/workspace`.
2. In the chat, send: **`make the hero bolder`**
3. **Expect in UI:** an assistant reply that is *not* a clarifying question, and a
   build that starts and progresses to **ready** (watch the workspace
   preview/progress).

**Verify — the edit linked a result build and reached ready** (re-run until
`result_build_status = ready`):

```sql
select e.id as edit_id, e.scope, e.target, e.status as edit_status,
       e.source_build_id, e.result_build_id,
       rb.status as result_build_status,
       e.changed_slugs, e.change_reason, e.result_promoted_deployment_id,
       e.created_at
from workspace_edits e
left join site_builds rb on rb.id = e.result_build_id
where e.project_id = '<PROJECT_ID>'
order by e.created_at desc
limit 5;
```

Assert on the top row: `scope = component`, `result_build_status = ready`,
`changed_slugs` is **non-empty** (≥1 page contains the targeted block).
Note its `edit_id` and `result_build_id`.

> **Note (2026-06-09):** on sites whose targeted blocks are synthesized
> (`acf_flex/*` / `cpt_template/*` — i.e. Two Roads), the raw-tree diff cannot
> see the target and `computeChangedPages` deliberately fail-closes:
> `changed_slugs` = **every** page and `change_reason` = NULL. That still
> passes this scenario (non-empty set, changed pages pending) but the
> carry-forward assertion degenerates to all-pages-pending. Precision returns
> when synthesized nodes are persisted into `block_tree` (tracked follow-up).

**Verify — scoped review / carry-forward** (changed pages reset to `pending`,
carried pages keep the source approval):

```sql
select pi.slug, fr.approval_status,
       (pi.slug = any(e.changed_slugs)) as is_changed
from workspace_edits e
join fidelity_reports fr on fr.site_build_id = e.result_build_id
join page_inventory pi   on pi.id = fr.page_inventory_id
where e.id = '<EDIT_ID>'
order by is_changed desc, pi.slug;
```

Assert: every `is_changed = true` row has `approval_status = 'pending'`; every
`is_changed = false` row carries the source's status (e.g. `approved`).

---

## Scenario 2 — approve changed pages → promote (REAL Vercel deploy)

> This is the spend/deploy step. It runs a real Anthropic-free but real Vercel
> production promote.

1. Open the scoped review for the result build:
   `/projects/<projectId>/builds/<result_build_id>/review`
2. The banner should default to **changed pages only**; approve each changed page.
3. Click **Publish** (promote). Wait for it to settle.

**Verify — production deployment + lineage:**

```sql
-- the promoted production deployment (id comes from Scenario 1's
-- result_promoted_deployment_id once Publish completes; re-run S1 query if null)
select id, environment, status, provider_deployment_id, promoted_from_deployment_id
from deployments
where id = '<RESULT_PROMOTED_DEPLOYMENT_ID>';
```

Assert: `environment = 'production'` and `status = 'ready'`, and that
`workspace_edits.result_promoted_deployment_id` (top row of the S1 query) equals
this `id` — that's the audit chain closing.

**Verify — supersede sweep** (older production deployments demoted):

```sql
select id, status, created_at
from deployments
where project_id = '<PROJECT_ID>' and environment = 'production'
order by created_at desc;
```

Assert: exactly one `ready` (the newest); prior production rows are
`superseded`.

---

## Scenario 3 — shell edit changes the header (guidance threaded, not a no-op)

1. Chat: **`add a phone number to the header`**
2. **Expect:** actionable (not a clarifying question); a build runs to **ready**.

**Verify — scope/target + shell generation:**

```sql
-- top row should be scope=shell, target=header
select id, scope, target, source_build_id, result_build_id, status
from workspace_edits
where project_id = '<PROJECT_ID>'
order by created_at desc
limit 3;

-- the result build re-generated both shells
select shell_kind, compile_status
from shell_generations
where site_build_id = '<SHELL_RESULT_BUILD_ID>';
```

**Verify — the header tsx actually changed** (the real proof guidance was
threaded into compose, not a byte-identical no-op). In Supabase Storage, bucket
**`site-screenshots`**, download and diff:

- source: `builds/<SOURCE_BUILD_ID>/project/components/site/Header.tsx`
- result: `builds/<SHELL_RESULT_BUILD_ID>/project/components/site/Header.tsx`

Assert: they differ (ideally the result mentions a phone number). Identical bytes
= guidance was dropped → fail.

---

## Scenario 4 — vague prompt → clarifying question, NO new build

1. First, baseline the build count:

   ```sql
   select count(*) as builds_before from site_builds where project_id = '<PROJECT_ID>';
   ```

2. Chat: **`make it nicer`**
3. **Expect in UI:** a clarifying question, no build starts.

**Verify — clarify, no edit, no build:**

```sql
-- latest assistant turn: clarifying, no edit linked
select role, needs_clarification, edit_id, left(content, 100) as content, created_at
from chat_messages
where project_id = '<PROJECT_ID>'
order by created_at desc
limit 4;

-- build count unchanged from builds_before
select count(*) as builds_after from site_builds where project_id = '<PROJECT_ID>';
```

Assert: top assistant row has `needs_clarification = true` and `edit_id IS NULL`;
`builds_after = builds_before`.

---

## Pass criteria (all four)

| # | Assertion |
|---|-----------|
| 1 | Component edit → result build `ready`; `changed_slugs` non-empty; changed pages `pending`, carried pages inherit source approval |
| 2 | Promote → `deployments` production row `ready`; `result_promoted_deployment_id` matches; older production rows `superseded` |
| 3 | Shell edit `scope=shell/target=header` → `ready`; `Header.tsx` differs source→result |
| 4 | Vague prompt → assistant `needs_clarification=true`, `edit_id NULL`; build count unchanged |

Report any failure (which scenario, which query row) and I'll fix it before Phase 3.

---

## Operator appendix (added 2026-06-11 after the first full live loop)

Lessons from the first end-to-end validation (chat -> edit build -> preview ->
review -> publish -> production, build `8ca94b28`, Two Roads).

### Worker host: ONE server, production build

- **Never run more than one `next dev` against the same checkout.** Multiple
  dev servers share `.next/` and clobber each other's chunks; Inngest invokes
  then receive Next error-page HTML and the worker dies instantly (functions
  run with `retries: 0`, so the edit/build strands with no error written).
- The stable pattern: host the workers with a **production build** —
  `pnpm build` then `pnpm start` in `apps/web`. Requires `INNGEST_DEV=1` in
  `.env.local` (otherwise the SDK runs in cloud mode and 401s the local
  Inngest dev server) plus `JAB_CHAT_EDIT=1` for chat.
- The prod bundle is frozen: after ANY `apps/web` code change, rebuild
  (`pnpm build`, ~3 min) and restart, or workers/actions run stale code.
- Warming `next dev` routes via curl does not work for authed pages (curl only
  triggers middleware redirects, never page compiles). Don't bother.

### Stuck-state recovery recipes (scratch drivers in `apps/web/scripts/_scratch/`)

| Symptom | Recovery |
|---|---|
| Build stuck at `verifying`, no failure written (worker invoke died at HTTP layer) | Re-dispatch `site/verify.requested` directly — fidelity rows upsert per page, fully idempotent. Pattern: `_t13-resume-verify.ts`. |
| Build `failed@composing` with a fixable cause (e.g. the tsc gate) | Reset the row to `queued` (clear `failed_phase`/`error_text`/`finished_at`) and dispatch `site/compose.requested` — the cloned artifacts + config are banked on the build row, so compose re-runs C->D->E. Pattern: `_t13-resume-compose.ts`. |
| Edit stranded at `queued`/`running` with a dead worker | `autoFailStaleOpenEdits` sweeps it automatically (queued>10 min, running>45 min) at action entry + workspace page load; the row gets a visible `error_text`. Re-send the prompt. |
| Review gate needs 45 identical approvals for a shell edit | `_t13-bulk-approve.ts <buildId>` flips all `pending` rows to `approved` (refuses unless the build is `ready`). A real bulk-approve UI is a follow-up. |
| Same prompt re-sent while a build is in flight | The duplicate build correctly fails with "lost the start race" (migration 0031). Ignore the Failed row; the original build carries the change. |

### Publish semantics (changed 2026-06-11)

- Publish = **Vercel redeploy**, not `/promote`: the promote endpoint cannot
  promote preview-target deployments (422 "Resource cannot be processed" — it
  never rebuilds). `publishBuildAction` calls
  `VercelClient.redeployToProduction` (POST `/v13/deployments` with
  `deploymentId` + `target=production` + `forceNew=1`) and polls to READY.
- The Publish button therefore blocks ~1-3 min (a real Vercel production
  build). One click; do not re-click. Worker + progress UI is a follow-up.
- On success: production `deployments` row with a NEW provider deployment id,
  `promoted_from_deployment_id` -> the preview row, and the edit's
  `result_promoted_deployment_id` stamped.

### Known behavioral trap: shell-edit regeneration is NON-CUMULATIVE

`generateShell` receives the ORIGINAL discovery `shellDom` plus only the
NEWEST `regeneration_prompt` — it never sees the current `Header.tsx` or prior
accepted guidance. A second shell edit silently reverts the first one's
changes. Workaround until guidance chaining lands: put every shell
requirement in one prompt (e.g. "nav font weight 500 AND keep the logo ~40%
smaller"). This is the top product follow-up.
