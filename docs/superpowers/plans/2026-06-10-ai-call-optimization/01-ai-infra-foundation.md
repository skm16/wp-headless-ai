# Phase 1: AI Infra Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared AI infrastructure every later phase builds on — a typed Anthropic error classifier, a corrected model registry (hyphen-safe env keys, current model lineup, one task per call site), a `ModelClient` v2 that surfaces `stopReason` + ground-truth `model` and supports a real cached system prefix, migration 0034's cost-telemetry columns, and the telemetry-math fix that stops double-subtracting cache reads.

**Architecture:** `apps/web/lib/ai/model-client.ts` becomes the single request-construction point for component/shell generation: it takes an optional `cachedSystemPrefix` (rendered as the first system block with `cache_control`), resolves models through `lib/ai/model.ts` `getModelFor()`, borrows the process-wide SDK singleton from `lib/ai/client.ts`, and memoizes per-(model, maxTokens) client instances. A new `lib/ai/errors.ts` classifies SDK errors into a persistable `AiFailureKind`. Migration `0034_ai_cost_telemetry.sql` (+ mirrored drizzle `schema.ts` columns) adds `input_tokens_cache_creation`, `failure_kind`, and the Phase-4 carry-forward columns; `persist-generation.ts` / `persist-shell-generation.ts` write the corrected token math. Phase 1 deliberately does NOT restructure prompts (Phase 2) — callers pass `cachedSystemPrefix: undefined` so request bytes stay functionally equivalent to today (the old `cache_control` marker was a silent no-op below the cacheable minimum, so dropping it changes nothing billable).

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 1 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: none.

---

## Verified current state (read 2026-06-10, branch `feat/saas-e2e-loop`)

All line numbers below were verified by reading the files; trust these over the audit digest.

