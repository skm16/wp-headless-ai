import type { EditPlan } from "./edit-plan";
import { validateEditPlan } from "./edit-plan";
import type { SiteMap } from "./site-map";
import type { BatchEditState } from "./batch-edit";

/**
 * chat-turn-outcome — pure branch for a planned chat turn (§3.3 step 7).
 * A clarifying plan OR a validation failure → ask a question, run no edit.
 * An actionable+valid plan → run the edit.
 */
export type ChatTurnOutcome =
  | { kind: "clarify"; message: string; plan: EditPlan; batch: BatchEditState | null }
  | { kind: "edit"; assistantText: string; plan: EditPlan; batch: BatchEditState | null }
  | { kind: "revert"; intent: "undo_last" | "to_version"; version: number | null; plan: EditPlan };

function candidateList(siteMap: SiteMap): string {
  const blocks = siteMap.blockTypes.map((b) => `${b.label} (${b.blockName})`);
  const shells = [
    siteMap.shell.header ? "header" : null,
    siteMap.shell.footer ? "footer" : null,
  ].filter(Boolean);
  return [...blocks, ...shells].join(", ");
}

export function decideChatTurnOutcome(plan: EditPlan, siteMap: SiteMap): ChatTurnOutcome {
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
  // Revert intent is not a forward edit — route it before any block/token
  // validation (those checks are irrelevant to a version rollback).
  if (plan.revertIntent) {
    return { kind: "revert", intent: plan.revertIntent, version: plan.revertVersion, plan };
  }

  const valid = validateEditPlan(plan, siteMap);
  if (!valid.ok) {
    return {
      kind: "clarify",
      plan,
      // A validation-failure clarify is an ERROR bubble, NOT a batch propose:
      // an apply turn whose target isn't a real block gets surfaced here. If it
      // kept plan.batch, the persisted bubble would be byte-identical to a
      // genuine propose and render a spurious "Apply to all" chip that re-drives
      // the failure (re-adversarial residual 1). Only a planner-set
      // needsClarification (the propose branch above) carries batch.
      batch: null,
      message: `${valid.reason} I can edit: ${candidateList(siteMap)}. Which did you mean?`,
    };
  }
  return { kind: "edit", plan, batch: plan.batch, assistantText: plan.action };
}
