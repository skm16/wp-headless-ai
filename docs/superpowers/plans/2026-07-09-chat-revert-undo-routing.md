# Chat Revert/Undo Routing Implementation Plan (Defect 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace-chat user revert/undo edits in natural language ("undo that", "go back", "revert to version 10") — routing the request to the already-working `undoLastEditAction` / `revertToVersionAction` server actions instead of mis-planning it as a forward regeneration that crashes.

**Architecture:** Revert is modeled as a distinct planner intent that NEVER becomes a `workspace_edits` row or touches the build pipeline. The planner tool schema gains a standalone `revertIntent` field (independent of `scope` — `WorkspaceEditScope` stays the 3 real forward-edit scopes). `chat-turn-outcome.ts` gains a third outcome `kind: "revert"`. `sendChatMessageAction` branches on it and calls the existing revert actions directly, persisting a plain assistant chat row (no `edit_id`, no compose). "version N" resolves to the Nth completed, non-undone edit; when the mapping is uncertain the planner asks a clarifying question rather than guessing.

**Tech Stack:** TypeScript, Vitest, Anthropic tool-use (strict schema), Supabase JS client. No DB migration (uses existing `workspace_edits`/`drafts`).

## Global Constraints

- **`WorkspaceEditScope` stays `"component" | "shell" | "tokens"`** (lib/jab/workspace-edit-validation.ts:7). Revert is NOT a scope — it is a separate `revertIntent` field. Do not add "revert" to that enum (it feeds build-config/edit-impact/workspace_edits machinery a revert must bypass).
- **Strict schema discipline** (edit-plan.ts:42 `strict: true`): every property added to `input_schema.properties` MUST also be added to `required`, and nullable is expressed via `anyOf: [..., { type: "null" }]` — NOT a `type` array union, and NO numeric `minimum`/`maximum`/`minLength`/`maxLength` anywhere (the existing test `EDIT_PLAN_TOOL_SCHEMA … meets the structured-outputs grammar constraints` asserts this — it MUST stay green).
- **Revert v1 is undo-focused** (product decision 2026-07-09): `undo_last` handles "undo"/"go back"/"that was wrong" robustly; a numbered "version N" maps to the Nth completed non-undone edit ascending; when uncertain, the planner asks a clarifying question rather than reverting to the wrong point.
- A revert reply is INSTANT (no compose/build) — persist it as a plain assistant `chat_messages` row (`needs_clarification=false`, `edit_id=null`) and `revalidatePath` so the history panel reflects the reverted state. Never route it through `requestWorkspaceEditAction`.
- Surface the existing typed revert-action results (`no_draft`, `nothing_to_undo`, `edit_not_found`, `draft_locked`) as friendly chat text, never a raw throw.

---

### Task 1: Add `revertIntent`/`revertVersion` to the plan schema, interface, and parser

**Files:**
- Modify: `apps/web/lib/jab/edit-plan.ts` (`EditPlan` interface :13-27; `EDIT_PLAN_TOOL_SCHEMA` :38-97)
- Modify: `apps/web/lib/ai/edit-planner.ts` (`parsePlannerToolUse` :70-87)
- Test: `apps/web/lib/jab/edit-plan.test.ts`, `apps/web/lib/ai/edit-planner.test.ts`

**Interfaces:**
- Produces: `EditPlan.revertIntent: "undo_last" | "to_version" | null` and `EditPlan.revertVersion: number | null`. `parsePlannerToolUse` coerces both defensively. Later tasks (validation, outcome, routing) consume these exact names/types.

- [ ] **Step 1: Write the failing schema test**

Add to `apps/web/lib/jab/edit-plan.test.ts` (the `EDIT_PLAN_TOOL_SCHEMA` describe block already exists — extend it):

```typescript
it("declares revertIntent and revertVersion in properties and required", () => {
  const schema = EDIT_PLAN_TOOL_SCHEMA.input_schema as {
    required: readonly string[];
    properties: Record<string, unknown>;
  };
  expect(schema.properties.revertIntent).toBeDefined();
  expect(schema.properties.revertVersion).toBeDefined();
  expect([...schema.required]).toContain("revertIntent");
  expect([...schema.required]).toContain("revertVersion");
});
```

