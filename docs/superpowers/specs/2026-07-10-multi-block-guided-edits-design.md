# Guided Sequential Multi-Block Edits — Design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation plan
**Surface:** `apps/web` Live Draft chat-edit planner + chat surface (`edit-planner.ts`, `edit-plan.ts`, `chat-turn-outcome.ts`, `workspace-chat.ts`, `ChatPanel.tsx`)

## Problem

A single cross-cutting style request — e.g. "make all the 'View all X' links a reusable
'View More' style" — touches several block components. Today the planner is hard-wired to
ONE target (`EditPlan` has one `scope` + one `target`; the `emit_edit_plan` tool emits one
plan; `chat-turn-outcome` yields one outcome; one `workspace_edits` row → one `draft-edit`
worker invocation regenerating one unit). So the planner dead-ends with "I can only do one at
a time — which one?" and, worse, when the user names a set it can't map to a real block
(e.g. "Featured Offerings"), the fail-closed target validation refuses entirely. The result
is a frustrating loop for exactly the kind of consistency change users most want.

The Live Draft model is the key enabler: each chat edit patches ONE unit's TSX onto the
versioned draft in ~8–15s with no build (the `draft-edit` worker, event `site/edit.requested`).
The draft can absorb many sequential patches cheaply. So the fix is not a new multi-target
pipeline — it is to **sequence** existing single-block edits under planner guidance.

## Decisions (from brainstorming)

