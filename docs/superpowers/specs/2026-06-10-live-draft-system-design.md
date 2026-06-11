# Live Draft System — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorm with operator, this session)
**Branch context:** `feat/saas-e2e-loop`
**Supersedes:** the per-edit build pipeline for chat/manual edits (the `edit-site` worker's clone → regen → compose → deploy → verify chain). Full builds (`triggerBuildAction`) and the publish pipeline are unchanged.
**Builds on:** the workspace-chat-completion campaign ([plan](../plans/2026-06-10-workspace-chat-completion.md)) — its chat slot, open-edit polling, transcript merge, and stale-edit sweep all carry forward.

## 1. Problem

Every chat edit ("make the headline smaller") today creates a new `site_builds` row, clones block/page inventories and Storage artifacts, regenerates one component, then runs the FULL pipeline: compose (~30–90s incl. tsc gate) → Vercel deploy (1–5 min) → verify (Playwright ~27s/page). The edit itself is ~10–20s of LLM work; ~95% of the wall-clock is publish machinery. Users cannot iterate conversationally.

**Goal:** chat edits reflect in the preview pane in ~8–15 seconds. Build + verify + review run **once, pre-publish**, not per edit. Nothing touches Vercel until Publish.

## 2. Requirements (clarified with operator)

| Requirement | Decision |
| --- | --- |
| Fast-lane scope | Style + text edits to existing units are fast (~8–15s). Structural edits within a unit may take ~30–60s. ALL edits skip deploy + verify until publish. |
| Fidelity bar | "Close enough to trust": same generated components + real WP data via a lighter render path. The pre-publish build + verify is authoritative. |
| Latency target | 8–15s send → updated preview is acceptable (LLM in the loop per edit). |
| Draft control | Per-edit undo: each edit is a step; user can undo the last step or revert to any earlier step. Linear history, no branching. |
| Preview navigation | Fully navigable: every route renders with draft edits applied. |
| Pane source | Deployed Vercel preview by default; switch to the draft renderer when the draft has ≥1 active step (with a "Draft" badge + toggle back). |
| v1 edit scope | Existing components + header/footer only (what the planner can target today). Tree patches (add/remove/reorder sections) are designed-for but deferred. |

## 3. Why this works — load-bearing codebase facts (verified)

1. **Generated pages embed no content.** Emitted `page.tsx` fetches WP data at request time (ISR 60s) via `jabClient.callAbility`. A draft renderer needs only: draft component code + live WP data + the same composition pipeline.
2. **Every deterministic runtime the emitted site uses lives in `apps/web` as importable modules** — `lib/jab/compose-block-tree-runtime.ts`, `related-posts-runtime.ts`, `dynamic-lists-runtime.ts`, `rewrite-links-runtime.ts` are emitted verbatim into generated sites. The draft renderer imports the same modules; parity is structural.
3. **The LLM-generated import surface is tiny and client-safe.** Block components: named export, props `{ block: BlockNode; children?: ReactNode }`, type-only `BlockNode` import (erased at compile), Tailwind classes, optionally `next/image` with explicit dimensions, optional `"use client"` + handlers (added by `postprocessGeneratedTsx`). Shell: `next/link` + `useState` (mobile menu) only. No fonts, no icon libraries, no other imports (prompt contract in `lib/ai/component-generator.ts` + `lib/ai/shell-prompts.ts`).
4. **Tailwind 3.4.10 is already an `apps/web` dependency** and supports JIT over raw in-memory content (`content: [{ raw, extension: "tsx" }]`) with the same token config builder used by `emitTailwindConfigTs`.
5. **The dispatcher is deterministically emitted** (`emitDispatcherTsx`): registry blockName → component, `core/image` → MediaImage shim, Passthrough fallback, children pre-walk. The draft bundle reuses the same emit function.
6. **Per-edit blast radius is already computable** — `computeChangedPages` walks `page_inventory.block_tree` (migration 0027); approval carry-forward for unchanged pages exists in verify.

**Known defect this design also fixes:** today's regen path does not read the existing TSX — it regenerates from original DOM samples + a guidance string, so iterative edits ("smaller" … "now blue") can silently lose each other. The draft patch step takes the *current draft TSX* as input.

## 4. Architecture

```
        CHAT EDIT LOOP (seconds)                      PUBLISH LANE (minutes, once)
┌─────────────────────────────────────┐      ┌──────────────────────────────────────┐
│ chat → planner LLM (existing)       │      │ publishDraftAction                   │
│   → draft-edit worker:              │      │   → materialize: base components     │
│       patch LLM on current TSX      │      │     + draft unit overrides           │
│       esbuild bundle gate (~ms)     │      │   → compose (skip shell regen,       │
│       Tailwind JIT (~300ms)         │      │     use draft Header/Footer)         │
│       commit draft version N+1      │      │   → tsc compile gate                 │
│   → preview iframe bumps ?v=N+1     │      │   → Vercel deploy                    │
│                                     │      │   → verify changed pages (union)     │
│ undo / revert-to-step: no LLM,      │      │   → review screen → promote          │
│ restore snapshot + rebundle (~1s)   │      │                                      │
└─────────────────────────────────────┘      └──────────────────────────────────────┘
            both lanes run the same pure runtimes over live WP data
```

Chat edits **stop creating `site_builds` rows**. The draft is a pure function: `effectiveSite(baseBuild, activeSteps)`.

## 5. Data model

### 5.1 `drafts` (new table)

One active draft per project (partial unique index on `project_id WHERE status='active'`, same pattern as migration 0031).

| Column | Notes |
| --- | --- |
| `id`, `project_id`, `tenant_id` | Standard tenancy. RLS mirrors `workspace_edits`. |
| `base_build_id` | The `ready` build the draft forked from. Pinned — no rebase in v1. |
| `version` | Monotonic int, bumped on every committed step / undo / revert. Cache key for bundle + CSS. |
| `status` | `active \| publishing \| published \| discarded`. |
| `created_at`, `updated_at` | — |

### 5.2 `draft_unit_versions` (new table)

Immutable per-unit snapshots; these ARE the undo history.

| Column | Notes |
| --- | --- |
| `id`, `draft_id`, `tenant_id`, `project_id` | — |
| `unit_key` | Block name (`core/heading`, `acf/hero`) or `shell:header` / `shell:footer`. |
| `version_no` | Per-unit, monotonic. |
| `tsx` | The full unit source after the edit (≤ 10 KB cap, same as generation). |
| `created_by_edit_id` | FK → `workspace_edits` (the step that produced it). |

**Effective draft state** = base build's components (Storage `builds/{base}/components/`), overridden by each unit's latest snapshot whose creating step is not undone.

### 5.3 `workspace_edits` (extended, not replaced)

Each edit remains a `workspace_edits` row — the chat UI, history rail, error_text rendering, and `autoFailStaleOpenEdits` sweep all keep working. New columns (one migration):

| Column | Notes |
| --- | --- |
| `draft_id` | FK → drafts. NULL for legacy pre-draft rows. |
| `unit_version_id` | FK → draft_unit_versions. Set on success. |
| `undone_at` | Timestamp; set by undo/revert. Undone steps are excluded from the effective state and from `changed_slugs` union. |

`result_build_id` becomes NULL for draft edits (no per-edit build); it is retired for new rows, kept for legacy display. `status` semantics simplify: `completed` now means *applied to the draft* (terminal for the step), eliminating the "completed = dispatched" ambiguity tracked in `deriveEditUiState`.

### 5.4 Storage layout (new prefix, same bucket)

```
drafts/{draftId}/v{version}/bundle.js      ← esbuild output, immutable
drafts/{draftId}/v{version}/draft.css      ← Tailwind JIT + scoped theme.css, immutable
```

Written once by the worker at commit time; the serving routes stream from Storage (no recomputation on serverless cold starts). Cleanup: prefix deleted when the draft reaches a terminal status (keep last N=5 versions during `active` to bound growth).

## 6. Edit flow

### 6.1 Chat action (unchanged)

`sendWorkspaceChatMessageAction`: `JAB_CHAT_EDIT` gate → length cap → RLS membership → `assertEditBudget` (5 edits / 5 min — now gates LLM spend instead of Vercel deploys) → planner LLM (`planEdit`, Sonnet, tool-forced `emit_edit_plan`) → clarify or dispatch. The pinned test ordering (flag → length → membership → budget → persist) is preserved.

### 6.2 New `draft-edit` Inngest worker (replaces `edit-site` as the `site/edit.requested` handler)

Steps (retries: 0; covered by the existing `autoFailStaleOpenEdits` sweep):

1. **ensure-draft** — load the project's active draft; if none, create one forked from the latest `ready` build. No cloning of inventories or Storage — the draft stores only overrides. Refuse if another step is open (`OPEN_EDIT_STATUSES`), matching the existing one-in-flight guard.
2. **load-current-tsx** — unit's latest active snapshot, else the base build's component from `builds/{base}/components/{SafeName}.tsx`; for `shell:*`, the base build's `components/site/Header.tsx` / `Footer.tsx`.
3. **patch-llm** — NEW prompt: current TSX + the planner's `regenerationPrompt` → full modified TSX. Same tier → model mapping as generation (`modelClientForTier`), same 10 KB cap, same prompt-cache discipline. Output contract identical to generation (named export, props shape, Tailwind-only styling). **Fallback:** if no current TSX exists or the patch fails validation twice, fall back to the existing full `generateComponent` / `generateShell` path with guidance.
4. **bundle-gate** — esbuild-bundle the full effective component set (see §7.3). A bundle failure = step failure (stronger than today's `ts.createSourceFile` check — it resolves imports). Nothing is committed; the draft version does not move. No broken previews.
5. **css** — Tailwind 3 JIT over all effective unit sources + shell + static chrome as raw content, using the same token config as `emitTailwindConfigTs`; append the scoped theme.css (`emitThemeCss` output) when `design_tokens.themeStylesheets` exist.
6. **commit** — upload `bundle.js` + `draft.css` to `drafts/{draftId}/v{N+1}/`, insert the `draft_unit_versions` row, compute the step's `changed_slugs` via `computeChangedPages` over the **base build's** `page_inventory.block_tree` (shell scope → all pages, `reason='shell_all'`), update the `workspace_edits` row (`status='completed'`, `unit_version_id`, `changed_slugs`), bump `drafts.version` — in that order, version bump last (readers never see a version whose artifacts are missing).
7. **failure path** — `workspace_edits.status='failed'` + `error_text`; patch the linked chat message ("That edit couldn't be applied: …"), exactly the current convention.

### 6.3 Undo / revert (server action, no LLM)

`undoDraftStepAction(editId)` / `revertDraftToStepAction(editId)`: RLS membership → set `undone_at` on the step (revert = all later steps) → recompute effective set → rebundle + re-JIT (~1–2s, synchronous in the action) → upload as `v{N+1}` → bump version → `revalidatePath`. Discard-draft sets `status='discarded'` (pane falls back to the deployed preview).

### 6.4 Preview pane reaction

The open-edit polling loop from the workspace-chat-completion campaign is unchanged (poll while `hasOpenEdit`, `router.refresh()` on meaningful transitions). New behavior: `loadWorkspacePreviewStateAction` also returns the draft descriptor (`draftId`, `version`, active-step count); when a poll observes a version bump, the pane bumps the iframe `?v=` param (cache-busted reload) instead of waiting for a deployment URL change.

## 7. Draft renderer

### 7.1 Surfaces (all in `apps/web`)

| Route | Responsibility |
| --- | --- |
| `GET /draft/[projectId]/[[...path]]` | Static HTML shell: links `draft.css` + Google-font tags (same logic as `emitLayoutTsx`'s `buildGoogleFontLinks`), loads `bundle.js`, fetches page JSON for the current path, renders client-side. Intercepts same-site link clicks → `pushState` + refetch (fully navigable, no shell reload). Serves with `Content-Security-Policy` limiting connect/img/font sources. |
| `GET /api/draft/[projectId]/page?path=…&token=…` | Server: resolve route via the same ROUTE_MAP / POST_TYPE_MAP derivation used by `emitRouteMapTs` / `emitPostTypeMapTs` (from base build's `page_inventory`), `callAbility` by-slug with the project's WP credentials (@jab/core `McpClient`, session-expiry re-init already landed), run `composeBlockTree` + `resolveRelationshipRefs` + `resolveDynamicLists` + `rewriteHtmlOriginLinks` — the same modules the emitted site imports — return `RenderableBlock[]` JSON + page meta. Front-page slug redirects to `/` (mirror the 308 behavior). Short TTL cache (≤60s, keyed projectId+path) for snappy navigation. |
| `GET /api/draft/[projectId]/bundle/[hash].js` | Streams `drafts/{draftId}/v{N}/bundle.js` from Storage. `Cache-Control: immutable`. |
| `GET /api/draft/[projectId]/css/[hash].css` | Same for `draft.css`. |

### 7.2 Client renderer

A small static module (not LLM-generated) bundled into `bundle.js` alongside the components: walks `RenderableBlock[]` exactly like the emitted dispatcher (registry lookup → component; `core/image` → MediaImage draft variant; unknown → Passthrough innerHTML with rewrite-links), pre-walking `innerBlocks` into `children`. The registry itself is produced by running `emitDispatcherTsx` over the effective inventory and compiling its output — same emit function, zero duplicated mapping logic.

### 7.3 Bundling (esbuild, new dependency)

- Inputs via an esbuild virtual-FS plugin: effective unit TSX (DB/Storage), emitted dispatcher + Passthrough source, renderer shell module.
- Shims (esbuild `alias`/plugin resolution): `next/image` → `<img>` wrapper, `next/link` → `<a>` with the click-intercept hook, MediaImage → draft variant (`<img>`, no host validation needed in draft), `@/lib/sdk/types` → type stub (erased anyway).
- React: bundled from `apps/web`'s tree; JSX `automatic`. (Emitted sites pin `react ^18.3.1`; the platform's React may differ — accepted divergence, see §11.)
- Output: single ESM bundle (loaded by the shell via `<script type="module">`), content-hashed. Per-edit cost ≈ tens of ms.

### 7.4 Security (the invariant)

LLM-generated code **never executes in the `apps/web` server process** (service-role + Anthropic keys live there). The server only parses/bundles (esbuild executes nothing). Execution happens in the user's browser inside the preview iframe, served **sandboxed without `allow-same-origin`** → opaque origin → no access to app cookies/storage despite same-host serving. Because the opaque origin sends no cookies, draft routes authenticate with a short-lived signed token (HMAC over `projectId` + expiry, ~2h; app secret) minted by the workspace RSC into the iframe URL and required by all four routes. Same trust boundary as today's cross-origin Vercel preview iframe.

## 8. Publish lane

`publishDraftAction(projectId)`:

1. RLS membership; draft must be `active` with ≥1 active step; `drafts.status='publishing'`.
2. Create ONE `site_builds` row (`config.mode='draft_publish'`, refs: `draft_id`, `base_build_id`, union `changed_slugs` + `change_reason` over active steps).
3. Materialize component set into `builds/{newBuildId}/components/`: copy base build's components, overwrite with draft unit snapshots. Draft `shell:*` TSX is stored where compose's existing shell-reuse path picks it up (compose must **not** regenerate the shell when a draft shell override exists — extends the `JAB_SKIP_SHELL_REGEN` reuse machinery).
4. Clone page/block inventories from the base build (the existing `edit-site` clone helpers move here — this is the one place cloning still happens, once per publish).
5. Dispatch `site/compose.requested` → unchanged compose → tsc gate → deploy → verify (changed pages re-scored; approval carry-forward for the rest — both exist) → review screen → `publishBuildAction` → promote.
6. On `ready`+promote: `drafts.status='published'`. On pipeline failure: build fails loudly as today; draft returns to `active` (steps intact — user can keep editing or retry publish).

**Base staleness:** the draft pins `base_build_id`. If a newer `ready` build lands while a draft is open, the workspace shows a "draft is based on an older build" notice; v1 resolution is publish or discard (no rebase). Entry guard: `triggerBuildAction` warns when an active draft with steps exists.

## 9. Pane behavior

`deriveWorkspacePreviewState` gains a branch: active draft with ≥1 active step → `{ kind: "draft", url: draftShellUrl, version }`, rendered with a "Draft" badge and a toggle back to the deployed preview. Otherwise behavior is exactly today's. During `publishing` the pane follows the build (existing `building` state).

## 10. Failure handling

| Failure | Behavior |
| --- | --- |
| Patch LLM invalid TSX twice | Fall back to full regen; if that also fails → step `failed` + `error_text` + chat patch. Version doesn't move. |
| esbuild bundle failure | Step `failed` (error excerpt in `error_text`). Nothing committed. |
| Tailwind JIT failure | Same as bundle failure. |
| Stranded step (worker died) | Existing `autoFailStaleOpenEdits` sweep (queued >10m, running >45m, CAS). |
| WP unreachable at render | Page JSON route returns a typed error; shell renders a loud inline error panel (not a blank frame). |
| Storage artifact missing for current version | Shell shows reload prompt; version bump ordering (§6.2.6) makes this transient-only. |
| Token expired | 401 from routes → shell posts a `jab:token-expired` message → pane refreshes the RSC to mint a fresh token. |

## 11. Accepted divergences (draft render vs published site)

| Divergence | Why accepted |
| --- | --- |
| Client-side render (no SSR) | Visual output identical for these presentational components; publish-lane verify is authoritative. |
| `<img>` instead of `next/image` optimization | Same pixels, different loading characteristics. |
| Always-fresh WP data vs 60s ISR | Draft is *more* current, never less. |
| Platform React version vs emitted `^18.3.1` | Components use no version-sensitive APIs (JSX + useState only). |
| No real Lighthouse/perf parity | Out of scope for a draft; publish verify captures home-route perf. |

## 12. Explicitly out of scope (v1)

- **Tree patches** (add/remove/reorder sections). The unit model accommodates a future `treepatch:*` unit kind; planner, emit, and publish-bake changes are a separate campaign.
- **Click-to-edit** (selection overlay → postMessage → chat context). Enabled by owning the iframe shell; follow-up.
- **WP content writes** ("fix this typo" → WP). Different track (write abilities).
- **Draft rebase** onto newer builds; multi-user drafts; redo stacks; shareable-link hardening beyond the token.

## 13. Testing

- **Pure units (vitest, mirroring repo discipline):** effective-state fold (snapshots + undone flags → unit set), undo/revert reducers, route resolution parity (same fixtures as `emitRouteMapTs` tests), token sign/verify + expiry, shim resolution map, changed-slug union, version-bump ordering.
- **Integration:** esbuild-bundle real fixture components (reuse Phase B fixtures) and assert the bundle evaluates + renders expected DOM in jsdom; Tailwind JIT output contains classes present in fixture sources; dispatcher registry built from `emitDispatcherTsx` output binds fixtures correctly.
- **Live (Two Roads runbook, new scenario):** chat edit → preview updates with NO new `site_builds` row; second edit compounds the first (patch-not-regen proof); undo restores; publish → exactly one build through compose/deploy/verify; review shows only changed pages pending; promote succeeds. Flag-off path unchanged.

## 14. Rollout

Single gate remains `JAB_CHAT_EDIT`. The `draft-edit` worker takes over the `site/edit.requested` event; the `edit-site` worker (clone+regen+dispatch path) is deleted in the same campaign (rollback = git revert). The manual Targeted-edits form dispatches the same event and gets the same draft semantics. Legacy `workspace_edits` rows (with `result_build_id`, NULL `draft_id`) keep rendering in history via the existing UI states.

## 15. Open follow-ups recorded elsewhere

- Migration numbering: next free slot at write time is **0034** (drafts + draft_unit_versions + workspace_edits columns). Apply to BOTH Supabase projects (local "JAB WP" + prod "jab-prod") per standing practice.
- `verify-fidelity` page capture is sequential (~27s/page); fine for publish-only cadence now, parallelization is a separate perf follow-up.
