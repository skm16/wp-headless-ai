# Phase 5: Planner and Chat Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the user-facing chat-edit path — planner model routing via `getModelFor("planner")`, shared SDK singleton, `strict: true` tool schema, stop_reason/max_tokens handling with a distinct truncation notice, prompt caching with a cache-stable history trim, typed Anthropic error handling that never leaves a dangling chat turn, and real enforcement of the declared cost-cap constants.

**Architecture:** All changes live in the planner call chain: `sendChatMessageAction` (apps/web/lib/actions/workspace-chat.ts) → `planEdit` / `AnthropicPlannerClient` (apps/web/lib/ai/edit-planner.ts) → Anthropic Messages API, plus the cost-guard module (apps/web/lib/ai/edit-cost-guard.ts), the tool schema (apps/web/lib/jab/edit-plan.ts), and the regen worker library (apps/web/lib/jab/regenerate-unit.ts). No DB migration: the truncation/retry telemetry mark is encoded inside the existing `chat_messages.plan` jsonb as a `plannerMeta` key.

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 5 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: **Phase 1** (it consumes Phase 1's `apps/web/lib/ai/errors.ts` `classifyAiError`, the `"planner"` task in `apps/web/lib/ai/model.ts` `getModelFor`, and the `StopReason` type exported from `apps/web/lib/ai/model-client.ts`). Independent of Phases 2–4.

---

## Audit issues addressed (clusters: workspace-chat all, edit-planner 2/3/4/8/10/11)

| # | Issue | Task |
|---|---|---|
| 1 | No prompt caching on the planner call (full history + system + tools re-billed every turn); `slice(-12)` slides the window every turn past 12 | 2, 6 |
| 2 | `stop_reason` never checked — a max_tokens-truncated plan is silently masked as a clarification (and a partial-but-parseable tool input can dispatch a real edit) | 7, 8 |
| 3 | No typed Anthropic error handling — API failure after the user message is persisted orphans the turn and surfaces a generic toast | 8 |
| 4 | Trimmed planner window can start with an assistant turn (Messages API requires `messages[0]` user-role) | 2 |
| 5 | `PLANNER_COST_CAP_TOKENS` / `EDIT_COST_CAP_TOKENS` exported but enforced nowhere | 1, 3, 9 |
| 6 | New Anthropic SDK client constructed per chat turn, bypassing the `getAnthropicClient()` singleton; client hard-constructed at the call site | 5, 8 |
| 7 | Tool not declared `strict` — even untruncated tool inputs are not schema-guaranteed | 4 |
| 8 | Planner model hardcoded (`PLANNER_MODEL = "claude-sonnet-4-6"`), bypassing the per-task `getModelFor` env-override system | 5 |

**Decisions made by this plan (drafter decisions the assignment delegated):**

1. **Truncation telemetry mark** → encoded in the existing `chat_messages.plan` jsonb (no migration): the persisted object becomes `{ ...EditPlan, plannerMeta: { stopReason, retriedForMaxTokens } }`. Nothing in the repo reads `chat_messages.plan` back as a strict `EditPlan` (verified by grep — it is write-only telemetry today), so the extra key is safe.
2. **`EDIT_COST_CAP_TOKENS`: ENFORCE, not delete.** Enforced in `regenerateComponentUnit` (apps/web/lib/jab/regenerate-unit.ts) before the `deps.generate` call, over the TEXT prompt inputs only (`JSON.stringify(entry)` + `JSON.stringify(tokens)` + guidance). The visual-tier screenshot is excluded from the estimate because image token cost is resolution-based, not text-length-based — documented in code. This point was chosen because (a) it is the only place that has the prompt inputs loaded (pre-dispatch in `sendChatMessageAction` the 50KB DOM sample isn't loaded and loading it there would add a heavy serial read to a user-facing action), and (b) the edit-site worker already catches ANY throw from `regenerateComponentUnit` (edit-site.ts lines 262–266: generic catch → `{ ok: false, isCompile, message }` → "abort-on-regen-fail" marks edit + build failed and surfaces the message to chat), so the cap fails loudly with zero new plumbing. `blockRowToEnrichedEntry` passes `source_dom_sample` through untruncated (verified — inventory-entry-from-row.ts:58), so the estimate is meaningful.
3. **`clarifyingQuestion` schema shape** → the `type: ["string", "null"]` array form is replaced with `anyOf: [{ type: "string" }, { type: "null" }]` and the key is added to `required`. Structured-outputs/strict grammar compilation explicitly supports `anyOf` and the `null` basic type; the type-array form is not in the documented supported list. Making the key required (value may still be null) is semantically identical and satisfies the strictest grammar interpretation.
4. **Module-scope planner client** → a module-private lazily-memoized accessor in workspace-chat.ts (one instance per server process). It cannot be an eager module-scope `const`: (a) `"use server"` modules may only export async functions, so no test-reset export is possible, and (b) constructing `AnthropicPlannerClient` calls `getAnthropicClient()`, which throws when `ANTHROPIC_API_KEY` is unset — an eager instance would crash module evaluation at build time / on flag-off deployments.

**Explicitly out of scope for this phase** (tracked elsewhere): workspace-chat audit issue "chat turn is fully blocking / no streaming" (architectural, low, defensible per the audit itself); edit-planner issue 1 (shell regen on every edit build → Phase 4); edit-planner issues 5/9 (regen prompt content / corrective retry → Phase 2); edit-planner issue 6/7 (component-generator caching → Phase 2). No new env flags are introduced by this phase, so no flag-off byte-identical test is required; the existing `JAB_CHAT_EDIT` server-side gate and its tests are untouched.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/web/lib/ai/edit-cost-guard.ts` | Modify | Add `estimateTokens`; extend `EditBudgetError` code union with `"planner_cost_cap"` / `"edit_cost_cap"`; correct the cost-cap docblock |
| `apps/web/lib/ai/edit-cost-guard.test.ts` | Modify | Tests for `estimateTokens` + new codes |
| `apps/web/lib/ai/edit-planner.ts` | Modify | `stableHeadSlice` + leading-assistant drop; pre-call cost cap; `getAnthropicClient`/injectable sdk; `getModelFor("planner")`; cache_control on system + last message block; max_tokens single retry; `PlannerClientResult`/`PlannerCallMeta` |
| `apps/web/lib/ai/edit-planner.test.ts` | Modify | Tests for trim stability, role invariant, cost cap, model resolution, request shape (caching/strict), stop_reason retry |
| `apps/web/lib/jab/edit-plan.ts` | Modify | `strict: true` + structured-outputs-conformant `EDIT_PLAN_TOOL_SCHEMA` |
| `apps/web/lib/jab/edit-plan.test.ts` | Modify | Schema-constraint tests |
| `apps/web/lib/actions/workspace-chat.ts` | Modify | Module-scope lazy planner client; typed-error wrap around `planEdit`; distinct max_tokens notice; `plannerMeta` into plan jsonb |
| `apps/web/lib/actions/workspace-chat.test.ts` | Modify | Tests: RateLimitError → notice (no dangling turn), non-API rethrow, cost-cap notice, truncation notice + jsonb mark |
| `apps/web/lib/jab/regenerate-unit.ts` | Modify | `EDIT_COST_CAP_TOKENS` enforcement before the generate call |
| `apps/web/lib/jab/regenerate-unit.test.ts` | Modify | Cost-cap test (generate never called) |

All test commands run from the repo root. The repo's runner is Vitest via the `@jab/web` package script `"test": "vitest run"` (verified in `apps/web/package.json`), so the per-file form is:

```
pnpm --filter @jab/web test <relative-path-under-apps/web>
```

---

### Task 1: `estimateTokens` + cost-cap error codes in edit-cost-guard

**Files:**
- Modify: `apps/web/lib/ai/edit-cost-guard.ts` (docblock at lines 26–28; `EditBudgetError` at lines 30–38)
- Test: `apps/web/lib/ai/edit-cost-guard.test.ts` (append to existing file)

- [ ] **Write the failing test.** Append to `apps/web/lib/ai/edit-cost-guard.test.ts` (after the closing `});` of the existing `describe` at line 54). Also add `estimateTokens` to the import list at the top of the file (lines 2–9):

```ts
// at the top — extend the existing import from "./edit-cost-guard":
import {
  evaluateEditBudget,
  EDIT_RATE_WINDOW_MS,
  MAX_EDITS_PER_WINDOW,
  MAX_CHAT_MESSAGES_PER_WINDOW,
  PLANNER_MAX_TURNS,
  EditBudgetError,
  estimateTokens,
} from "./edit-cost-guard";
```

```ts
// appended at the end of the file:
describe("estimateTokens", () => {
  it("estimates ceil(length / 4) tokens", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});

describe("EditBudgetError cost-cap codes", () => {
  it("accepts planner_cost_cap and edit_cost_cap", () => {
    expect(new EditBudgetError("planner_cost_cap", "m").code).toBe("planner_cost_cap");
    expect(new EditBudgetError("edit_cost_cap", "m").code).toBe("edit_cost_cap");
  });
});
```

- [ ] **Run it; confirm it fails.**

```
pnpm --filter @jab/web test lib/ai/edit-cost-guard.test.ts
```

Expected failure: `estimateTokens is not a function` (the import is `undefined`), and the cost-cap-codes test fails to compile under typecheck later if skipped — both new describes must be red.

- [ ] **Implement.** In `apps/web/lib/ai/edit-cost-guard.ts`, replace lines 26–38 (the cost-cap constants docblock + `EditBudgetError`) with:

```ts
/**
 * Hard token caps — ENFORCED (2026-06-10 AI-call optimization, Phase 5):
 *  - PLANNER_COST_CAP_TOKENS: `planEdit` (edit-planner.ts) estimates
 *    system prompt + tool-schema JSON + trimmed history via `estimateTokens`
 *    and throws EditBudgetError("planner_cost_cap") BEFORE calling Anthropic.
 *  - EDIT_COST_CAP_TOKENS: `regenerateComponentUnit` (regenerate-unit.ts)
 *    estimates the TEXT prompt inputs (serialized entry + tokens + guidance)
 *    and throws EditBudgetError("edit_cost_cap") BEFORE the generate call.
 *    The visual-tier screenshot is excluded from the estimate (image token
 *    cost is resolution-based, not text-length-based).
 */
export const PLANNER_COST_CAP_TOKENS = 30_000;
export const EDIT_COST_CAP_TOKENS = 60_000;

/**
 * Cheap deterministic token estimate (~4 chars/token). No network call,
 * stable in tests. Slightly over on dense prose, under on code — fine for a
 * tripwire cap with ~2x headroom over today's structural worst case
 * (MAX_CHAT_CONTENT_CHARS x PLANNER_MAX_TURNS ≈ 12K tokens vs the 30K cap).
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export type EditBudgetCode =
  | "rate_limited_edits"
  | "rate_limited_messages"
  | "planner_cost_cap"
  | "edit_cost_cap";

export class EditBudgetError extends Error {
  constructor(
    public readonly code: EditBudgetCode,
    message: string,
  ) {
    super(message);
    this.name = "EditBudgetError";
  }
}
```

Then update the `EditBudgetResult` type (currently lines 46–48) to reuse the union so it keeps compiling:

```ts
export type EditBudgetResult =
  | { ok: true }
  | { ok: false; code: "rate_limited_edits" | "rate_limited_messages"; reason: string };
```

(`EditBudgetResult` is unchanged — only `evaluateEditBudget` produces it and it only ever emits the two rate-limit codes. Leave it as-is; this checkbox is a verification that you did NOT widen it.)

- [ ] **Run it; confirm it passes.**

```
pnpm --filter @jab/web test lib/ai/edit-cost-guard.test.ts
```

Expected: all tests in the file pass (existing 6 + new 2).

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-cost-guard.ts apps/web/lib/ai/edit-cost-guard.test.ts
git commit -m "feat(saas): estimateTokens + planner/edit cost-cap error codes in edit-cost-guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `stableHeadSlice` history trim + first-message-is-user invariant

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (the `slice(-PLANNER_MAX_TURNS)` at line 90 inside `planEdit`, lines 85–94)
- Test: `apps/web/lib/ai/edit-planner.test.ts`

Background (verified): the existing trim test at edit-planner.test.ts:103–121 builds 20 user-role messages and expects 12 received with `received[0].content === "msg 8"`. `stableHeadSlice(20-element, 12, 4)` drops `Math.ceil(8/4)*4 = 8` → identical output, so that test stays green unchanged.

- [ ] **Write the failing tests.** In `apps/web/lib/ai/edit-planner.test.ts`: change line 2 to also import `stableHeadSlice`, and append two describes at the end of the file:

```ts
// line 2 becomes:
import { planEdit, parsePlannerToolUse, stableHeadSlice, type PlannerClient, type PlannerMessage } from "./edit-planner";
```

```ts
describe("stableHeadSlice", () => {
  it("returns the array unchanged at or under max", () => {
    const msgs = [1, 2, 3];
    expect(stableHeadSlice(msgs, 12, 4)).toEqual([1, 2, 3]);
    expect(stableHeadSlice(Array.from({ length: 12 }, (_, i) => i), 12, 4)).toHaveLength(12);
  });

  it("only shifts the window start every `chunk` turns (cache-prefix stability)", () => {
    // max=12, chunk=4: lengths 13..16 all drop exactly 4 → same head element.
    for (const len of [13, 14, 15, 16]) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4)[0]).toBe(4);
    }
    // lengths 17..20 all drop exactly 8.
    for (const len of [17, 18, 19, 20]) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4)[0]).toBe(8);
    }
  });

  it("never returns more than max", () => {
    for (let len = 0; len <= 30; len++) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4).length).toBeLessThanOrEqual(12);
    }
  });
});

describe("planEdit message-role invariant", () => {
  it("drops leading assistant turns so messages[0] is user-role", async () => {
    // The budget-notice path persists assistant-only rows, so a conversation
    // can legitimately START with an assistant turn.
    const messages: PlannerMessage[] = [
      { role: "assistant", content: "You're sending messages too quickly. Please slow down." },
      { role: "user", content: "make the hero bolder" },
    ];
    let received: PlannerMessage[] = [];
    const client: PlannerClient = {
      async createPlan({ messages: m }) {
        received = m;
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };
    await planEdit({ messages, siteMap, client });
    expect(received).toHaveLength(1);
    expect(received[0].role).toBe("user");
  });
});
```

- [ ] **Run them; confirm they fail.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

Expected failure: `stableHeadSlice is not a function` for the first describe; the role-invariant test fails with `expected 2 to be 1` (the current code sends both messages).

- [ ] **Implement.** In `apps/web/lib/ai/edit-planner.ts`, add the export above `planEdit` and replace the body of `planEdit` (currently lines 85–94). Full new region:

```ts
/**
 * Cache-stable history trim. A naive slice(-max) shifts the window start on
 * EVERY turn once history exceeds max, changing messages[0] each turn and
 * invalidating the prompt-cache prefix. Dropping the head in fixed chunks of
 * `chunk` keeps the window start stable for `chunk` consecutive turns, so
 * cache hits accrue between shifts (the prefix only re-writes once per chunk).
 */
export function stableHeadSlice<T>(msgs: T[], max = 12, chunk = 4): T[] {
  if (msgs.length <= max) return msgs;
  const drop = Math.ceil((msgs.length - max) / chunk) * chunk;
  return msgs.slice(drop);
}

export async function planEdit(args: {
  messages: PlannerMessage[];
  siteMap: SiteMap;
  client: PlannerClient;
}): Promise<{ plan: EditPlan; usage: PlannerUsage }> {
  let trimmed = stableHeadSlice(args.messages, PLANNER_MAX_TURNS);
  // The Messages API requires messages[0] to be user-role. The budget-notice
  // path writes assistant-only rows (workspace-chat writeAssistant on
  // EditBudgetError), so a conversation — and therefore a trimmed window —
  // can start with assistant turns. Drop them; they are also pure noise
  // ("You're sending messages too quickly...") the planner doesn't need.
  while (trimmed.length > 0 && trimmed[0].role === "assistant") {
    trimmed = trimmed.slice(1);
  }
  const system = buildSystemPrompt(args.siteMap);
  const { toolInput, usage } = await args.client.createPlan({ system, messages: trimmed });
  return { plan: parsePlannerToolUse(toolInput), usage };
}
```

(The action always persists the user message before calling `planEdit`, so the window always ends in a user turn and can never become empty here.)

- [ ] **Run them; confirm they pass** (including the pre-existing `trims messages to the last PLANNER_MAX_TURNS turns` test — see Background note).

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(saas): cache-stable planner history trim + user-first message invariant

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: enforce `PLANNER_COST_CAP_TOKENS` before the Anthropic call

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (the `planEdit` body from Task 2; the import from `./edit-cost-guard` at line 5)
- Test: `apps/web/lib/ai/edit-planner.test.ts`

- [ ] **Write the failing test.** Append inside the file (new describe at the end). Also add `vi` to the vitest import on line 1:

```ts
// line 1 becomes:
import { describe, it, expect, vi, afterEach } from "vitest";
```

```ts
describe("planEdit cost cap", () => {
  it("throws EditBudgetError(planner_cost_cap) BEFORE calling the client when the estimate exceeds the cap", async () => {
    // 4 turns x 50,000 chars = 200,000 chars ≈ 50,000 tokens > 30,000 cap.
    // (The per-message 4000-char cap lives in the ACTION, not here — planEdit
    // must defend itself.)
    const big = "x".repeat(50_000);
    const messages: PlannerMessage[] = Array.from({ length: 4 }, () => ({
      role: "user" as const,
      content: big,
    }));
    const createPlan = vi.fn();
    await expect(
      planEdit({ messages, siteMap, client: { createPlan } as unknown as PlannerClient }),
    ).rejects.toMatchObject({ name: "EditBudgetError", code: "planner_cost_cap" });
    expect(createPlan).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run it; confirm it fails.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

Expected failure: `promise resolved ... instead of rejecting` (today `planEdit` happily calls the client).

- [ ] **Implement.** In `apps/web/lib/ai/edit-planner.ts`:

Line 5's import becomes:

```ts
import {
  EditBudgetError,
  estimateTokens,
  PLANNER_COST_CAP_TOKENS,
  PLANNER_MAX_TURNS,
} from "./edit-cost-guard";
```

And inside `planEdit`, between `const system = buildSystemPrompt(args.siteMap);` and the `createPlan` call, insert:

```ts
  // Pre-call cost cap (audit: the declared caps were exported but enforced
  // nowhere). estimateTokens is a deliberate cheap heuristic — no
  // count_tokens round-trip on a user-facing turn. Structural bounds keep
  // real traffic far below this; it is a tripwire against unbounded growth
  // (e.g. a giant block inventory inflating the system prompt).
  const estimatedInputTokens =
    estimateTokens(system) +
    estimateTokens(JSON.stringify(EDIT_PLAN_TOOL_SCHEMA)) +
    trimmed.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (estimatedInputTokens > PLANNER_COST_CAP_TOKENS) {
    throw new EditBudgetError(
      "planner_cost_cap",
      "This conversation has grown too large to plan against. Send a fresh, specific request describing the single change you want.",
    );
  }
```

- [ ] **Run it; confirm it passes.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(saas): enforce PLANNER_COST_CAP_TOKENS pre-call in planEdit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `strict: true` + structured-outputs-conformant tool schema

**Files:**
- Modify: `apps/web/lib/jab/edit-plan.ts` (`EDIT_PLAN_TOOL_SCHEMA`, lines 27–61)
- Test: `apps/web/lib/jab/edit-plan.test.ts`

Constraint check performed against the current schema (lines 27–61): `additionalProperties: false` already present; no numeric min/max, no minLength/maxLength, no recursion, `enum` on `scope` is supported. Two gaps for strict/structured-outputs grammar: (1) `clarifyingQuestion` uses the `type: ["string", "null"]` array form — replaced by `anyOf` (explicitly supported) per Decision 3; (2) `clarifyingQuestion` is absent from `required` — added (null value still expresses "no question").

- [ ] **Write the failing tests.** In `apps/web/lib/jab/edit-plan.test.ts`, extend the `EDIT_PLAN_TOOL_SCHEMA` describe (lines 69–74) to:

```ts
describe("EDIT_PLAN_TOOL_SCHEMA", () => {
  it("constrains scope to exactly component|shell (no deferred scopes)", () => {
    const scope = EDIT_PLAN_TOOL_SCHEMA.input_schema.properties.scope as { enum: readonly string[] };
    expect(scope.enum).toEqual(["component", "shell"]);
  });

  it("declares strict tool use", () => {
    expect((EDIT_PLAN_TOOL_SCHEMA as { strict?: boolean }).strict).toBe(true);
  });

  it("meets the structured-outputs grammar constraints", () => {
    const schema = EDIT_PLAN_TOOL_SCHEMA.input_schema as {
      additionalProperties: boolean;
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    // strict grammar: every property key present in required
    // (clarifyingQuestion stays nullable via anyOf).
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    // no unsupported constraints anywhere in the schema
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/"minimum"|"maximum"|"minLength"|"maxLength"/);
    // no type-array unions — nullable is expressed via anyOf
    const cq = schema.properties.clarifyingQuestion as { type?: unknown; anyOf?: unknown[] };
    expect(Array.isArray(cq.type)).toBe(false);
    expect(Array.isArray(cq.anyOf)).toBe(true);
  });
});
```

- [ ] **Run them; confirm they fail.**

```
pnpm --filter @jab/web test lib/jab/edit-plan.test.ts
```

Expected failures: `expected undefined to be true` (no `strict` key), required-vs-properties mismatch (`clarifyingQuestion` missing from required), and `expected true to be false` on the type-array check.

- [ ] **Implement.** In `apps/web/lib/jab/edit-plan.ts`, replace `EDIT_PLAN_TOOL_SCHEMA` (lines 27–61) with:

```ts
/**
 * The Anthropic tool-use input schema the planner is constrained to.
 * `strict: true` → the API guarantees the tool input is schema-valid by
 * construction (structured-outputs grammar), making parsePlannerToolUse's
 * defensive coercion a true dead path for well-formed responses. Grammar
 * constraints honored here: additionalProperties:false on the object, every
 * property in `required`, nullable expressed via anyOf (type-array unions
 * are not in the documented supported set), no numeric/length bounds.
 */
export const EDIT_PLAN_TOOL_SCHEMA = {
  name: "emit_edit_plan",
  description:
    "Emit a structured plan for the user's requested edit, OR ask a clarifying question when the target is ambiguous or the request is too vague to act on.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      needsClarification: {
        type: "boolean",
        description: "true when you cannot confidently pick a single target; then run no edit.",
      },
      scope: { type: "string", enum: ["component", "shell"] },
      target: {
        type: "string",
        description:
          "For scope=component: the exact block_name from the site map. For scope=shell: 'header' or 'footer'. Empty string when needsClarification.",
      },
      action: {
        type: "string",
        description:
          "One sentence stating exactly what changes and the blast radius, e.g. 'Regenerate the Cover block — affects 3 pages'.",
      },
      regenerationPrompt: {
        type: "string",
        description: "Concrete instructions passed to the component/shell generator. Empty when needsClarification.",
      },
      clarifyingQuestion: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "The question to ask the user. Required when needsClarification, null otherwise.",
      },
    },
    required: [
      "needsClarification",
      "scope",
      "target",
      "action",
      "regenerationPrompt",
      "clarifyingQuestion",
    ],
    additionalProperties: false,
  },
} as const;
```

- [ ] **Run them; confirm they pass.** Also run the planner tests — the schema is serialized into the Task 3 estimate, which must still work:

```
pnpm --filter @jab/web test lib/jab/edit-plan.test.ts lib/ai/edit-planner.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/jab/edit-plan.ts apps/web/lib/jab/edit-plan.test.ts
git commit -m "feat(saas): strict:true structured-outputs-conformant emit_edit_plan tool schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: shared SDK singleton + injectable sdk + `getModelFor("planner")`

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`PLANNER_MODEL` const at line 37; `AnthropicPlannerClient` constructor at lines 102–106; `model:` at line 110)
- Test: `apps/web/lib/ai/edit-planner.test.ts`

Pre-condition (Phase 1): `apps/web/lib/ai/model.ts` `TASKS` includes `"planner"` with `DEFAULTS.planner === "claude-sonnet-4-6"`, and the env key builder handles hyphens (irrelevant for `planner`, key is `JAB_AI_MODEL_PLANNER`). If `getModelFor("planner")` does not compile, STOP — Phase 1 has not landed; do not re-implement it here.

- [ ] **Write the failing tests.** In `apps/web/lib/ai/edit-planner.test.ts`: import `AnthropicPlannerClient` and `Anthropic`, add the fake-SDK helpers (reused by Tasks 6–7), an env-cleanup hook, and a new describe. Add near the top of the file (after the existing imports):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicPlannerClient } from "./edit-planner";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Minimal Messages-API response; override per test. */
function fullResponse(over: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "emit_edit_plan",
        input: {
          needsClarification: true,
          scope: "component",
          target: "",
          action: "",
          regenerationPrompt: "",
          clarifyingQuestion: "Which?",
        },
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...over,
  };
}

/** Fake SDK whose messages.create resolves the given responses in order. */
function fakeSdk(responses: Array<Record<string, unknown>>) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(fullResponse(r));
  return { sdk: { messages: { create } } as unknown as Anthropic, create };
}
```

(Note: `AnthropicPlannerClient` can be merged into the existing line-2 import instead of a second import statement — either form is fine.)

Then append the describe:

```ts
describe("AnthropicPlannerClient model + sdk plumbing", () => {
  it("resolves the model via getModelFor('planner') — default sonnet", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("honors the JAB_AI_MODEL_PLANNER env override (resolved per call)", async () => {
    vi.stubEnv("JAB_AI_MODEL_PLANNER", "claude-haiku-4-5-20251001");
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses the injected sdk instead of constructing its own", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Run them; confirm they fail.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

Expected failure: the constructor takes no options today and throws `ANTHROPIC_API_KEY not set.` (or, with a key set in the shell, `create` is never the injected mock) — all three tests red.

- [ ] **Implement.** In `apps/web/lib/ai/edit-planner.ts`:

Add imports:

```ts
import { getAnthropicClient } from "./client";
import { getModelFor } from "./model";
```

Delete line 37 (`const PLANNER_MODEL = "claude-sonnet-4-6";`) and replace the class constructor + `model:` line. The class becomes (full current shape — `createPlan` body otherwise unchanged until Task 6):

```ts
/**
 * Real Anthropic-backed PlannerClient. Forces the emit_edit_plan tool so the
 * model's only output channel is the structured plan. Uses the process-wide
 * SDK singleton (one keep-alive pool, one shared backoff state); `sdk` is
 * injectable for tests. Model resolves through getModelFor("planner") per
 * call so JAB_AI_MODEL_PLANNER works without a redeploy.
 */
export class AnthropicPlannerClient implements PlannerClient {
  private readonly sdk: Anthropic;
  constructor(opts?: { sdk?: Anthropic }) {
    this.sdk = opts?.sdk ?? getAnthropicClient();
  }

  async createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult> {
    const response = await this.sdk.messages.create({
      model: getModelFor("planner"),
      max_tokens: 1024,
      system: args.system,
      tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput = toolBlock && toolBlock.type === "tool_use" ? toolBlock.input : null;
    const toolInput =
      rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>)
        : { needsClarification: true, clarifyingQuestion: "Could you describe the change in more detail?" };
    const u = response.usage;
    return {
      toolInput,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
```

(The `EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool` cast stays — SDK 0.95.x typings may lag the `strict` field; the wire accepts it.)

- [ ] **Verify the singleton invariant.** Run:

```
rg -n "new Anthropic\(" apps/web/lib apps/web/app
```

Expected output: only `apps/web/lib/ai/client.ts` (Phase 1 removed the `model-client.ts` occurrence; this task removes the planner's). If anything else appears, fix it before committing.

- [ ] **Run the tests; confirm they pass.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(saas): planner resolves model via getModelFor('planner') + shared SDK singleton

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: prompt caching — cache_control on system block + last message block

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (the `createPlan` request body from Task 5)
- Test: `apps/web/lib/ai/edit-planner.test.ts`

- [ ] **Write the failing test.** Append to the `AnthropicPlannerClient` describe (or a new one):

```ts
describe("AnthropicPlannerClient prompt caching", () => {
  it("places cache_control on the system block and on the LAST message's last content block only", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });
    const body = create.mock.calls[0][0];
    // system is a block array with the breakpoint (caches tools+system,
    // render order tools → system → messages).
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    // earlier messages stay plain strings (no breakpoints wasted — max 4/request)
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
    expect(body.messages[1]).toEqual({ role: "assistant", content: "second" });
    // last message converted to block-array form carrying the breakpoint —
    // the multi-turn pattern: tools+system+history become the cached prefix.
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "third", cache_control: { type: "ephemeral" } }],
    });
  });
});
```

- [ ] **Run it; confirm it fails.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

Expected failure: `body.system` is the plain string `"sys"` and `body.messages[2].content` is the plain string `"third"`.

- [ ] **Implement.** In `createPlan`, replace the request construction (the `this.sdk.messages.create({...})` call from Task 5) with:

```ts
    // Prompt caching — multi-turn pattern. Two breakpoints (max 4/request):
    //  1. system block → caches tools + system (render order tools→system→
    //     messages). On small sites this span alone may sit under Sonnet
    //     4.6's 2048-token minimum cacheable prefix — the marker is then
    //     silently inert (no error), which is fine.
    //  2. last content block of the last message → the whole request prefix
    //     (tools + system + history) becomes the cached span, so turn N+1
    //     reads turn N's prefix at ~0.1x once the conversation crosses the
    //     minimum. stableHeadSlice (planEdit) keeps the window start stable
    //     so trimming doesn't invalidate the prefix every turn.
    // The markers are applied on EVERY call — including the max_tokens retry.
    const messages: Anthropic.MessageParam[] = args.messages.map((m, i) =>
      i === args.messages.length - 1
        ? {
            role: m.role,
            content: [
              {
                type: "text" as const,
                text: m.content,
                cache_control: { type: "ephemeral" as const },
              },
            ],
          }
        : { role: m.role, content: m.content },
    );
    const response = await this.sdk.messages.create({
      model: getModelFor("planner"),
      max_tokens: 1024,
      system: [
        {
          type: "text" as const,
          text: args.system,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
      messages,
    });
```

- [ ] **Run it; confirm it passes.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(saas): planner prompt caching — system + last-message cache breakpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: stop_reason handling — single max_tokens retry at 2048 + `PlannerCallMeta`

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`PlannerClientResult` lines ~22–25; `PlannerClient` interface; `planEdit` return; the `createPlan` method)
- Test: `apps/web/lib/ai/edit-planner.test.ts` (new tests + update existing mock clients to the new result shape)

- [ ] **Write the failing tests.** Append:

```ts
describe("AnthropicPlannerClient stop_reason handling", () => {
  it("retries ONCE at max_tokens=2048 when the first attempt truncates, accumulating usage and keeping cache markers", async () => {
    const { sdk, create } = fakeSdk([
      { stop_reason: "max_tokens", content: [] },
      {}, // healthy tool_use response
    ]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].max_tokens).toBe(1024);
    expect(create.mock.calls[1][0].max_tokens).toBe(2048);
    // cache marker present on the RETRY too (never drop it on retry)
    expect(create.mock.calls[1][0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(result.retriedForMaxTokens).toBe(true);
    expect(result.stopReason).toBe("tool_use");
    // usage accumulated across BOTH attempts (true spend, not just the winner)
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(40);
  });

  it("discards a parseable-but-TRUNCATED tool input when the retry also hits max_tokens", async () => {
    // The dangerous variant: a max_tokens response that still carries a
    // tool_use block whose input parses — e.g. a cut-off regenerationPrompt.
    // Trusting it would dispatch a real edit from half an instruction.
    const truncatedInput = {
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerate the Cover",
      regenerationPrompt: "make the he",
      clarifyingQuestion: null,
    };
    const truncated = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "tu_t", name: "emit_edit_plan", input: truncatedInput }],
    };
    const { sdk, create } = fakeSdk([truncated, truncated]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(2); // exactly one retry, never more
    expect(result.stopReason).toBe("max_tokens");
    expect(result.retriedForMaxTokens).toBe(true);
    // the truncated input was NOT trusted
    expect(result.toolInput.needsClarification).toBe(true);
  });

  it("does not retry on a healthy tool_use stop_reason", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("tool_use");
    expect(result.retriedForMaxTokens).toBe(false);
  });
});

describe("planEdit plannerMeta threading", () => {
  it("returns plannerMeta from the client result", async () => {
    const client: PlannerClient = {
      async createPlan() {
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "max_tokens" as const,
          retriedForMaxTokens: true,
        };
      },
    };
    const { plannerMeta } = await planEdit({
      messages: [{ role: "user", content: "hi" }],
      siteMap,
      client,
    });
    expect(plannerMeta).toEqual({ stopReason: "max_tokens", retriedForMaxTokens: true });
  });
});
```

- [ ] **Run them; confirm they fail.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

Expected failures: `create` called once where 2 expected; `result.stopReason`/`result.retriedForMaxTokens` undefined; `plannerMeta` undefined from `planEdit`.

- [ ] **Implement.** In `apps/web/lib/ai/edit-planner.ts`:

Add the type import and constants near the top (after the existing imports):

```ts
import type { StopReason } from "./model-client";

/** First-attempt output budget — right-sized for a small structured plan. */
const PLANNER_MAX_OUTPUT_TOKENS = 1024;
/** Single-retry budget when the first attempt truncates at max_tokens. */
const PLANNER_RETRY_MAX_OUTPUT_TOKENS = 2048;
```

Replace `PlannerClientResult` (currently the `{ toolInput; usage }` interface) and add `PlannerCallMeta`:

```ts
/**
 * Per-call metadata threaded into chat telemetry. Persisted INSIDE the
 * existing chat_messages.plan jsonb as a `plannerMeta` key — deliberately no
 * new column / migration (Phase 5 decision).
 */
export interface PlannerCallMeta {
  /** stop_reason of the FINAL attempt ("max_tokens" ⇒ truncated even after the retry). */
  stopReason: StopReason;
  /** true when attempt 1 hit max_tokens and the single 2048 retry was made. */
  retriedForMaxTokens: boolean;
}

export interface PlannerClientResult {
  toolInput: Record<string, unknown>;
  usage: PlannerUsage;
  stopReason: StopReason;
  retriedForMaxTokens: boolean;
}
```

Change `planEdit`'s signature/return (keeping the Task 2 + Task 3 body):

```ts
export async function planEdit(args: {
  messages: PlannerMessage[];
  siteMap: SiteMap;
  client: PlannerClient;
}): Promise<{ plan: EditPlan; usage: PlannerUsage; plannerMeta: PlannerCallMeta }> {
  // ... trimmed / role-drop / system / cost-cap from Tasks 2–3 unchanged ...
  const { toolInput, usage, stopReason, retriedForMaxTokens } = await args.client.createPlan({
    system,
    messages: trimmed,
  });
  return {
    plan: parsePlannerToolUse(toolInput),
    usage,
    plannerMeta: { stopReason, retriedForMaxTokens },
  };
}
```

Add the usage helpers above the class:

```ts
function usageOf(response: Anthropic.Message): PlannerUsage {
  const u = response.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: PlannerUsage, b: PlannerUsage): PlannerUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}
