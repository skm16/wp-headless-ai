// NOTE: deliberately NOT "server-only". Pure env-var → model-ID resolution;
// model IDs are not secrets. Imported by scripts/debug-shell-llm.ts under
// tsx, where the server-only marker package is unresolvable.

/**
 * Per-task model selection for Anthropic calls.
 *
 * Tasks (one per distinct LLM call site):
 *   - `design`             — scrape-agent design-tokens pass (bounded JSON)
 *   - `codegen`            — page-code rebuild (no live call site yet)
 *   - `component-visual`   — Phase B visual-tier block components (vision)
 *   - `component-standard` — Phase B standard-tier block components
 *   - `component-trivial`  — Phase B trivial-tier scaffolds (cheap tier)
 *   - `shell`              — Phase C Header/Footer generation
 *   - `planner`            — chat-edit planner (edit-planner.ts; wired Phase 5)
 *   - `fidelity-vision`    — Phase E vision fidelity scoring (wired Phase 7)
 *
 * (The former `content` task — the scrape-agent content-brief pass — was
 * deleted with its call site in the Stage 0 v2 teardown and is gone from
 * this registry as of the 2026-06-10 AI-call-optimization campaign.)
 *
 * Env precedence (first match wins):
 *   1. `JAB_AI_MODEL_<TASK>` per-task override — see `envKeyFor()`; hyphens
 *      in the task name become underscores (`JAB_AI_MODEL_COMPONENT_VISUAL`).
 *   2. `JAB_AI_MODEL` legacy global override — kept for compatibility, but
 *      it now logs one console.warn line whenever it moves a task off its
 *      default (an operator pinning the global to upgrade codegen must not
 *      silently move the Haiku design pass to a pricier tier).
 *   3. `DEFAULTS[task]` below.
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
  "claude-opus-4-8",
] as const;
export type AllowedModel = (typeof ALLOWED)[number];

const TASKS = [
  "design",
  "codegen",
  "component-visual",
  "component-standard",
  "component-trivial",
  "shell",
  "planner",
  "fidelity-vision",
] as const;
export type AiTask = (typeof TASKS)[number];

/**
 * Per-task model defaults.
 *
 * `design` runs on Haiku 4.5 (deterministic-first refocus, 2026-05-25,
 * `docs/ai-prompt-modes.md` §10.0) with a Sonnet escalation inside
 * scrape-agent on output failure. Component tiers mirror the design-doc
 * §6.4 table previously hardcoded in model-client.ts. `shell` matches the
 * visual tier. `planner` and `fidelity-vision` default to Sonnet pending
 * the Phase 5/7 cheap-tier trials.
 */
const DEFAULTS: Record<AiTask, AllowedModel> = {
  design: "claude-haiku-4-5-20251001",
  codegen: "claude-sonnet-4-6",
  "component-visual": "claude-sonnet-4-6",
  "component-standard": "claude-sonnet-4-6",
  "component-trivial": "claude-haiku-4-5-20251001",
  shell: "claude-sonnet-4-6",
  planner: "claude-sonnet-4-6",
  "fidelity-vision": "claude-sonnet-4-6",
};

/**
 * Env-var key for a task's per-task override. Hyphens map to underscores —
 * `component-visual` → `JAB_AI_MODEL_COMPONENT_VISUAL`. (The previous bare
 * `task.toUpperCase()` produced `JAB_AI_MODEL_COMPONENT-VISUAL`, a name
 * POSIX shells and Vercel's env UI reject — the override surface for every
 * hyphenated task was unreachable.)
 */
export function envKeyFor(task: AiTask): string {
  return "JAB_AI_MODEL_" + task.toUpperCase().replace(/-/g, "_");
}

function validate(raw: string, source: string): AllowedModel {
  if ((ALLOWED as readonly string[]).includes(raw)) {
    return raw as AllowedModel;
  }
  throw new Error(
    `${source}="${raw}" is not in the allowed list (${ALLOWED.join(", ")}). Fix the env var or remove it.`,
  );
}

/**
 * Once-per-process dedupe for the legacy-global warn — getModelFor became a
 * hot path when modelClientForTier started resolving through it (one call
 * per block type per build); one line per distinct task:model migration is
 * signal, one per resolution is noise.
 */
const warnedLegacyGlobal = new Set<string>();

export function __resetLegacyGlobalWarnForTests(): void {
  warnedLegacyGlobal.clear();
}

export function getModelFor(task: AiTask): AllowedModel {
  // `!== undefined` (not truthiness): an explicit empty string from the env
  // is treated as a set-but-invalid value and goes to `validate`, which
  // throws. Falling through to the next tier on `""` would let an operator
  // who blanks a per-task var to "restore the default" silently land on the
  // legacy global instead — exactly the opposite of what the doc promises.
  const perTaskKey = envKeyFor(task);
  const perTaskRaw = process.env[perTaskKey];
  if (perTaskRaw !== undefined) return validate(perTaskRaw, perTaskKey);

  const globalRaw = process.env.JAB_AI_MODEL;
  if (globalRaw !== undefined) {
    const resolved = validate(globalRaw, "JAB_AI_MODEL");
    if (resolved !== DEFAULTS[task]) {
      const dedupeKey = `${task}:${resolved}`;
      if (!warnedLegacyGlobal.has(dedupeKey)) {
        warnedLegacyGlobal.add(dedupeKey);
        console.warn(
          `[model] legacy JAB_AI_MODEL override active: task "${task}" default ${DEFAULTS[task]} → ${resolved} (set ${perTaskKey} to scope this per task)`,
        );
      }
    }
    return resolved;
  }

  return DEFAULTS[task];
}
