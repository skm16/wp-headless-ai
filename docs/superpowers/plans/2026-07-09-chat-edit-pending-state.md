# Chat-Driven Draft-Edit Pending State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace chat bubble and the Live Draft preview pane honestly reflect whether a chat-dispatched edit is still in flight, done, or failed — instead of the chat bubble claiming "Applied to draft ✓" the instant the edit is merely dispatched.

**Architecture:** Surface the existing `workspace_edits.status` column (already a real `queued → running → completed | failed | discarded` lifecycle, set correctly by `lib/inngest/functions/draft-edit.ts`) through to `ChatMessageView` via a join on `chat_messages.edit_id`, then branch the chat bubble's rendering on it. Add a lightweight `Updating draft…` pill to the Live Draft preview pane, shown while `hasOpenEdit` is true, positioned to not collide with the existing `Draft vN` badge. No new tables, columns, or Inngest events.

**Tech Stack:** Next.js 15 App Router, TypeScript, Vitest, Supabase JS client (raw client, not Drizzle query builder, in the touched files), Tailwind.

## Global Constraints

- Tone: plain, literal copy matching existing `PHASE_LABELS` register (e.g. "Discovering content") — no rotating "personality" phrases. Copy for this feature is exactly: `Applying to draft…` (chat, in-flight), `Applied to draft ✓` (chat, unchanged from today), `Updating draft…` (preview pane pill).
- Motion: any pulse/animation must respect `prefers-reduced-motion` via the same `motion-reduce:` Tailwind convention already used in `ChatPanel.tsx`.
- No new DB migration — `workspace_edits.status` and `workspace_edits.error_text` already exist (migration 0024).
- Preserve the existing Supabase embedded-join defensive pattern already used in `lib/actions/workspace-edit.ts:144` (`Array.isArray(x) ? x[0] : x`) for any new embedded-resource select.
- Preview pane: never dim/scrim/hide the current draft iframe. The pill is additive only.

---

### Task 1: Add `editStatus`/`editError` to `ChatMessageView` and thread them through `loadConversation` + `insertAssistant`

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts:56-95` (interface + `loadConversation`), `:385-422` (`insertAssistant`)
- Test: `apps/web/lib/actions/workspace-chat.test.ts`

**Interfaces:**
- Consumes: nothing new — reads existing `workspace_edits.status` / `workspace_edits.error_text` columns (already defined in `lib/db/schema.ts:391-421`) via a join on `chat_messages.edit_id`.
- Produces: `ChatMessageView.editStatus: "queued" | "running" | "completed" | "failed" | "discarded" | null` and `ChatMessageView.editError: string | null`. Every later task (chat bubble rendering, merge-equality check) consumes these two fields by exactly these names and types.

- [ ] **Step 1: Write the failing test for `loadConversation` joining edit status**

Open `apps/web/lib/actions/workspace-chat.test.ts` first and read lines 1-75 (the mock setup). It uses `vi.hoisted` to create `mockCreateClient` (mocking `@/lib/supabase/server`'s `createClient`), whose default implementation is a fixed chain (`.from().select().eq().single()`) intended for `resolveProject`'s RLS check. `loadConversation` calls `createClient()` independently and chains differently — `.from("conversations").select().eq().order().limit().maybeSingle()`, then a second `.from("chat_messages").select().eq().order()` call with no terminal method (the array resolves directly). Do NOT change the shared default mock (other tests depend on it) — instead override `mockCreateClient` for just this describe block using `mockCreateClient.mockImplementationOnce`, once per test, returning a purpose-built stub client that satisfies exactly the two chains `loadConversation` calls, in order.

Add this describe block to the file:

```typescript
describe("loadConversation — editStatus/editError", () => {
  function stubClientFor(rows: Array<Record<string, unknown>>) {
    let call = 0;
    return {
      from: (table: string) => {
        call += 1;
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: { id: "conv-1" } }),
                  }),
                }),
              }),
            }),
          };
        }
        // table === "chat_messages"
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: rows }),
            }),
          }),
        };
      },
    };
  }

  it("joins workspace_edits.status and error_text onto each message via edit_id", async () => {
    const rows = [
      {
        id: "msg-1",
        role: "assistant",
        content: "Regenerate the Hero — this changes it on every page that uses it (3 pages).",
        needs_clarification: false,
        edit_id: "edit-1",
        build_id: null,
        created_at: "2026-07-09T00:00:00.000Z",
        edit: { status: "running", error_text: null },
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Applied to draft ✓",
        needs_clarification: false,
        edit_id: "edit-2",
        build_id: null,
        created_at: "2026-07-09T00:01:00.000Z",
        edit: { status: "failed", error_text: "The generator hit a problem: timeout" },
      },
      {
        id: "msg-3",
        role: "user",
        content: "make it bolder",
        needs_clarification: false,
        edit_id: null,
        build_id: null,
        created_at: "2026-07-09T00:02:00.000Z",
        edit: null,
      },
    ];
    mockCreateClient.mockImplementationOnce(async () => stubClientFor(rows));

    const { messages } = await loadConversation("proj-1");

    expect(messages[0].editStatus).toBe("running");
    expect(messages[0].editError).toBeNull();
    expect(messages[1].editStatus).toBe("failed");
    expect(messages[1].editError).toBe("The generator hit a problem: timeout");
    expect(messages[2].editStatus).toBeNull();
    expect(messages[2].editError).toBeNull();
  });

  it("handles the embedded edit resource arriving as an array (Supabase relationship inference)", async () => {
    const rows = [
      {
        id: "msg-1",
        role: "assistant",
        content: "x",
        needs_clarification: false,
        edit_id: "edit-1",
        build_id: null,
        created_at: "2026-07-09T00:00:00.000Z",
        edit: [{ status: "completed", error_text: null }],
      },
    ];
    mockCreateClient.mockImplementationOnce(async () => stubClientFor(rows));

    const { messages } = await loadConversation("proj-1");

    expect(messages[0].editStatus).toBe("completed");
  });
});
```

Make sure `loadConversation` is imported at the top of the test file alongside whatever else is already imported from `./workspace-chat` — check the existing import line and add it there rather than a second import statement.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts -t "editStatus/editError"`
Expected: FAIL — `messages[0].editStatus` is `undefined`, not `"running"` (the field doesn't exist yet on `ChatMessageView`, and `loadConversation` doesn't select it).