Note: the pre-existing test `meets the structured-outputs grammar constraints` (which asserts `required` equals `Object.keys(properties)` and no `minimum/maximum/minLength/maxLength`) will now also cover the new fields automatically — do not weaken it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/edit-plan.test.ts -t "revertIntent and revertVersion"`
Expected: FAIL — `schema.properties.revertIntent` is undefined.

- [ ] **Step 3: Add the two fields to the interface + schema**

In `apps/web/lib/jab/edit-plan.ts`, extend the `EditPlan` interface (after `tokenDelta`, line 26):

```typescript
  /** Structured brand-token change for scope="tokens"; null otherwise. */
  tokenDelta: TokenDelta | null;
  /**
   * Version-control intent, INDEPENDENT of scope. Non-null means the user asked
   * to revert/undo — the request is routed to the revert actions, NOT a forward
   * edit. "undo_last" = undo the most recent edit; "to_version" = revert to
   * revertVersion. null for every forward edit / clarification.
   */
  revertIntent: "undo_last" | "to_version" | null;
  /** The 1-based edit ordinal for revertIntent="to_version"; null otherwise. */
  revertVersion: number | null;
```

Add both to `EDIT_PLAN_TOOL_SCHEMA.input_schema.properties` (after `tokenDelta`, before the closing `}` at line 84), using anyOf-null unions:

```typescript
      revertIntent: {
        anyOf: [{ type: "string", enum: ["undo_last", "to_version"] }, { type: "null" }],
        description:
          "Set ONLY when the user asks to revert/undo (e.g. 'undo that', 'go back', 'revert to version 10'). 'undo_last' undoes the most recent edit; 'to_version' reverts to the edit number in revertVersion. null for every forward edit and clarification. When set, leave scope='component', target='', regenerationPrompt='' — they are ignored.",
      },
      revertVersion: {
        anyOf: [{ type: "number" }, { type: "null" }],
        description:
          "For revertIntent='to_version': the version/edit number the user named (e.g. 10). null otherwise.",
      },
```

Add both to the `required` array (after `"tokenDelta"`, line 93):

```typescript
    required: [
      "needsClarification",
      "scope",
      "target",
      "action",
      "regenerationPrompt",
      "clarifyingQuestion",
      "tokenDelta",
      "revertIntent",
      "revertVersion",
    ],
```

- [ ] **Step 4: Run schema test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/edit-plan.test.ts`
Expected: All PASS (new test + the grammar-constraints test still green).

- [ ] **Step 5: Write the failing parser test**

Add to `apps/web/lib/ai/edit-planner.test.ts` (find the `parsePlannerToolUse` describe block; if none, add one):

```typescript
describe("parsePlannerToolUse — revert fields", () => {
  it("coerces revertIntent and revertVersion", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "", action: "Undo the last change",
      regenerationPrompt: "", clarifyingQuestion: null, tokenDelta: null,
      revertIntent: "to_version", revertVersion: 10,
    });
    expect(plan.revertIntent).toBe("to_version");
    expect(plan.revertVersion).toBe(10);
  });

  it("defaults missing/invalid revert fields to null", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "x", action: "y",
      regenerationPrompt: "z", clarifyingQuestion: null, tokenDelta: null,
    });
    expect(plan.revertIntent).toBeNull();
    expect(plan.revertVersion).toBeNull();
  });

  it("rejects a bogus revertIntent value", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "x", action: "y",
      regenerationPrompt: "z", clarifyingQuestion: null, tokenDelta: null,
      revertIntent: "delete_everything", revertVersion: "not a number",
    });
    expect(plan.revertIntent).toBeNull();
    expect(plan.revertVersion).toBeNull();
  });
});
```

Ensure `parsePlannerToolUse` is imported in the test file (check the existing imports from `./edit-planner`).

- [ ] **Step 6: Run parser test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "revert fields"`
Expected: FAIL — `plan.revertIntent` is undefined (the parser doesn't return it yet).

- [ ] **Step 7: Extend `parsePlannerToolUse`**

In `apps/web/lib/ai/edit-planner.ts`, add a coercion helper above `parsePlannerToolUse` and return the two fields (append to the returned object at line 82-86):

```typescript
function isRevertIntent(v: unknown): v is "undo_last" | "to_version" {
  return v === "undo_last" || v === "to_version";
}
```

In the returned object, after the `tokenDelta` field:

```typescript
    tokenDelta:
      input.tokenDelta && typeof input.tokenDelta === "object" && !Array.isArray(input.tokenDelta)
        ? (input.tokenDelta as TokenDelta)
        : null,
    revertIntent: isRevertIntent(input.revertIntent) ? input.revertIntent : null,
    revertVersion:
      typeof input.revertVersion === "number" && Number.isFinite(input.revertVersion)
        ? input.revertVersion
        : null,
