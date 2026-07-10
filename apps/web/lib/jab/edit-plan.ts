import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import type { SiteMap } from "./site-map";
import { validateTokenDelta, type TokenDelta } from "./token-override";
import type { BatchEditState } from "./batch-edit";

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
  /** Structured brand-token change for scope="tokens"; null otherwise. */
  tokenDelta: TokenDelta | null;
  /**
   * Version-control intent, INDEPENDENT of scope. Non-null means the user asked
   * to revert/undo — the request is routed to the revert actions, NOT a forward
   * edit. "undo_last" = undo the most recent edit; "to_version" = revert to
   * revertVersion. null for every forward edit / clarification.
   */
  revertIntent: "undo_last" | "to_version" | null;
  /** The 1-based edit ordinal for revertIntent="to_version"; null otherwise. */
  revertVersion: number | null;
  /**
   * Cross-cutting multi-block change state (spec 2026-07-10). Non-null when the
   * planner is proposing or applying a set of blocks that share one style
   * change: `remaining` is the ordered block_names still to edit, `guidance` is
   * the shared instruction. null for every ordinary single edit / clarify /
   * revert / token change — the queue lives in conversation history, this field
   * only makes it machine-readable for the UI + echo.
   */
  batch: BatchEditState | null;
}

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
      scope: { type: "string", enum: ["component", "shell", "tokens"] },
      target: {
        type: "string",
        description:
          "For scope=component: the exact block_name from the site map. For scope=shell: 'header' or 'footer'. Empty string when needsClarification.",
      },
      action: {
        type: "string",
        description:
          "One sentence stating exactly what changes and the blast radius using the page count EXACTLY as shown for the target in the unit list — copy its wording verbatim, INCLUDING the 'at least N' phrasing when the list uses it (that count is capped and the true number may be higher). e.g. 'Regenerate the Cover block — this changes it on every page that uses it (3 pages).' NEVER invent, round, or drop the 'at least' from a number the list does not state plainly.",
      },
      regenerationPrompt: {
        type: "string",
        description: "Concrete instructions passed to the component/shell generator. Empty when needsClarification.",
      },
      clarifyingQuestion: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "The question to ask the user. Required when needsClarification, null otherwise.",
      },
      tokenDelta: {
        anyOf: [
          {
            type: "object",
            properties: {
              colors: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, color: { type: "string" } }, required: ["slug", "color"], additionalProperties: false } },
              fontFamilies: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, fontFamily: { type: "string" } }, required: ["slug", "fontFamily"], additionalProperties: false } },
              fontSizes: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, size: { type: "string" } }, required: ["slug", "size"], additionalProperties: false } },
            },
            additionalProperties: false,
          },
          { type: "null" },
        ],
        description:
          "For scope=tokens ONLY: the brand-token change. colors[].color is a CSS color (e.g. #c00); fontFamilies[].fontFamily is a family name; fontSizes[].size is a CSS length. Use the EXACT slugs from the site map's design-tokens list (e.g. 'primary', 'heading', 'body'). null for component/shell/clarification.",
      },
      revertIntent: {
        anyOf: [{ type: "string", enum: ["undo_last", "to_version"] }, { type: "null" }],
        description:
          "Set ONLY when the user asks to revert/undo (e.g. 'undo that', 'go back', 'revert to version 10'). 'undo_last' undoes the most recent edit; 'to_version' reverts to the edit number in revertVersion. null for every forward edit and clarification. When set, leave scope='component', target='', regenerationPrompt='' — they are ignored.",
      },
      revertVersion: {
        anyOf: [{ type: "number" }, { type: "null" }],
        description:
          "For revertIntent='to_version': the version/edit number the user named (e.g. 10). null otherwise.",
      },
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
    },
    required: [
      "needsClarification",
      "scope",
      "target",
      "action",
      "regenerationPrompt",
      "clarifyingQuestion",
      "tokenDelta",
      "revertIntent",
      "revertVersion",
      "batch",
    ],
    additionalProperties: false,
  },
} as const;

export type ValidateEditPlanResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "unknown_target"
        | "invalid_shell_target"
        | "shell_absent"
        | "empty_guidance"
        | "invalid_token_delta"
        | "unsafe_action";
      reason: string;
    };

// action is free text the model composes for direct chat display (chat-turn-outcome's
// assistantText) — unlike target/regenerationPrompt/tokenDelta, nothing else constrains
// its content. A strict tool-use grammar only guarantees "valid JSON string", not "safe to
// render as chat" — a model can still emit literal tool-call-style markup as the string's
// value, which must never reach the user verbatim.
const TOOL_MARKUP_PATTERN = /<\/?(?:invoke|parameter|function_calls|antml:invoke|antml:parameter)\b/i;

export function validateEditPlan(plan: EditPlan, siteMap: SiteMap): ValidateEditPlanResult {
  // A clarifying plan is always valid — it runs no edit.
  if (plan.needsClarification) return { ok: true };

  if (TOOL_MARKUP_PATTERN.test(plan.action)) {
    return {
      ok: false,
      code: "unsafe_action",
      reason: "The plan's summary contained unexpected formatting.",
    };
  }

  // scope="tokens" is a deterministic apply — it has no regenerationPrompt and
  // no block target; the TokenDelta is the whole edit, so validate it here
  // (BEFORE the empty_guidance check, which tokens deliberately skip).
  if (plan.scope === "tokens") {
    const v = validateTokenDelta(plan.tokenDelta);
    if (!v.ok) return { ok: false, code: "invalid_token_delta", reason: v.reason };
    return { ok: true };
  }

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
