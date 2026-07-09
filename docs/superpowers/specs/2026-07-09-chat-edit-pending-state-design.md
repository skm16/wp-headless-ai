# Chat-driven draft-edit pending state — Design

**Date:** 2026-07-09
**Status:** Approved, ready for implementation plan
**Surfaces touched:** `apps/web` workspace ChatPanel + WorkspacePreviewPane (Live Draft only)

## Problem

The workspace chat (`ChatPanel.tsx`) dispatches a targeted edit via `sendChatMessageAction`,
which returns almost immediately — it plans the edit and inserts a `workspace_edits` row
(`status: "queued"`), then fires the `draft-edit` Inngest worker asynchronously. The actual
work (patch-generation LLM call + draft artifact rebuild) takes roughly 8-15 seconds.

Today, the assistant chat bubble renders **"Applied to draft ✓"** based solely on
`editId && !buildId` being true — which is true from the instant the row is inserted, not
from actual completion. Simultaneously, the preview iframe (`WorkspacePreviewPane`) has no
pending indicator at all; it silently shows the stale draft until its 3s poll detects a
version bump. The result: the UI declares success before the edit has run, in both places
that matter.

## Root cause

`workspace_edits.status` already tracks the real lifecycle
(`queued → running → completed | failed | discarded`) — the draft-edit worker
(`lib/inngest/functions/draft-edit.ts`) sets `status: "completed"` only after the patch
succeeds and draft artifacts are rebuilt (confirmed at lines 234 and 381). Neither UI surface
reads this column. `ChatMessageView` doesn't carry it, and `previewPaneStatusFor` /
`hasOpenWorkspaceEdit` already expose an "open" signal but nothing renders it as a pending
state in the draft-preview path specifically.

This is a data-plumbing gap, not a missing capability — no new tables, columns, or Inngest
events are needed.

## Decisions (from brainstorming)

1. **Fix both the timing AND the message**, not just insert a spinner before the same
   (currently-inaccurate) trigger. The bubble must reflect real `workspace_edits.status`.
2. **Tone: plain + subtle motion**, not personality-forward ("beeping, booping"). Every other
   progress surface in this app (`build-status.ts`'s `PHASE_LABELS`: "Discovering content",
   "Composing the site", "Verifying fidelity") uses literal, technical English. This is an
   agency-facing tool — agencies may demo this live to their own clients — so pending-state
   copy stays consistent with that register. Personality is expressed through a small
   animated cue (pulsing dot / shimmer), not rotating joke phrases.
3. **Preview pane: keep the stale draft visible + a small overlay pill**, not a
   dimmed/scrimmed modal-style block. The current draft is still valid content; hiding or
   dimming it overstates the disruption and blocks interacting with genuinely-fine content.
4. **Failure surfaces the real `error_text`** in the chat bubble (styled like the existing
   amber/clarification treatment), not a generic "something went wrong." Consistent with
   "errors are loud" and how `sendChatMessageAction` already handles every other failure
   class.

## Design

### Data plumbing

Add `editStatus: WorkspaceEditStatus | null` to `ChatMessageView`
(`"queued" | "running" | "completed" | "failed" | "discarded"`), threaded through the same
places `editId`/`buildId` already flow:

- `loadConversation` (`workspace-chat.ts`) — join/select the status alongside the existing
  `edit_id`/`build_id` columns already read from `chat_messages`. (`chat_messages` doesn't
  itself carry status — it must be read from the linked `workspace_edits` row via `edit_id`;
  confirm the cheapest join shape, likely a single follow-up `IN` query keyed by the page's
  edit ids rather than N+1.)
- `insertAssistant` / the `sendChatMessageAction` return value — the row is freshly inserted
  as `queued`, so this can be a literal `"queued"` at insert time rather than a re-fetch.

No new DB migration — `workspace_edits.status` already exists (migration 0024).

### Chat bubble (`ChatBubble` in `ChatPanel.tsx`)

Replace the current condition (`message.editId && !message.buildId && !message.needsClarification`
→ static "Applied to draft ✓") with a branch on `message.editStatus`:

| `editStatus` | Rendered content | Style |
|---|---|---|
| `"queued"` \| `"running"` | `Applying to draft…` + subtle pulse animation | neutral (existing non-amber bubble style) |
| `"completed"` | `Applied to draft ✓` (unchanged copy) | neutral |
| `"failed"` | The real `error_text` from the linked `workspace_edits` row | amber/clarification style (matches `needsClarification` bubbles) |
| `"discarded"` \| `null` | No footer line (today's behavior for edits with no status) | — |

The pulse animation respects `prefers-reduced-motion`, consistent with the panel's existing
`motion-reduce:transition-none` usage.

`error_text` needs to reach `ChatMessageView` for the `"failed"` case — add it as an optional
field (`editError: string | null`) alongside `editStatus`, sourced from the same join.

### Preview pane (`WorkspacePreviewPane.tsx`, draft-iframe branch only)

While `hasOpenEdit` is true (existing signal, already polled every 5s via
`loadWorkspacePreviewStateAction`) **and** the draft-iframe branch is rendering (i.e.
`draftPreview` is non-null), show a small pill:

- Text: `Updating draft…` + the same pulse treatment as the chat bubble (shared visual
  language between the two surfaces).
- Position: **top-left** of the iframe (`absolute left-3 top-3`), so it doesn't collide with
  the existing `Draft vN` badge at top-right.
- The iframe itself keeps rendering the current draft version underneath, fully interactive
  — no scrim, no dimming.
- Disappears the moment `hasOpenEdit` goes false OR the poll detects a version bump —
  whichever the existing polling logic naturally produces first. No new polling loop.

### Failure case in the preview pane

`hasOpenWorkspaceEdit`'s query only counts `queued`/`running` rows — a transition to
`failed` naturally drops `hasOpenEdit` to `false`, so the pill disappears on its own. The
preview pane needs no new failure-specific UI: the chat bubble is the sole place the failure
reason surfaces, since the visible draft content is unchanged (the last-good version keeps
showing).

### Testing

- `previewPaneStatusFor`-style pure-function unit test for the bubble's
  `editStatus → { text, style }` mapping.
- `loadConversation` / `insertAssistant` tests confirming `editStatus` (and `editError` for
  the failed case) thread through correctly.
- Extend `chatTranscriptsEqual` / `mergeChatMessages` tests: a message whose only change is
  `editStatus` (e.g. `queued` → `completed`) must be treated as a real diff, not a no-op —
  audit the current equality check for this before assuming it already works.
- Preview-pane pill visibility test alongside the existing `previewPaneStatusFor` /
  `isMeaningfulTransition` tests.

## Out of scope

- Rotating "personality" status phrases (rejected — tone mismatch with the rest of the app).
- A scrim/dimmed preview treatment (rejected — overstates disruption to valid content).
- Any change to the `draft-edit` worker's actual timing, retry behavior, or the underlying
  patch-generation pipeline — this is a status-surfacing fix only.
- The `discarded` status getting its own bubble treatment (no current flow produces a fresh
  bubble in this state).
