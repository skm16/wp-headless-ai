# Guided Sequential Multi-Block Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single cross-cutting chat request ("restyle all the View-all links") be handled as a planner-proposed, user-confirmed set of blocks edited one-per-turn with auto-advance and a visible remaining list — reusing the existing single-target draft-edit path with no DB migration and no worker change.

**Architecture:** A new OPTIONAL `EditPlan.batch` field (`{ remaining: string[]; guidance: string } | null`) makes the "set still to edit" machine-readable. The planner prompt gains a "Multi-block changes" section: propose the set as a clarify, then emit a normal single-target edit for the first remaining block each turn while echoing what's left. Queue state lives entirely in conversation history (the planner re-derives it every turn). `chat-turn-outcome` carries `batch` through unchanged outcome kinds. `workspace-chat` surfaces `batchRemaining` on `ChatMessageView`. `ChatPanel` renders quick-reply chips on a batch clarify and an "N of M" hint on apply turns, degrading to plain text when `batch` is absent.

**Tech Stack:** TypeScript, Next.js 15 App Router (server actions + "use client" panel), Vitest, Anthropic strict tool-use schema.

## Global Constraints

- No DB migration. No change to `workspace_edits`, the `draft-edit` worker, `EDIT_REQUESTED_EVENT`, or the concurrency guard. Queue state is conversation history only.
- `batch=null` MUST be byte-identical to today for every ordinary single edit, clarification, revert, and token change.
- Strict tool-use grammar rules (from `EDIT_PLAN_TOOL_SCHEMA`): every property listed in `required`, `additionalProperties: false`, nullable expressed via `anyOf: [<type>, { type: "null" }]`, no numeric/length bounds.
- The planner must NEVER invent a block name; batch members come only from the real unit list.
- User-facing free-text (`action`, `clarifyingQuestion`) is already scrubbed for leaked tool markup at the parse boundary (`stripLeakedToolMarkup`) — batch prose rides that path; do not add a second scrubber.
- Run tests from `apps/web`: `cd apps/web && npx vitest run <path>`. Full suite: `npx vitest run`. Typecheck: `npx tsc --noEmit` (expect exit 0).
- The current full suite is **1648 tests green** on master before this plan.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/lib/jab/edit-plan.ts` | Add `batch` to the `EditPlan` interface + `EDIT_PLAN_TOOL_SCHEMA` (anyOf-null, in `required`). Pure. |
| `apps/web/lib/ai/edit-planner.ts` | `parsePlannerToolUse` coerces `batch`; `buildSystemPrompt` gains the "## Multi-block changes" section. Pure. |
| `apps/web/lib/jab/chat-turn-outcome.ts` | Carry `plan.batch` through the `clarify` + `edit` outcomes. Pure. |
| `apps/web/lib/actions/workspace-chat.ts` | Fetch `plan` in `loadConversation`; derive `batchRemaining` onto `ChatMessageView`; set it on the edit-branch return. Server. |
| `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx` | Batch chips on a clarify bubble + "N of M" hint; degrades to text. Client. |
| `apps/web/lib/jab/batch-edit.ts` (new) | Pure helpers: `coerceBatchState`, `batchRemainingFrom`, `batchProgressLabel`. Keeps batch logic out of the big files + independently testable. |

---

## Task 1: Pure batch helpers + type

**Files:**
- Create: `apps/web/lib/jab/batch-edit.ts`
- Test: `apps/web/lib/jab/batch-edit.test.ts`

**Interfaces:**
- Produces:
  - `interface BatchEditState { remaining: string[]; guidance: string }`
  - `coerceBatchState(input: unknown): BatchEditState | null` — defensive coercion from raw tool JSON.
  - `batchRemainingFrom(planRecord: unknown): string[]` — pull `batch.remaining` out of a persisted plan JSON blob, `[]` when absent/malformed.
  - `batchProgressLabel(remainingCount: number): string | null` — e.g. `"2 sections left in this change"`; null when 0.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/batch-edit.test.ts
import { describe, it, expect } from "vitest";
import { coerceBatchState, batchRemainingFrom, batchProgressLabel } from "./batch-edit";

describe("coerceBatchState", () => {
  it("accepts a well-formed batch", () => {
    expect(coerceBatchState({ remaining: ["acf/a", "acf/b"], guidance: "make links uniform" }))
      .toEqual({ remaining: ["acf/a", "acf/b"], guidance: "make links uniform" });
  });
  it("accepts an empty remaining array (batch finished)", () => {
    expect(coerceBatchState({ remaining: [], guidance: "x" })).toEqual({ remaining: [], guidance: "x" });
  });
  it("returns null for null / non-object", () => {
    expect(coerceBatchState(null)).toBeNull();
    expect(coerceBatchState("nope")).toBeNull();
    expect(coerceBatchState(42)).toBeNull();
  });
  it("returns null when remaining is not a string[]", () => {
    expect(coerceBatchState({ remaining: "acf/a", guidance: "x" })).toBeNull();
    expect(coerceBatchState({ remaining: [1, 2], guidance: "x" })).toBeNull();
    expect(coerceBatchState({ remaining: ["ok", null], guidance: "x" })).toBeNull();
  });
  it("returns null when guidance is missing or not a string", () => {
    expect(coerceBatchState({ remaining: ["acf/a"] })).toBeNull();
    expect(coerceBatchState({ remaining: ["acf/a"], guidance: 5 })).toBeNull();
  });
  it("drops extra keys, keeping only remaining + guidance", () => {
    expect(coerceBatchState({ remaining: ["acf/a"], guidance: "x", evil: 1 }))
      .toEqual({ remaining: ["acf/a"], guidance: "x" });
  });
});

describe("batchRemainingFrom", () => {
  it("pulls remaining out of a persisted plan record", () => {
    expect(batchRemainingFrom({ batch: { remaining: ["acf/a", "acf/b"], guidance: "x" } }))
      .toEqual(["acf/a", "acf/b"]);
  });
  it("returns [] when there is no batch", () => {
    expect(batchRemainingFrom({ action: "just an edit" })).toEqual([]);
    expect(batchRemainingFrom(null)).toEqual([]);
    expect(batchRemainingFrom({ batch: null })).toEqual([]);
  });
  it("returns [] when batch.remaining is malformed", () => {
    expect(batchRemainingFrom({ batch: { remaining: "x", guidance: "y" } })).toEqual([]);
  });
});

describe("batchProgressLabel", () => {
  it("labels a positive remaining count", () => {
    expect(batchProgressLabel(2)).toBe("2 sections left in this change");
    expect(batchProgressLabel(1)).toBe("1 section left in this change");
  });
  it("returns null for zero", () => {
    expect(batchProgressLabel(0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/batch-edit.test.ts`