```

And restructure the class — the Task 6 request body moves into a private `request` method; `createPlan` gains the retry. Full final class:

```ts
export class AnthropicPlannerClient implements PlannerClient {
  private readonly sdk: Anthropic;
  constructor(opts?: { sdk?: Anthropic }) {
    this.sdk = opts?.sdk ?? getAnthropicClient();
  }

  private async request(
    args: { system: string; messages: PlannerMessage[] },
    maxTokens: number,
  ): Promise<Anthropic.Message> {
    // Prompt caching — multi-turn pattern. Two breakpoints (max 4/request):
    //  1. system block → caches tools + system (render order tools→system→
    //     messages). On small sites this span alone may sit under Sonnet
    //     4.6's 2048-token minimum cacheable prefix — the marker is then
    //     silently inert (no error), which is fine.
    //  2. last content block of the last message → the whole request prefix
    //     (tools + system + history) becomes the cached span, so turn N+1
    //     reads turn N's prefix at ~0.1x once the conversation crosses the
    //     minimum. stableHeadSlice (planEdit) keeps the window start stable
    //     so trimming doesn't invalidate the prefix every turn.
    // The markers are applied on EVERY call — including the max_tokens retry.
    const messages: Anthropic.MessageParam[] = args.messages.map((m, i) =>
      i === args.messages.length - 1
        ? {
            role: m.role,
            content: [
              {
                type: "text" as const,
                text: m.content,
                cache_control: { type: "ephemeral" as const },
              },
            ],
          }
        : { role: m.role, content: m.content },
    );
    return this.sdk.messages.create({
      model: getModelFor("planner"),
      max_tokens: maxTokens,
      system: [
        {
          type: "text" as const,
          text: args.system,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
      messages,
    });
  }

  async createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult> {
    let response = await this.request(args, PLANNER_MAX_OUTPUT_TOKENS);
    let usage = usageOf(response);
    let retriedForMaxTokens = false;
    if (response.stop_reason === "max_tokens") {
      // Truncation is observable, not a blind re-roll: retry ONCE with a
      // doubled output budget, then stop.
      console.warn(
        `[edit-planner] plan truncated at max_tokens=${PLANNER_MAX_OUTPUT_TOKENS} — retrying once at ${PLANNER_RETRY_MAX_OUTPUT_TOKENS}`,
      );
      retriedForMaxTokens = true;
      response = await this.request(args, PLANNER_RETRY_MAX_OUTPUT_TOKENS);
      usage = addUsage(usage, usageOf(response));
    }
    const stopReason = (response.stop_reason ?? null) as StopReason;
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput = toolBlock && toolBlock.type === "tool_use" ? toolBlock.input : null;
    // A max_tokens response can carry a PARTIAL-but-parseable tool input
    // (e.g. a cut-off regenerationPrompt) — never trust it: a truncated turn
    // must not dispatch a real edit. The caller (workspace-chat) surfaces a
    // DISTINCT truncation notice on stopReason === "max_tokens"; the clarify
    // payload below is only the last-resort shape for non-truncation
    // responses that somehow carry no usable tool block.
    const toolInput =
      stopReason !== "max_tokens" && rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>)
        : {
            needsClarification: true,
            clarifyingQuestion: "Could you describe the change in more detail?",
          };
    return { toolInput, usage, stopReason, retriedForMaxTokens };
  }
}
```

- [ ] **Update the existing mock clients to the new result shape** (same file, edit-planner.test.ts) — three places:

1. `mockClient` (lines 12–21) — its `createPlan` return gains the two fields:

```ts
function mockClient(toolInput: Record<string, unknown>): PlannerClient {
  return {
    async createPlan() {
      return {
        toolInput,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: "tool_use" as const,
        retriedForMaxTokens: false,
      };
    },
  };
}
```

2. The inline client in the `trims messages...` test (lines ~109–117) — its return gains:

```ts
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "tool_use" as const,
          retriedForMaxTokens: false,
        };
