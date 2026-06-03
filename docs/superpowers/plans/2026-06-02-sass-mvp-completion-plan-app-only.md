# JAB App Completion — Internal Pilot Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` if subagents are available). Tasks use checkbox (`- [ ]`) syntax. Each numbered phase is a commit boundary; verify (`pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`) before committing.

**Goal:** Finish wiring the Next.js SaaS app at `apps/web/` so an internal pilot can: trigger a full JAB build from a connected project → land on a preview URL → verify per-page fidelity → review/approve/publish (production promote) → iterate with targeted AI edits that produce new staged builds. **Strictly app-only** — no WP plugin work, no billing, no public-beta hardening.

**Architecture:** Bolt the missing rungs onto the existing Phase A–D worker chain. The pipeline already exists in pieces; this plan adds the orchestrator entry point, the verify worker, the review/publish gate, the deployments-table writes, the workspace targeted-edit loop, and the UI surfaces that show real build state instead of mocks.

**Out of scope (deferred):** WP plugin changes, payment / subscription / quotas, public-beta reliability, custom domain DNS, full agent IDE editing, Refresh/Reimagine intent variants, Lighthouse scoring, multi-tenant concurrency beyond one active build per project.

---

## Verified gap matrix (2026-06-03, against tip `77785d6`)

| Plan claim | Evidence | Status |
| --- | --- | --- |
| `discover-site` does not dispatch `site/components.requested` | `apps/web/lib/inngest/functions/discover-site.ts` ends at `finalize-counts` → `warn-design-tokens` (dispatches `project/design.requested` only); leaves `site_builds.status='discovering'` | **Verified gap** |
| `generate-components` already dispatches compose | `generate-components.ts:335 step.sendEvent("dispatch-compose", …)` | **Already wired** |
| `compose-site` already dispatches deploy | `compose-site.ts:538 step.sendEvent("dispatch-deploy", …)` | **Already wired** |
| `deploy-site` dispatches verify but no verify worker is registered | `deploy-site.ts:222 step.sendEvent("dispatch-verify", …)`; `app/api/inngest/route.ts:21` registers only `[extractProjectDesign, discoverSite, generateComponents, composeSite, deploySite]` | **Verified gap** |
| `deploy-site` never inserts into `deployments` | `deploy-site.ts` updates only `site_builds.preview_url` + `vercel_deployment_id` | **Verified gap** |
| `createDeployment()` hardcodes `target: "production"` | `apps/web/lib/vercel/client.ts:215` | **Verified gap** |
| No Vercel `promote` method exists | `client.ts` surface ends at `getDeploymentEvents` | **Verified gap** |
| Project detail page hardcodes `live = false` and disables Build site | `app/(app)/projects/[id]/page.tsx:81 const live = false;`, button disabled at line 361–365 | **Verified gap** |
| `triggerDiscovery` exists; no top-level `triggerBuild` action | `apps/web/lib/actions/trigger-discovery.ts` (40 lines) inserts `site_builds` + dispatches `site/discover.requested`; no project-state gating, no concurrency guard | **Verified gap** |
| `deployments` table schema is ready | `drizzle/migrations/0014_saas_v2_schema.sql:109–129`; `schema.ts:193–219` | **Verified — table exists, just unused** |
| `site_builds.status` CHECK already supports the full state machine | `0014_saas_v2_schema.sql:71–75` includes `queued, discovering, components, composing, building, verifying, ready, failed, cancelled` | **Verified — no new constraint needed** |
| `fidelity_reports.approval_status` is ready for the review gate | `0014_saas_v2_schema.sql:269–270` (`pending | approved | approved_with_issues | rejected`) | **Verified** |
| No `workspace_edits` table | Schema search returns no match | **Verified gap — new migration needed** |
| Workspace page streams a mocked AI conversation | `app/(app)/projects/[id]/workspace/page.tsx` delegates to `WorkspaceJabDemo` (the demo component); only `previewHtml` + `build` are real | **Verified gap** |

The gap matrix is the contract for this plan. Don't re-validate it during execution — fix what's listed, and add new rows here if you discover deviations.

---

## Phase ordering and dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
Vercel        Build       Progress     Verify      Review       UI
preview       trigger     surface      worker      gate         polish

                                                                  │
                                                                  ▼
                                                              Phase 7
                                                              Workspace
                                                              targeted edits

                                                                  │
                                                                  ▼
                                                              Phase 8
                                                              Smoke + tests + docs