- `apps/web/lib/ai/model-client.ts` — `GenerateOptions.cacheSystemPrompt: boolean` at :39; `AnthropicModelClientOptions.model` is the literal union `"claude-sonnet-4-6" | "claude-haiku-4-5-20251001"` at :49; constructor news up `new Anthropic({ apiKey })` at :63; `generate()` at :68–115 with the manual usage cast at :99–104 and **no** `stop_reason` read; `modelClientForTier` at :189–209 hardcodes the per-tier model table (never consults `getModelFor`) and constructs a fresh `AnthropicModelClient` per call.
- `apps/web/lib/ai/model.ts` — `ALLOWED` at :23–27 pins stale `claude-opus-4-7`; `TASKS` at :30 still carries the dead `"content"` task (zero call sites — `getModelFor` is only called at `scrape-agent.ts:240` with `"design"`); env key built at :70 via `task.toUpperCase()` with **no hyphen mapping** (yields invalid `JAB_AI_MODEL_COMPONENT-VISUAL`); legacy global `JAB_AI_MODEL` honored silently at :74–75.
- `apps/web/lib/ai/client.ts` — `getAnthropicClient()` singleton at :21–31 (only consumer today: `scrape-agent.ts`).
- `apps/web/lib/ai/component-generator.ts` — hardcoded telemetry model at :704–706; `client.generate({ ..., cacheSystemPrompt: attempt === 0, ... })` at :737–742; usage accumulators :748–751; success return :783–794; failure return :797–808. `GeneratedComponent` interface at :35–46.
- `apps/web/lib/ai/generate-shell.ts` — `cacheSystemPrompt: attempt === 0` at :137; hardcoded `modelUsed: "claude-sonnet-4-6"` at :180 (success) and :197 (failure); accumulators at :124–128.
- `apps/web/lib/ai/persist-generation.ts` — telemetry math bug at :76: `input_tokens_uncached: component.inputTokens - component.cacheReadTokens` (the API's `input_tokens` is ALREADY the uncached remainder); `cacheCreationTokens` accumulated by callers but never persisted.
- `apps/web/lib/ai/persist-shell-generation.ts` — same bug at :113.
- `apps/web/lib/ai/edit-planner.ts` — defines its OWN `PlannerUsage`/`PlannerClient` types and imports `Anthropic` directly; it shares **no** types with `model-client.ts`, so nothing in this phase touches it (Phase 5 does).
- `apps/web/lib/ai/model-client.test.ts` — module-mocks the whole SDK and never asserts request construction; all four `generate()` calls pass `cacheSystemPrompt: false`.
- **No `model.test.ts` exists anywhere in apps/web** (verified by glob) — Task 2 creates it.
- `apps/web/lib/db/schema.ts` — `projects` at :60–100 (last data column `contentOwnership` at :96), `blockInventory` at :243–288 (last data column `spec` at :280), `shellGenerations` at :431–455 (last data column `compileAttemptCount` at :448).
- `apps/web/drizzle/migrations/` — latest migration is `0033_page_inventory_link.sql`, so **0034** is the next number. Table names verified: `public.block_inventory` (0014, has `input_tokens_cached`/`input_tokens_uncached`/`output_tokens`/`model_used`), `public.shell_generations` (0021, same columns), `public.projects` (0000), `public.site_builds` (0014).
- `apps/web/package.json` — test script is `"test": "vitest run"`; typecheck is `"typecheck": "tsc --noEmit"`. **All commands in this plan run from `apps/web/`.** Vitest does not typecheck (esbuild transform), so every task ends with `pnpm typecheck` before commit.
- `apps/web/vitest.config.ts` — `server-only` is mocked via `vitest.setup.ts`; `@` aliases to `apps/web`.
- TypeScript is ^5.5 — inferred type predicates make `response.content.find((b) => b.type === "text")?.text` compile without a cast (the existing code relies on this; keep the pattern).
- `Tier` type (`apps/web/lib/jab/inventory.ts:73`): `"trivial" | "standard" | "visual" | "passthrough"`.
- Other `ModelClient` consumers verified by grep: only `component-generator.ts`, `generate-shell.ts`, `compose-site.ts` (via `modelClientForTier("visual")` — signature unchanged, no edit needed), and the two test files' fakes.

## File structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `apps/web/lib/ai/errors.ts` | `AiFailureKind` union + `classifyAiError()` instanceof ladder + `isRetryableAiFailure()` |
| Create | `apps/web/lib/ai/errors.test.ts` | Classifier unit tests (prototype-injection fakes, no network) |
| Modify | `apps/web/lib/ai/model.ts` | `envKeyFor()` hyphen fix, ALLOWED refresh (opus-4-8), TASKS update (drop `content`, add `shell`/`planner`/`fidelity-vision`), DEFAULTS, legacy-global warn |
| Create | `apps/web/lib/ai/model.test.ts` | Registry tests: env-key building, override precedence, allow-list, warn behavior |
| Modify | `apps/web/.env.local.example` | Document the new task list + corrected env key names |
| Modify | `apps/web/lib/ai/model-client.ts` | v2 contract: `cachedSystemPrefix`, `stopReason`+`model` in `GenerateResult`, SDK singleton + injectable `sdk`, `COMPONENT_TASK_BY_TIER`, memoized `modelClientForTier`, `__resetModelClientCacheForTests` |
| Rewrite | `apps/web/lib/ai/model-client.test.ts` | Request-construction assertions via injected fake SDK |
| Modify | `apps/web/lib/ai/component-generator.ts` | Drop `cacheSystemPrompt`; persist ground-truth `result.model` |
| Modify | `apps/web/lib/ai/generate-shell.ts` | Drop `cacheSystemPrompt`; persist ground-truth `result.model` |
| Modify | `apps/web/lib/ai/component-generator.test.ts` | Fake client returns `model`/`stopReason`; ground-truth telemetry tests |
| Modify | `apps/web/lib/ai/generate-shell.test.ts` | Same for the shell fake |
| Create | `apps/web/drizzle/migrations/0034_ai_cost_telemetry.sql` | New telemetry + carry-forward columns (block_inventory, shell_generations, projects) |
| Modify | `apps/web/lib/db/schema.ts` | Mirror 0034 columns in drizzle schema |
| Create | `apps/web/lib/db/schema-ai-telemetry.test.ts` | Pin the new column names/SQL mapping |
| Modify | `apps/web/lib/ai/persist-generation.ts` | Math fix + `input_tokens_cache_creation` + `failure_kind` (nullable arg) |
| Modify | `apps/web/lib/ai/persist-shell-generation.ts` | Same for shells |
| Modify | `apps/web/lib/ai/persist-generation.test.ts` | Payload assertions via mocked admin client |
| Modify | `apps/web/lib/ai/persist-shell-generation.test.ts` | Same for shells |

Task order matters: Task 3 depends on Task 2 (new `AiTask` values); Task 4 depends on Task 3; Task 6 depends on Tasks 1 and 5.

---

### Task 1: Typed Anthropic error classifier (`lib/ai/errors.ts`)

**Files:**
- Create: `apps/web/lib/ai/errors.ts`
- Create: `apps/web/lib/ai/errors.test.ts`

The classifier is a pure function over SDK error classes. It deliberately does NOT import `"server-only"` — it holds no secrets and later phases (smoke scripts, batch tooling) may import it from `tsx` scripts.

- [ ] **Verify the SDK exports the error classes we ladder on** (sanity check before writing code; `@anthropic-ai/sdk` is pinned `^0.95.1`):

  ```powershell
  node -e "const A=require('@anthropic-ai/sdk'); console.log(['RateLimitError','OverloadedError','AuthenticationError','PermissionDeniedError','BadRequestError','APIConnectionError','InternalServerError','APIError'].map(n=>n+'='+typeof A[n]).join('\n'))"
  ```

  Expected: every line ends in `=function`. **Fallback if `OverloadedError=undefined`:** replace that one instanceof check with `err instanceof Anthropic.APIError && err.status === 529` placed at the same position in the ladder, and report the deviation in your task summary.

- [ ] Write the failing test — create `apps/web/lib/ai/errors.test.ts` with exactly:

  ```ts
  import { describe, it, expect } from "vitest";
  import Anthropic from "@anthropic-ai/sdk";
  import { classifyAiError, isRetryableAiFailure, type AiFailureKind } from "./errors";

  /**
   * Build an `instanceof`-true instance WITHOUT invoking the SDK error
   * constructor (its signature varies across SDK versions; prototype
   * injection is stable across all of them).
   */
  function fakeInstance<T extends abstract new (...args: never[]) => unknown>(cls: T): InstanceType<T> {
    return Object.create(cls.prototype) as InstanceType<T>;
  }

  describe("classifyAiError", () => {
    it("classifies RateLimitError as rate_limit", () => {
      expect(classifyAiError(fakeInstance(Anthropic.RateLimitError))).toBe("rate_limit");
    });

    it("classifies OverloadedError (529) as overloaded", () => {
      expect(classifyAiError(fakeInstance(Anthropic.OverloadedError))).toBe("overloaded");
    });

    it("classifies AuthenticationError and PermissionDeniedError as auth", () => {
      expect(classifyAiError(fakeInstance(Anthropic.AuthenticationError))).toBe("auth");
      expect(classifyAiError(fakeInstance(Anthropic.PermissionDeniedError))).toBe("auth");
    });

    it("classifies BadRequestError as bad_request", () => {
      expect(classifyAiError(fakeInstance(Anthropic.BadRequestError))).toBe("bad_request");
    });

    it("classifies APIConnectionError as connection", () => {
      expect(classifyAiError(fakeInstance(Anthropic.APIConnectionError))).toBe("connection");
    });

    it("classifies InternalServerError as server_error", () => {
      expect(classifyAiError(fakeInstance(Anthropic.InternalServerError))).toBe("server_error");
    });

    it("classifies a bare APIError as unknown", () => {
      expect(classifyAiError(fakeInstance(Anthropic.APIError))).toBe("unknown");
    });

    it("classifies non-Anthropic values as unknown", () => {
      expect(classifyAiError(new Error("boom"))).toBe("unknown");
      expect(classifyAiError("string error")).toBe("unknown");
      expect(classifyAiError(undefined)).toBe("unknown");
      expect(classifyAiError(null)).toBe("unknown");
    });
  });

  describe("isRetryableAiFailure", () => {
    it("marks rate_limit / overloaded / server_error / connection retryable", () => {
      const retryable: AiFailureKind[] = ["rate_limit", "overloaded", "server_error", "connection"];
      for (const kind of retryable) expect(isRetryableAiFailure(kind)).toBe(true);
    });

    it("marks bad_request / auth / unknown NOT retryable", () => {
      const fatal: AiFailureKind[] = ["bad_request", "auth", "unknown"];
      for (const kind of fatal) expect(isRetryableAiFailure(kind)).toBe(false);
    });
  });
  ```

- [ ] Run it and confirm the failure is a missing module:

  ```powershell
  pnpm test -- lib/ai/errors.test.ts
  ```

  Expected: FAIL — `Failed to resolve import "./errors"` (file does not exist yet).

- [ ] Create `apps/web/lib/ai/errors.ts` with exactly:

  ```ts
  import Anthropic from "@anthropic-ai/sdk";

  /**
   * errors.ts — typed classification of Anthropic SDK failures.
   *
   * Persistable discriminator for cost/robustness telemetry
   * (block_inventory.failure_kind, shell_generations.failure_kind — migration
   * 0034) and the retry decisions in the Phase 2 generation loops: bad_request
   * and auth failures must never burn a second full-price attempt, while
   * rate_limit / overloaded / server_error / connection may retry.
   *
   * Deliberately NOT "server-only": pure classification over SDK classes, no
   * secrets — operator scripts (tsx) may import it.
   *
   * Order matters: most-specific classes first. OverloadedError (529) is
   * checked before InternalServerError (>=500) because the SDK's 5xx classes
   * overlap; the base APIError catch-all comes last.
   */

  export type AiFailureKind =
    | "rate_limit"
    | "overloaded"
    | "server_error"
    | "bad_request"
    | "auth"
    | "connection"
    | "unknown";

  export function classifyAiError(err: unknown): AiFailureKind {
    if (err instanceof Anthropic.RateLimitError) return "rate_limit";
    if (err instanceof Anthropic.OverloadedError) return "overloaded";
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      return "auth";
    }
    if (err instanceof Anthropic.BadRequestError) return "bad_request";
    if (err instanceof Anthropic.APIConnectionError) return "connection";
    if (err instanceof Anthropic.InternalServerError) return "server_error";
    if (err instanceof Anthropic.APIError) return "unknown";
    return "unknown";
  }

  /** Kinds worth a second attempt; everything else fails fast. */
  export function isRetryableAiFailure(kind: AiFailureKind): boolean {
    return (
      kind === "rate_limit" ||
      kind === "overloaded" ||
      kind === "server_error" ||
      kind === "connection"
    );
  }
  ```

- [ ] Run the test again and confirm PASS:

  ```powershell
  pnpm test -- lib/ai/errors.test.ts
  ```

  Expected: 10 tests pass.

- [ ] Typecheck and commit:

  ```powershell
  pnpm typecheck
  git add lib/ai/errors.ts lib/ai/errors.test.ts
  git commit -m "feat(ai): typed Anthropic error classifier (classifyAiError + isRetryableAiFailure)"
  ```

---

### Task 2: Model registry refresh (`lib/ai/model.ts`)

**Files:**
- Modify: `apps/web/lib/ai/model.ts` (whole-file replacement below; current file is 79 lines)
- Create: `apps/web/lib/ai/model.test.ts`
- Modify: `apps/web/.env.local.example` (lines 54–64)

What changes and why:
1. `envKeyFor()` fixes the hyphen bug — `task.toUpperCase()` alone yields `JAB_AI_MODEL_COMPONENT-VISUAL`, a name POSIX shells and Vercel's env UI reject, so every per-task override for hyphenated tasks is dead today (model.ts:70).
2. `ALLOWED` drops previous-gen `claude-opus-4-7` (no task default, no caller) and adds `claude-opus-4-8` (current Opus, same $5/$25).
3. `TASKS` deletes the dead `"content"` task (its call site was deleted in the Stage 0 v2 teardown; `getModelFor` is only ever called with `"design"` — verified at scrape-agent.ts:240) and adds `shell` / `planner` / `fidelity-vision` so Phases 2/5/7 have registry entries.
4. Legacy global `JAB_AI_MODEL` is kept but now warns (one line) whenever it moves a task off its default — an operator upgrading codegen must not silently move the Haiku design pass to a 5x-priced model.

- [ ] Write the failing test — create `apps/web/lib/ai/model.test.ts` with exactly:

  ```ts
  import { describe, it, expect, vi, afterEach } from "vitest";
  import { envKeyFor, getModelFor } from "./model";

  const ENV_KEYS = [
    "JAB_AI_MODEL",
    "JAB_AI_MODEL_DESIGN",
    "JAB_AI_MODEL_CODEGEN",
    "JAB_AI_MODEL_COMPONENT_VISUAL",
    "JAB_AI_MODEL_COMPONENT_STANDARD",
    "JAB_AI_MODEL_COMPONENT_TRIVIAL",
    "JAB_AI_MODEL_SHELL",
    "JAB_AI_MODEL_PLANNER",
    "JAB_AI_MODEL_FIDELITY_VISION",
  ];

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.restoreAllMocks();
  });

  describe("envKeyFor — hyphen-safe env key builder", () => {
    it("maps hyphenated tasks to underscore env keys", () => {
      expect(envKeyFor("component-visual")).toBe("JAB_AI_MODEL_COMPONENT_VISUAL");
      expect(envKeyFor("component-standard")).toBe("JAB_AI_MODEL_COMPONENT_STANDARD");
      expect(envKeyFor("component-trivial")).toBe("JAB_AI_MODEL_COMPONENT_TRIVIAL");
      expect(envKeyFor("fidelity-vision")).toBe("JAB_AI_MODEL_FIDELITY_VISION");
    });

    it("passes through single-word tasks", () => {
      expect(envKeyFor("design")).toBe("JAB_AI_MODEL_DESIGN");
      expect(envKeyFor("shell")).toBe("JAB_AI_MODEL_SHELL");
      expect(envKeyFor("planner")).toBe("JAB_AI_MODEL_PLANNER");
    });
  });

  describe("getModelFor — defaults per CONTRACTS", () => {
    it("resolves the documented default for every task", () => {
      expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
      expect(getModelFor("codegen")).toBe("claude-sonnet-4-6");
      expect(getModelFor("component-visual")).toBe("claude-sonnet-4-6");
      expect(getModelFor("component-standard")).toBe("claude-sonnet-4-6");
      expect(getModelFor("component-trivial")).toBe("claude-haiku-4-5-20251001");
      expect(getModelFor("shell")).toBe("claude-sonnet-4-6");
      expect(getModelFor("planner")).toBe("claude-sonnet-4-6");
      expect(getModelFor("fidelity-vision")).toBe("claude-sonnet-4-6");
    });

    it("the dead 'content' task is gone from the union (compile-time pin)", () => {
      // @ts-expect-error — "content" was deleted from TASKS in Phase 1; if
      // this annotation stops erroring under `pnpm typecheck`, the dead task
      // came back.
      const removed = () => getModelFor("content");
      expect(typeof removed).toBe("function");
    });
  });

  describe("getModelFor — per-task override via hyphen-fixed key", () => {
    it("honors JAB_AI_MODEL_COMPONENT_VISUAL", () => {
      process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
      expect(getModelFor("component-visual")).toBe("claude-haiku-4-5-20251001");
    });

    it("an empty-string per-task var throws (set-but-invalid, never falls through)", () => {
      process.env.JAB_AI_MODEL_SHELL = "";
      expect(() => getModelFor("shell")).toThrow(/JAB_AI_MODEL_SHELL/);
    });
  });

  describe("ALLOWED list refresh", () => {
    it("accepts claude-opus-4-8", () => {
      process.env.JAB_AI_MODEL_CODEGEN = "claude-opus-4-8";
      expect(getModelFor("codegen")).toBe("claude-opus-4-8");
    });

    it("rejects the retired claude-opus-4-7 pin", () => {
      process.env.JAB_AI_MODEL_CODEGEN = "claude-opus-4-7";
      expect(() => getModelFor("codegen")).toThrow(/not in the allowed list/);
    });
  });

  describe("legacy global JAB_AI_MODEL warn", () => {
    it("warns once per resolution when the global moves a task off its default", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.JAB_AI_MODEL = "claude-sonnet-4-6"; // design default is haiku
      expect(getModelFor("design")).toBe("claude-sonnet-4-6");
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("design");
      expect(line).toContain("claude-haiku-4-5-20251001"); // the default
      expect(line).toContain("claude-sonnet-4-6"); // the override
    });

    it("does not warn when the global matches the task default", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.JAB_AI_MODEL = "claude-haiku-4-5-20251001";
      expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
      expect(warn).not.toHaveBeenCalled();
    });

    it("per-task override beats the global, with no warn", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.JAB_AI_MODEL = "claude-sonnet-4-6";
      process.env.JAB_AI_MODEL_DESIGN = "claude-haiku-4-5-20251001";
      expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
      expect(warn).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] Run it and confirm failure:

  ```powershell
  pnpm test -- lib/ai/model.test.ts
  ```

  Expected: FAIL — `envKeyFor` is not exported (SyntaxError / undefined import), plus default-value failures for the new tasks.

- [ ] Replace `apps/web/lib/ai/model.ts` in full with:

  ```ts
  import "server-only";

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
        console.warn(
          `[model] legacy JAB_AI_MODEL override active: task "${task}" default ${DEFAULTS[task]} → ${resolved} (set ${perTaskKey} to scope this per task)`,
        );
      }
      return resolved;
    }

    return DEFAULTS[task];
  }
  ```

- [ ] Run the tests and confirm PASS:

  ```powershell
  pnpm test -- lib/ai/model.test.ts
  ```

  Expected: 12 tests pass.

- [ ] Update `apps/web/.env.local.example` — replace lines 54–64 (the block starting `# Optional per-task model overrides.` and ending `# JAB_AI_MODEL_CODEGEN=claude-sonnet-4-6          # future page-code rebuild`) with:

  ```text
  # Optional per-task model overrides. Each AI call site resolves its model
  # at call time via lib/ai/model.ts → getModelFor(task), with precedence:
  #   1. JAB_AI_MODEL_<TASK> per-task (hyphens in the task name become
  #      underscores — e.g. component-visual → JAB_AI_MODEL_COMPONENT_VISUAL)
  #   2. JAB_AI_MODEL legacy global override (warns when it moves a task off
  #      its default — prefer the per-task keys)
  #   3. Hardcoded default (Haiku for design/component-trivial, Sonnet for
  #      everything else)
  # Allowed values are pinned in lib/ai/model.ts; a typo fails fast at the
  # first call rather than silently dispatching to a non-existent model.
  # JAB_AI_MODEL=claude-haiku-4-5-20251001                    # global override (legacy)
  # JAB_AI_MODEL_DESIGN=claude-haiku-4-5-20251001             # design tokens pass
  # JAB_AI_MODEL_CODEGEN=claude-sonnet-4-6                    # future page-code rebuild
  # JAB_AI_MODEL_COMPONENT_VISUAL=claude-sonnet-4-6           # Phase B visual tier
  # JAB_AI_MODEL_COMPONENT_STANDARD=claude-sonnet-4-6         # Phase B standard tier
  # JAB_AI_MODEL_COMPONENT_TRIVIAL=claude-haiku-4-5-20251001  # Phase B trivial tier
  # JAB_AI_MODEL_SHELL=claude-sonnet-4-6                      # Phase C header/footer
  # JAB_AI_MODEL_PLANNER=claude-sonnet-4-6                    # chat-edit planner
  # JAB_AI_MODEL_FIDELITY_VISION=claude-sonnet-4-6            # Phase E vision scoring
  ```

