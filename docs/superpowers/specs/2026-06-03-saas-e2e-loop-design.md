# SaaS End-to-End Loop — Unified Implementation Design

> **Status:** Approved 2026-06-03 (Sean) — ready to plan into TDD task batches.
> **Scope:** `apps/web` (`@jab/web`). Completes the managed-platform loop: migrate/generate → real dashboard → workspace → chat-driven edit → live preview → review gate → promote to production.
> **Supersedes:** the four isolated subsystem drafts (Dashboard data, Live preview, Chat targeted-edit, Review→promote). This is the single integrated spec; the four drafts are inputs, not the contract.
> **Ground-truth snapshot:** 2026-06-03, latest migration **0027** (`0027_page_inventory_block_tree.sql`).
> **Verifier blockers/majors:** resolved inline (see §7 "Resolutions log"); deliberate deferrals in §6.

---

## 1. Overview

Today the platform can take a connected WordPress site all the way to a published Next.js site: discover → generate components → compose → deploy a **Vercel preview** → fidelity-verify → mandatory per-page review → promote to production. That **build→preview→review→promote** half is real and reused verbatim. What is missing is the **iterate** half: the dashboard shows fabricated numbers once a site is live, the workspace preview iframe is hardcoded empty (`previewHtml: null`), the chat panel is a pure client-side mock with no server action and no table, and the edit worker clones a build byte-for-byte without ever regenerating the targeted unit (the guidance-driven regen was deferred to "Phase 7.1").

This design closes the iterate loop. A user types a free-form request in the workspace chat ("make the hero bolder"); a planning LLM resolves it against a compact site map into a structured `EditPlan`; the edit worker clones the prior `ready` build, **regenerates only the targeted unit** with that guidance, re-composes deterministically, and deploys a new **preview**; the workspace preview pane shows that preview live with per-phase progress; the review gate is **scoped to only the pages the edit actually changed** (untouched pages carry forward their prior approval so the existing all-approved invariant still holds); the user approves and promotes through the exact same promote path a full build uses. Every turn, plan, edit, and deployment is persisted and audit-linked. The dashboard shows only measured numbers; anything not measured is omitted, never invented.

### Lifecycle flow

```
                 ┌─────────────────────── full build (existing, reused) ──────────────────────┐
                 │                                                                             │
  connect WP ──► discover ──► components ──► compose ──► deploy(PREVIEW) ──► verify ──► REVIEW ─┴─► PROMOTE ──► production
                                                              │                          gate          (requestPromote +
                                                              ▼                       (all pages         supersede sweep)
                                                        preview_url                    approved)
                                                              │
   ┌──────────────────────────── iterate loop (NEW) ─────────┼───────────────────────────────────────────────┐
   │                                                          ▼                                                │
   │  workspace chat ──► planner LLM ──► EditPlan ──► edit-site worker:                                        │
   │   "make hero bolder"   (Sonnet)   {scope,target,    1. clone source `ready` build (inventory + storage)   │
   │        ▲                           regenPrompt}     2. regenerate ONLY targeted unit (guidance)           │
   │        │                                            3. compute changed pages (from SOURCE block_tree)     │
   │        │  clarifying question                       4. dispatch compose ──► deploy(PREVIEW) ──► verify    │
   │        │  (target ambiguous / vague)                         │                                  │         │
   │        └────────────────────────────────────────────────────┘                                  ▼         │
   │                                                                              verify finalize (edit-aware):│
   │   workspace preview pane shows the NEW preview ◄──── preview_url ────────────  carry-forward approvals    │
   │   (per-phase progress while building)                                         (untouched pages inherit;   │
   │        │                                                                       changed pages → pending)   │
   │        ▼                                                                                                  │
   │   SCOPED REVIEW (only changed pages actionable) ──► PROMOTE (same path) ──► production                    │
   │        │                                                                                                  │
   │        └──► reject / discard ──► auto-release edit slot ──► back to chat                                  │
   └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Build state machine (`site_builds.status`)

The state machine is **unchanged** by this design. Reference (from `lib/jab/build-status.ts`):

```
queued ─► discovering ─► components ─► composing ─► building ─► verifying ─► ready
   │           │             │            │            │            │
   └───────────┴─────────────┴────────────┴────────────┴────────────┴──► failed   (markBuildFailed, any worker catch)
   │
   └──► cancelled   (NEW terminal: discardEditAction direct UPDATE — see §3.4; markBuildFailed never writes 'cancelled')

ACTIVE   = { queued, discovering, components, composing, building, verifying }   (isActiveBuildStatus)
TERMINAL = { ready, failed, cancelled }
```

An **edit build** is just another `site_builds` row with `config.mode === "edit"`. It travels the identical status path. The only edit-specific behavior is (a) the regen step inside `edit-site`, (b) the carry-forward branch inside `verify-fidelity`'s finalize, and (c) presentational scoping of the review screen — all gated on `config.mode === "edit"`.

---

## 2. Architecture

### 2.1 The four subsystems and how they fit

| # | Subsystem | Owns | Depends on |
|---|-----------|------|------------|
| **S1** | Dashboard & Project Data | Real quick-stats, AI history, deploy-history labels, the four tab routes, perf capture in verify. | Nothing in S2–S4 except reading the shared `config` schema for deploy-history labels. **Independent parallel track.** |
| **S2** | Workspace Live Preview | **Sole owner of the workspace preview slot.** `WorkspacePreviewState`, `deriveWorkspacePreviewState`, `WorkspacePreviewPane`, the preview-reachability guard, the build-phase-aware building state, the poll-vs-refresh decision. | Reads `loadProjectBuildState` (exists). **Ships first — thin vertical slice.** |
| **S3** | Chat Targeted-Edit | **Sole owner of the `edit-site.ts` regen seam, the generator `guidance` param, the shared `site_builds.config` schema, and the `site/edit.requested` payload extension.** Conversations + messages, planner LLM, `EditPlan`, site map, regenerate-unit, chat UI. | Consumes S2's `WorkspacePreviewPane`. Produces the changed-page inputs S4 consumes. |
| **S4** | Review Gate → Promote | Changed-page computation, approval carry-forward, the edit-aware concurrency guard + DB index, discard, scoped review screen, promote lineage. | Consumes S3's regen output and shared `config` schema. Consumes S2's preview pane. |

**Critical ownership rules (resolve verifier blockers):**

1. **One migration sequence.** All new migrations are authored as one ordered batch and applied **once, in order, to BOTH Supabase projects** (`ajfurojjxthhzkjqttri` = local/"JAB WP", `celzwcxkrmsbwiswkxug` = "jab-prod") per the standing two-projects rule. See §2.3.
2. **S3 is the sole writer of `edit-site.ts`'s regen seam** (lines 187–198) and the sole owner of the generator `guidance` parameter. S4 never re-implements regen; it only reads the changed-page set S3 produces. There is exactly one rewrite of that 14-line region.
3. **S2 is the sole owner of the workspace preview slot.** S3 and S4 consume `WorkspacePreviewPane`/`WorkspacePreviewState`; neither touches `previewHtml` or the `srcDoc` iframe directly. (The existing `srcDoc` slot renders a string as literal HTML — it **cannot** load an external URL; only S2's `PreviewFrame` with `src=` is correct.)
4. **One `site_builds.config` schema** (§2.4) and **one `site/edit.requested` payload** (§2.5), defined once in S3 and consumed by S4.
5. **One `workspace_edits.scope` enum** (§2.6), defined once in `lib/jab/workspace-edit-validation.ts`. Deferred scopes are **not** added to the enum or the DB CHECK until the worker can handle them (no unreachable enum values).
6. **One owner per shared file.** `verify-fidelity.ts` is edited by S1 (perf), S4 (carry-forward + cancel guard). These land as **one coordinated change** in the edit-loop phase, not three overlapping diffs. `workspace/page.tsx` and the `WorkspaceProject` interface are edited by S2 first; S3/S4 build on the result.

### 2.2 Canonical answer: "which build is current for a project?"

There are two distinct, non-competing notions, and conflating them is the source of the "three different words" problem the verifier flagged. The single source of truth is **`loadProjectBuildState(supabase, projectId)`** (`lib/jab/load-project-builds.ts`). It returns three fields, each with a precise meaning:

| Field | Meaning | Used for |
|-------|---------|----------|
| `productionDeployment` | The current `deployments` row with `environment="production" AND status="ready"`. **This is what `live = !!productionDeployment` keys on.** | The user-visible production site. The project-header "Live" chip and the dashboard "Live" badge. |
| `latestBuild` | The most recent `site_builds` row (by `created_at`), **regardless of `config.mode`**. | "Is anything building right now?" — drives `hasActiveBuild` and the "Building"/"updating" badge. |
| `latestPreview` | The most recent `deployments` row with `environment="preview" AND status="ready"` **scoped to `latestBuild.id`**. | The workspace preview pane's iframe source. |

So for a project that is **live in production with an edit build in flight**, the three surfaces are *internally consistent*: production header = "Live", dashboard badge = "Building", workspace preview = "building spinner". To make this **one legible story** (verifier minor), all three surfaces render a **single shared status label** derived from these three fields:

```ts
// lib/jab/project-status-label.ts  (NEW, pure)
export type ProjectStatusLabel =
  | "in-setup" | "building" | "live" | "live-updating" | "needs-review" | "failed";