- [ ] **Step 3: Add the fields to `ChatMessageView` and update `loadConversation`'s select + mapping**

In `apps/web/lib/actions/workspace-chat.ts`, update the interface (currently lines 56-64):

```typescript
export type WorkspaceEditStatus = "queued" | "running" | "completed" | "failed" | "discarded";

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  needsClarification: boolean;
  editId: string | null;
  buildId: string | null;
  createdAt: string;
  editStatus: WorkspaceEditStatus | null;
  editError: string | null;
}
```

Update `loadConversation` (currently lines 68-95) — change the `chat_messages` select to join `workspace_edits` via `edit_id`, and map the two new fields defensively (embedded resource may arrive as object or array, per the existing pattern in `lib/actions/workspace-edit.ts:144`):

```typescript
export async function loadConversation(
  projectId: string,
): Promise<{ conversationId: string | null; messages: ChatMessageView[] }> {
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!conv) return { conversationId: null, messages: [] };
  const { data: rows } = await supabase
    .from("chat_messages")
    .select(
      "id, role, content, needs_clarification, edit_id, build_id, created_at, edit:edit_id(status, error_text)",
    )
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  const messages = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const editJoin = r.edit as
      | { status: WorkspaceEditStatus; error_text: string | null }
      | { status: WorkspaceEditStatus; error_text: string | null }[]
      | null;
    const edit = Array.isArray(editJoin) ? (editJoin[0] ?? null) : editJoin;
    return {
      id: String(r.id),
      role: r.role as "user" | "assistant",
      content: String(r.content),
      needsClarification: r.needs_clarification === true,
      editId: (r.edit_id as string | null) ?? null,
      buildId: (r.build_id as string | null) ?? null,
      createdAt: String(r.created_at),
      editStatus: edit?.status ?? null,
      editError: edit?.error_text ?? null,
    };
  });
  return { conversationId: conv.id, messages };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts -t "editStatus/editError"`
Expected: PASS

- [ ] **Step 5: Update `insertAssistant` to always populate the two new fields**

