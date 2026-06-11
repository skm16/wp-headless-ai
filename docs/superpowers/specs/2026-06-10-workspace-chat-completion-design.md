# Workspace Chat Completion — Design

**Date:** 2026-06-10
**Branch:** `feat/saas-e2e-loop`
**Status:** Approved (user, 2026-06-10)

## Problem

The workspace presents two chat-like surfaces. Typing into either appears to do
"something", but nothing visible changes:

1. **"AI Assistant"** (left column, chat mode) — when `JAB_CHAT_EDIT` is unset,
   the slot falls back to the demo `AIPanel` in
   `app/ui-kit/workspace-jab/workspace-jab-demo.tsx`, whose `handleSend()`
   clears the input and replays a canned fake-streaming animation. Nothing is
   sent anywhere. The real `ChatPanel` (planner → edit dispatch) exists and is
   fully wired but never renders: `JAB_CHAT_EDIT=1` is not set in
   `apps/web/.env.local`. `chat_messages` has zero rows ever.
2. **"Targeted edits"** — real (`requestWorkspaceEditAction` →
   `site/edit.requested` → `edit-site` worker), but gives zero post-submit
   feedback:
   - No `revalidatePath` after submit (chat and discard paths have it; the
     manual form doesn't) → no new history row, no state change on screen.
   - The preview pane polls only while its state is already `building`. An
     edit's result build is created *asynchronously* by the worker, so a
     revalidate immediately after submit still derives `ready` → the pane
     never starts polling → even a successful edit changes nothing on screen
     until a manual reload.
   - Failures render as a bare red "Failed" chip; `workspace_edits.error_text`
     is loaded but never displayed.

### Root-cause evidence (edit `854127ba`, 2026-06-10 16:09)

The edit dispatched correctly, but the `edit-site` Inngest run died in ~250 ms
**before any step executed**: the Next dev server was mid-HMR-recompile
(concurrent source edits) and returned its "missing required error components"
HTML page to the worker invoke. With `retries: 0` that was permanently fatal.
Because no step ran, the worker's own failure-handling never wrote
`status='failed'`/`error_text` — the row sat at `queued` ("Submitting…")
invisibly until discarded. There is no stale-edit sweep (the 2026-06-09
campaign added one for builds only).

### Interaction with the left-rail campaign (landed 2026-06-10, `8a1db56`…`c6385aa`)

A parallel session landed the workspace left-rail mode switcher: `chatSurface`
/ `editsSurface` slot props on `WorkspaceJabDemo`, a `LeftColumn` wrapper
(`w-[322px]`, `overflow-hidden`), and the page mounting both real surfaces via
slots. This campaign builds on that. One latent integration bug: `ChatPanel`
styles itself `w-[380px]` — inside the 322 px `LeftColumn` it renders clipped
by ~58 px. Never observed because the flag has never been on.

## Design

### Track A — Real chat on, theater off

- **A1. Enable the flag (dev):** add `JAB_CHAT_EDIT=1` to `apps/web/.env.local`.
  Env vars don't hot-reload — the Next dev server must be restarted. (Vercel
  prod env gets the flag whenever chat ships publicly; out of scope here.)
- **A2. No mock on real workspaces:** in `WorkspaceJabDemo`, the chat-mode slot
  becomes: `chatSurface` if provided; else if `project` is present render a
  quiet "Chat is disabled on this deployment" notice (LeftColumn-wrapped,
  brand-styled, no input); else (no `project` — the `/ui-kit/workspace-jab`
  demo route) keep the mock `AIPanel`. Real workspaces never show theater
  regardless of flag state.
- **A3. Fix the clip:** `ChatPanel`'s root drops `w-[380px] shrink-0 border-r`
  in favor of `h-full w-full` — `LeftColumn` owns width and border. ChatPanel
  is only ever mounted in the slot (verified sole consumer).

### Track B — Visible lifecycle

- **B1. Revalidate on manual submit:** `requestWorkspaceEditAction` calls
  `revalidatePath('/projects/<id>/workspace')` after the successful dispatch.
  Idempotent for the chat caller (which already revalidates).