1. **Guided sequential (queue), not auto-fan-out.** The planner enumerates the affected
   blocks and drives them one at a time, auto-advancing ("Featured Beer done — next is
   Featured News, same change?"). Each block edit stays an individually confirmed, validated,
   revertable single-target edit through the EXISTING worker. No multi-target plan schema.
2. **Planner proposes the set; the user confirms it.** The planner can't see block CONTENTS
   (only `block_name` + label + page count), so it INFERS candidate blocks from labels and
   proposes them as a clarifying question the user confirms or trims. The user is ground truth
   for set membership; a wrong guess costs one tap, never a bad edit. This turns the old
   hallucination risk (the "Featured Offerings" refusal) into a safe, editable proposal.
3. **Queue state lives in the conversation history — no DB, no migration.** The planner is
   already a stateless re-derive-from-history function each turn (`stableHeadSlice`). The
   confirmed set + shared guidance + progress ARE the transcript. Every follow-up message
   MUST echo the explicit remaining list, so the state is both visible (UX) and re-readable
   (persistence). Avoids a second source of truth that undo/revert would have to keep in sync.
4. **No worker, `workspace_edits`, or concurrency-guard change.** The guard already serializes
   the draft, which is exactly what a sequential batch wants.

## Architecture

The feature is expressed through EXISTING `EditPlan` fields plus new planner-prompt
intelligence, with ONE new OPTIONAL structured field (`batch`) so the remaining set is
machine-readable for the UI (chips + a reliable echo) rather than only prose.

### New optional plan field: `batch`

`EditPlan` gains `batch: BatchEditState | null` where:

```ts
interface BatchEditState {
  /** Block names still to edit in this cross-cutting change, in order. */
  remaining: string[];
  /** The shared style guidance applied to every block in the set. */
  guidance: string;
}
```

- On the **propose** turn: `needsClarification=true`, `batch={ remaining:[all inferred
  blocks], guidance }`, `clarifyingQuestion` = the propose prose. No edit runs.
- On each **apply** turn: a normal single-target edit for the FIRST remaining block
  (`scope="component"`, `target=<block>`, `regenerationPrompt=<guidance>`), PLUS
  `batch={ remaining:[the blocks AFTER this one], guidance }` so the assistant message can
  echo what's left and the UI can render "N of M".
- `batch=null` for every ordinary single edit, clarification, revert, or token change —
  byte-identical to today.

`batch` is validated defensively in `parsePlannerToolUse` (array of strings + string
guidance; anything malformed → null) and expressed in `EDIT_PLAN_TOOL_SCHEMA` as an
`anyOf: [object, null]` (strict-grammar rules: every prop required, `additionalProperties:
false`, nullable via `anyOf`).

### Planner prompt — new "## Multi-block changes" section

Teaches the planner the full contract:
- Recognize a cross-cutting request (a change described as applying to "all", "every", a
  pattern, or a repeated element across sections).
- **Propose** the inferred set as a clarifying question listing the real `block_name`s +
  labels, set `batch.remaining` to them and `batch.guidance` to the shared instruction.
  NEVER invent a block name — only names from the unit list.
- On confirmation / "next" / "yes", **emit a single-target edit for the first remaining
  block** and set `batch.remaining` to the rest.
- **Always echo** the remaining list in `action` ("Featured Beer ✓ — remaining: Featured
  News, Visit Us.").
- When `remaining` empties, the batch is done — a normal final edit with `batch.remaining=[]`
  (or null) and an "all done" `action`.
- Re-derive the batch from history each turn; if the user trims the set or diverges, honor
  the latest instruction (history is truth).

### Chat surface

- `chat-turn-outcome.ts` carries `batch` through the `clarify` and `edit` outcomes unchanged
  in kind — the propose step is a `clarify` that happens to have `batch`; the apply step is a
  normal `edit`. The pure branch only needs to pass `plan.batch` along.
- `workspace-chat.ts` `ChatMessageView` surfaces `batchRemaining: string[]` (derived from the
  persisted `plan.batch.remaining`, `[]` when absent) so the client can render chips /
  progress without re-reading the whole plan JSON.
- `ChatPanel.tsx` renders **quick-reply chips** on a batch clarify (a bubble whose
  `batchRemaining.length > 0`): a primary "Apply to all N" chip that sends a canned
  "apply the same change to all of them" follow-up, and a subtle "Let me pick" that just
  focuses the composer. During apply turns it shows an unobtrusive "N of M" progress hint.
  All chips send ordinary chat messages — no new server action. Absent `batch` → the panel is
  byte-identical to today (plain text bubbles).

## Data flow (batch)

```
"restyle all view-all links"
  → planner: needsClarification=true,
             batch={ remaining:[featured-beer, featured-news, visit-us], guidance:"…" }
  → clarify bubble + chips: [Apply to all 3] [Let me pick]
"apply to all"                (chip OR typed)
  → planner re-reads history: 3 remaining, none done
  → single-target edit for featured-beer; batch.remaining=[featured-news, visit-us]
  → existing draft-edit worker patches Featured Beer
  → assistant action: "Featured Beer ✓ — 2 left: Featured News, Visit Us. Continue?"
"yes" → edit featured-news (remaining=[visit-us]) → "yes" → edit visit-us (remaining=[])
  → "All 3 sections now share the View More style."
```

Each individual edit is the EXISTING fail-closed, validated, single-target path. The batch
only sequences them.

## Error handling & edge cases

- **User trims the set** ("not Visit Us") → planner emits a new batch with reduced `remaining`.
- **One block edit fails/refused** → that edit surfaces its normal error; the next apply turn's
  echo notes the skip and continues. A failure never strands the queue (there is no stored
  queue to strand — it's re-derived from history).
- **User diverges mid-batch** ("actually make the header red") → handled as a normal single
  edit; a later "continue" resumes the still-in-history remaining list.
- **Undo during a batch** → normal `undo_last`; state re-derives from what actually happened.
- **Empty / single-block "set"** → planner falls back to the ordinary single-edit path;
  `batch=null`, zero overhead.
- **Leaked tool markup in batch prose** → already scrubbed at the parse boundary
  (`stripLeakedToolMarkup` covers `action` + `clarifyingQuestion`).
- **Concurrency guard** → unchanged; already serializes the draft.

## Units (each one responsibility, independently testable)

| File | Responsibility | I/O |
|---|---|---|
| `lib/jab/edit-plan.ts` (modify) | Add `batch` to `EditPlan` + `EDIT_PLAN_TOOL_SCHEMA` (anyOf-null) | none |
| `lib/ai/edit-planner.ts` (modify) | `parsePlannerToolUse` coerces `batch`; prompt "## Multi-block changes" section | none |
| `lib/jab/chat-turn-outcome.ts` (modify) | Carry `batch` through clarify + edit outcomes | none |
| `lib/actions/workspace-chat.ts` (modify) | Surface `batchRemaining` on `ChatMessageView` | DB (existing reads) |
| `app/(app)/projects/[id]/workspace/ChatPanel.tsx` (modify) | Batch chips + "N of M" hint; degrades to text | none (client) |

## Testing

- `parsePlannerToolUse` — a well-formed `batch` coerces; malformed (`remaining` not an array,
  non-string entries, missing guidance) → null; absent → null.
- `EDIT_PLAN_TOOL_SCHEMA` — `batch` present, `anyOf: [object, null]`, strict-grammar-valid
  (every prop required, additionalProperties:false).
- `buildSystemPromptForTest` — contains the multi-block contract (propose-then-sequence,
  echo-remaining, never-invent-a-name).
- `chat-turn-outcome` — `batch` flows through a clarify outcome and an edit outcome; null when
  absent; clean single edits unaffected.
- `ChatMessageView` mapping — `batchRemaining` derived from `plan.batch.remaining`; `[]` when
  the plan has no batch.
- `ChatPanel` — a batch-clarify message renders chips; a non-batch message renders none;
  chips dispatch ordinary chat messages.
- No live-LLM test. **Manual validation:** on Two Roads, "make all the 'View all X' links a
  consistent View More style" → planner proposes the 3 blocks → "apply to all" → each is
  edited in turn with a visible remaining list → the draft shows a consistent link style on
  all three.

## Out of scope (this plan)

- **Auto fan-out** (all blocks edited from one confirm with no per-step turn) — deferred; the
  guided sequential model is the safe v1 and keeps every edit individually confirmable.
- **Content-scan set discovery** (grepping draft TSX to find the exact blocks) — the planner
  proposes and the user confirms instead; a deterministic scanner is a possible future
  precision upgrade.
- **A persisted queue column** — history-as-state is the v1 contract; a structured
  `pending_edit_queue` is only warranted if history-tracking proves unreliable in practice.
- **Cross-page-scope edits** — the batch is over block COMPONENTS (each shared across its
  pages), matching the existing edit unit; no new page-level scope.

## Post-implementation notes

### Adversarial review outcome

The feature shipped green (**1674 tests, `tsc --noEmit` clean**), but a **5-lens adversarial
panel** — run after the confirmatory task-reviews — found real defects those reviews missed.
**2 lenses held** (the feature was correct on their axis); **3 broke it**, and — the
high-confidence signal — **4 lenses converged on ONE root cause (finding A)**. All findings
were verified against real code before the remediation plan was written. The panel confirmed
the remediation of every fix design.

Confirmed findings (see
[`docs/superpowers/plans/2026-07-10-multi-block-adversarial-remediation.md`](../plans/2026-07-10-multi-block-adversarial-remediation.md)):

- **A (HIGH, 4-lens consensus)** — batch FAILURE paths flipped `needs_clarification=true`
  while leaving `plan.batch.remaining` populated, so `batchChipModel` rendered a spurious
  **"Apply to all N" chip on an _error_ bubble** and clicking it re-drove the failure. Two
  failure paths: `failEdit` (`draft-edit.ts`, worker-side edit failure) and the
  `WorkspaceEditError` catch (`workspace-chat.ts`, dispatch refusal).
- **B (CRITICAL)** — `failEdit` **overwrote the assistant message `content`** with an error
  string. That content is the echoed "remaining: …" list the planner reconstructs the
  history-only queue from; destroying it made a failed mid-batch **unrecoverable**.
- **C (HIGH)** — `loadPlannerMessages` selected only `role, content`, so the structured
  `plan.batch` never reached the planner; once `stableHeadSlice` trimmed the original
  cross-cutting request, the **shared guidance drifted**.
- **D (HIGH)** — the propose "Apply to all N" chip was never consumed/disabled, so
  **re-clicking a stale propose re-ran the whole set**.
- **Test-quality gap** — no test asserted `plan.batch` actually survives into the persisted
  `chat_messages.plan` JSONB, so a refactor dropping `batch` from `planRecord` would have
  passed the whole suite.

### What was fixed (Tasks 1–6)

- **Task 1 (A + B)** — `failEdit` no longer overwrites `content` or flips
  `needs_clarification`; a regression-locked `failedEditChatPatch()` returns `null` (message
  left untouched). The failure surfaces through the linked `workspace_edits.status='failed'` +
  `error_text` (→ `editError` → `chatBubbleFooterFor` amber footer).
- **Task 2 (rest of A)** — the dispatch-refusal catch leaves the batch-echo turn intact and
  writes the refusal reason as a **separate** assistant notice (`dispatchRefusalPlan`), never
  clobbering the echo or flipping its `needs_clarification`.
- **Task 3 (A defense-in-depth + D)** — `batchChipModel` only shows "Apply to all" on a **live,
  unanswered propose**: `needsClarification && editId == null && editStatus !== 'failed' &&
  !superseded`; every apply/error/superseded bubble falls to the progress hint.
- **Task 4 (wires D)** — `isProposeSuperseded(messages, index)` marks a propose stale once a
  later batch turn exists; `ChatPanel` threads `superseded` into `batchChipModel` and disables
  the chip while `pending`.
- **Task 5 (C)** — `loadPlannerMessages` now selects `plan` and runs each row through
  `appendBatchContext`, appending a compact machine-readable batch line
  (`[batch in progress — remaining blocks: … | shared change: …]`) so the planner reconstructs
  remaining + guidance structurally even after trimming.
- **Task 6 (test-quality)** — an action-level guard asserts `plan.batch` persists into the
  captured `chat_messages` insert payload (proven non-vacuous by temporarily dropping `batch`
  from `planRecord` and watching it fail).

Each fix was landed TDD (test failing against the buggy code for the adversary's stated reason
first), and each preserves the **null-batch byte-identical invariant** (with no batch present,
every path is unchanged). Final gate: **1686 tests green** (1674 + 12 remediation tests),
`tsc --noEmit` exit 0.

### Accepted residuals (deferred, documented)

- **Rate-limit stranding on 6+ block sets** (medium) — a set larger than
  `MAX_EDITS_PER_WINDOW` (5) strands mid-sequence when the window fills; recovery is "wait
  ~5 min, type continue". Batch-aware pacing (spreading a large set across windows, or a
  batch-scoped budget) is a follow-up.
- **`chatTranscriptsEqual` omits `batchRemaining`** (low, latent) — the transcript-equality
  check doesn't compare `batchRemaining`, so a change to only that field wouldn't be detected
  as a diff. Currently `batchRemaining` is write-once (derived from the immutable persisted
  `plan.batch`), so this cannot bite today; it becomes a real bug only if a row's
  `batchRemaining` ever becomes mutable. Noted for that future.
- **Weak never-invent prompt assertion** (low, test-quality) — the multi-block
  "never invent a block name" rule is covered by the planner's general Rules line but has no
  section-scoped assertion of its own; a targeted test is a follow-up.

### Re-adversarial pass (verified the fixes; found two residuals IN the fixes)

After the remediation landed (1686 green), a **re-adversarial pass** re-attacked the three
broken findings to confirm the fixes held AND introduced no new hole. **B, C, and D verified
genuinely fixed.** But two residuals surfaced — one an incompletely-fixed A, one a NEW defect
*emergent from the composition of two individually-correct fixes* (the kind only
re-adversarial-after-remediation can find):

- **Residual 1 (HIGH) — validation-failure clarify still showed a spurious chip.** The A
  remediation closed 2 of 3 failure paths, but an apply turn whose target isn't a real block
  fails `validateEditPlan` and is surfaced as a `clarify` that *still carried `plan.batch`*
  (`chat-turn-outcome.ts`). That bubble is byte-identical to a genuine propose, so
  `batchChipModel`'s `editId == null` guard could not tell them apart → the chip rendered on
  an error bubble. **Fixed** (commit `2ff30f8`): the validation-failure clarify branch now
  sets `batch: null` — only a **planner-set** `needsClarification` (a real propose) carries
  batch.
- **Residual 2 (MEDIUM, emergent) — a failed mid-batch block was silently dropped.** Task 1
  (preserve the optimistic echo) + Task 5 (reconstruct `remaining` from the plan) are each
  correct alone, but *together*: the apply-turn echo is written optimistically with the
  just-attempted block already excluded from `remaining`, and `loadPlannerMessages` surfaced
  only `role/content/plan` — never the linked edit's failed status. So a block that failed
  *after* its optimistic echo was read by the planner as success → skipped → the batch falsely
  reported complete (only an amber footer on the stale bubble signalled it). This **inverted**
  the pre-remediation behavior (loud stall → silent wrong-success) and was NOT in the
  documented residuals. **Fixed** (commit `2ff30f8`): `loadPlannerMessages` joins
  `edit:edit_id(status)` and passes `editFailed` into `appendBatchContext`, which appends an
  explicit `[NOTE: the edit for "<block>" FAILED — retry it …]` directive so the planner
  re-drives the failed block instead of advancing past it.

Both residual fixes preserve the null-batch byte-identical invariant. **Final gate after the
re-adversarial fixes: 1691 tests green, `tsc --noEmit` exit 0.**

The lesson (recurring across Defect 3 and this feature): **re-adversarial verification after a
remediation is not optional** — fixes interact, and a defect can emerge from the composition of
two individually-correct changes that no single-task review, and not even the first adversarial
pass, could have seen because it did not exist until both fixes landed.

### Still-open residuals after the re-adversarial pass

The three "accepted residuals" above (rate-limit stranding, `chatTranscriptsEqual` omission,
weak never-invent assertion) remain deferred — all low/medium, none a correctness defect in the
core flow. The re-adversarial pass added no new accepted residual beyond confirming those.