export function deriveProjectStatusLabel(s: ProjectBuildState): ProjectStatusLabel
//  productionDeployment && hasActiveBuild      -> "live-updating"   ("Live · updating")
//  productionDeployment && editAwaitingReview  -> "needs-review"    ("Live · review ready")
//  productionDeployment                        -> "live"
//  hasActiveBuild                              -> "building"
//  latestBuild?.status === "failed"            -> "failed"
//  else                                        -> "in-setup"
```

Dashboard, project header, and workspace all render from `deriveProjectStatusLabel` — one word per state, everywhere.

**Ownership (planning reconciliation, 2026-06-03):** **Phase 1 (S2) is the sole author and renderer** of `deriveProjectStatusLabel` and `projectStatusLabelText`, and rewrites the dashboard badge, the project-header chip, and the workspace status across all three surfaces in one place. **Phase 3 (S1) only adds the "Live · updating" regression fixture** and imports `projectStatusLabelText` — it must not re-implement the label table or re-rewrite the badge/chip. The function parameter is the full `ProjectBuildState` (plus an optional `editAwaitingReview` flag); callers pass the loaded `buildState` variable, never a literal-with-extras. This resolves the cross-plan blocker where both phases independently rewrote `ProjectStatusBadge` with competing label tables.

### 2.3 Data-model deltas — consolidated migration sequence

Authored as one ordered batch. **Apply in this order to BOTH Supabase projects.** No two subsystems share a number.

| Migration | Owner | Adds | Notes |
|-----------|-------|------|-------|
| **`0028_build_perf_metrics.sql`** | S1 | `site_builds`: `ttfb_ms integer`, `load_ms integer`, `transfer_bytes bigint`. **No `perf_score`** (dropped — see §3.1 / §7). | Additive, nullable, no backfill. |
| **`0029_chat_conversations.sql`** | S3 | New `conversations`, `chat_messages` tables (+ RLS, indexes). See §2.7. | |
| **`0030_workspace_edit_provenance.sql`** | S3 + S4 **merged** | `workspace_edits`: `regeneration_prompt text`, `action text`, `message_id uuid`, `changed_slugs text[]`, `change_reason text`, `result_promoted_deployment_id uuid`. **One** `status` CHECK rewrite (adds `'discarded'`). **No `scope` CHECK change** (scope enum unchanged this round — see §2.6). | **This is the single ALTER of `workspace_edits`.** Both subsystems' columns land here so the CHECK constraints are rewritten exactly once. `message_id` FK references `chat_messages(id)` so 0029 must precede it. |
| **`0031_one_active_build_per_project.sql`** | S4 | Partial unique index on `site_builds(project_id)` `WHERE status IN ('discovering','components','composing','building','verifying')`. **Excludes `'queued'`** (see §3.4 — lets racing inserts both land so the app-level check arbitrates and avoids a permanent wedge). | Lands **independently and first among S3/S4 work** with error-translation wired into both `triggerBuildAction` and `requestWorkspaceEditAction` (catch `23505` → friendly `active_build`). |

**Net new tables:** `conversations`, `chat_messages`. **Net new columns on existing tables:** `site_builds` (3 perf cols), `workspace_edits` (6 provenance cols + `'discarded'` status). **No** new column on `block_inventory`, `shell_generations`, or `fidelity_reports`. Edit intent rides in `site_builds.config` (jsonb, exists). Approval carry-forward writes existing `fidelity_reports` columns via service-role.

Mirror every column in `lib/db/schema.ts`. Record the apply in the migrations log.

### 2.4 Canonical `site_builds.config` schema

Defined once (S3 owns the type in `lib/jab/build-config.ts`), consumed by S3 worker, S4 carry-forward, S1 deploy-history labels.

```ts
// lib/jab/build-config.ts  (NEW)
export type BuildConfig =
  | { mode: "full" }
  | {
      mode: "edit";
      source_build_id: string;
      scope: WorkspaceEditScope;          // §2.6
      target: string;                     // block_name | shell kind ('header'|'footer')
      prompt: string;                     // raw user/plan text (human-readable)
      regeneration_prompt: string;        // guidance threaded into the generator
      action: string;                     // planner's human summary, e.g. "Regenerated the Hero block"
      edit_id: string;                    // workspace_edits.id
      message_id: string | null;          // chat_messages.id that triggered it (null for the manual form path)
      changed_slugs: string[];            // computed by edit-site's compute-changed-pages step
      change_reason: "component_pages" | "shell_all" | null;
    };
```

This is the **only** shape written to `config`. S4's carry-forward reads `config.source_build_id` and `config.changed_slugs`; S1's deploy-history label reads `config.mode` and `config.prompt` directly off the already-loaded build row (no extra join).

### 2.5 Canonical `site/edit.requested` payload

```ts
// extends the existing payload; new fields optional for the manual-form back-compat path
{
  editId: string;
  projectId: string;
  tenantId: string;
  sourceBuildId: string;
  scope: WorkspaceEditScope;
  target: string;
  prompt: string;
  regenerationPrompt?: string;   // NEW — manual form falls back to `prompt`
  action?: string;               // NEW
  messageId?: string | null;     // NEW
}
```

### 2.6 Canonical `workspace_edits.scope` enum

```ts
// lib/jab/workspace-edit-validation.ts — single source of truth
export type WorkspaceEditScope = "component" | "shell";
```

**This round ships only `component` and `shell`** — exactly what the regen engine can handle. `page` / `page-content` / `global-style` are **deliberately NOT added** to the enum or the DB CHECK (verifier blocker: an unreachable enum value invites the planner to emit it and the validator to silently downgrade — the fake-affordance pattern). The planner system prompt is constrained to emit only `component` and `shell`. When per-page regen lands later, the enum, CHECK, planner, and worker are widened in one coordinated change. (The existing `scope` CHECK already allows `'page'` from migration 0024; we leave it as-is — we do not narrow it, but the validator and planner never produce it.)

### 2.7 New chat tables (migration 0029)

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by_user_id uuid not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_project_idx on public.conversations(project_id, created_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  plan jsonb,                         -- the EditPlan (audit), null for user rows
  needs_clarification boolean not null default false,
  edit_id uuid references public.workspace_edits(id) on delete set null,
  build_id uuid references public.site_builds(id) on delete set null,
  input_tokens_cached int not null default 0,
  input_tokens_uncached int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index chat_messages_conversation_idx on public.chat_messages(conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.chat_messages enable row level security;

-- Reads go through the RLS user client (the policies are load-bearing — see §3.3).
create policy conv_select on public.conversations for select
  using (tenant_id in (select tenant_id from public.tenant_members where user_id = auth.uid()));
create policy msg_select on public.chat_messages for select
  using (project_id in (
    select p.id from public.projects p
    join public.tenant_members tm on tm.tenant_id = p.tenant_id
    where tm.user_id = auth.uid()));
-- No client INSERT policy: all writes go through the server action (service-role
-- admin client) which performs its own tenant-membership check first.
```