Expected: FAIL — `Cannot find module './batch-edit'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/jab/batch-edit.ts
/**
 * batch-edit — pure helpers for guided sequential multi-block edits
 * (spec 2026-07-10). A "batch" is a cross-cutting style change the planner
 * proposes over several block components and then applies one-per-turn. The
 * queue lives in conversation history; these helpers only coerce/read the
 * structured `batch` field the planner emits so the UI + echo are reliable.
 */

export interface BatchEditState {
  /** Block names still to edit in this change, in order. May be empty (done). */
  remaining: string[];
  /** Shared style guidance applied to every block in the set. */
  guidance: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Defensive coercion from raw tool JSON. Anything malformed → null. */
export function coerceBatchState(input: unknown): BatchEditState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (!isStringArray(o.remaining)) return null;
  if (typeof o.guidance !== "string") return null;
  return { remaining: o.remaining, guidance: o.guidance };
}

/** Pull batch.remaining out of a persisted plan JSON blob; [] when absent/malformed. */
export function batchRemainingFrom(planRecord: unknown): string[] {
  if (!planRecord || typeof planRecord !== "object") return [];
  const batch = coerceBatchState((planRecord as Record<string, unknown>).batch);
  return batch ? batch.remaining : [];
}

/** Human hint for an in-progress batch; null when nothing remains. */
export function batchProgressLabel(remainingCount: number): string | null {
  if (remainingCount <= 0) return null;
  return `${remainingCount} section${remainingCount === 1 ? "" : "s"} left in this change`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/batch-edit.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/batch-edit.ts apps/web/lib/jab/batch-edit.test.ts
git commit -m "feat(chat): pure batch-edit helpers (coerce/read batch state)"
```

---

## Task 2: `EditPlan.batch` field + tool schema

**Files:**
- Modify: `apps/web/lib/jab/edit-plan.ts` (the `EditPlan` interface ~13-36; the `EDIT_PLAN_TOOL_SCHEMA` properties ~54-103; the `required` array ~105-115)
- Test: `apps/web/lib/jab/edit-plan.test.ts` (add a describe block; file already exists)

**Interfaces:**
- Consumes: `BatchEditState` from `./batch-edit` (Task 1).
- Produces: `EditPlan.batch: BatchEditState | null`; `EDIT_PLAN_TOOL_SCHEMA` with a `batch` property in `properties` AND in `required`.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/web/lib/jab/edit-plan.test.ts
import { EDIT_PLAN_TOOL_SCHEMA } from "./edit-plan";

