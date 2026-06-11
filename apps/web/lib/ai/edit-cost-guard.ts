import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * edit-cost-guard — rate-limit + budget gate for chat-driven edits (R2 / §3.3).
 * Pure decision (evaluateEditBudget) is unit-tested; assertEditBudget does the
 * window reads then delegates. Caps are deliberately conservative for the
 * internal pilot; tune after the first live runs.
 *
 * Schema reconciliation (2026-06-03): `chat_messages` has a `project_id` column
 * directly (confirmed in lib/db/schema.ts line 488 — migration 0029 added it
 * alongside `conversation_id`). The plan's original snippet works as-is; no
 * conversation-join detour is needed.
 */

/** Unbounded chat content flows into DB rows and the planner LLM — cap it. */
export const MAX_CHAT_CONTENT_CHARS = 4000;
/** Rolling window for rate limiting. */
export const EDIT_RATE_WINDOW_MS = 5 * 60 * 1000;
/** Max edit dispatches per window per project. */
export const MAX_EDITS_PER_WINDOW = 5;
/** Max chat messages per window per project. */
export const MAX_CHAT_MESSAGES_PER_WINDOW = 30;
/** Cap on how many prior conversation turns the planner sees. */
export const PLANNER_MAX_TURNS = 12;
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

export interface EvaluateEditBudgetInput {
  now: number;
  recentEditCreatedAts: string[];
  recentMessageCreatedAts: string[];
}

export type EditBudgetResult =
  | { ok: true }
  | { ok: false; code: "rate_limited_edits" | "rate_limited_messages"; reason: string };

export function evaluateEditBudget(input: EvaluateEditBudgetInput): EditBudgetResult {
  const cutoff = input.now - EDIT_RATE_WINDOW_MS;
  const inWindow = (ats: string[]) => ats.filter((a) => Date.parse(a) >= cutoff).length;

  if (inWindow(input.recentEditCreatedAts) >= MAX_EDITS_PER_WINDOW) {
    return {
      ok: false,
      code: "rate_limited_edits",
      reason: "You've started several edits very recently. Give the current ones a moment to finish.",
    };
  }
  if (inWindow(input.recentMessageCreatedAts) >= MAX_CHAT_MESSAGES_PER_WINDOW) {
    return {
      ok: false,
      code: "rate_limited_messages",
      reason: "You're sending messages too quickly. Please slow down.",
    };
  }
  return { ok: true };
}

/**
 * DB-reading wrapper. Throws EditBudgetError on exceed. Uses the admin client
 * (the caller has already RLS-verified project membership).
 *
 * Both `workspace_edits` and `chat_messages` carry `project_id` directly, so
 * we query each table independently — no join needed.
 */
export async function assertEditBudget(args: { projectId: string }): Promise<void> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - EDIT_RATE_WINDOW_MS).toISOString();
  const [
    { data: edits, error: editsError },
    { data: messages, error: messagesError },
  ] = await Promise.all([
    supabase
      .from("workspace_edits")
      .select("created_at")
      .eq("project_id", args.projectId)
      .gte("created_at", since),
    supabase
      .from("chat_messages")
      .select("created_at")
      .eq("project_id", args.projectId)
      .gte("created_at", since),
  ]);
  if (editsError) throw editsError;
  if (messagesError) throw messagesError;
  const result = evaluateEditBudget({
    now: Date.now(),
    recentEditCreatedAts: (edits ?? []).map((e) => (e as { created_at: string }).created_at),
    recentMessageCreatedAts: (messages ?? []).map((m) => (m as { created_at: string }).created_at),
  });
  if (!result.ok) throw new EditBudgetError(result.code, result.reason);
}