```

Each phase = one commit boundary minimum. Phases 1 and 2 are foundations (no UI dependencies) and ship first. Phases 3–6 build the user-facing pipeline. Phase 7 layers on top of an approved build. Phase 8 hardens the whole thing.

---

## Phase 1 — Normalize Build and Deploy State

**Goal:** Make `deploy-site` create true preview deployments, persist them in `deployments`, and expose a `promote` path. The deploy worker stops being the canonical "what got deployed" record.

**Acceptance:** Phase D inserts a `deployments` row with `environment='preview', status='ready', provider='vercel', url=<vercel.app URL>`; `VercelClient.createDeployment()` defaults to creating a Preview (no `target`); `VercelClient.requestPromote()` exists with tests; preview build URLs work end-to-end without manual promote.

### Tasks

- [ ] **1a.** `apps/web/lib/vercel/client.ts` — change `createDeployment()` to accept an optional `target?: "preview" | "production"`. Default omits `target` (Vercel's preview path). Only include `target` in the POST body when `target === "production"`.
- [ ] **1b.** `apps/web/lib/vercel/client.ts` — add `requestPromote(projectId, deploymentId)` calling `POST /v10/projects/{projectId}/promote/{deploymentId}` (uses team header). Surfaces a `VercelApiError` on non-2xx.
- [ ] **1c.** `apps/web/lib/vercel/client.test.ts` — extend tests:
  - preview path: body has no `target` key.
  - production path: body has `target: "production"`.
  - `requestPromote` URL shape: includes `teamId`, Authorization header, throws on failure.
- [ ] **1d.** `apps/web/lib/vercel/client.ts` — env-var creation/update currently sets `target: ["production"]`. Update to `target: ["production", "preview"]` so preview builds read WP credentials. Update `client.test.ts`.
- [ ] **1e.** `apps/web/lib/inngest/functions/deploy-site.ts` — `create-deployment` step uses the new preview default (no explicit target). The deploy is a preview deploy.
- [ ] **1f.** `apps/web/lib/inngest/functions/deploy-site.ts` — add a new `record-preview-deployment` step inside the `READY` branch (after `on-success`) that inserts a `deployments` row:
  - `site_build_id = buildId`, `project_id = projectId`, `environment = 'preview'`, `status = 'ready'`, `provider = 'vercel'`, `provider_deployment_id = deployment.id`, `url = normalizedPreviewUrl`, `ready_at = now()`.
  - On the failure branch, insert with `status='failed'` (or skip — operator decision logged here: **insert with `status='failed'` so the deployments timeline shows every attempt**).
- [ ] **1g.** Add `apps/web/lib/inngest/functions/deploy-site.test.ts` (vitest, mocks Supabase + Vercel): asserts the preview deployment row is written exactly once on success and once with `status='failed'` on failure.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`

**Commit message:** `feat(saas-app): Phase 1 — Vercel preview semantics + promote + deployments table writes`

---

## Phase 2 — Top-level Build Trigger and Worker Chaining

**Goal:** A single server action starts the full pipeline. `discover-site` chains into `generate-components` automatically. Failures are uniformly captured.

**Acceptance:** Clicking Build site on a `status='ready'` project with no active build inserts `site_builds(status='queued', config={mode:'full'})`, dispatches `site/discover.requested`, returns the new buildId, and the worker chain runs unattended through preview deploy. Concurrent triggers are blocked. Any worker failure flips the row to `status='failed'` with `failed_phase` + `error_text`.

### Tasks

- [ ] **2a.** `apps/web/lib/jab/build-status.ts` (new) — pure helpers:
  - `BUILD_PHASES = ['queued','discovering','components','composing','building','verifying','ready','failed','cancelled'] as const`
  - `isActiveBuildStatus(s)` returns `true` for `queued|discovering|components|composing|building|verifying`.
  - `phaseLabel(s)` → human-readable.