```

- [ ] **Step 8: Run parser test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "revert fields"`
Expected: PASS.

- [ ] **Step 9: Typecheck (the new required EditPlan fields will surface every EditPlan literal that needs updating)**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -30`
Expected: errors pointing at EditPlan object literals in tests/fixtures missing `revertIntent`/`revertVersion`. Fix EACH by adding `revertIntent: null, revertVersion: null` to the literal (they are forward-edit/clarify fixtures). Common sites: `edit-plan.test.ts`'s `actionable()` helper and its `tokens`-scope literals, `chat-turn-outcome.test.ts` fixtures, `edit-planner.test.ts` fixtures. Re-run until clean. Do NOT make the fields optional to dodge this — they are required by design so no construction site silently omits intent.

- [ ] **Step 10: Commit**

```bash
cd apps/web
git add lib/jab/edit-plan.ts lib/jab/edit-plan.test.ts lib/ai/edit-planner.ts lib/ai/edit-planner.test.ts
# plus any fixture files touched in Step 9
git add -A
git commit -m "feat(chat): add revertIntent/revertVersion to the edit plan schema"
```

---

### Task 2: Teach the planner prompt about revert/undo

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`buildSystemPrompt` :89-139)
- Test: `apps/web/lib/ai/edit-planner.test.ts` (the prompt-text assertions, via `buildSystemPromptForTest`)

**Interfaces:**
- Consumes: `SiteMap` (unchanged).
- Produces: the planner system prompt now instructs the model to set `revertIntent` for revert/undo requests. No signature change.

- [ ] **Step 1: Write the failing prompt test**

Add to `apps/web/lib/ai/edit-planner.test.ts` (uses the existing `buildSystemPromptForTest` export):

```typescript
it("instructs the planner to use revertIntent for undo/revert requests", () => {
  const siteMap = {
    blockTypes: [], pageSlugs: [], shell: { header: true, footer: false },
    tokens: { colors: [], fonts: [], sizes: [] },
  } as unknown as import("@/lib/jab/site-map").SiteMap;
  const prompt = buildSystemPromptForTest(siteMap);
  expect(prompt.toLowerCase()).toContain("revert");
  expect(prompt).toContain("revertIntent");
  expect(prompt).toContain("undo_last");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "revertIntent for undo"`
Expected: FAIL — the prompt has no revert text.

- [ ] **Step 3: Add a revert section to the system prompt**

In `apps/web/lib/ai/edit-planner.ts` `buildSystemPrompt`, add a section before the final `Rules:` block (the string returned around line 122-138). Insert after the `${tokensSection}` interpolation and before "Rules:":

```typescript
  const revertSection = `

## Undo / revert (NOT a forward edit)
If the user asks to UNDO or REVERT — e.g. "undo that", "undo the last change",
"go back", "that last change was wrong", "revert to version 10", "restore the
previous version" — this is NOT a component/shell/token edit. Set:
- revertIntent="undo_last" for "undo"/"go back"/"undo the last change" (no number).
- revertIntent="to_version" and revertVersion=N when the user names a specific
  version/step number (e.g. "revert to version 10" → revertVersion=10).
Leave scope="component", target="", regenerationPrompt="", needsClarification=false
in that case — they are ignored for a revert. If the user's revert target is
genuinely ambiguous (e.g. "go back a bit" with many edits), set
needsClarification=true and ask which change to undo instead of guessing.`;
```

Then include `${revertSection}` in the returned template string, immediately before the `\n\nRules:` text.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/ai/edit-planner.ts lib/ai/edit-planner.test.ts
git commit -m "feat(chat): teach the planner to route undo/revert requests via revertIntent"
```

---

### Task 3: Add the `revert` outcome to `decideChatTurnOutcome`

**Files:**
- Modify: `apps/web/lib/jab/chat-turn-outcome.ts` (whole file — `ChatTurnOutcome` type :10-12, `decideChatTurnOutcome` :23-42)
- Test: `apps/web/lib/jab/chat-turn-outcome.test.ts`

**Interfaces:**
- Consumes: `EditPlan.revertIntent`/`revertVersion` (Task 1).
- Produces: `ChatTurnOutcome` gains `{ kind: "revert"; intent: "undo_last" | "to_version"; version: number | null; plan: EditPlan }`. `decideChatTurnOutcome` returns it when `plan.revertIntent` is non-null (checked BEFORE the forward-edit validation, but AFTER `needsClarification`).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/chat-turn-outcome.test.ts`:

```typescript
it("returns a revert outcome when revertIntent is set", () => {
  const plan = actionable({ revertIntent: "undo_last", revertVersion: null });
  const out = decideChatTurnOutcome(plan, siteMap);
  expect(out.kind).toBe("revert");
  if (out.kind === "revert") {
    expect(out.intent).toBe("undo_last");
    expect(out.version).toBeNull();
  }
});

it("carries the version for a to_version revert", () => {
  const plan = actionable({ revertIntent: "to_version", revertVersion: 10 });
  const out = decideChatTurnOutcome(plan, siteMap);
  expect(out.kind).toBe("revert");
  if (out.kind === "revert") expect(out.version).toBe(10);
});

it("still clarifies first when needsClarification is set, even with a revertIntent", () => {
  const plan = actionable({ needsClarification: true, revertIntent: "undo_last", clarifyingQuestion: "Which change?" });
  const out = decideChatTurnOutcome(plan, siteMap);
  expect(out.kind).toBe("clarify");
});
```

(Use whatever `actionable(...)` / `siteMap` helper the file already defines; ensure the helper defaults `revertIntent: null, revertVersion: null` after Task 1's typecheck fixups.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/chat-turn-outcome.test.ts -t "revert"`
Expected: FAIL — `out.kind` is `"edit"` (or a type error that `"revert"` isn't a valid kind).

- [ ] **Step 3: Extend the outcome type + function**

In `apps/web/lib/jab/chat-turn-outcome.ts`, extend the union (lines 10-12):

```typescript
export type ChatTurnOutcome =
  | { kind: "clarify"; message: string; plan: EditPlan }
  | { kind: "edit"; assistantText: string; plan: EditPlan }
  | { kind: "revert"; intent: "undo_last" | "to_version"; version: number | null; plan: EditPlan };
```

In `decideChatTurnOutcome`, add the revert branch AFTER the `needsClarification` check and BEFORE `validateEditPlan` (so a revert never runs forward-edit validation):

```typescript
export function decideChatTurnOutcome(plan: EditPlan, siteMap: SiteMap): ChatTurnOutcome {
  if (plan.needsClarification) {
    return {
      kind: "clarify",
      plan,
      message:
        plan.clarifyingQuestion?.trim() ||
        `Could you tell me which part to change? I can edit: ${candidateList(siteMap)}.`,
    };
  }

  // Revert intent is not a forward edit — route it before any block/token
  // validation (those checks are irrelevant to a version rollback).
  if (plan.revertIntent) {
    return { kind: "revert", intent: plan.revertIntent, version: plan.revertVersion, plan };
  }

  const valid = validateEditPlan(plan, siteMap);
  // ... unchanged from here
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/chat-turn-outcome.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/jab/chat-turn-outcome.ts lib/jab/chat-turn-outcome.test.ts
git commit -m "feat(chat): add a revert outcome to decideChatTurnOutcome"
```

---

### Task 4: Resolve "version N" to an edit id (pure helper)

**Files:**
- Create: `apps/web/lib/jab/resolve-revert-target.ts`
- Test: `apps/web/lib/jab/resolve-revert-target.test.ts`

**Interfaces:**
- Produces: `resolveRevertTarget(completedEdits: RevertEditRow[], version: number): { ok: true; editId: string } | { ok: false; reason: "out_of_range" }` where `RevertEditRow = { id: string; createdAt: string }`. `completedEdits` is the list of completed, non-undone edits for the draft, ascending by `createdAt`. `version` is 1-based; version N maps to `completedEdits[N-1]`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/resolve-revert-target.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveRevertTarget, type RevertEditRow } from "./resolve-revert-target";

const edits: RevertEditRow[] = [
  { id: "e1", createdAt: "2026-07-09T00:00:01Z" },
  { id: "e2", createdAt: "2026-07-09T00:00:02Z" },
  { id: "e3", createdAt: "2026-07-09T00:00:03Z" },
];

describe("resolveRevertTarget", () => {
  it("maps 1-based version N to the Nth edit ascending", () => {
    expect(resolveRevertTarget(edits, 2)).toEqual({ ok: true, editId: "e2" });
  });
  it("maps version 1 to the first edit", () => {
    expect(resolveRevertTarget(edits, 1)).toEqual({ ok: true, editId: "e1" });
  });
  it("returns out_of_range for N greater than the edit count", () => {
    expect(resolveRevertTarget(edits, 9)).toEqual({ ok: false, reason: "out_of_range" });
  });
  it("returns out_of_range for N < 1", () => {
    expect(resolveRevertTarget(edits, 0)).toEqual({ ok: false, reason: "out_of_range" });
  });
  it("returns out_of_range for an empty edit list", () => {
    expect(resolveRevertTarget([], 1)).toEqual({ ok: false, reason: "out_of_range" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/resolve-revert-target.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/lib/jab/resolve-revert-target.ts`:

```typescript
/**
 * resolve-revert-target — pure mapping from a user-named "version N" to a
 * workspace_edits id. v1 semantics: version N (1-based) = the Nth completed,
 * non-undone edit in chronological (ascending) order. Out of range → typed
 * failure the caller surfaces as a clarifying chat reply, never a guess.
 */
export interface RevertEditRow {
  id: string;
  createdAt: string;
}

export type ResolveRevertTargetResult =
  | { ok: true; editId: string }
  | { ok: false; reason: "out_of_range" };

export function resolveRevertTarget(
  completedEditsAscending: RevertEditRow[],
  version: number,
): ResolveRevertTargetResult {
  if (!Number.isInteger(version) || version < 1 || version > completedEditsAscending.length) {
    return { ok: false, reason: "out_of_range" };
  }
  return { ok: true, editId: completedEditsAscending[version - 1].id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/resolve-revert-target.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/jab/resolve-revert-target.ts lib/jab/resolve-revert-target.test.ts
git commit -m "feat(chat): resolve-revert-target — map version N to the Nth completed edit"
```

---

### Task 5: Route the revert outcome to the existing revert actions in `sendChatMessageAction`

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts` (the outcome branch, currently `sendChatMessageAction` around lines 244-296 — the `outcome.kind === "clarify"` and edit branches)
- Test: `apps/web/lib/actions/workspace-chat.test.ts`

**Interfaces:**
- Consumes: `decideChatTurnOutcome` (Task 3), `undoLastEditAction`/`revertToVersionAction` (existing, `lib/actions/draft-actions.ts`), `resolveRevertTarget` (Task 4).
- Produces: when `outcome.kind === "revert"`, `sendChatMessageAction` calls the revert action, writes a plain assistant reply, and returns — never dispatching a `workspace_edits` edit.

- [ ] **Step 1: Read the current outcome-branch structure**

Read `apps/web/lib/actions/workspace-chat.ts` lines 243-296 to see exactly how `outcome.kind === "clarify"` returns via `writeAssistant` and how the edit branch calls `requestWorkspaceEditAction`. Your revert branch mirrors the clarify branch's `writeAssistant` pattern (a plain assistant row) — it does NOT touch `insertAssistant` + `requestWorkspaceEditAction`.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/lib/actions/workspace-chat.test.ts`. Mock `decideChatTurnOutcome` (already mocked in this file — see the `vi.mock("@/lib/jab/chat-turn-outcome", ...)` at the top) to return a revert outcome, and mock the revert actions. Assert `undoLastEditAction` is called and NO forward edit is dispatched:

```typescript
describe("sendChatMessageAction — revert routing", () => {
  it("routes an undo_last outcome to undoLastEditAction and does not dispatch a forward edit", async () => {
    // Arrange: membership OK, budget OK, a ready build exists, planner returns
    // a plan, and decideChatTurnOutcome returns a revert outcome.
    // (Follow the file's existing arrange pattern for a successful turn — the
    // mocks for createClient/createAdminClient/planEdit are already set up in
    // sibling tests; reuse them.)
    mockDecideChatTurnOutcome.mockReturnValue({ kind: "revert", intent: "undo_last", version: null, plan: {} });
    mockUndoLastEditAction.mockResolvedValue({ ok: true, newVersion: 3 });

    const res = await sendChatMessageAction({ projectId: "proj1", content: "undo that" });

    expect(mockUndoLastEditAction).toHaveBeenCalledWith("proj1");
    expect(mockRequestWorkspaceEditAction).not.toHaveBeenCalled();
    expect(res.assistant.role).toBe("assistant");
    expect(res.assistant.editId).toBeNull();
  });
});
```

You must add the mock wiring at the top of the file: extend the existing `vi.mock("@/lib/jab/chat-turn-outcome", ...)` to expose `mockDecideChatTurnOutcome`, add a `vi.mock("@/lib/actions/draft-actions", () => ({ undoLastEditAction: mockUndoLastEditAction, revertToVersionAction: mockRevertToVersionAction }))`, and hoist those mock fns in the `vi.hoisted(...)` block (mirror how `mockAssertEditBudget` etc. are hoisted). Read the file's top matter first and match its exact hoisting convention.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts -t "revert routing"`
Expected: FAIL — no revert branch exists, so the outcome falls through (likely a type error on the unhandled `"revert"` kind, or the forward-edit branch runs).

- [ ] **Step 4: Add the revert branch**

In `apps/web/lib/actions/workspace-chat.ts`, add imports at the top:

```typescript
import { undoLastEditAction, revertToVersionAction } from "@/lib/actions/draft-actions";
import { resolveRevertTarget } from "@/lib/jab/resolve-revert-target";
```

Add the revert branch immediately after the `outcome.kind === "clarify"` block (before the edit branch). It calls the right action, maps typed failures to friendly text, and writes a plain assistant reply:

```typescript
  if (outcome.kind === "revert") {
    let replyText: string;
    if (outcome.intent === "undo_last") {
      const r = await undoLastEditAction(args.projectId);
      replyText = r.ok
        ? "Done — I undid the last change. The preview is updating."
        : r.error === "nothing_to_undo"
          ? "There's nothing to undo yet."
          : r.error === "no_draft"
            ? "There's no live draft to undo. Make an edit first."
            : r.error === "draft_locked"
              ? "This draft is publishing right now — cancel the publish first, then I can undo."
              : "I couldn't undo that. Please try again.";
    } else {
      // to_version — resolve the named version to a concrete edit id.
      const { data: editRows } = await admin
        .from("workspace_edits")
        .select("id, created_at")
        .eq("project_id", args.projectId)
        .eq("status", "completed")
        .is("undone_at", null)
        .order("created_at", { ascending: true });
      const ascending = ((editRows ?? []) as Array<{ id: string; created_at: string }>).map((r) => ({
        id: r.id,
        createdAt: r.created_at,
      }));
      const resolved =
        outcome.version === null
          ? ({ ok: false, reason: "out_of_range" } as const)
          : resolveRevertTarget(ascending, outcome.version);
      if (!resolved.ok) {
        replyText = `I couldn't find that version. There ${ascending.length === 1 ? "is 1 edit" : `are ${ascending.length} edits`} to revert to — tell me which one, or say "undo" to undo the last change.`;
      } else {
        const r = await revertToVersionAction(args.projectId, resolved.editId);
        replyText = r.ok
          ? "Done — I reverted to that version. The preview is updating."
          : r.error === "no_draft"
            ? "There's no live draft to revert. Make an edit first."
            : r.error === "draft_locked"
              ? "This draft is publishing right now — cancel the publish first, then I can revert."
              : r.error === "edit_not_found"
                ? "I couldn't find that edit to revert to."
                : "I couldn't revert that. Please try again.";
      }
    }
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: replyText,
      needsClarification: false,
      conversationId,
    });
  }
```

Note: `admin`, `tenantId`, `userId`, `conversationId` are all already in scope at this point in `sendChatMessageAction` (they're established before the outcome branch — verify against the file). `writeAssistant` already `revalidatePath`s the workspace, so the history panel refreshes.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts`
Expected: All PASS.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors (the `"revert"` outcome kind is now handled, so the exhaustiveness is satisfied).

- [ ] **Step 7: Commit**

```bash
cd apps/web
git add lib/actions/workspace-chat.ts lib/actions/workspace-chat.test.ts
git commit -m "feat(chat): route revert/undo chat intent to the existing revert actions"
```

---

### Task 6: Full-suite verification

- [ ] **Step 1: Full suite**

Run: `cd apps/web && npx vitest run`
Expected: all pass.

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Sanity — confirm revert never dispatches a forward edit**

Run: `cd apps/web && grep -n "requestWorkspaceEditAction" lib/actions/workspace-chat.ts`
Expected: `requestWorkspaceEditAction` is called ONLY inside the `outcome.kind === "edit"` branch — never reachable from the revert branch.
