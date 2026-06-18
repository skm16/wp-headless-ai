/**
 * workspace-edit-validation — non-async exports for the workspace-edit
 * server action. Lives outside the "use server" file because Next.js
 * forbids non-async exports from server-action modules.
 */

export type WorkspaceEditScope = "component" | "shell" | "tokens";

/**
 * Unbounded prompts flow into DB rows and the generator LLM — cap them.
 * regenerationPrompt is not separately capped — chat-path values are planner
 * output bounded by max_tokens, and the manual path falls back to this capped prompt.
 */
export const MAX_PROMPT_CHARS = 4000;

export class WorkspaceEditError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "source_not_ready"
      | "invalid_scope"
      | "invalid_target"
      | "prompt_too_short"
      | "prompt_too_long"
      | "page_scope_unsupported"
      | "active_build"
      | "edit_in_review"
      | "dispatch_failed",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceEditError";
  }
}

export interface ValidateEditInputArgs {
  scope: WorkspaceEditScope;
  target: string;
  prompt: string;
  /** When set, used in place of `scope` for branch coverage in tests. */
  rawScope?: string;
}

export function validateEditInput(input: ValidateEditInputArgs): void {
  const scopeValue = input.rawScope ?? input.scope;
  if (scopeValue === "page") {
    throw new WorkspaceEditError(
      "page_scope_unsupported",
      "scope='page' is not supported in v1. Use scope='component' or 'shell'.",
    );
  }
  if (scopeValue === "tokens") {
    // A tokens edit has no block target — `target` is a free label and the
    // structured TokenDelta was validated upstream by validateEditPlan. Skip the
    // target checks; the prompt-length checks below still apply (the user's NL
    // message flows as the prompt).
  } else if (scopeValue !== "component" && scopeValue !== "shell") {
    throw new WorkspaceEditError(
      "invalid_scope",
      `scope must be 'component', 'shell', or 'tokens' (got '${scopeValue}').`,
    );
  } else if (input.scope === "shell" && input.target !== "header" && input.target !== "footer") {
    throw new WorkspaceEditError(
      "invalid_target",
      `For scope='shell', target must be 'header' or 'footer' (got '${input.target}').`,
    );
  } else if (input.scope === "component" && !input.target.trim()) {
    throw new WorkspaceEditError(
      "invalid_target",
      "For scope='component', target must be a non-empty block name.",
    );
  }
  if (!input.prompt || input.prompt.trim().length < 5) {
    throw new WorkspaceEditError(
      "prompt_too_short",
      "prompt must be at least 5 characters.",
    );
  }
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    throw new WorkspaceEditError(
      "prompt_too_long",
      `Prompt is too long (${input.prompt.length} chars; max ${MAX_PROMPT_CHARS}).`,
    );
  }
}