- [ ] Run the FULL suite to prove nothing else referenced the dead task or the opus-4-7 pin (`getModelFor` is only called by scrape-agent with `"design"`; `AllowedModel` is type-only there):

  ```powershell
  pnpm test
  pnpm typecheck
  ```

  Expected: all green.

- [ ] Commit:

  ```powershell
  git add lib/ai/model.ts lib/ai/model.test.ts .env.local.example
  git commit -m "feat(ai): model registry refresh — envKeyFor hyphen fix, opus-4-8, shell/planner/fidelity-vision tasks, legacy-global warn"
  ```

---

### Task 3: `model-client.ts` v2 — `cachedSystemPrefix`, `stopReason` + `model`, SDK singleton, memoized tier clients

**Files:**
- Rewrite: `apps/web/lib/ai/model-client.test.ts` (full replacement below)
- Modify: `apps/web/lib/ai/model-client.ts` (full replacement below; currently 209 lines)
- Modify: `apps/web/lib/ai/component-generator.ts` (:737–742 — the `client.generate` call)
- Modify: `apps/web/lib/ai/generate-shell.ts` (:134–138 — the `client.generate` call)
- Modify: `apps/web/lib/ai/component-generator.test.ts` (:30–39 `makeFakeClient`)
- Modify: `apps/web/lib/ai/generate-shell.test.ts` (:5–12 `makeMockClient`)

All edits in this task land in ONE commit — removing `cacheSystemPrompt` from `GenerateOptions` breaks the two callers and the test fakes under `tsc`, so they must move together. Behavior note for reviewers: the old `cache_control` marker on attempt 0 was a **silent no-op** (the rendered system prompts are ~500–1,500 tokens, below Sonnet 4.6's 2048-token minimum cacheable prefix and Haiku 4.5's 4096), so callers passing `cachedSystemPrefix: undefined` produce billing-identical requests. Phase 2 introduces the real ≥2048-token prefix.

