# Multi-Block Guided Edits — Adversarial Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the confirmed critical/high defects the adversarial review found in the guided multi-block chat-edit feature, at production quality, with each fix regression-locked by a test written against the adversary's exact repro.

**Context:** The feature shipped green (1674 tests, tsc clean) but a 5-lens adversarial panel found real defects the confirmatory task-reviews missed. Three lenses converged on ONE root cause (findings A below), which makes it high-confidence. All fixes verified against real code before this plan was written.

## Global Constraints

- Run from `apps/web`: `cd apps/web && npx vitest run <path>`; full suite `npx vitest run`; typecheck `npx tsc --noEmit` (exit 0).
- Current suite: **1674 green** on the feature branch tip (commit `8d6c141`).
- The null-batch byte-identical invariant still holds after every fix: with no batch present, all paths must be unchanged.
- TDD mandatory: each fix's test must FAIL against current code for the adversary's stated reason before you implement.
- Do NOT introduce a DB migration. All fixes are code-only.

---

## Root causes (confirmed against real code)

- **A (HIGH, 4-lens consensus)** — batch edit FAILURE paths flip `needs_clarification=true` while leaving `plan.batch.remaining` populated, so `batchChipModel` renders a spurious "Apply to all N" chip on an *error* bubble, and clicking it re-drives the failure. Two failure paths: (1) `failEdit` in `draft-edit.ts:239-251` (worker-side edit failure); (2) the `WorkspaceEditError` catch in `workspace-chat.ts:396-402` (dispatch refusal). Also the validation-failure clarify (`chat-turn-outcome.ts:42-49`) carries `batch` — but that one is a genuine clarify (no edit dispatched), handled in Task 3.
- **B (CRITICAL)** — `failEdit` (`draft-edit.ts:245-250`) OVERWRITES the assistant message `content` with an error string. That content is the echoed "remaining: …" list the planner relies on to reconstruct the history-only queue. Destroying it makes a failed mid-batch unrecoverable. Unified with A: `failEdit` should stop overwriting content AND stop setting needs_clarification.
- **C (HIGH)** — `loadPlannerMessages` (`workspace-chat.ts:478-491`) selects only `role, content`, so the planner never sees the structured `plan.batch`; once `stableHeadSlice` trims the original request, the shared guidance drifts. Fix: surface batch to the planner as a compact appended line.
- **D (HIGH)** — the propose "Apply to all N" chip is never consumed/disabled; re-clicking re-runs the whole set (`ChatPanel.tsx` + `chat-batch-ui.ts`). Fix: the chip only shows on a bubble with NO linked edit and NOT superseded by a later batch turn in the same conversation.

Deferred (documented, lower severity — see final task): rate-limit stranding on 6+ block sets (medium), `chatTranscriptsEqual` omitting `batchRemaining` (medium/low, latent), BatchChip pending-state polish (low), weak never-invent prompt assertion (low, test-quality).

---

## Task 1: `failEdit` preserves the echo and does not fake a clarification (fixes B + half of A)

**Files:**
- Modify: `apps/web/lib/inngest/functions/draft-edit.ts` (`failEdit` ~239-251)
- Test: `apps/web/lib/inngest/functions/draft-edit.test.ts`

**Root cause:** `failEdit` does `chat_messages.update({ content: error, needs_clarification: true }).eq('id', messageId)`. This (1) destroys the echoed remaining list [B], (2) flips needs_clarification=true which both suppresses the existing failure footer (`chatBubbleFooterFor` returns null when needsClarification) AND makes `batchChipModel` render "Apply to all" on the error bubble [A]. The failed edit already surfaces via `workspace_edits.status='failed'` + `error_text` (joined into `editError`), which `chatBubbleFooterFor` renders as an amber footer when needs_clarification is FALSE.

**Interfaces:**
- Produces: `failEdit` no longer mutates `chat_messages.content` or `needs_clarification`; it relies on the linked-edit failed status + `error_text` for the UI.

- [ ] **Step 1: Write the failing test**

The `failEdit` closure isn't exported. Extract its chat-message behavior into a pure, exported helper and test THAT (keeps it unit-testable without an Inngest harness). Add to `draft-edit.ts`:

```ts
/**
 * On edit failure we DO NOT overwrite the assistant chat message: its content
 * is the echoed batch "remaining" list the planner reconstructs the queue from
 * (adversarial finding B), and flipping needs_clarification would both hide the
 * failure footer and render a spurious "Apply to all" batch chip (finding A).
 * The failure surfaces through the linked workspace_edits.status='failed' +
 * error_text (joined as editError → chatBubbleFooterFor amber footer). This
 * helper returns the chat_messages patch to apply on failure — now empty, i.e.
 * the message is left untouched. Kept as a named export so the invariant is
 * regression-locked by a test.
 */
export function failedEditChatPatch(): Record<string, never> | null {
  return null; // leave the assistant message untouched
}
```

Test:

```ts
// draft-edit.test.ts
import { failedEditChatPatch } from "./draft-edit";

describe("failedEditChatPatch — preserves the batch echo (findings A+B)", () => {
  it("returns null so the assistant message content + needs_clarification are untouched on edit failure", () => {
    // The assistant turn carries the echoed 'remaining: …' list the planner
    // needs; overwriting it (old behavior) destroyed the history-only queue and
    // made an error bubble render an 'Apply to all' chip. The failure must
    // surface via the linked edit's failed status + error_text instead.
    expect(failedEditChatPatch()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/inngest/functions/draft-edit.test.ts -t "preserves the batch echo"`
Expected: FAIL — `failedEditChatPatch` is not exported.

- [ ] **Step 3: Implement — add the helper + rewire `failEdit`**

Add the `failedEditChatPatch` export (above). Change `failEdit` to use it — remove the `chat_messages` content/needs_clarification overwrite:

```ts
    const failEdit = async (message: string) => {
      await admin
        .from("workspace_edits")
        .update({ status: "failed", error_text: message, finished_at: new Date().toISOString() })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
      // Deliberately DO NOT overwrite the assistant chat message (findings A+B):
      // its content is the batch echo the planner reconstructs the queue from,
      // and flipping needs_clarification would hide the failure footer + render
      // a spurious batch chip. The failure surfaces via the linked edit's
      // failed status + error_text (chatBubbleFooterFor amber footer).
      const patch = failedEditChatPatch();
      if (patch && data.messageId) {
        await admin.from("chat_messages").update(patch).eq("id", data.messageId);
      }
    };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run lib/inngest/functions/draft-edit.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/inngest/functions/draft-edit.ts apps/web/lib/inngest/functions/draft-edit.test.ts
git commit -m "fix(chat): failed edit preserves the batch echo, no fake clarify (adversarial A+B)"
```

---

## Task 2: dispatch-refusal path preserves the echo too (rest of A)

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts` (the `WorkspaceEditError` catch ~396-402)
- Test: `apps/web/lib/actions/workspace-chat.test.ts`

**Root cause:** the dispatch-refusal catch does the same `{ content: err.message, needs_clarification: true }` overwrite (workspace-chat.ts:397-402). Same two harms as Task 1's failEdit. But here we DO want to tell the user why the dispatch was refused (concurrency/budget). Resolution: keep a user-visible refusal, but as a SEPARATE assistant message, and do NOT mutate the batch-echo turn or flip its needs_clarification.

**Interfaces:**
- Consumes: `writeAssistant` (already in the file).
- Produces: on a `WorkspaceEditError`, the original assistant echo row is left intact (edit stays linked, will show failed via its own status) and a NEW assistant notice row carries the refusal reason.

- [ ] **Step 1: Write the failing test**

Extract the decision into a pure helper (the file already favors this). Add to `workspace-chat.ts`:

```ts
/**
 * A dispatch refusal (WorkspaceEditError: concurrency/budget/source-not-ready)
 * must NOT overwrite the batch-echo assistant turn or flip its
 * needs_clarification (findings A+B). We surface the refusal as a SEPARATE
 * assistant notice instead. This pure helper decides the two writes.
 */
export function dispatchRefusalPlan(reason: string): {
  overwriteOriginal: false;
  noticeContent: string;
} {
  return { overwriteOriginal: false, noticeContent: reason };
}
```

Test:

```ts
// workspace-chat.test.ts
import { dispatchRefusalPlan } from "./workspace-chat";

