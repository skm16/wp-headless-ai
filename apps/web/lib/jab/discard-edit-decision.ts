/**
 * discard-edit-decision — pure refusal rule for discardEditAction (§3.4).
 * Discarding a PROMOTED edit would be a re-promote of the prior production
 * deployment — out of scope (§6). Refuse it; everything else can be discarded.
 */
export interface DiscardDecisionInput {
  resultPromotedDeploymentId: string | null;
  resultBuildId: string | null;
}
export type DiscardDecision =
  | { ok: true; resultBuildId: string | null }
  | { ok: false; code: "already_promoted"; reason: string };

export function evaluateDiscard(input: DiscardDecisionInput): DiscardDecision {
  if (input.resultPromotedDeploymentId) {
    return {
      ok: false,
      code: "already_promoted",
      reason:
        "This edit is already live in production. Reverting a promoted edit isn't supported yet.",
    };
  }
  return { ok: true, resultBuildId: input.resultBuildId };
}
