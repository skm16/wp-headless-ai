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

_(to be filled after the adversarial review + remediation, mirroring the Defect-3 spec's
"adversarial review outcome" + "accepted residuals" sections.)_
