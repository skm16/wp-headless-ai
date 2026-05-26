import "server-only";

/**
 * Per-task model selection for Anthropic calls.
 *
 * Tasks (one per distinct LLM call site):
 *   - `content` — scrape-agent content-brief pass (extractive markdown)
 *   - `design`  — scrape-agent design-tokens pass (bounded JSON)
 *   - `codegen` — page-code rebuild (Phase 2/3; no live call site yet)
 *
 * Env precedence (first match wins):
 *   1. `JAB_AI_MODEL_<TASK>` per-task override (e.g. `JAB_AI_MODEL_CONTENT`)
 *   2. `JAB_AI_MODEL` legacy global override
 *   3. `DEFAULTS[task]` below
 *
 * Allowed model IDs are pinned so a typo in Vercel's env-var UI fails fast
 * instead of silently dispatching to a non-existent model.
 *
 * Resolution is per-call (not eager at import) so tests can mutate
 * `process.env` between calls without restarting the module.
 */

const ALLOWED = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
] as const;
export type AllowedModel = (typeof ALLOWED)[number];

const TASKS = ["content", "design", "codegen"] as const;
export type AiTask = (typeof TASKS)[number];

/**
 * Per-task model defaults.
 *
 * `content` + `design` ran on Sonnet through 2026-05-25 then flipped to
 * Haiku 4.5 as part of the deterministic-first refocus (step 4,
 * `docs/ai-prompt-modes.md` §10.0). Both passes are extractive /
 * bounded-JSON work — well within Haiku's comfort zone, ~4× cheaper.
 * `scrape-agent.ts` falls back to Sonnet automatically on output-failure
 * (empty markdown, malformed JSON, schema-validation miss) so a Haiku
 * miss never silently ships bad data.
 *
 * `codegen` is a placeholder until the page-code rebuild lands.
 */
const DEFAULTS: Record<AiTask, AllowedModel> = {
  content: "claude-haiku-4-5-20251001",
  design: "claude-haiku-4-5-20251001",
  codegen: "claude-sonnet-4-6",
};

function validate(raw: string, source: string): AllowedModel {
  if ((ALLOWED as readonly string[]).includes(raw)) {
    return raw as AllowedModel;
  }
  throw new Error(
    `${source}="${raw}" is not in the allowed list (${ALLOWED.join(", ")}). Fix the env var or remove it.`,
  );
}

export function getModelFor(task: AiTask): AllowedModel {
  // `!== undefined` (not truthiness): an explicit empty string from the env
  // is treated as a set-but-invalid value and goes to `validate`, which
  // throws. Falling through to the next tier on `""` would let an operator
  // who blanks a per-task var to "restore the default" silently land on the
  // legacy global instead — exactly the opposite of what the doc promises.
  const perTaskKey = `JAB_AI_MODEL_${task.toUpperCase()}`;
  const perTaskRaw = process.env[perTaskKey];
  if (perTaskRaw !== undefined) return validate(perTaskRaw, perTaskKey);

  const globalRaw = process.env.JAB_AI_MODEL;
  if (globalRaw !== undefined) return validate(globalRaw, "JAB_AI_MODEL");

  return DEFAULTS[task];
}