- **B2. Preview pane polls during open edits:**
  `loadWorkspacePreviewStateAction` returns a new `hasOpenEdit: boolean` —
  true when any `workspace_edits` row for the project is in
  `('queued','running')` (cheap head-count query; `completed`-but-building
  edits are already covered by `hasActiveBuild` → `building` state).
  `previewPaneStatusFor(state, hasOpenEdit)` gains the param: `shouldPoll` is
  true for `building` (as today) **or** `ready && hasOpenEdit`. The page
  passes `initialHasOpenEdit`; each poll updates it. This closes the timing
  hole between dispatch and the worker creating the result build.
- **B3. `router.refresh()` on meaningful transitions:** in the pane's poll
  callback, when the polled result differs meaningfully from the previous one
  (state `kind` change, `building` phase change, `hasOpenEdit` flip), call
  `router.refresh()`. The page is `force-dynamic`, so the RSC re-renders the
  edit history (fresh chips, error text) and chat `initialMessages`. This is
  the previously-deferred "chat live-refresh", with zero new endpoints.
- **B4. Transcript re-sync:** `ChatPanel` merges fresh `initialMessages` into
  client state via `useEffect` on the prop. Merge semantics (pure function,
  unit-tested, e.g. `mergeChatMessages(server, local)`):
  - Server rows are authoritative (dedupe by id).
  - Local-only rows whose id starts with `optimistic-`/`err-` are preserved
    **unless** a server row supersedes them (same role + content for
    optimistic user rows — the server insert has a real id).
  - Result sorted by `createdAt`.
  With B3, the assistant bubble's "View progress → / Review →" links appear
  once `edit-site`'s link-edit-row step backfills `build_id` — no reload.
- **B5. Failures readable:** in the edits history list, rows whose derived
  label is `Failed` render `edit.errorText` (single truncated monospace line,
  red-toned). The loader already returns `errorText`.

### Track C — Self-heal for stranded edits

- **C1. `autoFailStaleOpenEdits(projectId)`** in `lib/db/` mirroring
  `autoFailStaleActiveBuild`: rows in `('queued','running')` older than
  **10 min (queued)** / **45 min (running)** flip to `status='failed'` with
  `error_text` explaining the auto-fail, `finished_at` stamped, compare-and-set
  on status (`.eq('status', <observed>)`) so a row that just progressed is
  never clobbered. A swept edit renders the Failed chip and releases the
  concurrency slot (`isEditAwaitingReview` is false for failed).
- **C2. Call sites:** `requestWorkspaceEditAction` (beside
  `autoFailStaleActiveBuild`) and the workspace page load (before
  `loadWorkspaceEditHistory`).
- **C3. Keep `retries: 0`** on `edit-site`: a retry after a lost ACK on the
  `dispatch-compose` sendEvent could double-fire compose, and every other
  worker runs `retries: 0` with entry guards tuned to that posture. The sweep
  is the recovery path; today's stranded edit would have self-healed at the
  10-minute mark.

### Track D — Live validation

Restart both dev servers (Next with `JAB_CHAT_EDIT=1`), then against the
Two Roads project (`075e33fd-…`, ready build `bc4c25a2`):

1. Manual-smoke runbook scenarios 1–4
   (`docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md`):
   component edit → ready → scoped review → publish; shell edit (header
   byte-diff); vague prompt → clarify, no build; concurrency refusal.
   Observe the new behavior: preview pane flips to `deploying` without reload,
   history row + chips update live, links appear in the chat bubble.
2. `edit-site.smoke.ts` run (`JAB_CHAT_EDIT=1`, real planner + workers).
3. **Hard rule:** no source-file edits while an edit build is in flight (the
   HMR window is what killed edit `854127ba`).

## Testing

- New unit coverage: `previewPaneStatusFor` (new param matrix),
  `mergeChatMessages` (server-wins, optimistic preserved/superseded, ordering),
  `autoFailStaleOpenEdits` (thresholds, CAS, untouched fresh rows).
- Pinned behavior that must not change: `workspace-chat.test.ts` ordering
  gates (flag → length → membership → budget → persist), conversation-race
  handling; `workspace-preview-pane` existing poll-guard tests.
- Full suites green: `@jab/web` (879+), `@jab/core`, tsc.

## Out of scope / residuals

- TopBar's static "Preview live" text (mock-only `isStreaming` never fires for
  real projects; the real preview pane shows the live phase). Candidate
  follow-up: thread preview state into TopBar.
- Supabase realtime as a poll replacement.
- Production rollout of `JAB_CHAT_EDIT` (Vercel env).
- Host-alias rewrites, menus persistence, hierarchical-page by-path lookup
  (tracked from the 2026-06-10 routing campaign).