- [ ] Replace `apps/web/lib/ai/model-client.test.ts` in full with:

  ```ts
  import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
  import type Anthropic from "@anthropic-ai/sdk";
  import { validateTsx } from "./component-generator";
  import {
    AnthropicModelClient,
    MockModelClient,
    modelClientForTier,
    COMPONENT_TASK_BY_TIER,
    __resetModelClientCacheForTests,
  } from "./model-client";

  // ---------------------------------------------------------------------------
  // Fake SDK — captures messages.create args so tests assert REQUEST
  // CONSTRUCTION (the cost-relevant behavior), not just response plumbing.
  // ---------------------------------------------------------------------------

  interface FakeResponseOverrides {
    stop_reason?: string | null;
    usage?: Record<string, number | null | undefined>;
    model?: string;
  }

  function makeFakeSdk(overrides: FakeResponseOverrides = {}) {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "GENERATED_TSX" }],
      stop_reason: overrides.stop_reason === undefined ? "end_turn" : overrides.stop_reason,
      model: overrides.model ?? "claude-sonnet-4-6-echoed-by-api",
      usage: overrides.usage ?? {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 9,
      },
    });
    const sdk = { messages: { create } } as unknown as Anthropic;
    return { sdk, create };
  }

  function lastCreateArgs(create: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return create.mock.calls[create.mock.calls.length - 1][0] as Record<string, unknown>;
  }

  afterEach(() => {
    delete process.env.JAB_GENERATE_MOCK;
    delete process.env.JAB_AI_MODEL_COMPONENT_VISUAL;
    __resetModelClientCacheForTests();
    vi.restoreAllMocks();
  });

  describe("AnthropicModelClient — request construction", () => {
    it("renders cachedSystemPrefix as the FIRST system block with cache_control, systemPrompt second (uncached)", async () => {
      const { sdk, create } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      await client.generate({
        cachedSystemPrefix: "STABLE SHARED PREFIX",
        systemPrompt: "PER-BUILD SYSTEM",
        userPrompt: "go",
      });
      const args = lastCreateArgs(create);
      expect(args.system).toEqual([
        { type: "text", text: "STABLE SHARED PREFIX", cache_control: { type: "ephemeral" } },
        { type: "text", text: "PER-BUILD SYSTEM" },
      ]);
    });

    it("emits NO cache_control anywhere when cachedSystemPrefix is absent", async () => {
      const { sdk, create } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      await client.generate({ systemPrompt: "PER-BUILD SYSTEM", userPrompt: "go" });
      const args = lastCreateArgs(create);
      expect(args.system).toEqual([{ type: "text", text: "PER-BUILD SYSTEM" }]);
      expect(JSON.stringify(args)).not.toContain("cache_control");
    });

    it("passes the configured model and max_tokens through to messages.create", async () => {
      const { sdk, create } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-haiku-4-5-20251001", maxTokens: 2048, sdk });
      await client.generate({ systemPrompt: "s", userPrompt: "u" });
      const args = lastCreateArgs(create);
      expect(args.model).toBe("claude-haiku-4-5-20251001");
      expect(args.max_tokens).toBe(2048);
    });

    it("places the screenshot image block BEFORE the user text block", async () => {
      const { sdk, create } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
      await client.generate({ systemPrompt: "s", userPrompt: "USER TEXT", screenshotBase64: "QkFTRTY0" });
      const args = lastCreateArgs(create);
      const messages = args.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content[0]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QkFTRTY0" },
      });
      expect(messages[0].content[1]).toEqual({ type: "text", text: "USER TEXT" });
    });

    it("sends no image block when screenshotBase64 is absent", async () => {
      const { sdk, create } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
      await client.generate({ systemPrompt: "s", userPrompt: "USER TEXT" });
      const args = lastCreateArgs(create);
      const messages = args.messages as Array<{ content: Array<Record<string, unknown>> }>;
      expect(messages[0].content).toEqual([{ type: "text", text: "USER TEXT" }]);
    });
  });

  describe("AnthropicModelClient — response mapping", () => {
    it("maps usage, stopReason, and the API-echoed model into GenerateResult", async () => {
      const { sdk } = makeFakeSdk();
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
      expect(result.text).toBe("GENERATED_TSX");
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 7,
        cacheCreationTokens: 9,
      });
      expect(result.stopReason).toBe("end_turn");
      expect(result.model).toBe("claude-sonnet-4-6-echoed-by-api");
    });

    it("defaults cache token fields to 0 when the API omits them", async () => {
      const { sdk } = makeFakeSdk({ usage: { input_tokens: 10, output_tokens: 5 } });
      const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
      const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheCreationTokens).toBe(0);
    });

    it("surfaces max_tokens as stopReason and normalizes unknown values to null", async () => {
      {
        const { sdk } = makeFakeSdk({ stop_reason: "max_tokens" });
        const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
        const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
        expect(result.stopReason).toBe("max_tokens");
      }
      {
        const { sdk } = makeFakeSdk({ stop_reason: "model_context_window_exceeded" });
        const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
        const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
        expect(result.stopReason).toBeNull();
      }
      {
        const { sdk } = makeFakeSdk({ stop_reason: null });
        const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 4096, sdk });
        const result = await client.generate({ systemPrompt: "s", userPrompt: "u" });
        expect(result.stopReason).toBeNull();
      }
    });
  });

  describe("MockModelClient", () => {
    it("returns valid TSX that passes validateTsx, with end_turn + its label as model", async () => {
      const client = new MockModelClient("claude-sonnet-4-6");
      const result = await client.generate({ systemPrompt: "ignored", userPrompt: "ignored" });
      expect(validateTsx(result.text, "MockBlock.tsx")).toEqual([]);
      expect(result.text).toContain('import type { BlockNode } from "@/lib/jab/ability-client"');
      expect(result.text).toContain("export function MockBlock(");
      expect(result.stopReason).toBe("end_turn");
      expect(result.model).toBe("claude-sonnet-4-6");
    });

    it("reports zero usage so cost telemetry records 0", async () => {
      const client = new MockModelClient("claude-haiku-4-5-20251001");
      const result = await client.generate({ systemPrompt: "ignored", userPrompt: "ignored" });
      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    });
  });

  describe("modelClientForTier", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "test-key";
    });

    it("maps tiers to the component-* tasks", () => {
      expect(COMPONENT_TASK_BY_TIER).toEqual({
        visual: "component-visual",
        standard: "component-standard",
        trivial: "component-trivial",
      });
    });

    it("returns MockModelClient for every non-passthrough tier when JAB_GENERATE_MOCK=1", () => {
      process.env.JAB_GENERATE_MOCK = "1";
      expect(modelClientForTier("visual")).toBeInstanceOf(MockModelClient);
      expect(modelClientForTier("standard")).toBeInstanceOf(MockModelClient);
      expect(modelClientForTier("trivial")).toBeInstanceOf(MockModelClient);
    });

    it("returns AnthropicModelClient when JAB_GENERATE_MOCK is unset", () => {
      delete process.env.JAB_GENERATE_MOCK;
      expect(modelClientForTier("visual")).toBeInstanceOf(AnthropicModelClient);
      expect(modelClientForTier("standard")).toBeInstanceOf(AnthropicModelClient);
      expect(modelClientForTier("trivial")).toBeInstanceOf(AnthropicModelClient);
    });

    it("memoizes per model+maxTokens — repeated calls return the SAME instance", () => {
      const a = modelClientForTier("visual");
      const b = modelClientForTier("visual");
      expect(a).toBe(b);
      // standard differs by maxTokens → distinct instance
      expect(modelClientForTier("standard")).not.toBe(a);
    });

    it("__resetModelClientCacheForTests clears the memo", () => {
      const a = modelClientForTier("visual");
      __resetModelClientCacheForTests();
      const b = modelClientForTier("visual");
      expect(b).not.toBe(a);
    });

    it("resolves the model through getModelFor — JAB_AI_MODEL_COMPONENT_VISUAL reaches the client", () => {
      process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
      __resetModelClientCacheForTests();
      const client = modelClientForTier("visual") as AnthropicModelClient;
      expect(client.model).toBe("claude-haiku-4-5-20251001");
    });

    it("does NOT memoize mock clients (fresh instance per call)", () => {
      process.env.JAB_GENERATE_MOCK = "1";
      expect(modelClientForTier("visual")).not.toBe(modelClientForTier("visual"));
    });

    it("still throws for tier=passthrough even in mock mode", () => {
      process.env.JAB_GENERATE_MOCK = "1";
      expect(() => modelClientForTier("passthrough")).toThrow(/passthrough/);
    });
  });
  ```

- [ ] Run and confirm failure:

  ```powershell
  pnpm test -- lib/ai/model-client.test.ts
  ```

  Expected: FAIL — `COMPONENT_TASK_BY_TIER` / `__resetModelClientCacheForTests` are not exported; `generate()` calls missing the (removed) required `cacheSystemPrompt` would also fail once typechecked.

- [ ] Replace `apps/web/lib/ai/model-client.ts` in full with:

  ```ts
  import "server-only";

  /**
   * model-client.ts — provider-agnostic LLM interface for Phase B component
   * generation and the Phase C shell calls.
   *
   * Motivation: blocks route to different models by tier (design doc §6.4):
   *   visual:    component-visual task   (default Sonnet 4.6 — vision capable)
   *   standard:  component-standard task (default Sonnet 4.6 — text only)
   *   trivial:   component-trivial task  (default Haiku 4.5 — cheap scaffolds)
   * Defaults + JAB_AI_MODEL_* env overrides live in lib/ai/model.ts —
   * modelClientForTier resolves through getModelFor, so the documented
   * override surface actually governs these calls (it was dead before
   * the 2026-06-10 AI-call-optimization campaign).
   *
   * Prompt caching: callers pass `cachedSystemPrefix` ONLY when the prefix
   * clears the model's minimum cacheable size (2048 tokens on Sonnet 4.6,
   * 4096 on Haiku 4.5 — shorter prefixes silently never cache). The prefix is
   * rendered as the FIRST system text block with cache_control and must be
   * sent on EVERY attempt including retries (a request without the marker
   * performs no cache lookup, so dropping it on retry forfeits the
   * guaranteed-hit read).
   *
   * SDK instance: the process-wide singleton from lib/ai/client.ts (one
   * keep-alive pool, one shared rate-limit backoff state — see that file's
   * docblock). NEVER `new Anthropic()` outside client.ts; tests inject a
   * fake via the `sdk` option.
   */

  import type Anthropic from "@anthropic-ai/sdk";
  import { getAnthropicClient } from "./client";
  import { getModelFor, type AiTask, type AllowedModel } from "./model";
  import type { Tier } from "@/lib/jab/inventory";

  export type StopReason =
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null;

  const KNOWN_STOP_REASONS = [
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
  ] as const;

  /** Map the SDK's stop_reason onto our union; unknown/new values become null. */
  function normalizeStopReason(raw: string | null | undefined): StopReason {
    return raw != null && (KNOWN_STOP_REASONS as readonly string[]).includes(raw)
      ? (raw as StopReason)
      : null;
  }

  export interface GenerateUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }

  export interface GenerateResult {
    text: string;
    usage: GenerateUsage;
    stopReason: StopReason;
    /** Model ID actually used — ground truth for telemetry; callers must persist THIS, never a re-hardcoded constant. */
    model: string;
  }

  export interface GenerateOptions {
    /** Optional stable shared prefix. Rendered as the FIRST system text block with cache_control {type:"ephemeral"} on EVERY call (including retries — never drop the marker on retry). Only pass when the prefix clears the model's minimum cacheable size (2048 tokens Sonnet 4.6 / 4096 Haiku 4.5); for Haiku-tier calls pass undefined. */
    cachedSystemPrefix?: string;
    /** Per-build/per-call system content; rendered as the second (uncached) system text block. */
    systemPrompt: string;
    userPrompt: string;
    screenshotBase64?: string;
  }

  export interface ModelClient {
    generate(opts: GenerateOptions): Promise<GenerateResult>;
  }

  export interface AnthropicModelClientOptions {
    model: AllowedModel;
    maxTokens: number;
    /** Injectable for tests. Defaults to the shared singleton from client.ts. */
    sdk?: Anthropic;
  }

  export class AnthropicModelClient implements ModelClient {
    private readonly sdk: Anthropic;
    /** Resolved model ID this client dispatches to (readable for tests/telemetry). */
    readonly model: AllowedModel;
    readonly maxTokens: number;

    constructor(opts: AnthropicModelClientOptions) {
      this.sdk = opts.sdk ?? getAnthropicClient();
      this.model = opts.model;
      this.maxTokens = opts.maxTokens;
    }

    async generate(opts: GenerateOptions): Promise<GenerateResult> {
      const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];
      if (opts.cachedSystemPrefix) {
        systemBlocks.push({
          type: "text",
          text: opts.cachedSystemPrefix,
          cache_control: { type: "ephemeral" },
        });
      }
      systemBlocks.push({ type: "text", text: opts.systemPrompt });

      const userContent: Anthropic.Messages.ContentBlockParam[] = [];
      if (opts.screenshotBase64) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: opts.screenshotBase64 },
        });
      }
      userContent.push({ type: "text", text: opts.userPrompt });

      const response = await this.sdk.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemBlocks,
        messages: [{ role: "user", content: userContent }],
      });

      const text = response.content.find((b) => b.type === "text")?.text ?? "";

      return {
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        stopReason: normalizeStopReason(response.stop_reason),
        model: response.model,
      };
    }
  }

  /**
   * MockModelClient — dry-run client used when JAB_GENERATE_MOCK=1.
   *
   * Returns a fixed, valid TSX component without making any API calls. Used by
   * the Phase B smoke runner to verify the full orchestration (worker batching,
   * status transitions, Storage writes, DB updates, event dispatch) without
   * incurring Anthropic API cost.
   *
   * The emitted TSX:
   *   - Imports BlockNode (matches the real prompt's output contract)
   *   - Is a named export (matches `validateTsx` + composer expectations)
   *   - Parses cleanly under `ts.createSourceFile(..., ScriptKind.TSX)`
   *   - Contains a visible MOCK badge so a dry-run build can't be confused
   *     with a real one if it accidentally reaches a preview surface.
   *
   * Usage returns all zeros so `block_inventory` cost columns record 0 — a
   * clear signal in the DB that no LLM call fired. `model` echoes the label
   * (the resolved model id) and stopReason is always "end_turn".
   */
  export class MockModelClient implements ModelClient {
    private readonly modelLabel: string;

    constructor(modelLabel: string) {
      this.modelLabel = modelLabel;
    }

    async generate(_opts: GenerateOptions): Promise<GenerateResult> {
      const tsx = `import type { BlockNode } from "@/lib/jab/ability-client";

  /**
   * MOCK component — generated with JAB_GENERATE_MOCK=1 (no API call made).
   * Used for verifying the Phase B orchestration end-to-end at zero cost.
   */
  export function MockBlock({ block }: { block: BlockNode }) {
    return (
      <div className="p-4 border-2 border-dashed border-amber-500 bg-amber-50 dark:bg-amber-950">
        <div className="text-xs font-mono text-amber-700 dark:text-amber-400">MOCK · ${this.modelLabel} · dry-run</div>
        <pre className="text-xs mt-2 overflow-x-auto">{JSON.stringify(block.attrs ?? {}, null, 2)}</pre>
      </div>
    );
  }
  `;
      return {
        text: tsx,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        stopReason: "end_turn",
        model: this.modelLabel,
      };
    }
  }

  let mockNoticeShown = false;
  function noteMockMode(): void {
    if (mockNoticeShown) return;
    mockNoticeShown = true;
    console.warn(
      "[model-client] JAB_GENERATE_MOCK=1 detected — MockModelClient active. No Anthropic API calls will be made; cost telemetry will report 0 for this run.",
    );
  }

  /** Tier → model.ts task. Exported so workers/scripts resolve the same way. */
  export const COMPONENT_TASK_BY_TIER: Record<"visual" | "standard" | "trivial", AiTask> = {
    visual: "component-visual",
    standard: "component-standard",
    trivial: "component-trivial",
  };

  /** Per-tier output budgets (unchanged from the pre-campaign table). */
  const MAX_TOKENS_BY_TIER: Record<"visual" | "standard" | "trivial", number> = {
    visual: 8192,
    standard: 4096,
    trivial: 2048,
  };

  /**
   * Memoized real clients, keyed model:maxTokens. One AnthropicModelClient per
   * configuration per process — they all share the client.ts SDK singleton, so
   * this only avoids object churn and keeps `client === client` stable for the
   * lifetime of a worker. Mock clients are NEVER memoized (cheap, stateless,
   * and tests toggle JAB_GENERATE_MOCK between cases).
   */
  const clientCache = new Map<string, AnthropicModelClient>();

  export function __resetModelClientCacheForTests(): void {
    clientCache.clear();
  }

  /**
   * Returns the appropriate ModelClient for a given block tier.
   *
   * Model resolution goes through getModelFor(COMPONENT_TASK_BY_TIER[tier]) —
   * defaults match the old hardcoded table (Sonnet 4.6 for visual/standard,
   * Haiku 4.5 pinned snapshot for trivial), and the JAB_AI_MODEL_* env
   * overrides now actually reach this path.
   *
   * If JAB_GENERATE_MOCK=1 is set in the environment, returns a MockModelClient
   * instead — used by the smoke runner's dry-run mode to verify orchestration
   * without API cost. The env var must be set in the Inngest dev server's
   * process (which reads .env.local at boot), not just the smoke script.
   */
  export function modelClientForTier(tier: Tier): ModelClient {
    if (tier === "passthrough") {
      throw new Error(
        "modelClientForTier called with tier=passthrough — caller should skip LLM for passthrough blocks",
      );
    }

    const mockEnabled = process.env.JAB_GENERATE_MOCK === "1";
    if (mockEnabled) noteMockMode();

    const model = getModelFor(COMPONENT_TASK_BY_TIER[tier]);
    const maxTokens = MAX_TOKENS_BY_TIER[tier];

    if (mockEnabled) return new MockModelClient(model);

    const key = `${model}:${maxTokens}`;
    const cached = clientCache.get(key);
    if (cached) return cached;
    const client = new AnthropicModelClient({ model, maxTokens });
    clientCache.set(key, client);
    return client;
  }
  ```