---

## 3. Subsystem designs

### 3.1 S1 — Dashboard & Project Data

**Scope correction (verifier major):** the project page **already** gates `quickStats`, `aiHistory`, `aiCreditsRemaining`, and the deploy list behind `live` (`page.tsx:228/846/941/977`), and `realWpConnectionFrom` (`page.tsx:616`) already replaced the WP-connection mock. So no user sees fake data **until a project is live**. The genuine remaining fake-as-fact is narrow: a **live** project shows hardcoded Lighthouse 94 / TTFB 38ms / Build 2.1s / Content items 47 / Content types 8 and three fabricated AI prompts. This subsystem fixes exactly that, and resolves the four "Coming soon" tabs.

**Reuse:** `loadProjectBuildState`/`loadDashboardBuildStates`, `deployments` table, `page_inventory`/`block_inventory` counts (already denormalized onto `site_builds`), `fidelity_reports` + `site_builds.fidelity_avg`, `loadWorkspaceEditHistory`, `lib/jab/playwright-verify.ts`, `verify-fidelity.ts`, `lib/jab/build-status.ts`, `lib/format-relative.ts`.

**New files:** `lib/jab/perf-capture.ts` (pure `extractPerf(navTimingJson) → { ttfbMs, loadMs, transferBytes }`); `lib/jab/build-quick-stats.ts` (pure `(buildSummary, contentOwnership) → QuickStat[]`, **omits any stat whose value is null**); `lib/jab/load-project-content.ts`; `lib/jab/project-status-label.ts` (§2.2); tab routes `app/(app)/projects/[id]/tabs/{content,deploy,ai,settings}/page.tsx`; `app/(app)/projects/[id]/layout.tsx` (shared tab bar). Unit tests for each pure module.

**Changed files:**
- `mocks.ts` — delete `lighthouse`, `quickStats`, `aiHistory`, `aiCreditsRemaining`, and the unused `wpConnection`/`deploys`/`lastDeployedRelative` literals; remove the `SITE_DETAIL_MOCKS` export. Keep only type-only row interfaces, moved to `mocks-types.ts`.
- `projects/[id]/page.tsx` — build `quickStats` from `build-quick-stats.ts` (Content types from `content_ownership`/`blockTypeCount`, Content items = `pageCount`, Components = `componentCount`, Fidelity = `fidelityAvg`, TTFB/Load from the new build columns); render only stats with real values. AI Update card history from `loadWorkspaceEditHistory(project.id, 5)`; **remove the credits chip entirely**. Replace `<InactiveTab>` spans with real `<Link>` tabs. Deploy-history `message`: read `config.mode`/`config.prompt` **directly off the already-loaded build row** ("Full build" / "AI edit: <excerpt>") — no second `workspace_edits` join (verifier minor).
- `load-project-builds.ts` — extend `BuildSummary` with `ttfbMs`, `loadMs`, `transferBytes` (+ map in `toBuildSummary`). `live` semantics unchanged.
- `verify-fidelity.ts` — **(coordinated with S4 — single owner for this file in the edit-loop phase)** add perf capture *inside the existing `capture-generated` Playwright loop* (verifier major: `captureGeneratedScreenshots` closes its context per page and returns only paths, so add an optional `collectPerfForHomeRoute` that runs `page.evaluate(() => performance.getEntriesByType('navigation')[0])` on the home route and threads `{ ttfbMs, loadMs, transferBytes }` back alongside paths). Write the perf columns in `finalize`. **Fail-soft:** any perf error logs and leaves the columns null — perf never fails the build. The `mark-ready-empty` early-return path leaves perf null (acceptable).

**Key signatures:**
```ts
extractPerf(nav: PerformanceNavigationTimingJSON): { ttfbMs: number|null; loadMs: number|null; transferBytes: number|null }
buildQuickStats(b: BuildSummary, ownership: ContentOwnership|null): QuickStat[]   // omits null-valued
loadProjectContent(supabase, buildId): Promise<{ pages: PageRow[]; blockTypes: BlockTypeRow[] }>
deriveProjectStatusLabel(s: ProjectBuildState): ProjectStatusLabel
```