`insertAssistant` (currently lines 385-422) inserts a freshly-created row — at insert time an edit (if any) doesn't exist yet as a DB row the insert can join against in the same call, but the row IS then updated with `edit_id` afterward by the caller (`sendChatMessageAction` line 279: `.update({ edit_id: editId })`). So `insertAssistant`'s returned `ChatMessageView` should default `editStatus`/`editError` to `null`, and the one caller that immediately dispatches an edit (`sendChatMessageAction`, Step 6 below) is responsible for reflecting the true just-dispatched state in its own return value — do not have `insertAssistant` re-query the DB to backfill this (adds a round trip for no benefit; the edit doesn't exist yet when this function runs).

Update the return statement in `insertAssistant` (currently lines 413-421):

```typescript
  return {
    id: String(data.id),
    role: "assistant",
    content: String(data.content),
    needsClarification: data.needs_clarification === true,
    editId: (data.edit_id as string | null) ?? null,
    buildId: (data.build_id as string | null) ?? null,
    createdAt: String(data.created_at),
    editStatus: null,
    editError: null,
  };
```

- [ ] **Step 6: Update `sendChatMessageAction`'s edit-branch return to reflect `"queued"` immediately after dispatch**

In `sendChatMessageAction` (around current line 281, `return { assistant: { ...assistantRow, editId } };`), the edit was just successfully dispatched via `requestWorkspaceEditAction` — its `workspace_edits` row was inserted as `status: "queued"` by that action (confirm this default by reading `lib/db/schema.ts:412-415`, already true — `.default("queued")`). Update the return to also stamp `editStatus: "queued"` so the client-side render (Task 3) has the correct in-flight state on the very first paint, without waiting for the next poll:

```typescript
    await admin.from("chat_messages").update({ edit_id: editId }).eq("id", assistantRow.id);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return { assistant: { ...assistantRow, editId, editStatus: "queued" } };
```

- [ ] **Step 7: Run the full file's test suite to confirm no regression**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts`
Expected: All tests PASS (the pre-existing 11 tests plus the 2 new ones = 13 total).

- [ ] **Step 8: Commit**

```bash
cd apps/web
git add lib/actions/workspace-chat.ts lib/actions/workspace-chat.test.ts
git commit -m "feat(chat): thread workspace_edits.status/error_text onto ChatMessageView"
```

---

### Task 2: Fix `chatTranscriptsEqual` to treat an `editStatus`/`editError` change as a real diff

**Files:**
- Modify: `apps/web/lib/jab/chat-message-merge.ts:54-69`
- Test: create `apps/web/lib/jab/chat-message-merge.test.ts` if it does not already exist; otherwise extend it.

**Interfaces:**
- Consumes: `ChatMessageView` (now carrying `editStatus`/`editError`, from Task 1).
- Produces: `chatTranscriptsEqual` behavior unchanged for existing fields; now also returns `false` whenever any message's `editStatus` or `editError` differs between `a` and `b`.

- [ ] **Step 1: Check whether `chat-message-merge.test.ts` already exists**

Run: `cd apps/web && ls lib/jab/chat-message-merge.test.ts 2>&1 || echo "does not exist"`

If it exists, read it fully before proceeding so the new test matches its existing style/fixtures exactly. If it does not exist, you'll create it fresh in Step 3.

- [ ] **Step 2: Write the failing test**

Add (to the existing file, or a new one — see Step 1) using this base message-builder helper if the file doesn't already have one:

```typescript
import { describe, it, expect } from "vitest";
import { chatTranscriptsEqual, mergeChatMessages } from "./chat-message-merge";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

function baseMessage(over: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: "msg-1",
    role: "assistant",
    content: "Regenerate the Hero.",
    needsClarification: false,
    editId: "edit-1",
    buildId: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    editStatus: "queued",
    editError: null,
    ...over,
  };
}

describe("chatTranscriptsEqual — editStatus/editError sensitivity", () => {
  it("treats a queued->completed editStatus change as NOT equal", () => {
    const a = [baseMessage({ editStatus: "queued" })];
    const b = [baseMessage({ editStatus: "completed" })];
    expect(chatTranscriptsEqual(a, b)).toBe(false);
  });

  it("treats a newly-populated editError as NOT equal", () => {
    const a = [baseMessage({ editStatus: "running", editError: null })];
    const b = [baseMessage({ editStatus: "failed", editError: "boom" })];
    expect(chatTranscriptsEqual(a, b)).toBe(false);
  });

  it("still treats fully identical transcripts as equal", () => {
    const a = [baseMessage()];
    const b = [baseMessage()];
    expect(chatTranscriptsEqual(a, b)).toBe(true);
  });
});
```

If this is a new test file, also carry over minimal coverage of the pre-existing `mergeChatMessages`/`chatTranscriptsEqual` behavior is NOT required here — those are presumably already covered elsewhere (check `ChatPanel.tsx`'s own test file, if any, before assuming zero coverage exists; if genuinely zero coverage exists anywhere for these two functions, that's a pre-existing gap out of scope for this task — only add the 3 tests above).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/chat-message-merge.test.ts -t "editStatus/editError sensitivity"`
Expected: FAIL on the first two tests (`chatTranscriptsEqual` returns `true` for both today, since it doesn't compare these fields).

- [ ] **Step 4: Update `chatTranscriptsEqual` to compare the two new fields**

In `apps/web/lib/jab/chat-message-merge.ts`, update the function (currently lines 54-69):

```typescript
export function chatTranscriptsEqual(
  a: ChatMessageView[],
  b: ChatMessageView[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    return (
      m.id === o.id &&
      m.content === o.content &&
      m.buildId === o.buildId &&
      m.editId === o.editId &&
      m.needsClarification === o.needsClarification &&
      m.editStatus === o.editStatus &&
      m.editError === o.editError
    );
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/chat-message-merge.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
cd apps/web
git add lib/jab/chat-message-merge.ts lib/jab/chat-message-merge.test.ts
git commit -m "fix(chat): treat editStatus/editError changes as real transcript diffs"
```

---

### Task 3: Render the chat bubble's pending/completed/failed states from `editStatus`

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx:145-189` (the `ChatBubble` component)
- Test: create `apps/web/app/(app)/projects/[id]/workspace/chat-bubble-status.test.ts` — a pure-function unit test for the status→render mapping, extracted so it's testable without mounting the component.

**Interfaces:**
- Consumes: `ChatMessageView.editStatus`, `ChatMessageView.editError` (Task 1).
- Produces: an exported pure function `chatBubbleFooterFor(message: Pick<ChatMessageView, "editId" | "buildId" | "editStatus" | "editError" | "needsClarification">): { text: string; tone: "neutral" | "pending" | "amber" } | null` that `ChatBubble` calls to decide its footer line + styling. Later tasks (none in this plan) would consume this name/signature if extended.

- [ ] **Step 1: Write the failing test for the pure mapping function**

Create `apps/web/app/(app)/projects/[id]/workspace/chat-bubble-status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { chatBubbleFooterFor } from "./chat-bubble-status";

describe("chatBubbleFooterFor", () => {
  it("returns null when there is no linked edit", () => {
    expect(
      chatBubbleFooterFor({ editId: null, buildId: null, editStatus: null, editError: null, needsClarification: false }),
    ).toBeNull();
  });

  it("returns null for a needsClarification message even if editId is set", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "queued", editError: null, needsClarification: true }),
    ).toBeNull();
  });

  it("shows a pending state for status=queued", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "queued", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applying to draft…", tone: "pending" });
  });

  it("shows a pending state for status=running", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "running", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applying to draft…", tone: "pending" });
  });

  it("shows the completed checkmark for status=completed", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "completed", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applied to draft ✓", tone: "neutral" });
  });

  it("shows the real error_text for status=failed, amber tone", () => {
    const r = chatBubbleFooterFor({
      editId: "e1", buildId: null, editStatus: "failed",
      editError: "The generator hit a problem: timeout", needsClarification: false,
    });
    expect(r).toEqual({ text: "The generator hit a problem: timeout", tone: "amber" });
  });

  it("falls back to a generic message for status=failed with no error_text", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "failed", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Something went wrong applying that edit.", tone: "amber" });
  });

  it("returns null for status=discarded", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "discarded", editError: null, needsClarification: false }),
    ).toBeNull();
  });

  it("returns null once a buildId is linked (full-build edit path, unaffected by this feature)", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: "build-1", editStatus: "completed", editError: null, needsClarification: false }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-bubble-status.test.ts"`
Expected: FAIL — the module `./chat-bubble-status` doesn't exist yet.

- [ ] **Step 3: Create the pure mapping function**

Create `apps/web/app/(app)/projects/[id]/workspace/chat-bubble-status.tsx`:

```typescript
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

/**
 * chat-bubble-status — pure mapping from a chat message's linked-edit state
 * to the bubble's footer line. Split out from ChatBubble so the branching
 * logic is unit-testable without mounting React.
 *
 * Kept separate from the buildId-linked footer (progress/review links,
 * rendered directly in ChatBubble): once a full-build edit exists (buildId
 * set), that link pair replaces this footer entirely — this function
 * returns null in that case so the two footers never both render.
 */
export type ChatBubbleFooterTone = "neutral" | "pending" | "amber";

export interface ChatBubbleFooter {
  text: string;
  tone: ChatBubbleFooterTone;
}

export function chatBubbleFooterFor(
  message: Pick<ChatMessageView, "editId" | "buildId" | "editStatus" | "editError" | "needsClarification">,
): ChatBubbleFooter | null {
  if (!message.editId || message.buildId || message.needsClarification) return null;

  switch (message.editStatus) {
    case "queued":
    case "running":
      return { text: "Applying to draft…", tone: "pending" };
    case "completed":
      return { text: "Applied to draft ✓", tone: "neutral" };
    case "failed":
      return {
        text: message.editError?.trim() || "Something went wrong applying that edit.",
        tone: "amber",
      };
    case "discarded":
    case null:
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-bubble-status.test.ts"`
Expected: All 9 tests PASS.

- [ ] **Step 5: Wire `ChatBubble` to use `chatBubbleFooterFor`**

In `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx`, add the import at the top of the file (alongside the existing imports, currently lines 1-8):

```typescript
import { chatBubbleFooterFor, type ChatBubbleFooter } from "./chat-bubble-status";
```

Replace the existing footer JSX in `ChatBubble` (currently lines 181-185):

```tsx
        {!isUser && message.editId && !message.buildId && !message.needsClarification && (
          <p className="mt-2 font-mono text-[11px] text-teal/70">
            Applied to draft ✓
          </p>
        )}
```

with a call to the new pure function plus tone-based styling:

```tsx
        {!isUser && (() => {
          const footer = chatBubbleFooterFor(message);
          if (!footer) return null;
          return <ChatBubbleFooterLine footer={footer} />;
        })()}
```

Add a small dedicated sub-component right after `ChatBubble` (below its closing brace, before end of file) so the pulse animation and tone classes stay in one place:

```tsx
function ChatBubbleFooterLine({ footer }: { footer: ChatBubbleFooter }) {
  const toneClass =
    footer.tone === "amber"
      ? "text-amb"
      : footer.tone === "pending"
        ? "text-teal/70"
        : "text-teal/70";
  return (
    <p className={`mt-2 flex items-center gap-1.5 font-mono text-[11px] ${toneClass}`}>
      {footer.tone === "pending" && (
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal/70 motion-reduce:animate-none"
        />
      )}
      {footer.text}
    </p>
  );
}
```

- [ ] **Step 6: Run the ChatPanel-adjacent test suite to confirm no regression**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/"`
Expected: All tests in that directory PASS (including the new `chat-bubble-status.test.ts`).

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd apps/web
git add app/\(app\)/projects/\[id\]/workspace/ChatPanel.tsx app/\(app\)/projects/\[id\]/workspace/chat-bubble-status.tsx app/\(app\)/projects/\[id\]/workspace/chat-bubble-status.test.ts
git commit -m "feat(chat): render pending/failed edit states in the chat bubble instead of a premature checkmark"
```

---

### Task 4: Add the "Updating draft…" pill to the Live Draft preview pane

**Files:**
- Modify: `apps/web/components/workspace-preview-pane.tsx:220-241` (the draft-iframe branch)
- Test: `apps/web/components/workspace-preview-pane.test.ts` (extend if it exists — check first; if it doesn't exist, create it covering only the new pure logic below, not the full component).

**Interfaces:**
- Consumes: `hasOpenEdit` (already a `WorkspacePreviewPane` state variable, `workspace-preview-pane.tsx:101`), `draftPreview` (already existing state, same file).
- Produces: an exported pure function `shouldShowDraftUpdatingPill(hasOpenEdit: boolean, hasDraftPreview: boolean): boolean` — extracted so the visibility condition is unit-testable, following the same pattern as the existing exported `previewPaneStatusFor` / `isMeaningfulTransition` pure functions in this file.

- [ ] **Step 1: Check for an existing test file**

Run: `cd apps/web && ls components/workspace-preview-pane.test.ts 2>&1 || echo "does not exist"`

Read it fully if it exists, to match its existing style before adding new tests.

- [ ] **Step 2: Write the failing test**

Add to the existing test file (or create it):

```typescript
import { describe, it, expect } from "vitest";
import { shouldShowDraftUpdatingPill } from "./workspace-preview-pane";

describe("shouldShowDraftUpdatingPill", () => {
  it("is true when an edit is open and the draft preview is showing", () => {
    expect(shouldShowDraftUpdatingPill(true, true)).toBe(true);
  });

  it("is false when no edit is open", () => {
    expect(shouldShowDraftUpdatingPill(false, true)).toBe(false);
  });

  it("is false when there is no draft preview to show a pill over", () => {
    expect(shouldShowDraftUpdatingPill(true, false)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run components/workspace-preview-pane.test.ts -t "shouldShowDraftUpdatingPill"`
Expected: FAIL — `shouldShowDraftUpdatingPill` is not exported yet.

- [ ] **Step 4: Add the pure function and wire it into the draft-iframe branch**

In `apps/web/components/workspace-preview-pane.tsx`, add the exported pure function near the other exported pure functions in this file (after `isMeaningfulTransition`, currently ending at line 89):

```typescript
/**
 * shouldShowDraftUpdatingPill — true while a chat-dispatched edit is still
 * queued/running AND the Live Draft iframe (not the published/build preview)
 * is the thing on screen. The pill disappears the instant hasOpenEdit flips
 * false (edit completed OR failed) — no separate failure UI needed here,
 * since the chat bubble is the sole place the failure reason surfaces.
 */
export function shouldShowDraftUpdatingPill(
  hasOpenEdit: boolean,
  hasDraftPreview: boolean,
): boolean {
  return hasOpenEdit && hasDraftPreview;
}
```

Update the draft-iframe branch (currently lines 220-241) to render the pill alongside the existing `Draft vN` badge:

```tsx
  if (draftPreview) {
    return (
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
        <iframe
          key={draftPreview.tokenUrl}
          src={draftPreview.tokenUrl}
          title="Draft preview"
          className="h-full w-full flex-1 border-0"
          sandbox="allow-scripts allow-forms"
        />
        {/* "Draft vN" badge — top-right teal pill, pointer-events-none so it
            doesn't block scrolling the iframe chrome. */}
        <div
          aria-label={`Draft version ${draftPreview.version}`}
          className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/[0.12] px-2.5 py-1 font-mono text-[11px] text-teal"
        >
          <span className="block h-1.5 w-1.5 rounded-full bg-teal" />
          Draft v{draftPreview.version}
        </div>
        {shouldShowDraftUpdatingPill(hasOpenEdit, true) && (
          <div
            aria-live="polite"
            className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/[0.12] px-2.5 py-1 font-mono text-[11px] text-teal"
          >
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-teal motion-reduce:animate-none" />
            Updating draft…
          </div>
        )}
      </div>
    );
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run components/workspace-preview-pane.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd apps/web
git add components/workspace-preview-pane.tsx components/workspace-preview-pane.test.ts
git commit -m "feat(preview): show an Updating draft pill while a chat edit is in flight"
```

---

### Task 5: Full-suite verification

**Files:** none modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full `@jab/web` test suite**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (pre-existing count + the new tests added in Tasks 1-4).

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually confirm no orphaned copy**

Run: `cd apps/web && grep -rn "Applied to draft" app/ components/ --include="*.tsx" --include="*.ts"`
Expected: the string appears only inside `chat-bubble-status.tsx` (the single source of truth for that copy) and its test file — not duplicated as a separate literal anywhere else.

- [ ] **Step 4: Commit (only if any fixups were needed in Steps 1-3; otherwise skip)**

```bash
cd apps/web
git add -A
git commit -m "chore(chat-edit-pending-state): full-suite verification pass"
```