- [ ] Update the **component-generator caller** — in `apps/web/lib/ai/component-generator.ts`, replace the `client.generate` call (currently :737–742):

  ```ts
      result = await client.generate({
        systemPrompt,
        userPrompt,
        cacheSystemPrompt: attempt === 0,
        screenshotBase64: entry.tier === "visual" ? opts.screenshotBase64 ?? undefined : undefined,
      });
  ```

  with:

  ```ts
      result = await client.generate({
        systemPrompt,
        userPrompt,
        // Phase 1: no cached prefix yet. The old cache_control marker here was
        // a silent no-op (system prompt is below the model's minimum cacheable
        // size). Phase 2 introduces COMPONENT_SYSTEM_CORE as a real
        // cachedSystemPrefix, sent on EVERY attempt.
        cachedSystemPrefix: undefined,
        screenshotBase64: entry.tier === "visual" ? opts.screenshotBase64 ?? undefined : undefined,
      });
  ```

- [ ] Update the **generate-shell caller** — in `apps/web/lib/ai/generate-shell.ts`, replace the `client.generate` call (currently :134–138):

  ```ts
      result = await client.generate({
        systemPrompt,
        userPrompt,
        cacheSystemPrompt: attempt === 0,
      });
  ```

  with:

  ```ts
      result = await client.generate({
        systemPrompt,
        userPrompt,
        // Phase 1: no cached prefix yet (shell system prompt is ~500 tokens,
        // below Sonnet's 2048-token minimum — the old marker never cached).
        // Phase 2 moves the per-project-stable shell sections here when their
        // combined length clears the minimum.
        cachedSystemPrefix: undefined,
      });
  ```

- [ ] Update the **component-generator test fake** — in `apps/web/lib/ai/component-generator.test.ts`, replace `makeFakeClient` (currently :30–39):

  ```ts
  /** Build a ModelClient stub that always returns the given TSX text. */
  function makeFakeClient(tsx: string): ModelClient {
    return {
      async generate() {
        return {
          text: tsx,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "end_turn" as const,
          // Distinct from any real model id — Task 4 asserts this exact string
          // lands in GeneratedComponent.modelUsed (ground truth, no re-hardcode).
          model: "fake-test-model",
        };
      },
    };
  }
  ```

- [ ] Update the **generate-shell test fake** — in `apps/web/lib/ai/generate-shell.test.ts`, replace `makeMockClient` (currently :5–12):

  ```ts
  function makeMockClient(text: string): ModelClient {
    return {
      generate: vi.fn().mockResolvedValue({
        text,
        usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: "end_turn",
        model: "fake-shell-model",
      }),
    } as unknown as ModelClient;
  }
  ```

- [ ] Run the three affected suites and the typecheck:

  ```powershell
  pnpm test -- lib/ai/model-client.test.ts lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts
  pnpm typecheck
  ```

  Expected: all pass. (`generate-shell.test.ts:32` `expect(out.modelUsed).toBeTruthy()` still passes because generate-shell still hardcodes the model string until Task 4.)

- [ ] Run the full suite to catch any consumer missed by the grep (`compose-site.ts:629` calls `modelClientForTier("visual")` — signature unchanged, no edit):

  ```powershell
  pnpm test
  ```

  Expected: all green.

- [ ] Commit:

  ```powershell
  git add lib/ai/model-client.ts lib/ai/model-client.test.ts lib/ai/component-generator.ts lib/ai/generate-shell.ts lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts
  git commit -m "feat(ai): model-client v2 — cachedSystemPrefix, stopReason+model surfaced, shared SDK singleton, getModelFor-resolved memoized tier clients"
  ```

---

### Task 4: Ground-truth model telemetry in component-generator and generate-shell

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` (:702–706 hardcode; :748–751 accumulators; :783–794 success return; :797–808 failure return — line refs from BEFORE Task 3's edit, which only touched :737–742, so these regions shift by +4 lines after Task 3; locate by content)
- Modify: `apps/web/lib/ai/generate-shell.ts` (:124–128 accumulators; :175–186 success return; :192–203 failure return)
- Test: `apps/web/lib/ai/component-generator.test.ts`, `apps/web/lib/ai/generate-shell.test.ts`

Why: `component-generator.ts` re-hardcodes the model purely for telemetry (`entry.tier === "trivial" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6"`), and `generate-shell.ts` stamps `"claude-sonnet-4-6"` even when zero API calls succeeded. Now that `GenerateResult.model` carries the API echo, persist THAT. Semantics change deliberately: when no API call ever succeeded, `modelUsed`/`providerUsed` become `null` (the columns are nullable; a failure row claiming a model that never answered is fiction).

