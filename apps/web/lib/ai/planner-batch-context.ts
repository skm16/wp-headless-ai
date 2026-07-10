import { coerceBatchState } from "@/lib/jab/batch-edit";

/**
 * Surface an in-progress batch to the planner. loadPlannerMessages sends the
 * planner a plain (role, content) list; the structured plan.batch never reaches
 * it, so after stableHeadSlice trims the original cross-cutting request the
 * shared guidance drifts (adversarial finding C). We append a compact,
 * machine-readable batch line to the assistant turn's content so the planner
 * reconstructs remaining + guidance structurally, even post-trim.
 *
 * `editFailed` (re-adversarial residual 2): the apply-turn echo is written
 * OPTIMISTICALLY with the just-attempted block already excluded from
 * `remaining`. If that edit later FAILED, the planner — which only sees text —
 * would read the echo as success and silently advance past a broken block,
 * falsely reporting the batch complete. When the linked edit failed we append
 * an explicit failure directive naming the block (the plan's `target`) so the
 * planner re-drives it instead of skipping it. No schema change — still a plain
 * message.
 */
export function appendBatchContext(
  content: string,
  plan: unknown,
  opts?: { editFailed?: boolean },
): string {
  if (!plan || typeof plan !== "object") return content;
  const p = plan as Record<string, unknown>;
  const batch = coerceBatchState(p.batch);
  if (!batch || batch.remaining.length === 0) return content;
  const base = `${content}\n\n[batch in progress — remaining blocks: ${batch.remaining.join(", ")} | shared change: ${batch.guidance}]`;
  if (opts?.editFailed) {
    const failedBlock = typeof p.target === "string" && p.target ? p.target : "the last block";
    return `${base}\n[NOTE: the edit for "${failedBlock}" FAILED — it was NOT applied. Retry "${failedBlock}" with the shared change before moving to the remaining blocks.]`;
  }
  return base;
}