- [ ] **2b.** `apps/web/lib/actions/trigger-build.ts` (new, replaces `trigger-discovery.ts` callers; keep `trigger-discovery.ts` as a thin wrapper for the smoke scripts that already call it):
  - `"use server"`.
  - Read user-scoped Supabase client. Verify project exists, RLS-scoped (single SELECT; `PGRST116` → throw "Not found").
  - Require `status='ready'`, `wp_url`, `wp_username`, `wp_app_password_encrypted`, `manifest` non-null. Throw clear errors if any is missing.
  - Query latest active build via `isActiveBuildStatus`. If found, throw "Active build in progress".
  - Insert `site_builds` via service-role admin client with `status='queued'`, `config={mode:'full'}`.
  - Dispatch `site/discover.requested` with `{ projectId, tenantId, buildId }`.
  - Returns `{ buildId }` (no redirect — the caller does it).
- [ ] **2c.** `apps/web/lib/inngest/functions/discover-site.ts` — at the end of the `try` block, dispatch `site/components.requested` with `{ projectId, tenantId, buildId }`. Place before `return { buildId, pages, blockTypes, menus }`. Use `step.sendEvent('dispatch-components', …)` so it sits cleanly in the trace.
- [ ] **2d.** `apps/web/lib/inngest/shared-failure.ts` (new) — `markBuildFailed({ buildId, projectId, phase, error })`:
  - Idempotent; updates `site_builds` with `status='failed'`, `failed_phase=phase`, `error_text=<message>`, `finished_at=now()`.
  - Returns `void` (don't re-throw).
- [ ] **2e.** Refactor the existing inline `catch` blocks in `discover-site.ts`, `generate-components.ts`, `compose-site.ts`, `deploy-site.ts` to call `markBuildFailed(…)`. The pre-existing pattern duplicates this logic; collapse it.
- [ ] **2f.** `apps/web/lib/actions/trigger-build.test.ts` — assert the active-build guard, the project-readiness guard, the insert + dispatch happy path.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`

**Commit message:** `feat(saas-app): Phase 2 — top-level build trigger + worker chaining + shared failure helper`

---

## Phase 3 — Build Progress Surface

**Goal:** A page the user lands on after clicking Build that reconstructs current build state from the database.

**Acceptance:** `/projects/[id]/builds/[buildId]/progress` renders the build's phase, counts, and an actionable link (preview URL on `ready`, retry on `failed`). Reconstructs from DB on every load (polling-based, no Realtime in v1). RLS-scoped via `createClient` (the user-Supabase client).

### Tasks

- [ ] **3a.** `apps/web/app/(app)/projects/[id]/builds/[buildId]/progress/page.tsx` (new):
  - Server component, dynamic.
  - Load project (RLS, 404 on missing).
  - Load build (RLS via project), 404 on missing.
  - Render a 6-step timeline using `BUILD_PHASES` from Phase 2; the current phase is `site_builds.status`.
  - Show counts: `page_count`, `block_type_count`, `component_count`, `fidelity_avg`.
  - When `status === 'ready'`: link to `/projects/[id]/builds/[buildId]/review` (Phase 5).
  - When `status === 'failed'`: show `failed_phase` + `error_text`; link to retry (Build site again).
  - Polling shim: `revalidate` via `<meta http-equiv="refresh" content="5">` for non-terminal states — minimal viable refresh for v1.
- [ ] **3b.** Update `lib/actions/trigger-build.ts` callers: after `{ buildId }` comes back, the caller redirects to `/projects/[id]/builds/[buildId]/progress`.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- Manual: trigger a build in dev (with `JAB_GENERATE_MOCK=1`), confirm the progress page reconstructs each phase.

**Commit message:** `feat(saas-app): Phase 3 — build progress surface`

---

## Phase 4 — Fidelity Verification (Phase E worker)

**Goal:** Close the loop by registering a `verifyFidelity` worker that consumes `site/verify.requested` and writes `fidelity_reports`. Builds reach `status='ready'` only after verification completes.

**Acceptance:** A build that reaches `verifying` either populates `fidelity_reports` per page and flips to `ready` (with `fidelity_avg` set), or fails with `failed_phase='verifying'`. Pages without source screenshots are recorded as skipped with explicit coverage metadata.

### Tasks

- [ ] **4a.** Add `pixelmatch` + `pngjs` to `apps/web/package.json` (`dependencies` — runtime worker code). Pin to known versions: `pixelmatch@^5.3.0`, `pngjs@^7.0.0`. (Skip if already present — re-check.)
- [ ] **4b.** `apps/web/lib/jab/playwright-verify.ts` (new):
  - `captureGeneratedScreenshots({ previewUrl, pages, viewports, buildId, projectId, tenantId })`.
  - Per page from `page_inventory`, navigate `${previewUrl}${page.route_path}`, screenshot at 3 viewports (1440 / 768 / 375), upload to `site-screenshots` bucket under `builds/<id>/generated/<page-id>/<vp>.png`.
  - Returns `Array<{ pageInventoryId, generatedScreenshotPaths, sourceMissing }>`.
- [ ] **4c.** `apps/web/lib/ai/fidelity-score.ts` (new):
  - `pixelDiffScore({ sourceBuffer, generatedBuffer })` returns `{ diffRatio, score }`. `score = 1 - diffRatio` clamped.
  - `flagForVision(diffRatio)` → boolean (default threshold `> 0.10`).
  - `visionScore({ sourceUrl, generatedUrl })` calls the LLM (reuse `lib/ai/model-client.ts` model selection); returns `{ score, issues }`. Cap at 15 pages per build (worker-side gate).
- [ ] **4d.** `apps/web/lib/inngest/functions/verify-fidelity.ts` (new):
  - Trigger: `site/verify.requested` with `{ projectId, tenantId, buildId }`.
  - Load build → its `preview_url` + `page_inventory` rows.
  - Capture generated screenshots via 4b.
  - Per page: pixel-diff (4c); if flagged, vision-score; else record score-only row.
  - Insert/upsert `fidelity_reports` rows. Compute `fidelity_avg` (mean over scored pages; skipped pages don't count).
  - Update `site_builds` to `status='ready'`, `fidelity_avg`, `finished_at`.
  - On any throw → `markBuildFailed({ phase: 'verifying' })`.
- [ ] **4e.** `app/api/inngest/route.ts` — register `verifyFidelity` in the `serve()` functions array.
- [ ] **4f.** Unit tests:
  - `apps/web/lib/ai/fidelity-score.test.ts` — pixel diff math, threshold, vision cap.
  - `apps/web/lib/inngest/functions/verify-fidelity.test.ts` — happy path inserts rows, skip path records coverage, failure path calls `markBuildFailed`.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`

**Commit message:** `feat(saas-app): Phase 4 — verifyFidelity worker (Phase E)`

---

## Phase 5 — Review and Publish Gate

**Goal:** A mandatory pre-publish review screen that gates production promote. Approvals persist on `fidelity_reports`; publish promotes via Vercel and inserts a `deployments` row with `environment='production'`.

**Acceptance:** Publish is impossible until all `fidelity_reports` rows are `approved` or `approved_with_issues`. Publish calls `VercelClient.requestPromote()`, inserts a `deployments` row with `environment='production'`, marks prior production rows `superseded`, and sets `deployments.promoted_from_deployment_id` to the preview row.

### Tasks

- [ ] **5a.** New migration `drizzle/migrations/0023_fidelity_approval_rpc.sql`:
  - `CREATE OR REPLACE FUNCTION public.approve_fidelity_report(p_build_id uuid, p_page_inventory_id uuid, p_status text) RETURNS void` (SECURITY DEFINER, restricted to columns `approval_status`, `approved_by_user_id=auth.uid()`, `approved_at=now()`, and only when caller is a tenant member of the parent project).
  - `GRANT EXECUTE ... TO authenticated`.
- [ ] **5b.** `apps/web/lib/actions/build-review.ts` (new):
  - `approvePageAction(buildId, pageInventoryId)` — calls the RPC with `approved`.
  - `approvePageWithIssuesAction(buildId, pageInventoryId)` — `approved_with_issues`.
  - `rejectPageAction(buildId, pageInventoryId)` — `rejected`.
  - `publishBuildAction(buildId)`:
    - RLS verify project membership.
    - Verify build `status='ready'`.
    - Verify every `fidelity_reports` row for this build is `approved` or `approved_with_issues`.
    - Find the preview `deployments` row (latest ready preview for this build).
    - Call `VercelClient.requestPromote()`.
    - In a transaction: insert new `deployments` row (`environment='production'`, `status='ready'`, `promoted_from_deployment_id`), and `UPDATE deployments SET status='superseded' WHERE environment='production' AND project_id=… AND id != new.id`.
- [ ] **5c.** `app/(app)/projects/[id]/builds/[buildId]/review/page.tsx` (new):
  - Server component, RLS-scoped.
  - Load build, page_inventory, fidelity_reports.
  - Show preview URL, counts, average fidelity, screenshot coverage.
  - Per-page rows: source thumb + generated thumb + score + issues + approval status + approve / approve-with-issues / reject buttons (server-action forms).
  - Publish button: enabled only when every row is approved/approved_with_issues. Posts to `publishBuildAction`.
- [ ] **5d.** Unit tests:
  - `lib/actions/build-review.test.ts` — gate enforcement, transactional state changes.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`

**Commit message:** `feat(saas-app): Phase 5 — review/publish gate with Vercel promote`

---

## Phase 6 — Wire Project + Dashboard UI to Real Data

**Goal:** Stop lying. The project detail page and dashboard cards show actual build/deploy state for real projects. `live = false` becomes `live = !!productionDeployment`.

**Acceptance:** A real `status='ready'` project with no deploys shows "Setup complete" (current behavior). A project with a ready preview shows the preview URL + a link to Review. A project with a production deployment shows live with the real URL + real deploy history. The Build site button is enabled when there's no active build.

### Tasks

- [ ] **6a.** `apps/web/lib/jab/load-project-builds.ts` (new):
  - `loadProjectBuildState(projectId)` returns `{ latestBuild, latestPreview, productionDeployment, deployHistory, fidelitySummary, hasActiveBuild }`.
  - Uses RLS-scoped client; the file is a server-only data accessor.
- [ ] **6b.** `app/(app)/projects/[id]/page.tsx` — replace the hardcoded `const live = false` block:
  - Call `loadProjectBuildState`.
  - `live = !!productionDeployment`.
  - When `live`, the header URL chip uses the production URL; deploy history is the real array.
  - When a preview exists but no production: surface a "Review build" CTA pointing at the review page.
  - Build site button: enabled when `setupComplete && !hasActiveBuild`. Posts to `triggerBuildAction`.
  - Remove imports from `./mocks` once the real data covers each card. Keep the workspace AI panel mocked for now (Phase 7).
- [ ] **6c.** `app/(app)/dashboard/page.tsx` — dashboard project cards:
  - For each project, show production URL if `productionDeployment`. Show latest build status from `latestBuild`.
  - Do not derive deploy status from the placeholder mock map for real projects. Keep `/ui-kit/*` routes untouched.
- [ ] **6d.** Snapshot tests for the data accessor (mocked Supabase). Skip visual snapshot tests in v1.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`
- Manual: load a project with builds in different states; confirm no mocked deploy history leaks through.

**Commit message:** `feat(saas-app): Phase 6 — project + dashboard UI on real build/deploy data`

---

## Phase 7 — Workspace Targeted Edits

**Goal:** Replace the workspace's simulated AI panel with a real targeted-edit loop. Edits regenerate one component/shell, re-run compose → preview deploy → verify, and stage a new build.

**Acceptance:** Submitting a prompt against an approved or `ready` build inserts a `workspace_edits` row, dispatches `site/edit.requested`, and produces a new `site_builds` row that the user lands on. Production is never mutated by an edit; only an explicit publish promotes it.

### Tasks

- [ ] **7a.** New migration `drizzle/migrations/0024_workspace_edits.sql`:
  - Columns: `id`, `project_id`, `tenant_id`, `source_build_id`, `result_build_id NULL`, `user_id`, `scope` (`'page'|'component'|'shell'`), `target` (text — block name, page id, or shell kind), `prompt` text, `status` (`'queued'|'running'|'completed'|'failed'`), `error_text`, `created_at`, `finished_at`.
  - Add to `lib/db/schema.ts`.
  - RLS: SELECT scoped through `project_id`; INSERT scoped through `project_id IN (tenant projects)` with `WITH CHECK auth.uid() = user_id`.
- [ ] **7b.** `apps/web/lib/actions/workspace-edit.ts` (new) — `requestWorkspaceEditAction({ projectId, sourceBuildId, scope, target, prompt })`:
  - RLS verify; require source build `status='ready'` and approved or freshly built.
  - Insert `workspace_edits` row.
  - Dispatch `site/edit.requested`.
  - Return `{ editId }`.
- [ ] **7c.** `apps/web/lib/inngest/functions/edit-site.ts` (new) — worker:
  - Trigger: `site/edit.requested`.
  - Insert new `site_builds` (status `queued`, `config = { mode: 'edit', source_build_id, scope, target, prompt }`).
  - Copy artifacts from `source_build_id` (block_inventory rows, page_inventory rows, components) into the new build's Storage prefix. Use Storage `copy`/`upload-from-existing` rather than re-generation.
  - Regenerate only the targeted artifact:
    - `scope='component'` → re-run `generateComponent({ guidance: prompt })` for the targeted block.
    - `scope='shell'` → re-run `generateShell({ kind: target, guidance: prompt })`.
    - `scope='page'` (v1 may defer to a follow-up): out-of-scope for v1 — the action validates and refuses with a clear error.
  - Re-run compose → dispatch deploy.
  - Update `workspace_edits.result_build_id` to the new build id.
  - On failure, `markBuildFailed` and `workspace_edits.status='failed'`.
- [ ] **7d.** `apps/web/lib/ai/component-generator.ts` — extend the generation entry point to accept an optional `guidance?: string` and append it to the user prompt. Same for `generate-shell.ts`.
- [ ] **7e.** `app/(app)/projects/[id]/workspace/page.tsx` — when the project has an approved build, swap the demo's simulated AI panel for a real form that posts to `requestWorkspaceEditAction`. Show real edit history pulled from `workspace_edits`.
- [ ] **7f.** Unit tests:
  - `edit-site.test.ts` — artifact reuse, guidance plumbing through to the generator, dispatch order.
  - `workspace-edit.test.ts` — gate enforcement, RLS-via-tenant.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test`

**Commit message:** `feat(saas-app): Phase 7 — workspace targeted edits`

---

## Phase 8 — Smoke + Test Coverage + Docs

**Goal:** End-to-end confidence. The full pipeline runs in a mocked smoke script. Top-level docs reflect the completed pilot.

### Tasks

- [ ] **8a.** `apps/web/scripts/smoke-build.ts` (new) — drives `triggerBuildAction` against a known seeded project with `JAB_GENERATE_MOCK=1`, polls `site_builds.status` until `ready` (or fails on timeout / `status='failed'`).
- [ ] **8b.** `apps/web/scripts/smoke-deploy-site.ts` — update so `verifying` is no longer treated as terminal success (Phase 4 changed the contract).
- [ ] **8c.** `apps/web/scripts/smoke-verify.ts` (new) — drives verify-only against a fixed deploy build (useful for iterating on Phase 4 without re-running B/C/D).
- [ ] **8d.** `apps/web/package.json` — add `smoke:build` and `smoke:verify` scripts.
- [ ] **8e.** `CLAUDE.md` — update the SaaS-track status table: Phases A–D shipped → Phases E + F + Stage 7 shipped (this plan). Bump 2026-05-27 snapshot stamp.
- [ ] **8f.** `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md` — mark Stages 5, 6, 7 done.
- [ ] **8g.** This plan: tick every checkbox.

**Verify:**
- `pnpm --filter @jab/web typecheck`
- `pnpm --filter @jab/web test` — all green.
- `pnpm --filter @jab/web smoke:build` — runs end-to-end in mock mode.

**Commit message:** `chore(saas-app): Phase 8 — smoke runners + tests + docs sync`

---

## Final Acceptance Criteria (pilot-ready)

1. A `status='ready'` project can start a full build from the app UI (no smoke script).
2. The build reaches a real preview URL without manual phase dispatch.
3. Fidelity verification runs and writes per-page reports.
4. The reviewer can approve every page and publish to production.
5. Publish promotes the approved Vercel deployment and records a production `deployments` row; prior production rows are marked `superseded`.
6. The workspace can request a targeted edit that produces a new staged build pointing at the same project.
7. Project + dashboard surfaces show real build / deploy state for real projects (no mocked deploy history leaks).
8. Tests cover the state machine, deploy semantics, review gate, and targeted edit loop.

---

## Out of scope (explicit deferrals)

- WP plugin work (v0.7.x track is parallel; do not touch).
- Payment / subscription / quota tiers / SaaS admin tooling.
- Public-beta reliability beyond internal-pilot basics.
- Custom domain DNS management.
- Full agent IDE / file-diff editing inside the workspace.
- Refresh / Reimagine intent variants of the build trigger.
- Lighthouse / accessibility scoring inside the fidelity report.
- Multi-tenant concurrency beyond one active build per project.