- [ ] Write the failing tests — append to the END of `apps/web/lib/ai/component-generator.test.ts`:

  ```ts
  // ---------------------------------------------------------------------------
  // Ground-truth model telemetry (Phase 1, AI-call-optimization campaign)
  // ---------------------------------------------------------------------------

  describe("generateComponent — ground-truth model telemetry", () => {
    const OK_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";
  export function CoreButton({ block }: { block: BlockNode }) {
    return <div>ok</div>;
  }`;

    let modelClientMod: typeof import("./model-client");

    beforeEach(async () => {
      modelClientMod = await import("./model-client");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("records the model echoed by the client, never a re-hardcoded constant", async () => {
      vi.mocked(modelClientMod.modelClientForTier).mockReturnValue(makeFakeClient(OK_TSX));
      const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
      expect(out.compileStatus).toBe("ok");
      expect(out.modelUsed).toBe("fake-test-model");
      expect(out.providerUsed).toBe("anthropic");
    });

    it("records modelUsed=null and providerUsed=null when no API call ever succeeded", async () => {
      const failing: ModelClient = {
        generate: vi.fn().mockRejectedValue(new Error("simulated API outage")),
      };
      vi.mocked(modelClientMod.modelClientForTier).mockReturnValue(failing);
      const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
      expect(out.compileStatus).toBe("failed");
      expect(out.modelUsed).toBeNull();
      expect(out.providerUsed).toBeNull();
    });
  });
  ```

  And in `apps/web/lib/ai/generate-shell.test.ts`: change line 32 from `expect(out.modelUsed).toBeTruthy();` to `expect(out.modelUsed).toBe("fake-shell-model");` and append at the end of the file:

  ```ts
  describe("generateShell — ground-truth model telemetry", () => {
    it("records modelUsed=null when every attempt threw before a response arrived", async () => {
      const client = {
        generate: vi.fn().mockRejectedValue(new Error("simulated 529")),
      } as unknown as ModelClient;
      const out = await generateShell({ ...baseOpts, kind: "header", client });
      expect(out.compileStatus).toBe("failed");
      expect(out.modelUsed).toBeNull();
      expect(out.providerUsed).toBeNull();
    });

    it("failure after a successful-but-invalid response still records the responding model", async () => {
      const client = makeMockClient(`export function Header() { return <div>unclosed; }`);
      const out = await generateShell({ ...baseOpts, kind: "header", client });
      expect(out.compileStatus).toBe("failed");
      expect(out.modelUsed).toBe("fake-shell-model");
      expect(out.providerUsed).toBe("anthropic");
    });
  });
  ```

- [ ] Run and confirm failure:

  ```powershell
  pnpm test -- lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts
  ```

  Expected: FAIL — `modelUsed` is `"claude-sonnet-4-6"` where `"fake-test-model"` / `"fake-shell-model"` / `null` is expected.

- [ ] Implement in `apps/web/lib/ai/component-generator.ts`. Replace (locate by content; pre-Task-3 lines :702–706):

  ```ts
    const client = modelClientForTier(entry.tier);
    const providerUsed: "anthropic" = "anthropic";
    const modelUsed = entry.tier === "trivial"
      ? "claude-haiku-4-5-20251001"
      : "claude-sonnet-4-6";
  ```

  with:

  ```ts
    const client = modelClientForTier(entry.tier);
    // Ground-truth model telemetry: set from each GenerateResult (the API echo),
    // never re-hardcoded. Stays null when no API call ever succeeded, so a
    // failure row can't claim a model that never answered.
    let lastModel: string | null = null;
  ```

  In the accumulator block (after `accCacheCreation += result.usage.cacheCreationTokens;`), add one line:

  ```ts
      accCacheRead += result.usage.cacheReadTokens;
      accCacheCreation += result.usage.cacheCreationTokens;
      lastModel = result.model;
  ```

  In the SUCCESS return (the `compileStatus: "ok"` object), replace the two telemetry lines:

  ```ts
        modelUsed,
        providerUsed,
  ```

  with:

  ```ts
        modelUsed: result.model,
        providerUsed: "anthropic",
  ```

  In the FAILURE return (the trailing `compileStatus: "failed"` object), replace:

  ```ts
      modelUsed,
      providerUsed,
  ```

  with:

  ```ts
      modelUsed: lastModel,
      providerUsed: lastModel === null ? null : "anthropic",
  ```

- [ ] Implement in `apps/web/lib/ai/generate-shell.ts`. After the accumulator declarations (currently :124–128):

  ```ts
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let attemptCount = 0;
  ```

  add:

  ```ts
    // Ground-truth model telemetry (see component-generator.ts) — null until a
    // response actually arrives.
    let lastModel: string | null = null;
  ```

  After the usage accumulation inside the loop (`cacheCreationTokens += result.usage.cacheCreationTokens;`, currently :147), add:

  ```ts
      lastModel = result.model;
  ```

  In the SUCCESS return (currently :175–186), replace:

  ```ts
        modelUsed: "claude-sonnet-4-6",
        providerUsed: "anthropic",
  ```

  with:

  ```ts
        modelUsed: result.model,
        providerUsed: "anthropic",
  ```

  In the FAILURE return (currently :192–203), replace:

  ```ts
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
  ```

  with:

  ```ts
      modelUsed: lastModel,
      providerUsed: lastModel === null ? null : "anthropic",
  ```

- [ ] Run the tests and typecheck:

  ```powershell
  pnpm test -- lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts
  pnpm typecheck
  ```

  Expected: all pass (including the pre-existing suites in both files).

- [ ] Commit:

  ```powershell
  git add lib/ai/component-generator.ts lib/ai/generate-shell.ts lib/ai/component-generator.test.ts lib/ai/generate-shell.test.ts
  git commit -m "feat(ai): persist ground-truth model id from GenerateResult in component + shell telemetry"
  ```

---

### Task 5: Migration 0034 + drizzle schema — AI cost telemetry columns

**Files:**
- Create: `apps/web/drizzle/migrations/0034_ai_cost_telemetry.sql`
- Modify: `apps/web/lib/db/schema.ts` (`projects` :60–100, `blockInventory` :243–288, `shellGenerations` :431–455)
- Create: `apps/web/lib/db/schema-ai-telemetry.test.ts`

Repo convention (verified in `blockInventory`'s own comment at schema.ts:271–273): the hand-written `.sql` migration is the DDL source of truth; `lib/db/schema.ts` mirrors it. Do NOT run `drizzle-kit generate`. `0033` is the latest migration, so `0034` is next.

- [ ] Write the failing test — create `apps/web/lib/db/schema-ai-telemetry.test.ts` with exactly:

  ```ts
  import { describe, it, expect } from "vitest";
  import { blockInventory, shellGenerations, projects } from "./schema";

  /**
   * Pins the drizzle mirror of migration 0034_ai_cost_telemetry.sql.
   * If a column rename drifts between the .sql DDL and schema.ts, telemetry
   * writes silently miss — these assertions catch the drift class.
   */
  describe("migration 0034 — AI cost telemetry columns", () => {
    it("block_inventory carries cache-creation, failure-kind, and carry-forward columns", () => {
      expect(blockInventory.inputTokensCacheCreation.name).toBe("input_tokens_cache_creation");
      expect(blockInventory.failureKind.name).toBe("failure_kind");
      expect(blockInventory.promptInputsHash.name).toBe("prompt_inputs_hash");
      expect(blockInventory.reusedFromBuildId.name).toBe("reused_from_build_id");
    });

    it("shell_generations carries cache-creation and failure-kind columns", () => {
      expect(shellGenerations.inputTokensCacheCreation.name).toBe("input_tokens_cache_creation");
      expect(shellGenerations.failureKind.name).toBe("failure_kind");
    });

    it("projects carries design_scrape_usage", () => {
      expect(projects.designScrapeUsage.name).toBe("design_scrape_usage");
    });
  });
  ```

- [ ] Run and confirm failure:

  ```powershell
  pnpm test -- lib/db/schema-ai-telemetry.test.ts
  ```

  Expected: FAIL — `Cannot read properties of undefined (reading 'name')` (columns don't exist on the table objects yet).

- [ ] Create `apps/web/drizzle/migrations/0034_ai_cost_telemetry.sql` with exactly:

  ```sql
  -- 0034_ai_cost_telemetry.sql — 2026-06-10 AI-call-optimization campaign (Phase 1).
  --
  -- (1) input_tokens_cache_creation: usage.cache_creation_input_tokens is billed
  --     at 1.25x but was accumulated in code and never persisted — the cache
  --     write premium was invisible. Token identity going forward:
  --       total prompt tokens = input + cache_creation + cache_read
  --       cost = 1.0x input + 1.25x creation + 0.1x read
  --     (and input_tokens_uncached now stores the API's input_tokens AS-IS —
  --     the old code double-subtracted cache reads; fixed in the same phase.)
  -- (2) failure_kind: typed Anthropic error classification (lib/ai/errors.ts
  --     AiFailureKind: rate_limit | overloaded | server_error | bad_request |
  --     auth | connection | unknown — plus "max_tokens" written by the Phase 2
  --     truncation handling). Distinguishes "model wrote invalid TSX" from
  --     "API unreachable" on degraded rows. Plumbed nullable in Phase 1;
  --     populated by the Phase 2 generation loops.
  -- (3) prompt_inputs_hash + reused_from_build_id: Phase 4 cross-build
  --     component carry-forward (sha256 hex of the prompt inputs; provenance
  --     pointer to the build the .tsx was copied from). Nullable, unwritten
  --     until Phase 4.
  -- (4) projects.design_scrape_usage: scrape-agent design-pass usage telemetry
  --     ({ primary, fallback?, fallbackUsed, at }) including the WASTED primary
  --     call when the Haiku→Sonnet fallback fires. Written by Phase 6.
  --
  -- Apply to BOTH Supabase projects — local "JAB WP" (ajfurojjxthhzkjqttri)
  -- AND prod "jab-prod" (celzwcxkrmsbwiswkxug). NOTE: 0032 + 0033 were
  -- committed but still pending application at write time — apply in order
  -- 0032 → 0033 → 0034 on any project that is behind.

  ALTER TABLE public.block_inventory
    ADD COLUMN IF NOT EXISTS input_tokens_cache_creation integer NOT NULL DEFAULT 0;
  ALTER TABLE public.block_inventory
    ADD COLUMN IF NOT EXISTS failure_kind text;
  ALTER TABLE public.block_inventory
    ADD COLUMN IF NOT EXISTS prompt_inputs_hash text;
  ALTER TABLE public.block_inventory
    ADD COLUMN IF NOT EXISTS reused_from_build_id uuid REFERENCES public.site_builds(id);

  ALTER TABLE public.shell_generations
    ADD COLUMN IF NOT EXISTS input_tokens_cache_creation integer NOT NULL DEFAULT 0;
  ALTER TABLE public.shell_generations
    ADD COLUMN IF NOT EXISTS failure_kind text;

  ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS design_scrape_usage jsonb;

  COMMENT ON COLUMN public.block_inventory.input_tokens_cache_creation IS
    'Anthropic cache_creation_input_tokens (billed 1.25x). Total prompt = uncached + creation + cached.';
  COMMENT ON COLUMN public.block_inventory.failure_kind IS
    'Typed failure class (lib/ai/errors.ts AiFailureKind, plus max_tokens). NULL = no classified failure.';
  COMMENT ON COLUMN public.block_inventory.prompt_inputs_hash IS
    'sha256 hex of the generation prompt inputs (Phase 4 carry-forward key). NULL until Phase 4 writes it.';
  COMMENT ON COLUMN public.block_inventory.reused_from_build_id IS
    'When set, this row''s .tsx was copied from the referenced prior ready build (zero-token reuse).';
  COMMENT ON COLUMN public.shell_generations.input_tokens_cache_creation IS
    'Anthropic cache_creation_input_tokens (billed 1.25x) for this shell call.';
  COMMENT ON COLUMN public.shell_generations.failure_kind IS
    'Typed failure class (lib/ai/errors.ts AiFailureKind, plus max_tokens). NULL = no classified failure.';
  COMMENT ON COLUMN public.projects.design_scrape_usage IS
    'Design-pass usage telemetry: { primary: {model,inputTokens,outputTokens}, fallback?, fallbackUsed, at }.';
  ```

- [ ] Mirror the columns in `apps/web/lib/db/schema.ts`:

  In `blockInventory`, after `spec: jsonb("spec"),` (currently :280) and before `createdAt`, insert:

  ```ts
      // ── Migration 0034 (AI-call-optimization Phase 1) ──
      // Cache-write tokens (billed 1.25x). Total prompt = uncached + creation
      // + cached; cost = 1.0x uncached + 1.25x creation + 0.1x cached.
      inputTokensCacheCreation: integer("input_tokens_cache_creation").notNull().default(0),
      // Typed failure class (lib/ai/errors.ts AiFailureKind + "max_tokens").
      failureKind: text("failure_kind"),
      // Phase 4 carry-forward: sha256 of prompt inputs + provenance pointer.
      promptInputsHash: text("prompt_inputs_hash"),
      reusedFromBuildId: uuid("reused_from_build_id").references(() => siteBuilds.id),
  ```

  In `shellGenerations`, after `compileAttemptCount: integer("compile_attempt_count"),` (currently :448) and before `createdAt`, insert:

  ```ts
      // Migration 0034 — see blockInventory's matching columns.
      inputTokensCacheCreation: integer("input_tokens_cache_creation").notNull().default(0),
      failureKind: text("failure_kind"),
  ```

  In `projects`, after `contentOwnership: jsonb("content_ownership"),` (currently :96) and before `createdAt`, insert:

  ```ts
      // Migration 0034 — design-pass usage telemetry written by the scrape
      // worker: { primary: {model,inputTokens,outputTokens}, fallback?,
      // fallbackUsed, at }. Includes the wasted primary call when the
      // Haiku→Sonnet fallback fires. NULL until the worker has run post-0034.
      designScrapeUsage: jsonb("design_scrape_usage"),
  ```

- [ ] Run the test and typecheck:

  ```powershell
  pnpm test -- lib/db/schema-ai-telemetry.test.ts
  pnpm typecheck
  ```

  Expected: 3 tests pass; typecheck green.

- [ ] Commit:

  ```powershell
  git add drizzle/migrations/0034_ai_cost_telemetry.sql lib/db/schema.ts lib/db/schema-ai-telemetry.test.ts
  git commit -m "feat(db): migration 0034 — AI cost telemetry (cache-creation tokens, failure_kind, carry-forward provenance, design_scrape_usage)"
  ```

> **Operator note (NOT a code step):** 0034 must be applied to BOTH Supabase projects before the Task 6 code runs against a live DB — see Task 7's checklist. Until applied, `persistGeneration` will fail at runtime with `column "input_tokens_cache_creation" does not exist`.

---

### Task 6: Telemetry math fix + cache-creation / failure-kind persistence

**Files:**
- Modify: `apps/web/lib/ai/persist-generation.ts` (:24–28 input interface; :70–83 update payload)
- Modify: `apps/web/lib/ai/persist-shell-generation.ts` (:69–73 input interface; :103–119 upsert payload)
- Modify: `apps/web/lib/ai/persist-generation.test.ts` (append persistGeneration suite with mocked admin client)
- Modify: `apps/web/lib/ai/persist-shell-generation.test.ts` (append persistShellGeneration suite)

The bug (persist-generation.ts:76, persist-shell-generation.ts:113): `input_tokens_uncached: component.inputTokens - component.cacheReadTokens`. The API's `usage.input_tokens` is ALREADY the uncached remainder (total prompt = input + cache_creation + cache_read), so the subtraction double-counts and goes negative the moment caching works in Phase 2 — corrupting exactly the dashboards meant to prove the caching win. Fix: persist `component.inputTokens` AS-IS, persist `cacheCreationTokens` into the new column, and plumb `failureKind` as a nullable arg (callers pass nothing for now; Phase 2 threads real values).

- [ ] Write the failing tests. Replace `apps/web/lib/ai/persist-generation.test.ts` in full with:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { buildComponentStoragePath, persistGeneration } from "./persist-generation";
  import type { GeneratedComponent } from "./component-generator";

  // ---------------------------------------------------------------------------
  // Mocked Supabase admin client — captures the block_inventory update payload.
  // vi.mock factories are hoisted, so shared state must come from vi.hoisted.
  // ---------------------------------------------------------------------------

  const captured = vi.hoisted(() => ({
    updates: [] as Array<Record<string, unknown>>,
  }));

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
        }),
      },
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          captured.updates.push(payload);
          const chain = {
            eq: () => chain,
            // Awaiting the builder resolves to the supabase result shape.
            then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
          };
          return chain;
        },
      }),
    }),
  }));

  beforeEach(() => {
    captured.updates.length = 0;
  });

  const baseComponent: GeneratedComponent = {
    blockName: "core/heading",
    tsx: "export function CoreHeading() { return null; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "anthropic",
    // API semantics: input_tokens is ALREADY the uncached remainder.
    inputTokens: 900,
    outputTokens: 400,
    cacheReadTokens: 5000,
    cacheCreationTokens: 1250,
  };

  describe("buildComponentStoragePath", () => {
    it("produces a valid storage path for a standard block name", () => {
      const path = buildComponentStoragePath("build-abc", "core/heading");
      expect(path).toBe("builds/build-abc/components/CoreHeading.tsx");
    });

    it("handles acf_flex block names", () => {
      const path = buildComponentStoragePath("build-xyz", "acf_flex/page/sections/hero_section");
      expect(path).toBe("builds/build-xyz/components/AcfFlexPageSectionsHeroSection.tsx");
    });

    it("handles null block name (passthrough)", () => {
      const path = buildComponentStoragePath("build-123", "__null__");
      expect(path).toBe("builds/build-123/components/Null.tsx");
    });
  });

  describe("persistGeneration — cache-aware telemetry math (Phase 1 fix)", () => {
    it("persists input_tokens AS-IS (no cache-read subtraction) plus the cache-creation column", async () => {
      await persistGeneration({ buildId: "b1", projectId: "p1", component: baseComponent });
      expect(captured.updates).toHaveLength(1);
      const row = captured.updates[0];
      // THE FIX: previously 900 - 5000 = -4100 (double-subtraction).
      expect(row.input_tokens_uncached).toBe(900);
      expect(row.input_tokens_cached).toBe(5000);
      expect(row.input_tokens_cache_creation).toBe(1250);
      expect(row.output_tokens).toBe(400);
      expect(row.model_used).toBe("claude-sonnet-4-6");
      expect(row.compile_status).toBe("ok");
    });

    it("writes failure_kind=null when no failureKind is passed (default path)", async () => {
      await persistGeneration({ buildId: "b1", projectId: "p1", component: baseComponent });
      expect(captured.updates[0].failure_kind).toBeNull();
    });

    it("threads an explicit failureKind through to failure_kind", async () => {
      await persistGeneration({
        buildId: "b1",
        projectId: "p1",
        component: { ...baseComponent, compileStatus: "failed" },
        failureKind: "rate_limit",
      });
      expect(captured.updates[0].failure_kind).toBe("rate_limit");
    });
  });
  ```

  Replace `apps/web/lib/ai/persist-shell-generation.test.ts` in full with:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import {
    buildShellStoragePath,
    shouldReuseShell,
    persistShellGeneration,
  } from "./persist-shell-generation";
  import type { GeneratedShell } from "./generate-shell";

  const captured = vi.hoisted(() => ({
    upserts: [] as Array<Record<string, unknown>>,
  }));

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
        }),
      },
      from: () => ({
        upsert: (payload: Record<string, unknown>) => {
          captured.upserts.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }));

  beforeEach(() => {
    captured.upserts.length = 0;
  });

  describe("buildShellStoragePath", () => {
    it("returns builds/<id>/project/components/site/Header.tsx for header", () => {
      expect(buildShellStoragePath("abc-123", "header")).toBe(
        "builds/abc-123/project/components/site/Header.tsx",
      );
    });

    it("returns Footer.tsx for footer", () => {
      expect(buildShellStoragePath("xyz-456", "footer")).toBe(
        "builds/xyz-456/project/components/site/Footer.tsx",
      );
    });
  });

  describe("shouldReuseShell — JAB_SKIP_SHELL_REGEN decision", () => {
    it("reuses when skip enabled, no edit guidance, and the artifact exists", () => {
      expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: true })).toBe(true);
    });

    it("does NOT reuse when the skip flag is off (default production behaviour)", () => {
      expect(shouldReuseShell({ skipEnabled: false, hasEditGuidance: false, artifactExists: true })).toBe(false);
    });

    it("does NOT reuse when no prior artifact exists (first compose of the build)", () => {
      expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: false })).toBe(false);
    });

    it("does NOT reuse when this is a shell-scope edit targeting the kind — the edit MUST regenerate", () => {
      expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: true, artifactExists: true })).toBe(false);
    });
  });

  describe("persistShellGeneration — cache-aware telemetry math (Phase 1 fix)", () => {
    const baseShell: GeneratedShell = {
      shellKind: "header",
      tsx: "export function Header() { return null; }",
      compileStatus: "ok",
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
      inputTokens: 700,
      outputTokens: 300,
      cacheReadTokens: 4000,
      cacheCreationTokens: 800,
    };

    it("persists input_tokens AS-IS plus the cache-creation column, failure_kind null by default", async () => {
      await persistShellGeneration({ buildId: "b1", projectId: "p1", shell: baseShell });
      expect(captured.upserts).toHaveLength(1);
      const row = captured.upserts[0];
      // THE FIX: previously 700 - 4000 = -3300.
      expect(row.input_tokens_uncached).toBe(700);
      expect(row.input_tokens_cached).toBe(4000);
      expect(row.input_tokens_cache_creation).toBe(800);
      expect(row.output_tokens).toBe(300);
      expect(row.failure_kind).toBeNull();
    });

    it("threads an explicit failureKind through to failure_kind", async () => {
      await persistShellGeneration({
        buildId: "b1",
        projectId: "p1",
        shell: { ...baseShell, compileStatus: "failed" },
        failureKind: "overloaded",
      });
      expect(captured.upserts[0].failure_kind).toBe("overloaded");
    });
  });
  ```

- [ ] Run and confirm failure:

  ```powershell
  pnpm test -- lib/ai/persist-generation.test.ts lib/ai/persist-shell-generation.test.ts
  ```

  Expected: FAIL — `input_tokens_uncached` is `-4100` / `-3300` (the bug), `failureKind` is not an accepted property (TS surfaces at typecheck; runtime shows `failure_kind`/`input_tokens_cache_creation` as `undefined`).

- [ ] Implement in `apps/web/lib/ai/persist-generation.ts`:

  Add the import after the existing imports (line 4):

  ```ts
  import type { AiFailureKind } from "./errors";
  ```

  Replace the input interface (currently :24–28):

  ```ts
  export interface PersistGenerationInput {
    buildId: string;
    projectId: string;
    component: GeneratedComponent;
  }
  ```

  with:

  ```ts
  export interface PersistGenerationInput {
    buildId: string;
    projectId: string;
    component: GeneratedComponent;
    /**
     * Typed failure classification for degraded rows (migration 0034
     * failure_kind). Phase 1 callers omit it (persisted as NULL); the Phase 2
     * generation loop threads classifyAiError results / "max_tokens" through.
     */
    failureKind?: AiFailureKind | "max_tokens" | null;
  }
  ```

  Replace the update payload (currently :70–83):

  ```ts
    const { error: dbError } = await supabase
      .from("block_inventory")
      .update({
        model_used: component.modelUsed,
        provider_used: component.providerUsed,
        input_tokens_cached: component.cacheReadTokens,
        input_tokens_uncached: component.inputTokens - component.cacheReadTokens,
        output_tokens: component.outputTokens,
        compile_status: component.compileStatus,
        compile_attempt_count: component.compileAttemptCount,
      })
      .eq("site_build_id", buildId)
      .eq("project_id", projectId)
      .eq("block_name", blockNameKey);
  ```

  with:

  ```ts
    const { error: dbError } = await supabase
      .from("block_inventory")
      .update({
        model_used: component.modelUsed,
        provider_used: component.providerUsed,
        input_tokens_cached: component.cacheReadTokens,
        // The API's usage.input_tokens is ALREADY the uncached remainder —
        // total prompt = input + cache_creation + cache_read. The previous
        // `inputTokens - cacheReadTokens` double-subtracted reads and would go
        // negative once caching works. Cost = 1.0x uncached + 1.25x creation
        // + 0.1x cached, computed at the dashboard layer.
        input_tokens_uncached: component.inputTokens,
        input_tokens_cache_creation: component.cacheCreationTokens,
        output_tokens: component.outputTokens,
        compile_status: component.compileStatus,
        compile_attempt_count: component.compileAttemptCount,
        failure_kind: input.failureKind ?? null,
      })
      .eq("site_build_id", buildId)
      .eq("project_id", projectId)
      .eq("block_name", blockNameKey);
  ```

- [ ] Implement in `apps/web/lib/ai/persist-shell-generation.ts`:

  Add the import after the existing imports (line 4):

  ```ts
  import type { AiFailureKind } from "./errors";
  ```

  Replace the input interface (currently :69–73):

  ```ts
  export interface PersistShellGenerationInput {
    buildId: string;
    projectId: string;
    shell: GeneratedShell;
  }
  ```

  with:

  ```ts
  export interface PersistShellGenerationInput {
    buildId: string;
    projectId: string;
    shell: GeneratedShell;
    /** See persist-generation.ts — NULL until Phase 2 threads real values. */
    failureKind?: AiFailureKind | "max_tokens" | null;
  }
  ```

  Replace the upsert payload object (currently :103–119), keeping the `onConflict` second argument unchanged:

  ```ts
    const { error: dbError } = await supabase
      .from("shell_generations")
      .upsert(
        {
          site_build_id: buildId,
          project_id: projectId,
          shell_kind: shell.shellKind,
          model_used: shell.modelUsed,
          provider_used: shell.providerUsed,
          input_tokens_cached: shell.cacheReadTokens,
          // input_tokens is already the uncached remainder — see
          // persist-generation.ts for the full rationale.
          input_tokens_uncached: shell.inputTokens,
          input_tokens_cache_creation: shell.cacheCreationTokens,
          output_tokens: shell.outputTokens,
          compile_status: shell.compileStatus,
          compile_attempt_count: shell.compileAttemptCount,
          failure_kind: input.failureKind ?? null,
        },
        { onConflict: "site_build_id,shell_kind" },
      );
  ```

- [ ] Run the tests and typecheck:

  ```powershell
  pnpm test -- lib/ai/persist-generation.test.ts lib/ai/persist-shell-generation.test.ts
  pnpm typecheck
  ```

  Expected: all pass.

- [ ] Commit:

  ```powershell
  git add lib/ai/persist-generation.ts lib/ai/persist-shell-generation.ts lib/ai/persist-generation.test.ts lib/ai/persist-shell-generation.test.ts
  git commit -m "fix(ai): correct cache-aware telemetry math; persist cache-creation tokens + failure kind"
  ```

---

### Task 7: Final verification + migration application checklist

**Files:** none (verification only — no commit unless something needed fixing).

- [ ] Full suite + typecheck from `apps/web/`:

  ```powershell
  pnpm test
  pnpm typecheck
  ```

  Expected: every suite green (baseline before this phase was ~498+ app tests; this phase adds ~35). If anything fails, fix forward within the task that owns the file.

- [ ] Confirm no stray references to removed surfaces:

  ```powershell
  # All three must return NOTHING (rg from the apps/web directory):
  rg -n "cacheSystemPrompt" lib app scripts
  rg -n "claude-opus-4-7" lib app scripts .env.local.example
  rg -n "JAB_AI_MODEL_CONTENT|\"content\"" lib/ai/model.ts .env.local.example
  ```

- [ ] **Operator checklist — record completion in the task summary (do NOT skip):**
  1. Apply pending migrations IN ORDER to BOTH Supabase projects via `mcp__supabase__apply_migration` (or the SQL editor): local **"JAB WP"** (`ajfurojjxthhzkjqttri`) and prod **"jab-prod"** (`celzwcxkrmsbwiswkxug`). At plan-writing time 0032 and 0033 were committed but NOT yet applied to either project — the required order on a behind project is `0032 → 0033 → 0034`. Verify afterwards: `select column_name from information_schema.columns where table_name='block_inventory' and column_name in ('input_tokens_cache_creation','failure_kind','prompt_inputs_hash','reused_from_build_id');` returns 4 rows on both.
  2. **Deploy-order constraint:** Task 6's code writes the new columns unconditionally — 0034 must be live on a database before this branch's worker code runs against it, or every `persistGeneration` call fails with `column ... does not exist` (which, with `retries: 0` workers, fails builds).
  3. Note for operators with `JAB_AI_MODEL` or any `JAB_AI_MODEL_*` env pinned to `claude-opus-4-7` in Vercel/local env: that value now throws at first resolution (allowed-list refresh). Update to `claude-opus-4-8` or remove.

---

## What Phase 1 deliberately does NOT do

- No prompt restructuring, no `COMPONENT_SYSTEM_CORE`, no retry-loop changes (corrective retries, stop_reason handling, typed-error branching in the loops) — **Phase 2**. Phase 1 only makes the surfaces available (`stopReason`, `model`, `classifyAiError`, `failureKind` plumbing).
- No Batch API (**Phase 3**), no carry-forward writes to `prompt_inputs_hash`/`reused_from_build_id` (**Phase 4** — Phase 1 only creates the columns), no planner changes (**Phase 5** — `edit-planner.ts` shares no types with `model-client.ts`; verified it keeps compiling untouched), no scrape-agent structured outputs or `design_scrape_usage` writes (**Phase 6**), no vision/smoke changes (**Phase 7**).
- `cachedSystemPrefix` is passed as `undefined` by both callers — request bytes are billing-equivalent to today because the old marker never cleared the cacheable minimum. The flag-off-equivalence test is the `model-client.test.ts` case asserting zero `cache_control` emission when the prefix is absent.
