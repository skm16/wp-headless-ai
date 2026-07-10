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