```

3. The inline client in the Task 2 role-invariant test — same two fields added to its return.

- [ ] **Run the full planner test file; confirm everything passes.**

```
pnpm --filter @jab/web test lib/ai/edit-planner.test.ts
```

- [ ] **Typecheck** (the `PlannerClient` interface change must not break other consumers — `workspace-chat.ts` still compiles because it destructures only `plan`/`usage` until Task 8):

```
pnpm --filter @jab/web typecheck
```

Expected: clean. (If `workspace-chat.ts` errors here, it is destructuring a field that no longer exists — fix in Task 8, not by loosening types.)

- [ ] **Commit.**

```
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(saas): planner stop_reason handling — single max_tokens retry at 2048 + PlannerCallMeta

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: workspace-chat — typed-error wrap, distinct truncation notice, module-scope client, plan jsonb telemetry

**Files:**
- Modify: `apps/web/lib/actions/workspace-chat.ts` (imports at lines 5–11; planner call region at lines 157–186; clarify/edit branches at lines 168–186)
- Test: `apps/web/lib/actions/workspace-chat.test.ts` (extend `makeAdminMock` to thread insert payloads; new describe)

- [ ] **Extend the test harness to capture insert payloads.** In `apps/web/lib/actions/workspace-chat.test.ts`, in `makeAdminMock` (lines 116–183): change the handler type and `insertChain` so the payload reaches the handler. Replace the `insert?:` line of the `tableHandlers` type (line 121) and the `insertFn`/`insertChain` block (lines 155–170) with:

```ts
      insert?: (payload?: unknown) => Promise<{ data: unknown; error: unknown }>;
```

```ts
      // insert chain:
      //   .insert({}).select("id").single()      — conversations insert
      //   await .insert({})                       — chat_messages bare insert
      //   (the bare form works because we return a thenable object)
      // The payload is threaded to the handler so tests can assert on what
      // was persisted (e.g. the plan jsonb carrying plannerMeta).
      const insertFn = h.insert ?? (() => Promise.resolve({ data: null, error: null }));
      const insertChain = (payload: unknown) => {
        const result = {
          then: (
            resolve: (v: { data: unknown; error: unknown }) => unknown,
            reject: (e: unknown) => unknown,
          ) => insertFn(payload).then(resolve, reject),
          catch: (reject: (e: unknown) => unknown) => insertFn(payload).catch(reject),
          // chained form: .select("id").single()
          select: () => ({
            single: () => insertFn(payload),
          }),
        };
        return result;
      };
```

(Existing handlers take no arguments and ignore the new one — zero behavior change for the existing tests.)

- [ ] **Write the failing tests.** Append a new describe at the end of the test file. It needs three new imports at the top of the file (after line 78's SUT import is fine, but conventionally with the other imports — they resolve to the MOCKED modules for `planEdit`/`buildSiteMap`/`EditBudgetError`, and to the REAL SDK for `Anthropic`, which is exactly what the instanceof checks in the SUT need):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { planEdit } from "@/lib/ai/edit-planner";
import { buildSiteMap } from "@/lib/jab/site-map";
import { decideChatTurnOutcome } from "@/lib/jab/chat-turn-outcome";
import { EditBudgetError } from "@/lib/ai/edit-cost-guard";
```

```ts
describe("sendChatMessageAction — planner failure handling (Phase 5)", () => {
  function stubProjectResolved() {
    mockCreateClient.mockImplementation(async () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: vi.fn().mockResolvedValue({
              data: { id: "proj1", tenant_id: "tenant1" },
              error: null,
            }),
          }),
        }),
      }),
      auth: { getUser: async () => ({ data: { user: { id: "user1" } } }) },
    }));
  }

  const minimalSiteMap = {
    blockTypes: [],
    pageSlugs: [],
    shell: { header: false, footer: false },
  };

  /**
   * Admin mock that drives the flow all the way to planEdit:
   * conversation exists → user msg insert ok → ready build present →
   * (mocked) site map → (mocked) planEdit. Captures every chat_messages
   * insert payload so tests can assert on persisted content/plan jsonb.
   */
  function adminMockReachingPlanner() {
    const chatInserts: unknown[] = [];
    const admin = makeAdminMock({
      conversations: {
        select: async () => ({ data: { id: "conv-1" }, error: null }),
        update: async () => ({ data: null, error: null }),
      },
      chat_messages: {
        insert: async (payload?: unknown) => {
          chatInserts.push(payload);
          if (chatInserts.length === 1) {
            // user message — bare insert, destructures {error} only
            return { data: null, error: null };
          }
          // assistant message — chained .select().single() needs a full row
          const p = payload as { content?: string; needs_clarification?: boolean };
          return {
            data: {
              id: `msg-asst-${chatInserts.length}`,
              role: "assistant",
              content: p?.content ?? "",
              needs_clarification: p?.needs_clarification === true,
              edit_id: null,
              build_id: null,
              created_at: new Date().toISOString(),
            },
            error: null,
          };
        },
        // loadPlannerMessages awaits .select().eq().order() with no terminal —
        // makeAdminMock's non-thenable chain node makes `data` undefined and
        // the SUT coerces to [] (empty history). planEdit is mocked, so the
        // history content is irrelevant here.
        update: async () => ({ data: null, error: null }),
      },
      site_builds: {
        select: async () => ({ data: { id: "build-1" }, error: null }),
      },
    });
    return { admin, chatInserts };
  }

  function arm() {
    vi.stubEnv("JAB_CHAT_EDIT", "1");
    stubProjectResolved();
    const { admin, chatInserts } = adminMockReachingPlanner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockCreateAdminClient as Mock<any>).mockReturnValue(admin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (buildSiteMap as Mock<any>).mockResolvedValue(minimalSiteMap);
    return { chatInserts };
  }

  it("converts an Anthropic RateLimitError into a persisted assistant notice — no dangling turn, no raw throw", async () => {
    const { chatInserts } = arm();
    // Construct via the prototype so instanceof Anthropic.RateLimitError (and
    // the base Anthropic.APIError) hold WITHOUT depending on the SDK error
    // constructor signature (status/error/message/headers ordering varies
    // across SDK versions).
    const rateLimitErr = Object.assign(Object.create(Anthropic.RateLimitError.prototype), {
      status: 429,
      message: "rate limited",
      name: "RateLimitError",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(rateLimitErr);

    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it bolder" });

    expect(result.assistant.needsClarification).toBe(true);
    expect(result.assistant.content).toMatch(/overloaded|busy|try again/i);
    // user message (insert 1) AND assistant notice (insert 2) both persisted
    expect(chatInserts).toHaveLength(2);
  });

  it("rethrows a non-API error (genuine fault) instead of masking it as a chat reply", async () => {
    arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(new TypeError("boom"));
    await expect(
      sendChatMessageAction({ projectId: "proj1", content: "make it bolder" }),
    ).rejects.toThrow("boom");
  });

  it("converts a planner_cost_cap EditBudgetError from planEdit into an assistant notice", async () => {
    const { chatInserts } = arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(
      new EditBudgetError("planner_cost_cap", "This conversation has grown too large to plan against."),
    );
    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it bolder" });
    expect(result.assistant.needsClarification).toBe(true);
    expect(result.assistant.content).toMatch(/too large/i);
    expect(chatInserts).toHaveLength(2);
  });

  it("surfaces a DISTINCT notice on max_tokens truncation and stamps plannerMeta into the plan jsonb", async () => {
    const { chatInserts } = arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockResolvedValue({
      plan: {
        needsClarification: true,
        scope: "component",
        target: "",
        action: "",
        regenerationPrompt: "",
        clarifyingQuestion: "Could you describe the change in more detail?",
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      plannerMeta: { stopReason: "max_tokens", retriedForMaxTokens: true },
    });

    const result = await sendChatMessageAction({ projectId: "proj1", content: "redo everything" });

    // distinct truncation message — NEVER the generic clarify fallback
    expect(result.assistant.content).toMatch(/too complex/i);
    expect(result.assistant.content).not.toMatch(/describe the change in more detail/i);
    // telemetry mark inside the existing plan jsonb (no migration)
    const assistantPayload = chatInserts[1] as {
      plan?: { plannerMeta?: { stopReason?: string; retriedForMaxTokens?: boolean } };
    };
    expect(assistantPayload.plan?.plannerMeta).toEqual({
      stopReason: "max_tokens",
      retriedForMaxTokens: true,
    });
  });

  it("stamps plannerMeta on a normal clarify turn too", async () => {
    const { chatInserts } = arm();
    const plan = {
      needsClarification: true,
      scope: "component",
      target: "",
      action: "",
      regenerationPrompt: "",
      clarifyingQuestion: "Which block?",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockResolvedValue({
      plan,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      plannerMeta: { stopReason: "tool_use", retriedForMaxTokens: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (decideChatTurnOutcome as Mock<any>).mockReturnValue({
      kind: "clarify",
      message: "Which block?",
      plan,
    });

    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it nicer" });

    expect(result.assistant.content).toBe("Which block?");
    const assistantPayload = chatInserts[1] as {
      plan?: { plannerMeta?: { stopReason?: string } };
    };
    expect(assistantPayload.plan?.plannerMeta?.stopReason).toBe("tool_use");
  });
});
```

- [ ] **Run them; confirm they fail.**

```
pnpm --filter @jab/web test lib/actions/workspace-chat.test.ts
```

Expected failures: the RateLimitError / cost-cap tests REJECT instead of resolving (no catch around `planEdit` today); the truncation test resolves with the generic clarify text and `plan.plannerMeta` undefined.

- [ ] **Implement.** In `apps/web/lib/actions/workspace-chat.ts`:

(1) Imports — line 7 changes and two new imports are added:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { classifyAiError } from "@/lib/ai/errors";
import {
  planEdit,
  AnthropicPlannerClient,
  type PlannerClient,
  type PlannerMessage,
  type PlannerUsage,
} from "@/lib/ai/edit-planner";
```

(2) Module-scope lazy planner client — add after the imports/docblock (before `export interface ChatMessageView`):

```ts
// One planner client per server process: shares the SDK singleton's
// keep-alive pool + backoff state (getAnthropicClient) instead of newing up
// a client per chat turn. Lazily constructed (NOT a module-scope const):
// "use server" modules may only export async functions (no test-reset
// export), and eager construction would call getAnthropicClient() at module
// evaluation — throwing at build time / on deployments without
// ANTHROPIC_API_KEY even when JAB_CHAT_EDIT is off.
let _plannerClient: PlannerClient | null = null;
function getPlannerClient(): PlannerClient {
  _plannerClient ??= new AnthropicPlannerClient();
  return _plannerClient;
}
```

(3) Replace the planner-call region. The current lines 157–186 (from `// 7. Load conversation history + call the planner.` through the `insertAssistant` call closing `});`) become:

```ts
  // 7. Load conversation history + call the planner. The user message is
  // already persisted at this point, so a planner failure must produce a
  // persisted assistant notice — never a dangling user turn + raw 500.
  const history = await loadPlannerMessages(admin, conversationId);
  let planned: Awaited<ReturnType<typeof planEdit>>;
  try {
    planned = await planEdit({
      messages: history,
      siteMap,
      client: getPlannerClient(),
    });
  } catch (err) {
    if (err instanceof EditBudgetError) {
      // planner_cost_cap (pre-call estimate in planEdit) → same friendly
      // notice path as the rate-limit gate above.
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: err.message,
        needsClarification: true,
        conversationId,
      });
    }
    if (!(err instanceof Anthropic.APIError)) {
      // Genuine fault (programming error, DB) — surface it, don't mask it
      // as a chat reply.
      throw err;
    }
    const kind = classifyAiError(err);
    console.error(`[workspace-chat] planner API failure (${kind}):`, err);
    const content =
      kind === "rate_limit" || kind === "overloaded"
        ? "The planner is overloaded right now. Wait a moment and send your request again."
        : kind === "auth"
          ? "The planner can't reach the AI service (configuration problem). An operator needs to check this deployment's ANTHROPIC_API_KEY."
          : "The planner hit a temporary problem talking to the AI service. Please try again.";
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content,
      needsClarification: true,
      conversationId,
    });
  }
  const { plan, usage, plannerMeta } = planned;
  // Telemetry mark lives INSIDE the existing chat_messages.plan jsonb (no
  // migration): the persisted object is the EditPlan plus a plannerMeta key
  // ({ stopReason, retriedForMaxTokens }).
  const planRecord: Record<string, unknown> = { ...plan, plannerMeta };

  if (plannerMeta.stopReason === "max_tokens") {
    // Truncated even after the single 2048 retry. Distinct notice — never
    // the generic clarify fallback (the user should rephrase smaller, not
    // "describe in more detail").
    console.warn(
      `[workspace-chat] planner output truncated at max_tokens even after retry (project ${args.projectId})`,
    );
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content:
        "That request was too complex to plan in one pass. Try asking for one smaller, more specific change at a time.",
      needsClarification: true,
      plan: planRecord,
      usage,
      conversationId,
    });
  }

  // 8+9. Branch on outcome.
  const outcome = decideChatTurnOutcome(plan, siteMap);

  if (outcome.kind === "clarify") {
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: outcome.message,
      needsClarification: true,
      plan: planRecord,
      usage,
      conversationId,
    });
  }

  // 9b. Edit branch — insert the assistant row, then dispatch the edit.
  const assistantRow = await insertAssistant(admin, {
    conversationId,
    projectId: args.projectId,
    content: outcome.assistantText,
    needsClarification: false,
    plan: planRecord,
    usage,
  });
```

(Everything after — `await touchConversation(...)`, the `requestWorkspaceEditAction` try/catch — is unchanged.)

(4) Update the module docblock's step 7 line (line 24) to:

```
 *   7. loadPlannerMessages → planEdit (Anthropic) — typed-error wrapped:
 *      EditBudgetError/Anthropic.APIError → persisted assistant notice;
 *      stop_reason "max_tokens" → distinct truncation notice
```

- [ ] **Run the tests; confirm all pass** (the new describe AND the pre-existing gate/race tests, which exercise the unchanged early-exit paths):

```
pnpm --filter @jab/web test lib/actions/workspace-chat.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/actions/workspace-chat.ts apps/web/lib/actions/workspace-chat.test.ts
git commit -m "feat(saas): chat turn never dangles — typed planner error notices, distinct truncation reply, plannerMeta telemetry, module-scope planner client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: enforce `EDIT_COST_CAP_TOKENS` in regenerate-unit

**Files:**
- Modify: `apps/web/lib/jab/regenerate-unit.ts` (insert between `const tokens = await deps.loadTokens(input);` at line 126 and the screenshot load at lines 127–128; new import)
- Test: `apps/web/lib/jab/regenerate-unit.test.ts`

- [ ] **Write the failing test.** In `apps/web/lib/jab/regenerate-unit.test.ts`, add the import and a test inside the `regenerateComponentUnit` describe:

```ts
// new import at the top:
import { EditBudgetError } from "@/lib/ai/edit-cost-guard";
```

```ts
  it("throws EditBudgetError(edit_cost_cap) BEFORE generating when text prompt inputs exceed the cap", async () => {
    // EDIT_COST_CAP_TOKENS = 60_000 → 240_000 chars at ~4 chars/token.
    // blockRowToEnrichedEntry passes source_dom_sample through untruncated,
    // so an oversized DOM sample trips the estimate.
    const d = deps({
      loadTargetRow: vi.fn(async () => ({
        block_name: "core/cover",
        tier: "visual",
        kind: "block",
        spec: null,
        attr_samples: [{}],
        page_slugs: ["home"],
        occurrence_count: 4,
        source_dom_sample: "<div>" + "x".repeat(250_000) + "</div>",
        computed_styles: null,
      })),
    });
    await expect(
      regenerateComponentUnit(
        { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "x", screenshotSlug: "home" },
        d,
      ),
    ).rejects.toMatchObject({ name: "EditBudgetError", code: "edit_cost_cap" });
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.loadScreenshot).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("does not trip the cap on normal-sized inputs", async () => {
    const d = deps();
    const r = await regenerateComponentUnit(
      { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "bolder", screenshotSlug: "home" },
      d,
    );
    expect(r.compileStatus).toBe("ok");
    expect(d.generate).toHaveBeenCalled();
  });
```

(The `rejects.toMatchObject` check also asserts the error is the real `EditBudgetError` by `name`; add `expect(EditBudgetError).toBeDefined()` nowhere — the import is exercised below if you prefer `rejects.toBeInstanceOf(EditBudgetError)` as an additional line.)

- [ ] **Run them; confirm the first fails.**

```
pnpm --filter @jab/web test lib/jab/regenerate-unit.test.ts
```

Expected failure: the promise resolves (today nothing checks size; `generate` IS called).

- [ ] **Implement.** In `apps/web/lib/jab/regenerate-unit.ts`:

Add the import (with the other `@/lib/ai/*` imports near the top):

```ts
import { EDIT_COST_CAP_TOKENS, EditBudgetError, estimateTokens } from "@/lib/ai/edit-cost-guard";
```

Insert between `const tokens = await deps.loadTokens(input);` (line 126) and the `screenshotBase64` resolution (lines 127–128):

```ts
  // EDIT_COST_CAP_TOKENS enforcement (Phase 5 decision: ENFORCE, not delete —
  // the constant was exported-but-unenforced "dead reassurance"). This is the
  // only point that has the regen prompt inputs in hand pre-spend. Estimate
  // covers the TEXT inputs only: the serialized entry (attr samples + DOM
  // sample + computed styles + spec), resolved design tokens, and guidance.
  // The visual-tier screenshot is deliberately excluded — image token cost is
  // resolution-based, not text-length-based, and discovery bounds capture
  // dimensions. Today's structural caps (50KB DOM sample at prompt-build,
  // 4000-char guidance) keep real inputs far under the cap; this is a
  // tripwire against future unbounded growth. The edit-site worker's generic
  // catch converts this throw into a failed edit surfaced to chat.
  const estimatedPromptTokens =
    estimateTokens(JSON.stringify(entry)) +
    estimateTokens(JSON.stringify(tokens ?? null)) +
    estimateTokens(input.guidance);
  if (estimatedPromptTokens > EDIT_COST_CAP_TOKENS) {
    throw new EditBudgetError(
      "edit_cost_cap",
      `regenerate-unit: estimated text prompt inputs for '${input.target}' (~${estimatedPromptTokens} tokens) exceed EDIT_COST_CAP_TOKENS (${EDIT_COST_CAP_TOKENS}). Refusing the generate call.`,
    );
  }
```

- [ ] **Run them; confirm they pass.**

```
pnpm --filter @jab/web test lib/jab/regenerate-unit.test.ts
```

- [ ] **Commit.**

```
git add apps/web/lib/jab/regenerate-unit.ts apps/web/lib/jab/regenerate-unit.test.ts
git commit -m "feat(saas): enforce EDIT_COST_CAP_TOKENS before component regen generate call

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: full suite + typecheck + phase close-out

**Files:** none new — verification only.

- [ ] **Run the entire app test suite.**

```
pnpm --filter @jab/web test
```

Expected: green. Known interaction points to watch: `edit-planner.test.ts` (interface change from Task 7), `workspace-chat.test.ts` (harness change from Task 8), `edit-plan.test.ts`, `edit-cost-guard.test.ts`, `regenerate-unit.test.ts`, `chat-turn-outcome.test.ts` (untouched — must stay green).

- [ ] **Typecheck.**

```
pnpm --filter @jab/web typecheck
```

Expected: clean.

- [ ] **Verify the singleton invariant one final time.**

```
rg -n "new Anthropic\(" apps/web
```

Expected: only `apps/web/lib/ai/client.ts`.

- [ ] **Commit any stragglers and close the phase.**

```
git add -A
git commit -m "chore(saas): phase 5 planner/chat hardening close-out — full suite + typecheck green

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If nothing is left to commit, skip the commit — do not create an empty one.)

---

## Verification beyond unit tests (operator follow-up, not part of this plan's tasks)

1. **Live smoke (needs `JAB_CHAT_EDIT=1` + `ANTHROPIC_API_KEY`):** send one chat turn against a project with a ready build; confirm (a) the reply arrives, (b) the `chat_messages` assistant row's `plan` jsonb carries `plannerMeta.stopReason: "tool_use"`, (c) on a SECOND turn within 5 minutes, `input_tokens_cached` on the new assistant row is non-zero once the conversation prefix crosses Sonnet 4.6's 2048-token minimum (small sites may legitimately read 0 on early turns — the markers are silently inert below the minimum, by design).
2. **strict tool use:** the first live request after deploy pays a one-time schema-compilation latency (the compiled grammar is cached server-side ~24h). If the API ever rejects the schema (400 naming `strict` or the grammar), capture the error verbatim — the schema was vetted against the documented constraints (Task 4), so a rejection means the constraint set has drifted and the schema (not the plan) needs updating.
3. **Model override:** set `JAB_AI_MODEL_PLANNER=claude-haiku-4-5-20251001` on a non-prod deployment and confirm the next chat turn runs on Haiku (edit-planner issue 11's A/B path). Note Haiku's 4096-token minimum cacheable prefix makes early-turn cache hits rarer — sequence any permanent downgrade with cache-hit telemetry review.