describe("dispatchRefusalPlan — does not clobber the batch echo (findings A+B)", () => {
  it("never overwrites the original turn; carries the reason as a separate notice", () => {
    const p = dispatchRefusalPlan("A build is already active. Wait for it to finish.");
    expect(p.overwriteOriginal).toBe(false);
    expect(p.noticeContent).toMatch(/already active/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts -t "does not clobber the batch echo"`
Expected: FAIL — `dispatchRefusalPlan` not exported.

- [ ] **Step 3: Implement**

Add the helper. Rewrite the catch block (workspace-chat.ts ~390-403):

```ts
  } catch (err) {
    if (!(err instanceof WorkspaceEditError)) {
      throw err;
    }
    // Intended refusal (concurrency / budget / source-not-ready). Do NOT
    // overwrite the assistant echo turn (findings A+B): leave it intact so the
    // batch remaining list survives for the planner and no spurious batch chip
    // renders. Surface the reason as a separate assistant notice.
    const { noticeContent } = dispatchRefusalPlan(err.message);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: noticeContent,
      needsClarification: true,
      conversationId,
    });
  }
```

Note: the original `assistantRow` keeps its `edit_id` unset (dispatch failed before the edit id came back), so it correctly shows no footer; the separate notice explains the refusal. The batch echo text is preserved.

- [ ] **Step 4: Run to verify it passes + full planner/chat suites**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0. If an existing test asserted the OLD overwrite behavior, update it to the new two-message contract (and note it in the commit).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/actions/workspace-chat.ts apps/web/lib/actions/workspace-chat.test.ts
git commit -m "fix(chat): dispatch refusal keeps batch echo, uses a separate notice (adversarial A)"
```

---

## Task 3: chips never render on a non-propose / failed / superseded bubble (belt-and-suspenders for A + fixes D)

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.ts` (`batchChipModel`)
- Test: `apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts`

**Root cause:** `batchChipModel` shows `showApplyAll` whenever `needsClarification && batchRemaining.length>0`. Tasks 1-2 stop most error bubbles from having needsClarification=true, but defense-in-depth: a propose bubble is the ONLY place the apply-all chip belongs, and it must be identifiable as (a) having NO linked edit (`editId == null` — a propose dispatches nothing) and (b) not already answered/superseded. We add the editId guard now; the superseded guard (D) needs conversation context, so `batchChipModel` gains an optional `isSuperseded` flag the panel computes.

**Interfaces:**
- Consumes: `ChatMessageView` (has `editId`, `editStatus`).
- Produces: `batchChipModel(m, opts?: { superseded?: boolean })`; `showApplyAll` requires `m.editId == null && m.editStatus !== 'failed' && !opts?.superseded`.

- [ ] **Step 1: Write the failing tests**

```ts
// chat-batch-ui.test.ts — add
describe("batchChipModel — chip only on a live, unanswered propose (findings A+D)", () => {
  const propose: ChatMessageView = {
    id: "p", role: "assistant", content: "apply to all?", needsClarification: true,
    editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
    batchRemaining: ["a", "b", "c"],
  };
  it("shows the chip on a fresh propose (no linked edit, not superseded)", () => {
    expect(batchChipModel(propose)!.showApplyAll).toBe(true);
  });
  it("hides the chip when the bubble has a linked edit (an apply/error, not a propose)", () => {
    expect(batchChipModel({ ...propose, editId: "e1" })).toEqual(
      expect.objectContaining({ showApplyAll: false }),
    );
  });
  it("hides the chip when the linked edit failed", () => {
    const m = batchChipModel({ ...propose, editId: "e1", editStatus: "failed" });
    expect(m?.showApplyAll ?? false).toBe(false);
  });
  it("hides the chip when a later batch turn supersedes this propose", () => {
    expect(batchChipModel(propose, { superseded: true })?.showApplyAll ?? false).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts" -t "live, unanswered propose"`
Expected: FAIL — the linked-edit / superseded cases currently return showApplyAll=true.

- [ ] **Step 3: Implement**

```ts
export function batchChipModel(
  m: ChatMessageView,
  opts?: { superseded?: boolean },
): BatchChipModel | null {
  const count = m.batchRemaining.length;
  if (count === 0) return null;
  // A propose is the ONLY bubble that offers "Apply to all": it dispatched no
  // edit (editId == null), hasn't failed, and hasn't been superseded by a later
  // batch turn in the same conversation (findings A + D). An apply/error turn
  // has a linked edit and only ever shows the progress hint.
  const isLiveProposeAwaitingConfirm =
    m.needsClarification && m.editId == null && m.editStatus !== "failed" && !opts?.superseded;
  if (isLiveProposeAwaitingConfirm) {
    return { showApplyAll: true, count, progressLabel: null, applyAllMessage: "Yes, apply the same change to all of them." };
  }
  return { showApplyAll: false, count, progressLabel: batchProgressLabel(count), applyAllMessage: "" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts" && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.ts" "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts"
git commit -m "fix(chat): batch chip only on a live unanswered propose (adversarial A+D)"
```

---

## Task 4: ChatPanel computes `superseded` + disables the chip while pending (wires D)

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx`
- Test: `apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts` (test the pure superseded helper)

**Root cause:** D needs conversation-level context (is there a LATER batch turn than this propose?). Extract a pure helper and call it from the panel; pass `pending` to disable the chip.

**Interfaces:**
- Consumes: the messages array.
- Produces: `isProposeSuperseded(messages, index): boolean` — true if any assistant message AFTER `index` also has `batchRemaining.length > 0` (a newer batch turn exists, so this propose is stale).

- [ ] **Step 1: Write the failing test**

Add `isProposeSuperseded` to `chat-batch-ui.ts` and test:

```ts
// chat-batch-ui.test.ts
import { isProposeSuperseded } from "./chat-batch-ui";
describe("isProposeSuperseded", () => {
  const mk = (over: Partial<ChatMessageView>): ChatMessageView => ({
    id: "x", role: "assistant", content: "", needsClarification: false,
    editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
    batchRemaining: [], ...over,
  });
  it("is true when a later message also carries a batch", () => {
    const msgs = [mk({ batchRemaining: ["a", "b"] }), mk({ editId: "e1", batchRemaining: ["b"] })];
    expect(isProposeSuperseded(msgs, 0)).toBe(true);
  });
  it("is false when this is the newest batch turn", () => {
    const msgs = [mk({ batchRemaining: ["a", "b"] }), mk({ content: "unrelated" })];
    expect(isProposeSuperseded(msgs, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts" -t "isProposeSuperseded"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement helper + wire the panel**

```ts
// chat-batch-ui.ts
export function isProposeSuperseded(messages: ChatMessageView[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant" && messages[i].batchRemaining.length > 0) return true;
  }
  return false;
}
```

In `ChatPanel.tsx`: pass the index + superseded + pending down to `ChatBubble`, and to `batchChipModel(message, { superseded })`; add `disabled={pending}` to `BatchChip` with pending-aware styling (mirror the Send button's disabled classes). `ChatBubble` must receive the messages array or the precomputed `superseded` boolean — pass the boolean (compute in the `.map`):

```tsx
{messages.map((m, i) => (
  <ChatBubble
    key={m.id}
    message={m}
    superseded={isProposeSuperseded(messages, i)}
    pending={pending}
    onQuickReply={sendContent}
  />
))}
```

Thread `superseded`/`pending` into `ChatBubble`'s signature and into the `batchChipModel(message, { superseded })` call; give `BatchChip` a `disabled?: boolean` prop → `disabled={disabled}` + `disabled:opacity-60 disabled:cursor-not-allowed`.

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts" && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx" "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.ts" "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts"
git commit -m "fix(chat): supersede stale batch propose chips + disable while pending (adversarial D)"
```

---

## Task 5: planner sees the structured batch (fixes C)

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts` (`loadPlannerMessages` ~478-491)
- Create: `apps/web/lib/ai/planner-batch-context.ts` (pure)
- Test: `apps/web/lib/ai/planner-batch-context.test.ts`

**Root cause:** `loadPlannerMessages` selects only `role, content`, so `plan.batch` (guidance + remaining) never reaches the planner; after `stableHeadSlice` trims the original request, the shared guidance drifts. Fix: select `plan` too and append a compact machine-readable batch line to that assistant message's content so the planner reconstructs the set structurally even after trimming — no schema change, still a plain message list.

**Interfaces:**
- Produces: `appendBatchContext(content: string, plan: unknown): string` — if `plan.batch` is a valid batch with non-empty remaining, append `\n\n[batch in progress — remaining blocks: a, b | shared change: <guidance>]`; else return content unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// planner-batch-context.test.ts
import { describe, it, expect } from "vitest";
import { appendBatchContext } from "./planner-batch-context";

describe("appendBatchContext", () => {
  it("appends a machine-readable batch line when the plan carries an in-progress batch", () => {
    const out = appendBatchContext("Restyled Featured Beer.", {
      batch: { remaining: ["acf/featured-news", "acf/visit-us"], guidance: "uniform View More link" },
    });
    expect(out).toContain("Restyled Featured Beer.");
    expect(out).toContain("acf/featured-news");
    expect(out).toContain("acf/visit-us");
    expect(out).toContain("uniform View More link");
    expect(out.toLowerCase()).toContain("remaining");
  });
  it("returns content unchanged when there is no batch", () => {
    expect(appendBatchContext("hi", { action: "x" })).toBe("hi");
    expect(appendBatchContext("hi", null)).toBe("hi");
  });
  it("returns content unchanged when remaining is empty (batch finished)", () => {
    expect(appendBatchContext("done", { batch: { remaining: [], guidance: "x" } })).toBe("done");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/planner-batch-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/ai/planner-batch-context.ts
import { coerceBatchState } from "@/lib/jab/batch-edit";

/**
 * Surface an in-progress batch to the planner. loadPlannerMessages sends the
 * planner a plain (role, content) list; the structured plan.batch never reaches
 * it, so after stableHeadSlice trims the original cross-cutting request the
 * shared guidance drifts (adversarial finding C). We append a compact,
 * machine-readable batch line to the assistant turn's content so the planner
 * reconstructs remaining + guidance structurally, even post-trim. No schema
 * change — still a plain message.
 */
export function appendBatchContext(content: string, plan: unknown): string {
  if (!plan || typeof plan !== "object") return content;
  const batch = coerceBatchState((plan as Record<string, unknown>).batch);
  if (!batch || batch.remaining.length === 0) return content;
  return `${content}\n\n[batch in progress — remaining blocks: ${batch.remaining.join(", ")} | shared change: ${batch.guidance}]`;
}
```

Wire into `loadPlannerMessages`: add `plan` to the select and apply the append:

```ts
async function loadPlannerMessages(
  admin: ReturnType<typeof createAdminClient>,
  conversationId: string,
): Promise<PlannerMessage[]> {
  const { data } = await admin
    .from("chat_messages")
    .select("role, content, plan")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<{ role: "user" | "assistant"; content: string; plan: unknown }>).map(
    (r) => ({ role: r.role, content: appendBatchContext(r.content, r.plan) }),
  );
}
```

Add the import: `import { appendBatchContext } from "@/lib/ai/planner-batch-context";`

- [ ] **Step 4: Run to verify it passes + full suite + tsc**

Run: `cd apps/web && npx vitest run lib/ai/planner-batch-context.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

**Cache note:** appending batch context to a message changes its content, which affects the prompt-cache prefix ONLY for the turns that carry a batch. Ordinary single-edit conversations (no batch) are byte-identical — `appendBatchContext` returns content unchanged. Confirm no planner cache test regresses: `npx vitest run lib/ai/edit-planner.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/planner-batch-context.ts apps/web/lib/ai/planner-batch-context.test.ts apps/web/lib/actions/workspace-chat.ts
git commit -m "fix(chat): surface in-progress batch state to the planner (adversarial C)"
```

---

## Task 6: integration guard — batch persists into chat_messages.plan (closes test-quality gap)

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.test.ts`

**Root cause:** the test-quality lens found no test asserts `plan.batch` actually survives into the persisted `chat_messages.plan` JSONB (the whole history-as-state contract depends on it), nor that `insertAssistant`'s live `chatRowToView(plan: args.plan)` derivation is wired. A plausible refactor dropping `batch` from `planRecord` or the `plan:` arg would pass the whole suite. Lock both.

**Interfaces:** none new — strengthen existing tests.

- [ ] **Step 1: Write the failing/strengthening test**

If the file has an action-level test with a mock supabase capturing the assistant insert payload (the plannerMeta test at ~line 545 does), add:

```ts
it("persists plan.batch into chat_messages.plan so the queue survives in history", async () => {
  // … arrange the same mock-supabase harness the plannerMeta test uses, with a
  // planner returning a batch propose plan …
  // assert the captured assistant insert payload:
  expect(assistantPayload.plan.batch).toEqual({
    remaining: ["acf/featured-beer", "acf/featured-news"],
    guidance: expect.any(String),
  });
});
```

If no such harness exists, instead lock the pure contract that `planRecord` includes batch: assert `chatRowToView({ plan: { ...plan, plannerMeta } }).batchRemaining` reflects the plan's batch (proves the persisted-shape derivation), which fails if batch is ever cherry-picked out of planRecord.

```ts
it("planRecord preserves batch so chatRowToView surfaces it (history-as-state contract)", () => {
  const plan = { batch: { remaining: ["acf/a", "acf/b"], guidance: "x" }, action: "…" };
  const planRecord = { ...plan, plannerMeta: { stopReason: "tool_use" } };
  expect(chatRowToView({
    id: "m", role: "assistant", content: "", needs_clarification: true,
    edit_id: null, build_id: null, created_at: "", plan: planRecord,
    editStatus: null, editError: null,
  }).batchRemaining).toEqual(["acf/a", "acf/b"]);
});
```

- [ ] **Step 2: Run to verify it fails or guards**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts`
Expected: the new test PASSES against current correct code (it's a guard). To prove it's non-vacuous, temporarily change `planRecord` to omit batch and confirm it FAILS, then revert. Document that you did this.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/workspace-chat.test.ts
git commit -m "test(chat): lock batch persistence into chat_messages.plan (adversarial test-quality)"
```

---

## Task 7: full-suite gate + documented residuals

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-multi-block-guided-edits-design.md` (fill the "Post-implementation notes" section)

- [ ] **Step 1: Full suite + tsc**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: all green (1674 + the new remediation tests); tsc exit 0.

- [ ] **Step 2: Write the post-implementation section** documenting: the adversarial outcome (5 lenses, 2 held, 3 broke; the 4-lens consensus on finding A; the critical B), what was fixed (Tasks 1-6), and the ACCEPTED RESIDUALS deferred:
  - **Rate-limit stranding on 6+ block sets** (medium): a set larger than `MAX_EDITS_PER_WINDOW` (5) strands mid-sequence; recovery is "wait ~5 min, type continue". Batch-aware pacing is a follow-up.
  - **`chatTranscriptsEqual` omits `batchRemaining`** (low, latent): only bites if a row's batchRemaining ever becomes mutable (currently write-once), so deferred; note it.
  - **Weak never-invent prompt assertion** (low): the multi-block never-invent-a-name rule is covered by the general Rules line; a section-scoped assertion is a follow-up.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-multi-block-guided-edits-design.md
git commit -m "docs(spec): multi-block adversarial outcome + accepted residuals"
```

---

## Self-review checklist

- Finding A (4-lens) → Tasks 1+2 (stop the overwrites) + Task 3 (chip guard, defense-in-depth). ✓
- Finding B (critical) → Task 1 (preserve echo). ✓
- Finding C (high) → Task 5 (planner sees batch). ✓
- Finding D (high) → Tasks 3+4 (supersede + disable). ✓
- Test-quality gaps → Task 6 (persistence guard) + Task 7 (residuals). ✓
- Null-batch invariant preserved: every fix no-ops when batch is absent (failEdit patch null either way; dispatchRefusal only changes message routing; batchChipModel returns null at count===0; appendBatchContext returns content unchanged). ✓
