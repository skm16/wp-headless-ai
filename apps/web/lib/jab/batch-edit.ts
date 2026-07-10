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
