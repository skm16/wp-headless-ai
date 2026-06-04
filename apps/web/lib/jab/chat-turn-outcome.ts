import type { EditPlan } from "./edit-plan";
import { validateEditPlan } from "./edit-plan";
import type { SiteMap } from "./site-map";

/**
 * chat-turn-outcome — pure branch for a planned chat turn (§3.3 step 7).
 * A clarifying plan OR a validation failure → ask a question, run no edit.
 * An actionable+valid plan → run the edit.
 */
export type ChatTurnOutcome =
  | { kind: "clarify"; message: string; plan: EditPlan }
  | { kind: "edit"; assistantText: string; plan: EditPlan };

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
      message:
        plan.clarifyingQuestion?.trim() ||
        `Could you tell me which part to change? I can edit: ${candidateList(siteMap)}.`,
    };
  }
  const valid = validateEditPlan(plan, siteMap);
  if (!valid.ok) {
    return {
      kind: "clarify",
      plan,
      message: `${valid.reason} I can edit: ${candidateList(siteMap)}. Which did you mean?`,
    };
  }
  return { kind: "edit", plan, assistantText: plan.action };
}
