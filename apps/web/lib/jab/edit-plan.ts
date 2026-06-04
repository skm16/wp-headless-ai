import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import type { SiteMap } from "./site-map";

/**
 * edit-plan — the structured output of the planner LLM (spec §3.3). The plan
 * is the ONLY thing the model produces: a constrained scope enum, a target
 * validated against the real inventory, an action summary (states the blast
 * radius — R1), and a regenerationPrompt threaded into the generator. The
 * model can never name a file, path, or tool (prompt-injection containment).
 */

export interface EditPlan {
  /** True → ask the user a question, run no edit. */
  needsClarification: boolean;
  scope: WorkspaceEditScope;
  /** block_name (component) or "header"|"footer" (shell). Ignored when needsClarification. */
  target: string;
  /** Human summary stating the real blast radius, e.g. "Regenerated the Hero on 3 pages". */
  action: string;
  /** Guidance threaded into the generator. */
  regenerationPrompt: string;
  /** The question to show when needsClarification; null otherwise. */
  clarifyingQuestion: string | null;
}

/** The Anthropic tool-use input schema the planner is constrained to. */
export const EDIT_PLAN_TOOL_SCHEMA = {
  name: "emit_edit_plan",
  description:
    "Emit a structured plan for the user's requested edit, OR ask a clarifying question when the target is ambiguous or the request is too vague to act on.",
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
        type: ["string", "null"],
        description: "The question to ask the user. Required when needsClarification, null otherwise.",
      },
    },
    required: ["needsClarification", "scope", "target", "action", "regenerationPrompt"],
    additionalProperties: false,
  },
} as const;

export type ValidateEditPlanResult =
  | { ok: true }
  | {
      ok: false;
      code: "unknown_target" | "invalid_shell_target" | "shell_absent" | "empty_guidance";
      reason: string;
    };

export function validateEditPlan(plan: EditPlan, siteMap: SiteMap): ValidateEditPlanResult {
  // A clarifying plan is always valid — it runs no edit.
  if (plan.needsClarification) return { ok: true };

  if (!plan.regenerationPrompt || !plan.regenerationPrompt.trim()) {
    return { ok: false, code: "empty_guidance", reason: "The plan has no regeneration guidance." };
  }

  if (plan.scope === "shell") {
    if (plan.target !== "header" && plan.target !== "footer") {
      return {
        ok: false,
        code: "invalid_shell_target",
        reason: `Shell edits target 'header' or 'footer' (got '${plan.target}').`,
      };
    }
    const present = plan.target === "header" ? siteMap.shell.header : siteMap.shell.footer;
    if (!present) {
      return {
        ok: false,
        code: "shell_absent",
        reason: `This site has no ${plan.target}.`,
      };
    }
    return { ok: true };
  }

  // scope === "component": target must be a real block name.
  const known = siteMap.blockTypes.some((b) => b.blockName === plan.target);
  if (!known) {
    return {
      ok: false,
      code: "unknown_target",
      reason: `'${plan.target}' is not a block on this site.`,
    };
  }
  return { ok: true };
}