**Guardrails:**
- **No invented numbers.** Stats with null values are omitted, never shown as `0`. Builds predating 0028 have null perf → those stats simply don't render.
- **No `perf_score` composite.** The single fuzzy 0–100 score (the draft's own open question recommended against it) is dropped from the migration and the UI. We ship **measured** TTFB / Load / transfer only, each labeled as raw timing. A composite is a follow-up requiring an explicit, tooltip-documented formula — not baked into the schema now.
- **Tabs are real or honestly deferred.** Content/Deploy/AI tabs re-present existing data; Settings shows `DesignTokensReview` + connection summary (never secrets) + Vercel link + an explicitly-labeled "Billing & credits — not available yet" placeholder. No `cursor-not-allowed` dead ends.
- **Cross-tenant safety:** all tab routes use the RLS client and `notFound()` on PGRST116.
- **Perf reuse, not a second launch:** perf is collected in the same Chromium context the home-page screenshot already uses; no extra cold launch. The fidelity-scoring behavior is pinned by existing tests to prove the perf addition doesn't perturb capture.

### 3.2 S2 — Workspace Live Preview (sole owner of the preview slot)

**Goal:** replace `previewHtml: null` (`workspace/page.tsx:79`) with a real, sandboxed iframe loading the latest Vercel **preview** URL of the project's current build, with honest none/building/ready/failed states, a build-phase-aware building view, a responsive device toggle, and live refresh when a newer preview finishes. The preview URL is **already persisted** (`site_builds.preview_url` + `deployments` preview row) and `loadProjectBuildState.latestPreview` already derives it — this is overwhelmingly wiring.

**Reuse:** `lib/vercel/client.ts` (`createDeployment` already omits `target` → Preview channel; `requestPromote` exists), `deploy-site.ts` (already writes `preview_url` + preview `deployments` row), `loadProjectBuildState`, `components/preview-frame.tsx` (external `src`, hardened sandbox `allow-scripts allow-same-origin allow-forms allow-popups`, `referrerPolicy="no-referrer"`, device toggle, copy/open-in-tab, idle/deploying/failed placeholders), `components/scaled-iframe.tsx` (true-viewport scaling so the deployed site's own breakpoints fire), the progress page's polling pattern, `lib/jab/build-status.ts` `phaseLabel`.

**New files:**
- `lib/jab/workspace-preview-state.ts` — pure `deriveWorkspacePreviewState(s: ProjectBuildState): WorkspacePreviewState`:
  ```ts
  type WorkspacePreviewState =
    | { kind: "none" }
    | { kind: "building"; buildId: string; phase: string }   // phase from latestBuild.status -> phaseLabel
    | { kind: "ready"; url: string; buildId: string; deploymentId: string }
    | { kind: "failed"; buildId: string; failedPhase: string };
  ```
- `components/workspace-preview-pane.tsx` (`"use client"`) — wraps `PreviewFrame`, maps `kind → status`, owns the poll effect, renders empty/building/failed copy. The **building** state surfaces the actual `phase` (not a bare spinner) + a "View full progress" link to `/projects/[id]/builds/[buildId]/progress` (verifier major: a 2–3 min edit must not look hung).
- `lib/actions/workspace-preview.ts` — `loadWorkspacePreviewStateAction(projectId)`: RLS project SELECT → `loadProjectBuildState` → `deriveWorkspacePreviewState`. Re-validates per call; client sends only `projectId`.
- `lib/vercel/preview-protection.ts` — `assertPreviewReachable(url)` + `PreviewProtectedError` (HEAD/GET; 401/403 → throw). Guards against Vercel team-level Deployment Protection silently gating previews behind an SSO wall.
- Tests: `workspace-preview-state.test.ts` (every kind + the subtle races), `preview-protection.test.ts`.

**Changed files:**
- `workspace/page.tsx` — compute `previewState = deriveWorkspacePreviewState(buildState)` (buildState already loaded at line 72); drop `previewHtml: null`; pass `previewState`. Keep `dynamic = "force-dynamic"`.
- `workspace-jab-demo.tsx` — `WorkspaceProject.previewHtml` → `previewState?: WorkspacePreviewState | null`. `PreviewPane` (line 1374): replace the `srcDoc`/`NoPreviewFallback` branch with `<WorkspacePreviewPane state={...} .../>`. **Leave the `!project → <SiteMock/>` branch (line 1521) untouched** so `/ui-kit/workspace-jab` still demos. Strip the redundant inline device toggle (PreviewFrame owns it, and adds tablet for free).

**Guardrails / edge cases (the correctness core, all covered by `workspace-preview-state.test.ts`):**
- **Ready-but-preview-row-not-written-yet race:** when `latestBuild.status` is `ready`/`verifying` but `latestPreview` is still null (the `record-preview-deployment` step hasn't run), `deriveWorkspacePreviewState` returns `building`, **not** `none` — so we keep polling instead of flashing the empty state.
- **Stale prior-build preview:** `latestPreview` is already scoped to `latestBuild.id`, so a previous build's preview never leaks. New build in flight → `building` (v1 hides the old preview; showing last-good with an "updating" badge is deferred).
- **Vercel preview protection:** `assertPreviewReachable` surfaces `PreviewProtectedError` loudly (log + optional banner "Preview is protected — disable Deployment Protection in Vercel") rather than a blank iframe. Does **not** auto-fail the build (operator-recoverable).
- **Sandbox:** reuse `PreviewFrame`'s external-`src` sandbox; `allow-same-origin` is safe because the iframe origin is the Vercel preview domain, not the app origin. `allow-top-navigation` omitted → preview can't frame-bust the workspace.
- **Poll, not meta-refresh (a11y + state):** poll only while `kind==="building"`, ≥5s interval, guard against overlapping in-flight calls, clear on unmount. Meta-refresh full-reloads every 5s and resets chat focus/scroll — rejected for the workspace (a11y regression).
- **Cost:** zero new deploys — display only. Poll is a cheap RLS SELECT.

### 3.3 S3 — Chat Targeted-Edit (sole owner of regen + the edit-site seam)

**Goal:** turn the mocked chat panel into the product's core loop. Planner LLM interprets the conversation against a compact site map → `EditPlan`; when concrete, the **deferred guidance-driven regeneration** runs in `edit-site.ts` for **only** the targeted unit; clone + regen + compose + preview-deploy + verify; chat shows a "what changed" card linking to preview and review.

**Reuse:** `edit-site.ts` (the deferral target — seam at lines 187–198), `generateComponent` (`component-generator.ts:620`), `generateShell` (`generate-shell.ts:69`), `persistGeneration`/`persistShellGeneration`, the row→`EnrichedInventoryEntry` mapping (`generate-components.ts:181–237`), the screenshot-path resolution (`generate-components.ts` `load-page-screenshot-paths` step ~line 135), compose→deploy→verify chain (unchanged), `requestWorkspaceEditAction`, `modelClientForTier`.

**New files:**
- `lib/jab/build-config.ts` — the canonical `BuildConfig` type (§2.4).
- `lib/jab/site-map.ts` — `buildSiteMap(sourceBuildId) → SiteMap` (block-type list with human labels, page slug list, header/footer presence) from `block_inventory` + `page_inventory` + shell presence.
- `lib/jab/edit-plan.ts` — `EditPlan` type, scope union (= `WorkspaceEditScope`), JSON-schema constant, `validateEditPlan(plan, siteMap)` (target-exists, scope/target shape). Pure.
- `lib/ai/edit-planner.ts` — `planEdit({ messages, siteMap, client }) → { plan: EditPlan; usage }`. Constrained Claude call (tool-use / JSON schema), parses to typed `EditPlan`.
- `lib/jab/inventory-entry-from-row.ts` — extracted shared helper: `blockRowToEnrichedEntry(row) → EnrichedInventoryEntry` **and** `loadHomeOrSlugScreenshotBase64(supabase, buildId, slug)` that **resolves the page-slug→screenshot-path map from `page_inventory.source_screenshot_paths`** (verifier major: the screenshot lookup is its own step, not carried on the block row; the helper must rebuild the map so visual-tier regen isn't silently screenshot-less).
- `lib/jab/regenerate-unit.ts` — `regenerateComponentUnit(...)` / `regenerateShellUnit(...)`. Each reconstructs input, calls the generator **with `guidance`**, persists, returns `{ compileStatus, cost }`. Compile-fail → tagged `RegenCompileError`. **Asserts the target row exists in the cloned inventory before generating** (verifier major: a validated-but-missing target must fail loudly, not deploy a no-op identical preview).
- `lib/ai/edit-cost-guard.ts` — `assertEditBudget({ projectId, tenantId })` (rate limit over `workspace_edits`/`chat_messages` + active-build guard) + cap constants.
- `lib/actions/workspace-chat.ts` — `sendChatMessageAction`, `ensureConversation` (internal; the public `createConversationAction` was deleted 2026-06-09 — one thread per project is DB-enforced by migration 0032), `loadConversation`.
- `app/(app)/projects/[id]/workspace/ChatPanel.tsx` — real chat UI.
- Migrations 0029, 0030 (S3-owned columns merged with S4 in 0030).
- Tests for each pure module + the worker branch.

**Changed files:**
- `component-generator.ts` — add `guidance?: string` to `GenerateComponentOptions`; thread into **all five** prompt builders as a `## Targeted edit guidance` block appended to the **USER** section (after existing content, before "Generate the…"). Default empty → byte-identical to today.
- `generate-shell.ts` + `shell-prompts.ts` — add `guidance?: string`, append to the USER section of `headerPrompt`/`footerPrompt`.
- `edit-site.ts` — **the one rewrite of the seam.** Extend `create-result-build` `config` to the full `BuildConfig` edit shape (§2.4). Insert, between `clone-storage-artifacts` (line 177) and `dispatch-compose` (line 191):
  1. `regenerate-target` — `scope==="component"`: `blockRowToEnrichedEntry` + screenshot (visual tier) + `generateComponent({ ..., guidance: regenerationPrompt })` + `persistGeneration` (overwrites cloned `.tsx` + cost cols). `scope==="shell"`: thread guidance via `config` so compose's `generate-header`/`generate-footer` apply it (compose re-runs shell anyway — avoids double-generation; the `regenerate-target` step is a no-op for shell). On `RegenCompileError`: mark edit + result build `failed`, surface to chat, **return without dispatching compose** (no broken preview).
  2. `compute-changed-pages` — **S4's `computeChangedPages` against the SOURCE build's populated `block_tree`** (see §3.4) — writes `workspace_edits.changed_slugs`/`change_reason` and `config.changed_slugs`.
- `compose-site.ts` — `generate-header`/`generate-footer` read the build `config`; when `mode==="edit" && scope==="shell" && target===<kind>`, pass `guidance: config.regeneration_prompt`.
- `generate-components.ts` — replace the inline row→entry map + screenshot loader with imports from `inventory-entry-from-row.ts` (pure refactor, pinned by existing tests).
- `requestWorkspaceEditAction` (`workspace-edit.ts`) — accept optional `regenerationPrompt`/`action`/`messageId`, pass through to insert + event (manual form falls back to `prompt`).
- `workspace/page.tsx` — pass conversation + messages to `ChatPanel`; keep `WorkspaceEditsPanel` form as an advanced/manual surface. **Preview wiring is S2's `previewState`, not a raw URL.**
- `workspace-jab-demo.tsx` — `AIPanel` superseded by `ChatPanel` for real projects (demo path stays for `/ui-kit`).

**`sendChatMessageAction` flow** (all writes via admin client after one RLS membership SELECT on `projects`):
1. `assertEditBudget` → on exceed, assistant message "current build is still running / sending too fast".
2. Resolve/create conversation; insert **user** message (RLS user-client read path stays load-bearing — §2.7).
3. Resolve `sourceBuildId` = latest `ready` build (same constraint as the form path). None → assistant "No completed build to edit yet."
4. `buildSiteMap(sourceBuildId)` — **same `sourceBuildId` the edit will clone** (verifier major: planner and regen must agree on the build).
5. `planEdit(...)` → `EditPlan` + usage.
6. `validateEditPlan(plan, siteMap)`.
7. Branch: **needs clarification / validation fail** → assistant clarifying-question row (`needs_clarification=true`, `plan` for audit), **no edit**. **Actionable** → `requestWorkspaceEditAction({ ..., regenerationPrompt: plan.regenerationPrompt, action: plan.action, messageId })` → update assistant row with `edit_id`, `plan`, usage. The worker backfills `chat_messages.build_id` at `link-edit-row`.

**Guardrails / edge cases:**
- **Prompt-injection containment:** planner output is a constrained-schema `EditPlan` only — a `scope` enum, a `target` validated against the real inventory, an `action` string, a `regenerationPrompt`. The prompt can never name a file/path/tool. Generator output is `validateTsx` + size-capped (`MAX_COMPONENT_BYTES` 10KB / `MAX_SHELL_BYTES` 24KB) + `tsc --noEmit` compile-gated before any deploy.
- **Hallucinated / missing target:** `validateEditPlan` rejects → forced clarifying question listing real targets. `regenerate-unit` additionally asserts the row exists in the cloned inventory → loud failure, never a silent no-op preview.
- **Blast radius up front (verifier major):** a "change the About hero" request maps to a site-wide block edit. The planner's `action` summary **states the real blast radius** ("changes Hero on N pages"), and the chat surfaces that **page count before the build runs** so the user can cancel a too-broad edit.
- **Regen compile-fail:** hard stop — mark failed, surface to chat, no compose, no broken preview.
- **Cost caps + rate limit:** `EDIT_COST_CAP_TOKENS` / `PLANNER_COST_CAP_TOKENS`; cap planner context at ~12 turns. `assertEditBudget` + the active-build guard (§3.4) serialize edits.
- **Prompt cache:** guidance lands strictly **after** the `USER:` split marker (component-generator splits `combinedPrompt` on the literal marker and only `attempt===0` sets `cacheSystemPrompt`). A test asserts guidance appears after the marker for **every** one of the five builders so a future edit can't leak it into the cached system half.
- **Chat reads are RLS-gated:** `loadConversation` reads via the **RLS user client** so `conv_select`/`msg_select` are load-bearing (not dead policy behind an admin read). Writes go through the action's admin client after an explicit membership check.

### 3.4 S4 — Review Gate → Promote (consumes S3's output)

**Goal:** route an edit's `ready` preview build through the same review→promote rail as a full build, but scoped to only the pages the edit actually changed, carrying forward prior approvals for untouched pages so the existing all-approved gate still holds.

**Reuse (verbatim engine):** `lib/jab/publish-gate.ts` (`evaluatePublishGate`), `lib/actions/build-review.ts` (`publishBuildAction`, `setApprovalStatus`, the three approve/reject actions), `deployments-recorder.ts` (`recordDeployment`, `supersedePreviousProductionDeployments`), `VercelClient.requestPromote`, migration 0023 RPC, `deploy-site.ts`/`verify-fidelity.ts` (the edit build is already a preview deploy), `lib/jab/build-status.ts`.

**New files:**
- `lib/jab/edit-impact.ts` — pure `computeChangedPages({ scope, target, sourcePageInventory }) → { changedSlugs: string[]; reason }`. **Diff source is the SOURCE build's populated `page_inventory.block_tree`** (migration 0027), walking each page's tree for `target` — **NOT** the capped `block_inventory.page_slugs` (verifier blocker: cap=50 → fail-open). `scope==="shell"` → all slugs + `shell_all`. Any uncertainty → **widen to all pages (fail-closed)**.
- `lib/jab/approval-carry-forward.ts` — pure `planApprovalCarryForward({ sourceFidelityRows, resultPages, changedSlugs }) → { carry: [{pageInventoryId,status}]; resetToPending: string[] }`. Untouched pages inherit source status; changed pages → `pending`. Matches on **`slug`** (stable), not `page_inventory.id` (regenerated per build). Source-`pending` never upgraded.
- `lib/inngest/functions/edit-site.helpers.ts` — service-role shims: `loadSourceApprovals(sourceBuildId)`, `applyCarryForwardApprovals(resultBuildId, plan)` (direct UPDATE of `approval_status`/`approved_by_user_id`/`approved_at` on cloned `fidelity_reports`).
- `lib/jab/active-edit-guard.ts` — pure `evaluateEditConcurrency({ latestBuildStatus, inFlightEditCount }) → { ok; code?; reason? }`.
- `lib/actions/discard-edit.ts` + `lib/jab/discard-edit-errors.ts` (`DiscardEditError`; Next forbids non-async exports from `"use server"`).
- `app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx`.
- Migrations 0030 (S4 columns, merged with S3) + 0031 (active-build index).
- Tests for each pure module + the worker branch + an e2e.

**Changed files:**
- `verify-fidelity.ts` — **(single coordinated change with S1's perf addition).** (a) Add `config` to the `load-build` select (verifier blocker: it currently selects only `id, project_id, status, preview_url`). (b) In `finalize`, when `config.mode==="edit"`: `loadSourceApprovals(config.source_build_id)` + `applyCarryForwardApprovals` (changed pages → `pending`; untouched → inherited) **before** the `ready` flip. (c) **Handle `mark-ready-empty` explicitly** (verifier blocker): a zero-page edit skips carry-forward; the gate's `no_fidelity_rows` reject then correctly blocks publish — document this as the intended fail-closed behavior for a zero-page edit. (d) **Cancel guard:** the `ready` flip is a **conditional UPDATE** `SET status='ready' ... WHERE status != 'cancelled'`, and carry-forward is skipped if the build is `cancelled` (see discard below).
- `compose-site.ts`, `deploy-site.ts` — **add explicit `status==='cancelled'` short-circuit guards** (verifier blocker/major: discard is cosmetic today — these workers run to completion regardless). Each re-reads status at entry and bails if `cancelled`. Enumerated as real tasks, not a note.
- `requestWorkspaceEditAction` — concurrency guard: app-level `isActiveBuildStatus(latest.status)` fast path + catch Postgres `23505` from the 0031 index → `WorkspaceEditError("active_build")`; plus `edit_in_review` guard (one unpromoted-but-`ready` edit at a time). **Derive "ready" from the linked `site_builds.status`, not from `workspace_edits.status`** (verifier blocker — see edit state machine below).
- `triggerBuildAction` — same `23505` → `active_build` translation for the 0031 index (the index changes behavior for the **existing full-build path** too, so this lands first).
- `publishBuildAction` — one addition: after the supersede sweep, if `config.mode==="edit"`, set `workspace_edits.result_promoted_deployment_id` for the matching edit (closes the audit chain). Gate/promote core byte-unchanged.
- `review/page.tsx` — when `config.mode==="edit"`: render `<ScopedReviewBanner>`, default-filter the page list to `changed_slugs` (with "show all"), Publish wired to the **same** `publishBuildAction`. Purely presentational scoping over the existing full list.
- `workspace/page.tsx` — edit-history rows: link a **result-build-`ready`** edit to its `/review` route (not `/progress`); add a "Discard" affordance per unpromoted edit. (Preview iframe is S2's `previewState`.)
- `load-project-builds.ts` (or sibling `loadWorkspaceEditState`) — per recent edit: linked build status, preview URL, promoted? — to label each edit and drive `editAwaitingReview` for §2.2.

**Edit state machine (resolve verifier blocker — `'completed'` means *dispatched*, not *preview-ready*):**

`edit-site` sets `workspace_edits.status='completed'` immediately after dispatching compose — i.e. "edit was dispatched into the pipeline", while the result build is still `queued`/`composing`. Therefore **all review/concurrency/UI readiness logic derives readiness by joining `result_build_id → site_builds.status`, never from `workspace_edits.status`.** Canonical mapping:

| `workspace_edits.status` | linked `site_builds.status` | UI label / meaning |
|---|---|---|
| `queued` / `running` | (none yet / active) | "Submitting…" |
| `completed` | active (`composing`…`verifying`) | "Building…" |
| `completed` | `ready`, not promoted | **"Review ready"** (the `edit_in_review` slot) |
| `completed` | `ready`, promoted (`result_promoted_deployment_id` set) | "Live" |
| `completed` | `cancelled` | "Discarded" |
| `failed` | `failed` (or none) | "Failed" |
| `discarded` | `cancelled` | "Discarded" |

The `edit_in_review` guard counts edits whose **linked build is `ready` AND not promoted AND not cancelled**. A rejected/abandoned edit is releasable via Discard (see below), so one bad edit never wedges the workspace (verifier minor).

**Review surface decision (locked):** reuse the **full per-page review screen, scoped by a default filter** — do **not** build a separate inline approve-and-promote widget. The gate engine operates over *all* fidelity rows; carry-forward makes only changed pages actionable while satisfying the invariant, so the full screen *is* the scoped experience for free, and the promote path stays one audited code path.

**Concurrency index (resolve verifier major — wedge hazard):** `0031` indexes `WHERE status IN ('discovering','components','composing','building','verifying')` — **excluding `'queued'`**. Two racing inserts both land as `queued`; the app-level `isActiveBuildStatus` check arbitrates the friendly path. Because a crashed worker (`retries:0` + process death) can leave a row stuck in an active phase, excluding `queued` plus a documented **manual-recovery path** (operator UPDATE the wedged row to `failed`) avoids a permanent un-buildable project. The index is the hard backstop against true concurrent active builds; the app check is the friendly fast path.

**Discard (resolve verifier blocker — make it real):** `discardEditAction({ editId })` — RLS-load the edit; refuse if `result_promoted_deployment_id` is set (discarding production is a re-promote, out of scope §6); else direct UPDATE `site_builds.status='cancelled'` (bespoke — `markBuildFailed` writes `'failed'`, not `'cancelled'`) + `workspace_edits.status='discarded'` + best-effort Storage cleanup (export `listAllUnderPrefix` from `edit-site.ts`). The cancel guards added to compose/deploy/verify make this actually stop the pipeline (not cosmetic).

**Guardrails / edge cases:**
- **Fail-closed gate:** carry-forward never upgrades a source-`pending` page; changed pages always reset to `pending`; result-only pages (no source approval) → `pending`; >50-page blocks and any diff uncertainty → "changes all pages". A genuinely-changed page can never inherit a stale approval.
- **Shell edits** → all pages re-review (`shell_all`), no carry-forward.
- **Missing source captures:** untouched page with a skipped source row still inherits the *human* approval (pixel absence doesn't revoke a human decision); changed page with no capture → `pending`, manual approve-with-issues — same as a full build.
- **Audit chain:** edit (`workspace_edits`) → result build (`result_build_id`) → preview deploy (`deployments.environment=preview`) → production (`promoted_from_deployment_id` + `result_promoted_deployment_id`) + per-page `approved_by_user_id`/`approved_at`.

---

## 4. Phasing

Sequencing is driven by the verifier's hard serialization points: **one migration batch**, **S2 owns the preview slot and ships first**, **the 0031 index lands independently with error-translation before the edit loop depends on it**, and **S3+S4 ship as one coordinated edit-loop phase** (S4 is a no-op without S3's regen; S3 without S4 forces full-site re-review on every edit). S1 is an independent parallel track.

Every task in the four drafts maps to exactly one phase below.

### Phase 0 — Migration batch + shared contracts (serialization gate, ~1d)
*Must complete before any subsystem writes SQL or touches `edit-site.ts`/`config`.*
- Author migrations **0028 / 0029 / 0030 / 0031** as one ordered batch; mirror in `schema.ts`; **apply in order to BOTH Supabase projects**; record in the migrations log.
- Land the shared contracts: `lib/jab/build-config.ts` (`BuildConfig`), the `site/edit.requested` payload extension, `WorkspaceEditScope` in `workspace-edit-validation.ts`.
- **Ship 0031's error-translation independently**: `23505 → active_build` in both `triggerBuildAction` and `requestWorkspaceEditAction`, verified against the **existing full-build path** (a normal rebuild while one is active now returns a friendly error, not a raw 23505). This is the latent-concurrency-bug fix and must be proven on the existing path before the edit loop relies on it.
- **Shippable:** concurrency guard hardens the existing build path; schema ready. No user-facing feature yet.

### Phase 1 — THIN VERTICAL SLICE: see a real preview (S2, ~3–4d) ⭐
*Smallest path to visible value; depends on nothing new (preview URL already persisted).*
- S2 in full: `deriveWorkspacePreviewState` (+ tests for every race), `WorkspacePreviewPane` (phase-aware building state + progress link), `loadWorkspacePreviewStateAction`, `assertPreviewReachable`/`PreviewProtectedError`, poll effect, wire `workspace/page.tsx` + `PreviewPane`/`WorkspaceProject`, strip inline toggle, `deriveProjectStatusLabel` (shared status word).
- **Shippable + demoable:** trigger a full build from an existing project; the workspace preview pane shows the live Vercel preview with device toggle, refreshes building→ready without a full reload, and surfaces a protected-preview error if Deployment Protection is on. The dashboard/header/workspace show one consistent status word.

### Phase 2 — THIN VERTICAL SLICE completion: edit via chat → preview → promote (S3 + S4 together, ~9–11d) ⭐ **DEMO MILESTONE**
*The two are mutually entangled (S4 consumes S3's changed-page set; S4's carry-forward lives in the verify worker S3 triggers). Ship as one coordinated phase, behind `JAB_CHAT_EDIT` flag until the e2e smoke is green.*

Ordered within the phase:
1. **Generator `guidance` param** (S3): thread into all five component builders + both shell prompts; test guidance lands strictly after the `USER:` marker for every builder; byte-identical when omitted.
2. **Extract `inventory-entry-from-row.ts`** (S3): row→entry map **+ screenshot-path resolution from `page_inventory`**; re-import into `generate-components.ts` (pinned by existing tests).
3. **Pure cores** (S3+S4): `site-map.ts`, `edit-plan.ts`+`validateEditPlan`, `edit-impact.ts` (**diff against SOURCE `block_tree`, fail-closed >50**), `approval-carry-forward.ts`, `active-edit-guard.ts`, `edit-cost-guard.ts` — all TDD, no I/O.
4. **`edit-planner.ts`** (S3): constrained Claude call; tests for actionable / clarifying / hallucinated-target with a mocked client; planner constrained to `component`|`shell` only; `action` states blast radius.
5. **`regenerate-unit.ts`** (S3): component + shell branches; asserts target exists in cloned inventory; `RegenCompileError` on compile-fail.
6. **`edit-site.ts` rewrite** (S3, sole owner of the seam): full `BuildConfig` on `create-result-build`; `regenerate-target` + `compute-changed-pages` (S4's function, source-block_tree) between clone and dispatch; compose-side shell guidance threading; compile-fail aborts before compose; backfill `chat_messages.build_id`.
7. **`verify-fidelity.ts` coordinated change** (S4, also carries S1's perf — single owner of this file this phase): add `config` to load-build; carry-forward branch in finalize; `mark-ready-empty` explicit skip; conditional `ready` flip `WHERE status != 'cancelled'`.
8. **Cancel guards** (S4): explicit `status==='cancelled'` short-circuits in `compose-site.ts` + `deploy-site.ts` (real tasks).
9. **Concurrency + discard** (S4): `requestWorkspaceEditAction` guards (derive readiness from `site_builds.status`); `discardEditAction` (+ Storage cleanup, refuse-if-promoted); auto-release on reject/abandon.
10. **`publishBuildAction` lineage write** (S4).
11. **Server actions + chat tables wiring** (S3): `sendChatMessageAction`/`ensureConversation` (internal; `createConversationAction` deleted 2026-06-09 — one thread per project DB-enforced by migration 0032)/`loadConversation` (RLS user-client reads); `requestWorkspaceEditAction` pass-through.
12. **UI** (S3+S4): `ChatPanel.tsx` (optimistic send, clarifying-question render, "what changed" card with **phase + elapsed**, preview + review links, blast-radius page count, **aria-live='polite'** transcript, composer focus retention, `prefers-reduced-motion`); `ScopedReviewBanner` + changed-only filter in `review/page.tsx`; workspace edit-history "Review →"/"Discard".
13. **End-to-end smoke** against the Two Roads pilot: chat "make the hero bolder" → planner emits `component`/hero → regen overwrites cloned tsx → preview `ready` → carried approvals present → scoped review shows only the hero pages pending → approve → promote → production row + supersede + `result_promoted_deployment_id`. Assert a vague prompt yields a clarifying question and **no build**.
- **Shippable + the headline demo:** the complete iterate loop, flagged on once smoke is green.

### Phase 3 — Dashboard real data + tabs (S1, independent parallel track, ~5–6d)
*Can run in parallel with Phases 1–2 except the `verify-fidelity` perf write, which is folded into the Phase-2 coordinated edit of that file.*
- `0028` perf columns (already in the Phase-0 batch); `perf-capture.ts` + tests; perf collection inside the verify Playwright loop (Phase-2 coordinated); `BuildSummary` extension.
- `build-quick-stats.ts` (omit-null) + `mocks.ts` purge + `page.tsx` real stats; AI card from `workspace_edits` (no credits chip); deploy-history label from `config`.
- Tab bar/layout + Content/Deploy/AI/Settings routes; dashboard badge regression fixture (live + in-flight edit → "Live · updating").
- **Shippable:** a live project shows only measured numbers; four real tabs; no fabricated values anywhere.

**Demo milestone = end of Phase 2:** chat-driven edit → real live preview → scoped review → promote to production, end to end, against the Two Roads pilot.

---

## 5. Risks & open questions (consolidated)

| # | Risk / question | Mitigation |
|---|---|---|
| R1 | **Component→page blast radius surprises the user** ("change the About hero" → site-wide hero change resetting every page to pending). | Planner `action` states blast radius; chat surfaces the affected-page **count before the build runs** so the user can cancel. Per-page component variants are deferred (§6). |
| R2 | **Planner quality on vague input** ("make it bolder") — over-eager builds burn Vercel cost. | Bias the planner toward a clarifying question when confidence is low; `assertEditBudget` rate-limits; the one-active-edit slot caps concurrent preview spend. |
| R3 | **Stuck active build wedges the project** (crashed worker + `retries:0` leaves a row mid-phase; the 0031 index then refuses new builds). | 0031 excludes `'queued'`; documented manual-recovery (operator UPDATE wedged row → `failed`); a stuck-build reaper is a tracked follow-up. |
| R4 | **`block_tree` availability for the diff.** `computeChangedPages` reads the **source** build's `page_inventory.block_tree` (populated by migration 0027's `discoverSite`). Builds discovered before 0027 have null `block_tree`. | For a source build with null `block_tree`, fall back to **fail-closed** ("changes all pages") rather than the capped `page_slugs`. New builds always have it. |
| R5 | **Vercel team-level Deployment Protection** could gate every preview behind SSO, making the whole feature look broken. | `assertPreviewReachable` fires loudly per build; one-time operator check before ship that org-wide protection is off (per-project `ssoProtection:null` is already sent at create). |
| R6 | **Carried-page screenshots reference the source build's Storage** (the known carry-forward gap from CLAUDE.md). The scoped review shows untouched pages whose screenshots live under the source build's prefix. | Acceptable for v1 (untouched pages didn't change visually; the source screenshot is correct). Storage-copy-on-carry for fidelity artifacts is a tracked follow-up. |
| R7 | **Prompt-cache leak** if a future prompt-builder edit lands guidance on the system side of the `USER:` marker. | A test asserts guidance appears strictly after the marker for all five builders. |
| R8 | **Conversation scoping** — v1 assumes one active conversation per project; multi-thread is unspecified. | Schema supports many; UI picks the latest. Multi-thread deferred. |
| R9 | **Verify worker grows an edit-only branch** (carry-forward coupled into verify). | Accepted for fewer moving parts, gated on `config.mode==="edit"`; a dispatched `site/carry-forward.requested` event is the documented alternative if the branch gets heavy. |

---

## 6. Out of scope (deliberate deferrals)

- **Vision-LLM fidelity scoring** — `lib/ai/fidelity-score.ts`'s `visionScore` stays the pixel-echo stub (the real LLM call is the existing Phase 7.1 follow-up). The gate runs on pixel-diff + human approval.
- **Agentic / free-form file edits** — the planner selects from an **enumerated catalog** (block types, shell kinds) only. It cannot name a path, run a tool, or write arbitrary files. No free-form code generation.
- **Per-page component variants** — `block_inventory` is keyed by `block_name` only; "the About hero" vs "the Home hero" are the same regenerable unit. True per-page overrides are a larger follow-up.
- **`page` / `page-content` / `global-style` scopes** — not in the enum, the CHECK, the planner, or the worker this round. Added together when per-page/global regen lands.
- **`perf_score` composite** — dropped from the schema and UI; we ship measured TTFB/Load/transfer only. A documented composite is a follow-up.
- **AI credits / billing** — `aiCreditsRemaining` removed; no billing table. Token counts already live on `block_inventory`/`shell_generations`/`chat_messages` for a future cost view.
- **Rollback from production** — Discard handles *preview* edits only. Reverting a *promoted* edit = re-promoting the prior (now `superseded`) production deployment — a separate "re-promote previous" action, not designed here.
- **Last-good preview during a new build** — v1 shows a building spinner, not the prior preview with an "updating" badge.
- **Code/visual diff in the chat card** — v1 names the regenerated unit and shows the affected-page count; a before/after thumbnail (from the new build's `fidelity_reports` screenshots) is a follow-up.
- **Storage-copy-on-carry for fidelity artifacts** — carried-page screenshots reference the source build's Storage paths (R6); copy-on-carry is a tracked follow-up shared with the incremental skip-unchanged work.
- **Multi-thread conversations** — one active conversation per project in v1.

---

## 7. Resolutions log (verifier findings → how this design addresses them)

| Severity | Finding | Resolution |
|---|---|---|
| blocker | Three subsystems claim migration 0028. | §2.3 single ordered batch 0028/0029/0030/0031, applied once to both projects. |
| blocker | S3 & S4 both rewrite the same `edit-site.ts` seam + both do guidance regen. | §2.1 rule 2 + §3.3: **S3 is sole owner**; S4 only reads the changed-page set. One seam rewrite, one `config` schema (§2.4), one event payload (§2.5). |
| blocker | Carry-forward in `verify-fidelity` misses `mark-ready-empty` and never loads `config`. | §3.4: add `config` to load-build; explicit zero-page handling (fail-closed via `no_fidelity_rows`); carry-forward in finalize only. |
| blocker | `page_slugs` capped at 50 + cloned build has null `block_tree` → fail-open gate. | §3.4: `computeChangedPages` diffs the **SOURCE** build's populated `block_tree`; >50/uncertain → "changes all pages" (fail-closed). Not the capped array. |
| blocker | S2/S3/S4 give three incompatible plans for the preview slot; `srcDoc` can't load a URL. | §2.1 rule 3 + §3.2: **S2 sole owner**; S3/S4 consume `WorkspacePreviewPane`/`previewState`. |
| blocker | S3 & S4 disagree on `'completed'` semantics + scope vocabulary. | §3.4 edit state machine: readiness derives from linked `site_builds.status`, not `workspace_edits.status`. §2.6 one scope enum (`component`/`shell` only); deferred scopes not added. |
| major | Perf can't reuse the verify Playwright pass without a scoped refactor. | §3.1: explicit `collectPerfForHomeRoute` inside the existing per-page loop; fidelity behavior pinned by existing tests. |
| major | `regenerate-unit` needs the screenshot-path map, which lives in its own step. | §3.3: `inventory-entry-from-row.ts` also rebuilds the slug→screenshot-path map from `page_inventory`. |
| major | Discard sets `cancelled` but workers don't honor it. | §3.4: explicit cancel guards in compose/deploy/verify as real tasks; conditional `ready` flip. |
| major | 0029 (now 0031) index can permanently wedge a project. | §3.4: index excludes `'queued'`; documented manual recovery; reaper as follow-up. |
| major | S1 over-claims fake data (already gated behind `live`); WP mock stale; `perf_score` reintroduces the risk. | §3.1: re-scoped to post-live stats; `realWpConnectionFrom` acknowledged; `perf_score` dropped. |
| major | 45s+ deploy shows a bare spinner. | §3.2: building state surfaces `phase` + progress link; §3.3 chat card shows phase + elapsed. |
| major | Planner can produce a mismatched/no-op target. | §3.3: `buildSiteMap` and regen share `sourceBuildId`; `regenerate-unit` asserts the row exists → loud failure. |
| minor | Deploy-history `message` redundant join. | §3.1: read `config.mode`/`config.prompt` off the loaded build row. |
| minor | `chat_messages` RLS policy unused if reads go via admin. | §2.7/§3.3: reads via RLS user client → policies load-bearing. |
| minor | Guidance might leak into cached system prompt. | §3.3: test asserts guidance after the `USER:` marker for all five builders. |
| minor | Rejected-edit retry loop thin; one bad edit wedges the slot. | §3.4: `edit_in_review` treats rejected/abandoned as releasable; reject links back to chat. |
| minor | A11y of new live regions under-specified. | §3.2 poll-not-refresh; §3.3 `aria-live`, focus retention, reduced-motion. |
| minor | "Current build" reads as three words across surfaces. | §2.2: `deriveProjectStatusLabel` — one shared status word everywhere. |
| minor | Three subsystems touch `verify-fidelity` concurrently. | §2.1 rule 6: one coordinated change in Phase 2 (S1 perf + S4 carry-forward + cancel guard). |

---

## 8. Files of record

**New (pure/testable cores):** `lib/jab/build-config.ts`, `lib/jab/project-status-label.ts`, `lib/jab/workspace-preview-state.ts`, `lib/jab/perf-capture.ts`, `lib/jab/build-quick-stats.ts`, `lib/jab/load-project-content.ts`, `lib/jab/site-map.ts`, `lib/jab/edit-plan.ts`, `lib/jab/inventory-entry-from-row.ts`, `lib/jab/regenerate-unit.ts`, `lib/jab/edit-impact.ts`, `lib/jab/approval-carry-forward.ts`, `lib/jab/active-edit-guard.ts`, `lib/jab/discard-edit-errors.ts`.
**New (impure):** `lib/ai/edit-planner.ts`, `lib/ai/edit-cost-guard.ts`, `lib/actions/workspace-chat.ts`, `lib/actions/workspace-preview.ts`, `lib/actions/discard-edit.ts`, `lib/inngest/functions/edit-site.helpers.ts`, `lib/vercel/preview-protection.ts`.
**New (UI):** `components/workspace-preview-pane.tsx`, `app/(app)/projects/[id]/workspace/ChatPanel.tsx`, `app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx`, `app/(app)/projects/[id]/layout.tsx`, `app/(app)/projects/[id]/tabs/{content,deploy,ai,settings}/page.tsx`.
**Changed:** `lib/inngest/functions/edit-site.ts` (S3 sole owner of seam), `verify-fidelity.ts` (coordinated S1+S4), `compose-site.ts`, `deploy-site.ts`, `generate-components.ts`, `lib/ai/component-generator.ts`, `lib/ai/generate-shell.ts`, `lib/ai/shell-prompts.ts`, `lib/ai/persist-generation.ts`, `lib/actions/workspace-edit.ts`, `lib/actions/build-review.ts` (`publishBuildAction` lineage), `lib/actions/trigger-build.ts` (23505 translation), `lib/jab/workspace-edit-validation.ts`, `lib/jab/load-project-builds.ts`, `lib/jab/build-status.ts` (cancelled terminal), `lib/db/schema.ts`, `app/(app)/projects/[id]/page.tsx`, `app/(app)/projects/[id]/workspace/page.tsx`, `app/(app)/projects/[id]/builds/[buildId]/review/page.tsx`, `app/(app)/dashboard/page.tsx`, `app/(app)/projects/[id]/mocks.ts`, `app/ui-kit/workspace-jab/workspace-jab-demo.tsx`.
**Migrations:** `drizzle/migrations/0028_build_perf_metrics.sql`, `0029_chat_conversations.sql`, `0030_workspace_edit_provenance.sql`, `0031_one_active_build_per_project.sql` — applied in order to both `ajfurojjxthhzkjqttri` and `celzwcxkrmsbwiswkxug`.
**Reused verbatim:** `lib/jab/publish-gate.ts`, `lib/jab/deployments-recorder.ts`, `lib/vercel/client.ts` (`createDeployment`/`requestPromote`), `lib/inngest/functions/poll-deployment.ts`, `components/preview-frame.tsx`, `components/scaled-iframe.tsx`, migration `0023_fidelity_approval_rpc.sql`, migration `0027_page_inventory_block_tree.sql`.