describe("EDIT_PLAN_TOOL_SCHEMA — batch field", () => {
  const props = EDIT_PLAN_TOOL_SCHEMA.input_schema.properties as Record<string, any>;

  it("declares a nullable batch property (anyOf object|null)", () => {
    expect(props.batch).toBeDefined();
    expect(Array.isArray(props.batch.anyOf)).toBe(true);
    const kinds = props.batch.anyOf.map((s: any) => s.type);
    expect(kinds).toContain("object");
    expect(kinds).toContain("null");
  });

  it("the batch object requires remaining + guidance and forbids extra keys", () => {
    const obj = props.batch.anyOf.find((s: any) => s.type === "object");
    expect(obj.additionalProperties).toBe(false);
    expect(obj.required).toEqual(expect.arrayContaining(["remaining", "guidance"]));
    expect(obj.properties.remaining.type).toBe("array");
    expect(obj.properties.remaining.items.type).toBe("string");
    expect(obj.properties.guidance.type).toBe("string");
  });

  it("lists batch in the top-level required array (strict grammar)", () => {
    expect(EDIT_PLAN_TOOL_SCHEMA.input_schema.required).toContain("batch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/edit-plan.test.ts -t "batch field"`
Expected: FAIL — `props.batch` is undefined.

- [ ] **Step 3: Add the field to the interface**

In `apps/web/lib/jab/edit-plan.ts`, add the import at the top (near the other imports):

```ts
import type { BatchEditState } from "./batch-edit";
```

Add to the `EditPlan` interface, after `revertVersion`:

```ts
  /**
   * Cross-cutting multi-block change state (spec 2026-07-10). Non-null when the
   * planner is proposing or applying a set of blocks that share one style
   * change: `remaining` is the ordered block_names still to edit, `guidance` is
   * the shared instruction. null for every ordinary single edit / clarify /
   * revert / token change — the queue lives in conversation history, this field
   * only makes it machine-readable for the UI + echo.
   */
  batch: BatchEditState | null;
```

- [ ] **Step 4: Add the schema property + required entry**

In `EDIT_PLAN_TOOL_SCHEMA.input_schema.properties`, after `revertVersion`:

```ts
      batch: {
        anyOf: [
          {
            type: "object",
            properties: {
              remaining: { type: "array", items: { type: "string" } },
              guidance: { type: "string" },
            },
            required: ["remaining", "guidance"],
            additionalProperties: false,
          },
          { type: "null" },
        ],
        description:
          "Multi-block change tracking. Set ONLY for a cross-cutting change spanning several blocks. On the PROPOSE turn (needsClarification=true): remaining = ALL the block_names (exact, from the unit list) you infer share the change, guidance = the shared instruction. On each APPLY turn: emit a normal single-target edit for the FIRST remaining block AND set remaining to the blocks AFTER it. Empty remaining = batch finished. null for any single edit, clarification, revert, or token change.",
      },
```

Add `"batch"` to the top-level `required` array (after `"revertVersion"`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/edit-plan.test.ts -t "batch field"`
Expected: PASS.

- [ ] **Step 6: Typecheck (interface consumers)**

Run: `cd apps/web && npx tsc --noEmit`
Expected: FAIL — `parsePlannerToolUse` and any `EditPlan` literal now miss `batch`. That is expected and fixed in Task 3. If OTHER unrelated errors appear, stop and report. (Note: test-only `EditPlan` literals in existing tests may also error; they are fixed in Task 3's step where `parsePlannerToolUse` gains the field, because most construct plans via `parsePlannerToolUse`. Any hand-built `EditPlan` literal in a test must get `batch: null` — grep `as EditPlan` / `: EditPlan` and add it.)

- [ ] **Step 7: Commit** (defer until Task 3 makes tsc green — this task's test passes but the tree doesn't typecheck yet, so commit together with Task 3, OR add `batch: null` to any literal now to keep tsc green and commit standalone. Prefer: add `batch: null` to literals now.)

Grep for hand-built literals and null them:

Run: `cd apps/web && grep -rn "batch" lib/**/*.ts | grep -i "editplan" || true`

Then:

```bash
git add apps/web/lib/jab/edit-plan.ts apps/web/lib/jab/edit-plan.test.ts
git commit -m "feat(chat): add nullable EditPlan.batch to the plan schema"
```

---

## Task 3: `parsePlannerToolUse` coerces `batch`

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`parsePlannerToolUse` ~74-96)
- Test: `apps/web/lib/ai/edit-planner.test.ts` (add to the existing `parsePlannerToolUse` describe area)

**Interfaces:**
- Consumes: `coerceBatchState` from `@/lib/jab/batch-edit`.
- Produces: every `EditPlan` returned by `parsePlannerToolUse` now carries `batch`.

- [ ] **Step 1: Write the failing test**

```ts
// append near the other parsePlannerToolUse describes in edit-planner.test.ts
describe("parsePlannerToolUse — batch", () => {
  it("coerces a well-formed batch", () => {
    const plan = parsePlannerToolUse({
      needsClarification: true, clarifyingQuestion: "These 3 share it — apply to all?",
      batch: { remaining: ["acf/featured-beer", "acf/featured-news"], guidance: "uniform View More" },
    });
    expect(plan.batch).toEqual({
      remaining: ["acf/featured-beer", "acf/featured-news"],
      guidance: "uniform View More",
    });
  });
  it("defaults batch to null when absent", () => {
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "?" });
    expect(plan.batch).toBeNull();
  });
  it("nulls a malformed batch", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/x", action: "y",
      regenerationPrompt: "z", batch: { remaining: "not-an-array", guidance: "g" },
    });
    expect(plan.batch).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "parsePlannerToolUse — batch"`
Expected: FAIL — `plan.batch` is undefined.

- [ ] **Step 3: Implement**

Add the import at the top of `edit-planner.ts` (near the `TokenDelta` import):

```ts
import { coerceBatchState } from "@/lib/jab/batch-edit";
```

In `parsePlannerToolUse`, add to the returned object (after `revertVersion`):

```ts
    batch: coerceBatchState(input.batch),
```

- [ ] **Step 4: Run to verify it passes + fix remaining literals**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "parsePlannerToolUse — batch"`
Expected: PASS.

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0. If any hand-built `EditPlan` literal still errors ("property 'batch' is missing"), add `batch: null` to it. Grep: `grep -rn ": EditPlan\|as EditPlan\|EditPlan =" apps/web/lib apps/web/app`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(chat): parsePlannerToolUse coerces the batch field"
```

---

## Task 4: Planner prompt — "## Multi-block changes" section

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`buildSystemPrompt` ~120-184 — add a section string like the existing `tokensSection`/`revertSection`, and interpolate it into the returned template before `Rules:`)
- Test: `apps/web/lib/ai/edit-planner.test.ts` (add prompt-content assertions via `buildSystemPromptForTest`)

**Interfaces:**
- Consumes: `buildSystemPromptForTest(siteMap)` (already exported).
- Produces: the system prompt teaches propose→confirm→sequence→echo and never-invent-a-name.

- [ ] **Step 1: Write the failing test**

```ts
// in edit-planner.test.ts, near the other buildSystemPromptForTest tests
describe("buildSystemPrompt — multi-block section", () => {
  const siteMap = {
    blockTypes: [
      { blockName: "acf/featured-beer", label: "Featured Beer", pageCount: 2, pageCountIsFloor: false },
      { blockName: "acf/featured-news", label: "Featured News", pageCount: 1, pageCountIsFloor: false },
    ],
    pageSlugs: [], shell: { header: true, footer: true },
    tokens: { colors: [], fonts: [], sizes: [] },
  } as unknown as import("@/lib/jab/site-map").SiteMap;

  it("includes a multi-block changes contract", () => {
    const p = buildSystemPromptForTest(siteMap);
    expect(p).toMatch(/multi-block/i);
    expect(p).toMatch(/batch/i);
    // propose-then-sequence: mentions proposing the set as a clarification
    expect(p.toLowerCase()).toContain("propose");
    // echo the remaining list
    expect(p.toLowerCase()).toContain("remaining");
    // never invent a name (reinforced in the batch context)
    expect(p).toMatch(/never invent|only .* block_name|exact block_name/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "multi-block section"`
Expected: FAIL — the prompt has no multi-block text.

- [ ] **Step 3: Implement the section**

In `buildSystemPrompt`, after `revertSection` is built, add:

```ts
  const multiBlockSection = `

## Multi-block changes (a cross-cutting style change across several blocks)
When the user asks for ONE style change that clearly spans MULTIPLE blocks — e.g.
"make all the 'View all X' links a consistent style", "give every section the same
button", "restyle the links in all the cards" — DO NOT dead-end asking them to pick one.
Instead run a guided sequence using the "batch" field:

1. PROPOSE (first turn): set needsClarification=true and batch.remaining = the exact
   block_names from the unit list above that you believe share this element (infer from
   the labels; you cannot see block contents, so it is a best guess the user will
   confirm). Set batch.guidance = the shared instruction. In clarifyingQuestion, LIST the
   blocks by label and ask the user to confirm or trim the set (e.g. "I think these share
   that link: Featured Beer, Featured News, Visit Us — apply the same change to all of
   them?"). Run NO edit this turn.
2. APPLY (each following turn, once the user confirms / says "yes" / "next" / "all"):
   emit a NORMAL single-target component edit for the FIRST block in remaining
   (scope="component", target=that block_name, regenerationPrompt=batch.guidance adapted
   to that block), and set batch.remaining to the blocks AFTER it. In "action", state the
   block you just changed AND echo what is left, e.g. "Restyled the View-all link in
   Featured Beer — remaining: Featured News, Visit Us."
3. FINISH: when you emit the edit for the LAST block, set batch.remaining=[] and say in
   "action" that the whole set is done.

Rules for batches:
- remaining MUST contain only exact block_names from the unit list — NEVER invent a name.
  If the user names a block that isn't in the list, ask a clarifying question instead.
- Re-derive the batch from the conversation so far EACH turn: the confirmed set and which
  blocks you have already edited are visible in the prior messages. If the user trims the
  set, removes a block, or changes the instruction, honor the latest request.
- If the user diverges to an unrelated single edit mid-batch, just handle that edit
  normally (batch=null for it); you can resume the remaining set when they say "continue".
- For an ordinary single-block change, leave batch=null — this whole section does not apply.`;
```

Then interpolate it into the returned template, right after `${revertSection}` and before the `Rules:` line:

```ts
${revertSection}
${multiBlockSection}

Rules:
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts -t "multi-block section"`
Expected: PASS.

- [ ] **Step 5: Guard the cost cap — verify the prompt didn't blow the estimate**

The prompt grew by a fixed ~1.5KB. Confirm no existing planner cost-cap test regressed:

Run: `cd apps/web && npx vitest run lib/ai/edit-planner.test.ts`
Expected: PASS (all). If a `PLANNER_COST_CAP_TOKENS` test now trips, stop and report — the section may need trimming.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(chat): teach the planner guided multi-block batches"
```

---

## Task 5: `chat-turn-outcome` carries `batch`

**Files:**
- Modify: `apps/web/lib/jab/chat-turn-outcome.ts` (the `ChatTurnOutcome` union ~10-13 + `decideChatTurnOutcome` ~24-49)
- Test: `apps/web/lib/jab/chat-turn-outcome.test.ts` (file exists)

**Interfaces:**
- Consumes: `EditPlan.batch` (Task 2).
- Produces: `clarify` and `edit` outcomes carry `batch: BatchEditState | null` (from `plan.batch`).

- [ ] **Step 1: Write the failing test**

```ts
// append to chat-turn-outcome.test.ts (reuse whatever plan/siteMap factory the file already has;
// if it builds plans via parsePlannerToolUse, do the same here)
import { parsePlannerToolUse } from "@/lib/ai/edit-planner";

describe("decideChatTurnOutcome — batch passthrough", () => {
  const siteMap = {
    blockTypes: [{ blockName: "acf/featured-beer", label: "Featured Beer", pageCount: 2, pageCountIsFloor: false }],
    pageSlugs: [], shell: { header: true, footer: true },
    tokens: { colors: [], fonts: [], sizes: [] },
  } as unknown as import("@/lib/jab/site-map").SiteMap;

  it("carries batch through a propose (clarify) outcome", () => {
    const plan = parsePlannerToolUse({
      needsClarification: true, clarifyingQuestion: "Apply to all 2?",
      batch: { remaining: ["acf/featured-beer"], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("clarify");
    expect(out.batch).toEqual({ remaining: ["acf/featured-beer"], guidance: "uniform links" });
  });

  it("carries batch through an apply (edit) outcome", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/featured-beer",
      action: "Restyled the link — remaining: none", regenerationPrompt: "uniform links",
      batch: { remaining: [], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("edit");
    expect(out.batch).toEqual({ remaining: [], guidance: "uniform links" });
  });

  it("batch is null for an ordinary single edit", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/featured-beer",
      action: "Made the beer block bolder", regenerationPrompt: "bolder",
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("edit");
    expect(out.batch).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/jab/chat-turn-outcome.test.ts -t "batch passthrough"`
Expected: FAIL — `out.batch` doesn't exist (tsc + runtime).

- [ ] **Step 3: Implement**

Add the import at the top of `chat-turn-outcome.ts`:

```ts
import type { BatchEditState } from "./batch-edit";
```

Extend the union (add `batch` to `clarify` and `edit`; `revert` does not carry a batch):

```ts
export type ChatTurnOutcome =
  | { kind: "clarify"; message: string; plan: EditPlan; batch: BatchEditState | null }
  | { kind: "edit"; assistantText: string; plan: EditPlan; batch: BatchEditState | null }
  | { kind: "revert"; intent: "undo_last" | "to_version"; version: number | null; plan: EditPlan };
```

In `decideChatTurnOutcome`, set `batch: plan.batch` on the clarify return (the `needsClarification` branch), the validation-failure clarify return, and the final edit return:

```ts
  if (plan.needsClarification) {
    return {
      kind: "clarify",
      plan,
      batch: plan.batch,
      message:
        plan.clarifyingQuestion?.trim() ||
        `Could you tell me which part to change? I can edit: ${candidateList(siteMap)}.`,
    };
  }
```

```ts
  const valid = validateEditPlan(plan, siteMap);
  if (!valid.ok) {
    return {
      kind: "clarify",
      plan,
      batch: plan.batch,
      message: `${valid.reason} I can edit: ${candidateList(siteMap)}. Which did you mean?`,
    };
  }
  return { kind: "edit", plan, batch: plan.batch, assistantText: plan.action };
```

(Leave the `revert` return unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run lib/jab/chat-turn-outcome.test.ts`
Expected: PASS (all). Then `npx tsc --noEmit` → exit 0 (workspace-chat reads `outcome.batch` only in Task 6; the extra field is additive so nothing breaks yet).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/chat-turn-outcome.ts apps/web/lib/jab/chat-turn-outcome.test.ts
git commit -m "feat(chat): carry batch state through chat-turn outcomes"
```

---

## Task 6: Surface `batchRemaining` on `ChatMessageView`

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts` (`ChatMessageView` ~60-70; `loadConversation` select+map ~86-110; the edit-branch return ~350; the other `ChatMessageView` construction sites — there are a few `writeAssistant`/`insertAssistant` returns that build the view)
- Test: `apps/web/lib/actions/workspace-chat.test.ts` if it exists; else a focused pure test on the mapping. Check first: `ls apps/web/lib/actions/workspace-chat.test.ts`.

**Interfaces:**
- Consumes: `batchRemainingFrom` from `@/lib/jab/batch-edit`.
- Produces: `ChatMessageView.batchRemaining: string[]` (`[]` when the message's plan has no batch).

- [ ] **Step 1: Add the field to the type + write the failing test**

If a `workspace-chat.test.ts` exists and exercises `loadConversation` with a mock supabase, add a case there. If not, extract the row→view mapping into a tiny exported pure function and test THAT (preferred — keeps it unit-testable without a DB mock):

Add to `workspace-chat.ts` an exported pure mapper (near `loadConversation`):

```ts
/** Row → view mapping, pure + exported for test. `plan` is the persisted plan JSONB. */
export function chatRowToView(r: {
  id: unknown; role: unknown; content: unknown; needs_clarification: unknown;
  edit_id: unknown; build_id: unknown; created_at: unknown; plan?: unknown;
  editStatus: WorkspaceEditStatus | null; editError: string | null;
}): ChatMessageView {
  return {
    id: String(r.id),
    role: r.role as "user" | "assistant",
    content: String(r.content),
    needsClarification: r.needs_clarification === true,
    editId: (r.edit_id as string | null) ?? null,
    buildId: (r.build_id as string | null) ?? null,
    createdAt: String(r.created_at),
    editStatus: r.editStatus,
    editError: r.editError,
    batchRemaining: batchRemainingFrom(r.plan),
  };
}
```

Test:

```ts
// apps/web/lib/actions/workspace-chat.test.ts (create if missing)
import { describe, it, expect } from "vitest";
import { chatRowToView } from "./workspace-chat";

describe("chatRowToView — batchRemaining", () => {
  const base = {
    id: "m1", role: "assistant", content: "hi", needs_clarification: true,
    edit_id: null, build_id: null, created_at: "2026-07-10T00:00:00Z",
    editStatus: null, editError: null,
  };
  it("derives batchRemaining from the persisted plan", () => {
    const v = chatRowToView({ ...base, plan: { batch: { remaining: ["acf/a", "acf/b"], guidance: "x" } } });
    expect(v.batchRemaining).toEqual(["acf/a", "acf/b"]);
  });
  it("is [] when the plan has no batch", () => {
    expect(chatRowToView({ ...base, plan: { action: "just an edit" } }).batchRemaining).toEqual([]);
    expect(chatRowToView({ ...base }).batchRemaining).toEqual([]);
  });
});
```

Add `batchRemaining: string[];` to the `ChatMessageView` interface.

Add the import: `import { batchRemainingFrom } from "@/lib/jab/batch-edit";`

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts`
Expected: FAIL — `chatRowToView` not exported / `batchRemaining` missing.

- [ ] **Step 3: Wire the mapper into `loadConversation` + fix all construction sites**

- Add `plan` to the select string in `loadConversation`: change
  `"id, role, content, needs_clarification, edit_id, build_id, created_at, edit:edit_id(status, error_text)"`
  to include `plan`:
  `"id, role, content, needs_clarification, edit_id, build_id, created_at, plan, edit:edit_id(status, error_text)"`
- Replace the inline `.map((r) => { ... })` body with a call to `chatRowToView`, passing the derived `editStatus`/`editError` + `plan`:

```ts
  const messages = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const editJoin = r.edit as
      | { status: WorkspaceEditStatus; error_text: string | null }
      | { status: WorkspaceEditStatus; error_text: string | null }[]
      | null;
    const edit = Array.isArray(editJoin) ? (editJoin[0] ?? null) : editJoin;
    return chatRowToView({
      id: r.id, role: r.role, content: r.content, needs_clarification: r.needs_clarification,
      edit_id: r.edit_id, build_id: r.build_id, created_at: r.created_at, plan: r.plan,
      editStatus: edit?.status ?? null, editError: edit?.error_text ?? null,
    });
  });
```

- Every OTHER place that builds a `ChatMessageView` literal must get `batchRemaining`. The edit-branch return (~350) should reflect the just-emitted plan's batch:

```ts
    return { assistant: { ...assistantRow, editId, editStatus: "queued" } };
```

`assistantRow` comes from `insertAssistant`; ensure `insertAssistant` (and `writeAssistant`) return objects that include `batchRemaining`. Find their return shapes and add `batchRemaining` — for `writeAssistant`/`insertAssistant` derive it from the `plan` they persist via `batchRemainingFrom(plan)` (they already receive a `plan` record; when absent pass `[]`).

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd apps/web && npx vitest run lib/actions/workspace-chat.test.ts && npx tsc --noEmit`
Expected: test PASS; tsc exit 0 (every `ChatMessageView` now has `batchRemaining`). If tsc flags a construction site you missed, add `batchRemaining` there (derive from its plan, else `[]`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/actions/workspace-chat.ts apps/web/lib/actions/workspace-chat.test.ts
git commit -m "feat(chat): surface batchRemaining on ChatMessageView"
```

---

## Task 7: ChatPanel — batch chips + progress hint

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx` (the `ChatBubble` component ~150-194; and the optimistic/error `ChatMessageView` literals ~56-93 which now need `batchRemaining: []`)
- Test: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.test.tsx` if RTL is set up; otherwise extract the chip-decision into a pure helper and unit-test that.

**Interfaces:**
- Consumes: `ChatMessageView.batchRemaining` (Task 6); `batchProgressLabel` from `@/lib/jab/batch-edit`.
- Produces: chips render on a batch clarify; a progress hint renders on a batch apply; nothing renders when `batchRemaining` is empty.

**Note on testability:** the repo tests pure logic, not DOM. Extract the decision into a pure helper and test it; keep the JSX thin.

- [ ] **Step 1: Write the failing test (pure helper)**

Create `apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.ts`:

```ts
import { batchProgressLabel } from "@/lib/jab/batch-edit";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

export interface BatchChipModel {
  /** Show the "apply to all" primary chip (a propose turn awaiting confirmation). */
  showApplyAll: boolean;
  /** Count in the set, for the chip label ("Apply to all 3"). */
  count: number;
  /** Progress hint text for an in-progress apply turn, or null. */
  progressLabel: string | null;
  /** The canned message the "apply to all" chip sends. */
  applyAllMessage: string;
}

/**
 * A batch clarify (needsClarification + batchRemaining) → show the confirm chips.
 * A batch edit (edit linked + batchRemaining) → show a progress hint, no chips.
 */
export function batchChipModel(m: ChatMessageView): BatchChipModel | null {
  const count = m.batchRemaining.length;
  if (count === 0) return null;
  if (m.needsClarification) {
    return {
      showApplyAll: true,
      count,
      progressLabel: null,
      applyAllMessage: "Yes, apply the same change to all of them.",
    };
  }
  // apply turn (edit linked): just a progress hint
  return { showApplyAll: false, count, progressLabel: batchProgressLabel(count), applyAllMessage: "" };
}
```

Test `apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { batchChipModel } from "./chat-batch-ui";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

const base: ChatMessageView = {
  id: "m", role: "assistant", content: "", needsClarification: false,
  editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
  batchRemaining: [],
};

describe("batchChipModel", () => {
  it("shows apply-all chips on a batch propose (clarify)", () => {
    const m = batchChipModel({ ...base, needsClarification: true, batchRemaining: ["a", "b", "c"] });
    expect(m).not.toBeNull();
    expect(m!.showApplyAll).toBe(true);
    expect(m!.count).toBe(3);
    expect(m!.applyAllMessage).toMatch(/all of them/i);
  });
  it("shows a progress hint on a batch apply (edit linked)", () => {
    const m = batchChipModel({ ...base, editId: "e1", batchRemaining: ["b", "c"] });
    expect(m!.showApplyAll).toBe(false);
    expect(m!.progressLabel).toBe("2 sections left in this change");
  });
  it("returns null when there is no batch", () => {
    expect(batchChipModel(base)).toBeNull();
    expect(batchChipModel({ ...base, needsClarification: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper (paste from Step 1) and wire the JSX**

Create the helper file (content above). Then in `ChatPanel.tsx`:

- Add `batchRemaining: []` to the two `ChatMessageView` literals (optimistic user ~56, error assistant ~81).
- Import: `import { batchChipModel } from "./chat-batch-ui";`
- In `ChatBubble`, after the existing progress/review links block and before the footer, add:

```tsx
        {!isUser && (() => {
          const bm = batchChipModel(message);
          if (!bm) return null;
          if (bm.showApplyAll) {
            return (
              <div className="mt-2 flex flex-wrap gap-2">
                <BatchChip
                  projectId={projectId}
                  label={`Apply to all ${bm.count}`}
                  message={bm.applyAllMessage}
                  primary
                />
              </div>
            );
          }
          return bm.progressLabel ? (
            <p className="mt-2 font-mono text-[11px] text-teal/70">{bm.progressLabel}</p>
          ) : null;
        })()}
```

- Add a `BatchChip` client component in the SAME file that reuses the panel's send mechanism. The cleanest wiring: lift the send into a context or pass a callback. Given the current panel structure (send lives in `ChatPanel`), the minimal approach is to make `ChatBubble` accept an `onQuickReply?: (text: string) => void` prop threaded from `ChatPanel` (which calls the same code path as `onSend` with the canned text). Implement:

  1. In `ChatPanel`, extract the body of `onSend` after obtaining `content` into `sendContent(content: string)`; have `onSend` call `sendContent(draft.trim())`.
  2. Pass `onQuickReply={sendContent}` to `<ChatBubble>`.
  3. `BatchChip` is a `<button>` that calls `onQuickReply(message)`; style it like the existing Send button but smaller:

```tsx
function BatchChip({
  label, message, onQuickReply, primary,
}: { label: string; message: string; onQuickReply: (t: string) => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onQuickReply(message)}
      className={`inline-flex h-7 items-center rounded-full px-3 text-[12px] font-semibold transition-[filter] hover:brightness-110 motion-reduce:transition-none ${
        primary ? "bg-teal text-bg" : "border border-bord bg-elev text-wht"
      }`}
    >
      {label}
    </button>
  );
}
```

  (Drop the `projectId` prop from the earlier snippet — the chip only needs `onQuickReply` + `message`. Update the caller accordingly.)

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd apps/web && npx vitest run "app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts" && npx tsc --noEmit`
Expected: test PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx" "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.ts" "apps/web/app/(app)/projects/[id]/workspace/chat-batch-ui.test.ts"
git commit -m "feat(chat): batch confirm chips + progress hint in ChatPanel"
```

---

## Task 8: Full-suite + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS — 1648 prior + the new tests (batch-edit, edit-plan batch, planner batch + prompt, chat-turn-outcome batch, workspace-chat mapping, chat-batch-ui). No prior test regressed.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm the null-batch invariant by inspection**

Grep that no non-batch path reads `.batch` in a way that changes behavior when null:

Run: `cd apps/web && grep -rn "\.batch" lib app --include=*.ts --include=*.tsx | grep -v test`
Expected: every read is either `plan.batch` passthrough, `coerceBatchState`, `batchRemainingFrom`, or `batchChipModel` — all null-safe. No behavioral branch on a non-null batch in the worker/dispatch path (the batch only affects the planner + UI).

- [ ] **Step 4: Commit (if any lint touch-ups)**

```bash
git add -A && git commit -m "chore(chat): multi-block batch — full-suite green" || echo "nothing to commit"
```

---

## Self-review checklist (run before handing to execution)

- **Spec coverage:** propose/confirm (Task 4 prompt + Task 5 clarify carry), sequence-per-turn (Task 4 apply rule), echo-remaining (Task 4 action rule + Task 6/7 UI), no-migration/no-worker-change (Tasks touch only planner+chat+UI), chips (Task 7), null-batch byte-identical (Task 8 step 3). ✓
- **Placeholder scan:** every code step has full code. ✓
- **Type consistency:** `BatchEditState` defined in Task 1, consumed by Tasks 2/3/5; `batch` field name consistent; `batchRemaining` consistent Tasks 6/7; `batchChipModel`/`batchProgressLabel` names stable. ✓
