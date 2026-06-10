# Scrape Agent Structured Outputs and Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the design-token pass structurally unable to misformat (structured outputs), make its Haiku→Sonnet fallback fire only when escalation can actually help, persist its cost telemetry — including the wasted primary call when fallback fires — to `projects.design_scrape_usage`, bound the last unclamped prompt inputs, and stop the duplicate-dispatch race from double-billing.

**Architecture:** All changes live in two files plus their two new test files: `apps/web/lib/ai/scrape-agent.ts` (the single-LLM-call design pass: wire schema, structured-outputs call, fallback condition, usage accounting, prompt caps) and `apps/web/lib/inngest/functions/extract-project-design.ts` (the only caller: persists the new telemetry and gains a per-project debounce). The `projects.design_scrape_usage jsonb` column ships in Phase 1's migration `0034_ai_cost_telemetry.sql`; `classifyAiError` ships in Phase 1's `apps/web/lib/ai/errors.ts` — both are hard prerequisites.

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 6 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: Phase 1 (`apps/web/lib/ai/errors.ts` `classifyAiError`/`AiFailureKind`; migration `0034_ai_cost_telemetry.sql` adding `projects.design_scrape_usage jsonb` — apply to BOTH Supabase projects before live runs; `model.ts` keeps the `design` task with default `claude-haiku-4-5-20251001`, so `getModelFor("design")` is unaffected by Phase 1's task-table changes).

---

## Pre-flight facts (verified 2026-06-10 against the working tree)

- `apps/web/lib/ai/scrape-agent.ts` (434 lines): `MAX_OUTPUT_TOKENS = 4096` (line 33), `FALLBACK_MODEL = "claude-sonnet-4-6"` (line 34), `ScrapeAgentError` (lines 36–49), `isRetryableOnFallback` (lines 56–60, fires only on `design_parse_failed`), `LlmDesignSubsetSchema` (lines 127–130, `DesignAnalysisSchema.omit({colors, logo})`), `DesignTokenScrapeResult` (lines 133–144, carries `usage: { design: Anthropic.Messages.Usage }` + `models: { design: AllowedModel }` — **zero readers repo-wide**, verified by grep), `runDesignTokenScrape` (182–224), `runDesignPass` (230–265), `runDesignPassOnce` (267–323, `messages.create` at 275–280, fenced-block extraction at 289–300), `extractJsonBlock` (330–338, **only caller is line 294 in this same file** — safe to delete), `DESIGN_SYSTEM` (361–391, demands a ```` ```json ```` fenced block), `buildDesignUserPrompt` (397–433: buttons unclamped per-item at 413–419, `h1` un-sliced at line 423, `h2.slice(0, 6)` at line 424).
- `apps/web/lib/inngest/functions/extract-project-design.ts` (128 lines): `createFunction({ id: "extract-project-design", retries: 0 }, { event: "project/design.requested" }, ...)` at 38–43 — **no idempotency/debounce/concurrency config**; `scrape` step 51–56; `persist` step 78–125 with `updatePayload = { design_tokens, personality }` at 91–94 and asset-path conditionals at 95–97; the chain is `.update(payload).eq("id", projectId).eq("tenant_id", tenantId).select("id")` (105–110).
- Dispatch sites for `project/design.requested`: `apps/web/lib/actions/onboarding.ts:218–232` (connectWp, fire-and-forget) and `apps/web/lib/inngest/functions/discover-site.ts:769–789` (`warn-design-tokens` step — dispatches whenever `design_tokens` is still null, i.e. exactly while an onboarding-dispatched run may still be in flight). This is the duplicate-dispatch race (audit scrape-agent issue 3).
- `apps/web/lib/ai/client.ts:21–31` — `getAnthropicClient()` singleton; scrape-agent already routes through it via `getClient()` (scrape-agent.ts:166–176). Unchanged by this phase.
- `apps/web/lib/ai/model.ts:64–78` — `getModelFor("design")` defaults to `claude-haiku-4-5-20251001` (DEFAULTS at 46–53).
- `@anthropic-ai/sdk` **0.95.1** (apps/web/package.json) supports structured outputs: `MessageCreateParams.output_config?: OutputConfig` with `format?: JSONOutputFormat` where `JSONOutputFormat = { type: 'json_schema'; schema: { [key: string]: unknown } }` (verified in `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:594–602, 796–806`). Per CONTRACTS: numeric min/max, minLength/maxLength, recursion are unsupported in the wire schema; `additionalProperties: false` is required on objects.
- `inngest` **3.27.x** supports `debounce: { key?: string; period: "..." }` and `idempotency?: string` on `createFunction` config (verified in `node_modules/inngest/types.d.ts:1384–1388`).
- `apps/web/lib/ai/scrape-errors.ts` needs **no change**: the `PublicErrorCode` union is decoupled from `ScrapeAgentError.code` (the old `toPublicError` mapper was deleted in Stage 0); `ai_failed`/`unknown` copy still covers every agent failure.
- Test runner: Vitest. From the repo root (`c:/Projects/wp-headless`): `pnpm --filter @jab/web test <path-relative-to-apps/web>` (the `test` script is `vitest run`; `vitest.setup.ts` already stubs `server-only`; the `@` alias resolves to `apps/web`).
- Existing Supabase-stub test pattern: `vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }))` (see `lib/db/auto-fail-stale-build.test.ts:14-15`).
- There are **no existing scrape tests** (`lib/ai/scrape-agent.test.ts` and `lib/inngest/functions/extract-project-design.test.ts` are both created by this plan).

## Decisions this plan locks in (with rationale)

1. **Fallback condition** (CONTRACTS left the exact condition to the drafter): the Haiku→Sonnet fallback fires iff `err instanceof ScrapeAgentError` AND (`err.code === "design_parse_failed"` OR (`err.code === "design_pass_failed"` AND `classifyAiError(err.cause) === "bad_request"`)). `design_parse_failed` now means only "JSON.parse failed on the raw response text" (max_tokens truncation / empty response) or "Zod safeParse miss" (constraints the wire schema can't express: confidence range, non-empty reasoning). `bad_request` is included because a 400 can be model-specific (e.g. a model rejecting the schema/request shape) and one escalation is cheap; every other `AiFailureKind` (`rate_limit`, `overloaded`, `server_error`, `connection`, `auth`, `unknown`) propagates exactly as today — paying Sonnet to retry a transport failure is waste.
2. **`DesignTokenScrapeResult.usage` and `.models` are replaced by `scrapeUsage: DesignScrapeUsage`.** Verified zero readers (`extract-project-design.ts` is the only consumer of the result and reads neither field). The new shape is exactly the CONTRACTS jsonb shape so the worker persists it verbatim.
3. **Duplicate-dispatch guard = Inngest `debounce { key: "event.data.projectId", period: "2m" }`**, NOT `idempotency`. Justification: Inngest idempotency dedupes events with the same key for 24 hours — that would break the worker's documented recovery path ("Manual re-trigger via re-running the probe", extract-project-design.ts:32–33) and the documented "latest write wins / user can re-run the probe" semantics (lines 35–36). Debounce coalesces all events sharing a `projectId` inside a rolling 2-minute window into ONE run executed with the **latest** event — which is literally "latest write wins" — while leaving later deliberate re-runs untouched. Cost of the guard: every extraction starts ~2 minutes after the last dispatch; acceptable because nothing blocks on this worker (onboarding is explicitly fire-and-forget, onboarding.ts:212–217) and the first consumer of design tokens is compose, which runs after multi-minute discovery + component generation.
4. **`MAX_OUTPUT_TOKENS` stays 4096** — generous for a ~400–800-token JSON payload and below the streaming threshold; not worth churn.
5. **No behavior flags in this phase.** The structured-outputs switch replaces the sync path outright (it is strictly more reliable, same call count); the debounce is config, not code path.

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/web/lib/ai/scrape-agent.ts` | Modify | `DESIGN_JSON_SCHEMA` wire schema; structured-outputs call; delete `extractJsonBlock`; new fallback condition via `classifyAiError`; `DesignScrapeUsage` telemetry (incl. wasted primary call); h1/h2/button prompt caps; export `buildDesignUserPrompt` for tests |
| `apps/web/lib/ai/scrape-agent.test.ts` | Create | Unit tests: schema invariants, structured-outputs request shape, parse/Zod failure classification, fallback branches, telemetry shapes, prompt caps |
| `apps/web/lib/inngest/functions/extract-project-design.ts` | Modify | Persist `design_scrape_usage` in the `persist` step; add per-project `debounce` config |
| `apps/web/lib/inngest/functions/extract-project-design.test.ts` | Create | Worker tests: telemetry lands in the update payload; debounce config asserted |
| `apps/web/lib/ai/scrape-errors.ts` | None (verified) | Public error copy is decoupled from agent codes — no change needed |
| `apps/web/lib/ai/scrape-extract.ts` | None (verified) | Caps land in the prompt builder, not the extractor — extractor output stays full-fidelity for debug/audit |

---

### Task 1: `DESIGN_JSON_SCHEMA` — the structured-outputs wire schema

**Files:**
- Modify: `apps/web/lib/ai/scrape-agent.ts` (insert after `LlmDesignSubsetSchema`, currently ending line 131)
- Test: Create `apps/web/lib/ai/scrape-agent.test.ts`

The wire schema is derived from `LlmDesignSubsetSchema` (scrape-agent.ts:127–130 — `typography` + `buttonPair` + `personality` only; colors/logo stay deterministic). Constraints the structured-outputs grammar does not support are stripped to the Zod layer: `z.number().min(0).max(1)` → bare `"number"`, `z.string().min(1)` → bare `"string"`. Everything expressible IS expressed: `additionalProperties: false` on every object, exhaustive `required`, `enum` for energy, `["string","null"]` for nullable values.

- [ ] Create `apps/web/lib/ai/scrape-agent.test.ts` with the schema-invariant suite (this is the whole file at this point — later tasks append to it):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Module mocks (shared by all suites in this file).
//
// scrape-agent imports `getAnthropicClient` from "./client" and
// `fetchHtmlSafely`/`ScrapeFetchError` from "./scrape-fetch". Both are
// mocked so no network/API key is ever touched. `extractFromHtml`,
// `pickColors`, `pickLogo`, Zod validation, and the fallback orchestration
// all run REAL.
// ---------------------------------------------------------------------------

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock("./client", () => ({
  getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
}));

vi.mock("./scrape-fetch", () => {
  class ScrapeFetchError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly cause?: unknown,
    ) {
      super(message);
      this.name = "ScrapeFetchError";
    }
  }
  return {
    ScrapeFetchError,
    fetchHtmlSafely: vi.fn(async () => ({
      finalUrl: "https://example.com/",
      html: `<html><head><title>Example Co</title></head><body><h1>Hello</h1><a class="btn" href="/book">Book now</a></body></html>`,
      contentType: "text/html",
      byteSize: 123,
    })),
  };
});

import {
  DESIGN_JSON_SCHEMA,
  runDesignTokenScrape,
  ScrapeAgentError,
} from "./scrape-agent";

beforeEach(() => {
  delete process.env.JAB_AI_MODEL;
  delete process.env.JAB_AI_MODEL_DESIGN;
  messagesCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A response payload that passes LlmDesignSubsetSchema. */
const VALID_SUBSET = {
  typography: {
    heading: { value: "Playfair Display", confidence: 0.9, reasoning: "heading samples [0]" },
    body: { value: null, confidence: 0, reasoning: "no body samples" },
  },
  buttonPair: {
    primary: { value: "Book now", confidence: 0.8, reasoning: "header CTA [0]" },
    secondary: { value: null, confidence: 0, reasoning: "no second CTA" },
  },
  personality: {
    tone: { value: "playful", confidence: 0.6, reasoning: "casual heading copy" },
    energy: { value: "high", confidence: 0.6, reasoning: "exclamatory copy" },
    audience: { value: "local customers", confidence: 0.5, reasoning: "headings" },
  },
};

/** Builds a minimal Anthropic Messages response. */
function apiResponse(
  text: string,
  overrides: { stop_reason?: string; input_tokens?: number; output_tokens?: number } = {},
) {
  return {
    content: [{ type: "text", text }],
    stop_reason: overrides.stop_reason ?? "end_turn",
    usage: {
      input_tokens: overrides.input_tokens ?? 900,
      output_tokens: overrides.output_tokens ?? 400,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Walks every plain-object node in a JSON schema. */
function walkSchema(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walkSchema(n, visit);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walkSchema(v, visit);
  }
}

/** Path-based accessor for schema nodes in assertions. */
function at(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], obj);
}

// ---------------------------------------------------------------------------
// Task 1 — wire schema invariants
// ---------------------------------------------------------------------------

describe("DESIGN_JSON_SCHEMA", () => {
  it("requires typography, buttonPair, personality at the top level", () => {
    expect(at(DESIGN_JSON_SCHEMA, ["type"])).toBe("object");
    expect([...(at(DESIGN_JSON_SCHEMA, ["required"]) as string[])].sort()).toEqual(
      ["buttonPair", "personality", "typography"],
    );
  });

  it("sets additionalProperties:false and exhaustive required on EVERY object node", () => {
    let objectNodes = 0;
    walkSchema(DESIGN_JSON_SCHEMA, (obj) => {
      if (obj.type === "object" && obj.properties) {
        objectNodes += 1;
        expect(obj.additionalProperties).toBe(false);
        expect([...(obj.required as string[])].sort()).toEqual(
          Object.keys(obj.properties as Record<string, unknown>).sort(),
        );
      }
    });
    // 1 root + 3 groups + 7 confidence-field objects
    expect(objectNodes).toBe(11);
  });

  it("contains NO numeric/length constraints (unsupported by structured outputs)", () => {
    const banned = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength"];
    walkSchema(DESIGN_JSON_SCHEMA, (obj) => {
      for (const key of banned) {
        expect(obj, `schema node must not carry "${key}"`).not.toHaveProperty(key);
      }
    });
  });

  it("pins the energy value to the low/medium/high enum", () => {
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "personality", "properties", "energy", "properties", "value", "enum",
      ]),
    ).toEqual(["low", "medium", "high"]);
  });

  it("models nullable values as type [string, null]", () => {
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "typography", "properties", "heading", "properties", "value", "type",
      ]),
    ).toEqual(["string", "null"]);
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "buttonPair", "properties", "secondary", "properties", "value", "type",
      ]),
    ).toEqual(["string", "null"]);
  });
});
```

- [ ] Run it and confirm the import failure: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected failure: `SyntaxError: The requested module './scrape-agent' does not provide an export named 'DESIGN_JSON_SCHEMA'`.
- [ ] Implement: in `apps/web/lib/ai/scrape-agent.ts`, insert the following immediately after the `LlmDesignSubsetSchema` block (after current line 131, before `export interface DesignTokenScrapeResult`):

```ts
// ---------------------------------------------------------------------------
// Structured-outputs wire schema
// ---------------------------------------------------------------------------

/** Builds the { value, confidence, reasoning } object shape used by every field. */
function confidenceFieldSchema(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      confidence: { type: "number" },
      reasoning: { type: "string" },
    },
    required: ["value", "confidence", "reasoning"],
    additionalProperties: false,
  };
}

/**
 * Wire schema for the design pass's structured output
 * (`output_config.format` with `type: "json_schema"`).
 *
 * Derived from `LlmDesignSubsetSchema`. Constraints structured outputs
 * cannot express are deliberately ABSENT here and enforced by Zod
 * `safeParse` after parsing instead:
 *   - `confidence` z.number().min(0).max(1)  → bare "number" on the wire
 *   - `reasoning` / `value` z.string().min(1) → bare "string" on the wire
 *
 * Everything structurally expressible IS expressed: additionalProperties
 * false on every object, exhaustive `required`, the energy enum, and
 * ["string","null"] unions for nullable values. A Zod miss is therefore
 * rare (empty reasoning string or out-of-range confidence) and is what
 * keeps the Haiku→Sonnet fallback as a residual escape hatch.
 */
export const DESIGN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    typography: {
      type: "object",
      properties: {
        heading: confidenceFieldSchema({ type: ["string", "null"] }),
        body: confidenceFieldSchema({ type: ["string", "null"] }),
      },
      required: ["heading", "body"],
      additionalProperties: false,
    },
    buttonPair: {
      type: "object",
      properties: {
        primary: confidenceFieldSchema({ type: ["string", "null"] }),
        secondary: confidenceFieldSchema({ type: ["string", "null"] }),
      },
      required: ["primary", "secondary"],
      additionalProperties: false,
    },
    personality: {
      type: "object",
      properties: {
        tone: confidenceFieldSchema({ type: "string" }),
        energy: confidenceFieldSchema({ type: "string", enum: ["low", "medium", "high"] }),
        audience: confidenceFieldSchema({ type: "string" }),
      },
      required: ["tone", "energy", "audience"],
      additionalProperties: false,
    },
  },
  required: ["typography", "buttonPair", "personality"],
  additionalProperties: false,
};
```

- [ ] Run the suite again: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected: the 5 `DESIGN_JSON_SCHEMA` tests PASS.
- [ ] Commit:
  - `git add apps/web/lib/ai/scrape-agent.ts apps/web/lib/ai/scrape-agent.test.ts`
  - `git commit -m "feat(saas): DESIGN_JSON_SCHEMA wire schema for design-pass structured outputs"`

---

### Task 2: Switch the design pass to structured outputs; retire `extractJsonBlock`

**Files:**
- Modify: `apps/web/lib/ai/scrape-agent.ts` — `runDesignPassOnce` (currently lines 267–323), `extractJsonBlock` (currently lines 330–338, DELETE — verified only caller is line 294 in this file), `DESIGN_SYSTEM` (currently lines 361–391)
- Test: `apps/web/lib/ai/scrape-agent.test.ts` (append)

After this task the response text IS the JSON document. `design_parse_failed` becomes the rare arm: JSON.parse failure (max_tokens truncation mid-JSON / empty response) or Zod miss. The "no json code block" failure class is deleted along with the regex.

- [ ] Append this suite to `apps/web/lib/ai/scrape-agent.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Task 2 — structured-outputs call path
// ---------------------------------------------------------------------------

describe("runDesignPassOnce via runDesignTokenScrape — structured outputs", () => {
  it("sends output_config json_schema and parses the bare-JSON response", async () => {
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const params = messagesCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe("claude-haiku-4-5-20251001"); // design default
    expect(params.max_tokens).toBe(4096);
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: DESIGN_JSON_SCHEMA },
    });
    // The LLM subset lands merged with deterministic colors/logo.
    expect(result.design.typography.heading.value).toBe("Playfair Display");
    expect(result.design.personality.energy.value).toBe("high");
    expect(result.design.colors.primary).toBeDefined(); // deterministic, not from the LLM
  });

  it("no longer requires a ```json fenced block in the system prompt", async () => {
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));
    await runDesignTokenScrape({ url: "https://example.com" });
    const params = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(params.system).not.toContain("```json");
  });

  it("classifies malformed JSON (e.g. max_tokens truncation) as design_parse_failed", async () => {
    // Pin the design task to the fallback model so the fallback guard
    // (primary !== FALLBACK_MODEL) suppresses the second call and the
    // classification surfaces directly.
    process.env.JAB_AI_MODEL_DESIGN = "claude-sonnet-4-6";
    messagesCreate.mockResolvedValueOnce(
      apiResponse('{"typography": {"heading": {"valu', { stop_reason: "max_tokens" }),
    );

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      name: "ScrapeAgentError",
      code: "design_parse_failed",
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("classifies a Zod miss (constraints the wire schema can't express) as design_parse_failed", async () => {
    process.env.JAB_AI_MODEL_DESIGN = "claude-sonnet-4-6";
    // confidence 2 violates z.number().max(1) — valid per wire schema,
    // invalid per Zod.
    const bad = structuredClone(VALID_SUBSET);
    bad.typography.heading.confidence = 2;
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(bad)));

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      name: "ScrapeAgentError",
      code: "design_parse_failed",
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected failures: "sends output_config…" fails (today `params.output_config` is `undefined`, and the bare-JSON response has no fenced block so the current code throws `design_parse_failed`); "no longer requires…" fails (the current `DESIGN_SYSTEM` contains ```` ```json ````).
- [ ] Implement — replace `runDesignPassOnce` (current lines 267–323) in full:

```ts
async function runDesignPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ subset: LlmDesignSubset; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
      // Structured outputs: the API constrains generation to
      // DESIGN_JSON_SCHEMA, so the response text IS the JSON document —
      // no fences, no prose, no regex extraction.
      output_config: { format: { type: "json_schema", schema: DESIGN_JSON_SCHEMA } },
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "design_pass_failed",
      err,
    );
  }

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // design_parse_failed is now the RARE arm: with structured outputs the
  // only ways JSON.parse can fail are a max_tokens truncation mid-JSON or
  // an empty response.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fullText);
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass JSON.parse failed (stop_reason=${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }. First 200 chars: ${fullText.slice(0, 200)}`,
      "design_parse_failed",
      err,
    );
  }

  // Zod re-validates the constraints the wire schema can't express
  // (confidence range, non-empty reasoning). Keep LlmDesignSubsetSchema in
  // strip (non-strict) mode — see its docblock.
  const result = LlmDesignSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
    );
  }

  return { subset: result.data, usage: response.usage, model };
}
```

- [ ] Delete `extractJsonBlock` entirely (current lines 325–338 including its docblock). Verified: its only caller was the block replaced above.
- [ ] Replace `DESIGN_SYSTEM` (current lines 361–391) in full — the fenced-block demand goes away; the shape illustration stays (it teaches field SEMANTICS; the schema enforces structure); one rule is added nudging non-empty reasoning (the one residual Zod-miss class):

```ts
const DESIGN_SYSTEM = `You are a design analyst. Given structured extracts from a website (font samples, button text, headings), you classify the site's typography choices, CTA hierarchy, and brand personality.

You respond with a single JSON object matching the response schema. For reference, the shape is:

{
  "typography": {
    "heading": { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." },
    "body":    { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." }
  },
  "buttonPair": {
    "primary":   { "value": "..." | null, "confidence": 0.0, "reasoning": "..." },
    "secondary": { "value": "..." | null, "confidence": 0.0, "reasoning": "..." }
  },
  "personality": {
    "tone":     { "value": "...", "confidence": 0.0, "reasoning": "One short phrase: playful / serious / luxe / utilitarian / etc." },
    "energy":   { "value": "low" | "medium" | "high", "confidence": 0.0, "reasoning": "..." },
    "audience": { "value": "...", "confidence": 0.0, "reasoning": "Who is this site for, in one phrase." }
  }
}

Rules:
- Confidence is a number between 0 and 1. Be honest about uncertainty — under-claim, not over-claim.
- Reasoning must cite the actual evidence ("the heading samples are all in Playfair Display" / "the 'Book a discovery call' button is the only one in the header region") — not generic justifications. Reasoning must never be an empty string.
- Typography: pick from the font samples provided. The model may NOT invent a family name that isn't in the input.
- ButtonPair: primary is the single most prominent CTA (header / hero region preferred). Secondary is the next-most-prominent if one exists; null otherwise.
- Personality: infer from the headings, button copy, and overall content register. Audience is "who is this site for, in one phrase."
- If you genuinely cannot infer a field, set its value to null and confidence to 0.`;
```

- [ ] Update the `ScrapeAgentError` docblock context: in the class (lines 36–49) add one comment line above the `"design_parse_failed"` union member: `// rare under structured outputs: JSON.parse failure (truncation) or Zod miss` (keep the union itself unchanged — `scrape-errors.ts` is decoupled and needs no edit).
- [ ] Run the suite: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected: all Task 1 + Task 2 tests PASS.
- [ ] Typecheck (the `output_config` param shape must satisfy SDK 0.95.1): `pnpm --filter @jab/web typecheck` — expected: clean.
- [ ] Commit:
  - `git add apps/web/lib/ai/scrape-agent.ts apps/web/lib/ai/scrape-agent.test.ts`
  - `git commit -m "feat(saas): design pass uses structured outputs; retire extractJsonBlock"`

---

### Task 3: Fallback condition rewrite — Zod miss or bad_request only

**Files:**
- Modify: `apps/web/lib/ai/scrape-agent.ts` — imports (line 1–8 region) + `isRetryableOnFallback` (currently lines 51–60)
- Test: `apps/web/lib/ai/scrape-agent.test.ts` (append)

Depends on Phase 1's `apps/web/lib/ai/errors.ts` exporting `classifyAiError(err: unknown): AiFailureKind` (CONTRACTS). Transport errors (`rate_limit`, `overloaded`, `connection`, `server_error`, `auth`) keep propagating without a second paid call.

- [ ] Append this suite to `apps/web/lib/ai/scrape-agent.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Task 3 — fallback condition
// ---------------------------------------------------------------------------

function badRequestError(message = "schema rejected"): InstanceType<typeof Anthropic.BadRequestError> {
  return new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message } },
    message,
    new Headers(),
  );
}

function rateLimitError(): InstanceType<typeof Anthropic.RateLimitError> {
  return new Anthropic.RateLimitError(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
    "rate limited",
    new Headers(),
  );
}

describe("Haiku→Sonnet fallback condition", () => {
  it("falls back to Sonnet on a Zod-validation miss", async () => {
    const bad = structuredClone(VALID_SUBSET);
    bad.personality.tone.reasoning = ""; // violates z.string().min(1)
    messagesCreate
      .mockResolvedValueOnce(apiResponse(JSON.stringify(bad)))
      .mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect((messagesCreate.mock.calls[0]![0] as { model: string }).model).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect((messagesCreate.mock.calls[1]![0] as { model: string }).model).toBe(
      "claude-sonnet-4-6",
    );
    expect(result.design.typography.heading.value).toBe("Playfair Display");
  });

  it("falls back to Sonnet on an API bad_request", async () => {
    messagesCreate
      .mockRejectedValueOnce(badRequestError())
      .mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect((messagesCreate.mock.calls[1]![0] as { model: string }).model).toBe(
      "claude-sonnet-4-6",
    );
    expect(result.design.buttonPair.primary.value).toBe("Book now");
  });

  it("propagates transport failures (rate_limit) WITHOUT a second call", async () => {
    messagesCreate.mockRejectedValueOnce(rateLimitError());

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      name: "ScrapeAgentError",
      code: "design_pass_failed",
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT double-call when the primary is already the fallback model", async () => {
    process.env.JAB_AI_MODEL_DESIGN = "claude-sonnet-4-6";
    messagesCreate.mockRejectedValueOnce(badRequestError());

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      code: "design_pass_failed",
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected failure: "falls back to Sonnet on an API bad_request" fails (today a `bad_request` is wrapped as `design_pass_failed` and propagates — only 1 call made). The other three should already pass; confirm they do (they pin the pre-existing behavior this task must not break).
- [ ] Implement — in `apps/web/lib/ai/scrape-agent.ts`, add the import (after the existing `import { getAnthropicClient } from "./client";` on line 8):

```ts
import { classifyAiError } from "./errors";
```

  Then replace `isRetryableOnFallback` (current lines 51–60, including its docblock) in full:

```ts
/**
 * Fallback classifier — true means "escalating the identical prompt to
 * FALLBACK_MODEL could plausibly fix it":
 *
 *   - `design_parse_failed` — output-shape failure. Rare under structured
 *     outputs (JSON.parse failure on a truncated/empty response, or a Zod
 *     miss on the constraints the wire schema can't express); a stronger
 *     model may produce a valid shape.
 *   - `design_pass_failed` whose cause classifies as `bad_request` — a 400
 *     can be model-specific (request/schema shape rejection), so one
 *     escalation is worth a single try.
 *
 * Everything else — rate_limit, overloaded, server_error, connection,
 * auth, unknown — is not the model's fault: paying for a Sonnet retry of a
 * transport/env failure is pure waste, so those propagate unchanged.
 */
function isRetryableOnFallback(err: unknown): boolean {
  if (!(err instanceof ScrapeAgentError)) return false;
  if (err.code === "design_parse_failed") return true;
  return err.code === "design_pass_failed" && classifyAiError(err.cause) === "bad_request";
}
```

- [ ] Run the suite: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected: all tests PASS.
- [ ] Commit:
  - `git add apps/web/lib/ai/scrape-agent.ts apps/web/lib/ai/scrape-agent.test.ts`
  - `git commit -m "feat(saas): design-pass fallback fires only on output miss or bad_request"`

---

### Task 4: `DesignScrapeUsage` telemetry — including the wasted primary call

**Files:**
- Modify: `apps/web/lib/ai/scrape-agent.ts` — `ScrapeAgentError` (lines 36–49), `DesignTokenScrapeResult` (lines 133–144), `runDesignTokenScrape` return (lines 215–223), `runDesignPass` (lines 230–265), `runDesignPassOnce` (the Task 2 version)
- Test: `apps/web/lib/ai/scrape-agent.test.ts` (append)

The result type's dead `usage`/`models` fields (zero readers, verified) are REPLACED by `scrapeUsage: DesignScrapeUsage` — exactly the CONTRACTS jsonb shape for `projects.design_scrape_usage`: `{ primary: { model, inputTokens, outputTokens }, fallback?: { model, inputTokens, outputTokens }, fallbackUsed: boolean, at: ISO timestamp }`. When the fallback fires after a completed-but-invalid primary response, the primary's real usage is recorded (it was billed); when the primary call itself errored (`bad_request` — no usable response object), zeros are recorded.

- [ ] Append this suite to `apps/web/lib/ai/scrape-agent.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Task 4 — scrapeUsage telemetry
// ---------------------------------------------------------------------------

describe("scrapeUsage telemetry", () => {
  it("happy path: primary usage only, fallbackUsed false", async () => {
    messagesCreate.mockResolvedValueOnce(
      apiResponse(JSON.stringify(VALID_SUBSET), { input_tokens: 901, output_tokens: 402 }),
    );

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(result.scrapeUsage.primary).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 901,
      outputTokens: 402,
    });
    expect(result.scrapeUsage.fallback).toBeUndefined();
    expect(result.scrapeUsage.fallbackUsed).toBe(false);
    expect(Number.isNaN(Date.parse(result.scrapeUsage.at))).toBe(false);
  });

  it("Zod-miss fallback: records the WASTED primary usage and the fallback usage", async () => {
    const bad = structuredClone(VALID_SUBSET);
    bad.personality.tone.reasoning = "";
    messagesCreate
      .mockResolvedValueOnce(
        apiResponse(JSON.stringify(bad), { input_tokens: 900, output_tokens: 410 }),
      )
      .mockResolvedValueOnce(
        apiResponse(JSON.stringify(VALID_SUBSET), { input_tokens: 905, output_tokens: 432 }),
      );

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(result.scrapeUsage).toEqual({
      primary: { model: "claude-haiku-4-5-20251001", inputTokens: 900, outputTokens: 410 },
      fallback: { model: "claude-sonnet-4-6", inputTokens: 905, outputTokens: 432 },
      fallbackUsed: true,
      at: result.scrapeUsage.at,
    });
  });

  it("bad_request fallback: primary usage is zeros (the call returned no response)", async () => {
    messagesCreate
      .mockRejectedValueOnce(badRequestError())
      .mockResolvedValueOnce(
        apiResponse(JSON.stringify(VALID_SUBSET), { input_tokens: 910, output_tokens: 420 }),
      );

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(result.scrapeUsage.primary).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result.scrapeUsage.fallback).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 910,
      outputTokens: 420,
    });
    expect(result.scrapeUsage.fallbackUsed).toBe(true);
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected failure: `result.scrapeUsage` is `undefined` (TypeScript will also fail compilation of the test until the type exists — either failure mode is the expected red).
- [ ] Implement. Five edits to `apps/web/lib/ai/scrape-agent.ts`:

**(a)** Replace the `ScrapeAgentError` class (lines 36–49) in full — adds an optional `usage` carrying what the failed-validation call cost:

```ts
export class ScrapeAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "fetch_failed"
      | "extract_failed"
      | "design_pass_failed"
      // rare under structured outputs: JSON.parse failure (truncation) or Zod miss
      | "design_parse_failed",
    public readonly cause?: unknown,
    /**
     * Usage of the API call whose OUTPUT failed validation, when a response
     * completed (it was billed — the fallback path must account for it in
     * design_scrape_usage). Undefined when the call itself errored: no
     * response object, nothing to read.
     */
    public readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = "ScrapeAgentError";
  }
}
```

**(b)** Add the telemetry types right after the `LlmDesignSubset` type (after current line 131, before the Task 1 schema block):

```ts
/** Per-call token usage in the shape persisted to projects.design_scrape_usage. */
interface DesignCallUsage {
  inputTokens: number;
  outputTokens: number;
}

function toCallUsage(usage: Anthropic.Messages.Usage): DesignCallUsage {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/**
 * Cost/fallback telemetry for the design pass — one entry per API call
 * actually dispatched. When the Haiku→Sonnet fallback fires, `primary`
 * records the WASTED first call (real usage when its response completed
 * but failed validation; zeros when the call itself errored) so the
 * fallback's true cost (primary + fallback) is never invisible.
 * Persisted verbatim to projects.design_scrape_usage (jsonb) by
 * extract-project-design.
 */
export interface DesignScrapeUsage {
  primary: { model: string; inputTokens: number; outputTokens: number };
  fallback?: { model: string; inputTokens: number; outputTokens: number };
  fallbackUsed: boolean;
  /** ISO timestamp of when the design pass completed. */
  at: string;
}
```

**(c)** Replace `DesignTokenScrapeResult` (lines 133–144) in full — `usage`/`models` out, `scrapeUsage` in:

```ts
export interface DesignTokenScrapeResult {
  /** The final URL after redirects. */
  url: string;
  fetchedAt: string;
  byteSize: number;
  /** Deterministic extract — useful for debug + audit; also persisted alongside the JSON for "what did the model see?" introspection. */
  extract: ScrapeExtract;
  design: DesignAnalysis;
  /** Cost/fallback telemetry — persisted to projects.design_scrape_usage. */
  scrapeUsage: DesignScrapeUsage;
}
```

**(d)** Replace the return statement of `runDesignTokenScrape` (current lines 215–223) in full:

```ts
  return {
    url: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    byteSize: fetched.byteSize,
    extract,
    design: designOutcome.design,
    scrapeUsage: designOutcome.scrapeUsage,
  };
```

**(e)** Replace `runDesignPass` (current lines 230–265) and the Task 2 version of `runDesignPassOnce` in full:

```ts
async function runDesignPass(
  extract: ScrapeExtract,
  label?: string,
): Promise<{ design: DesignAnalysis; scrapeUsage: DesignScrapeUsage }> {
  // Deterministic first — these never fail, never call the network.
  const colors = pickColors(extract);
  const logo = pickLogo(extract.images);

  // LLM handles the remaining fields (typography / buttonPair / personality).
  // Output failure + bad_request retry on Sonnet; transport failure propagates.
  const primary = getModelFor("design");
  let llmResult: { subset: LlmDesignSubset; usage: DesignCallUsage; model: AllowedModel };
  let scrapeUsage: DesignScrapeUsage;
  try {
    llmResult = await runDesignPassOnce(extract, primary);
    scrapeUsage = {
      primary: { model: primary, ...llmResult.usage },
      fallbackUsed: false,
      at: new Date().toISOString(),
    };
  } catch (err) {
    if (isRetryableOnFallback(err) && primary !== FALLBACK_MODEL) {
      const tag = label ? `[scrape-agent ${label}]` : "[scrape-agent]";
      console.warn(
        `${tag} design pass falling back ${primary} → ${FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // The wasted primary call's usage: real numbers when a response
      // completed but failed validation (it was billed); zeros when the
      // call itself errored (bad_request — no response to read).
      const wasted: DesignCallUsage =
        err instanceof ScrapeAgentError && err.usage
          ? err.usage
          : { inputTokens: 0, outputTokens: 0 };
      llmResult = await runDesignPassOnce(extract, FALLBACK_MODEL);
      scrapeUsage = {
        primary: { model: primary, ...wasted },
        fallback: { model: FALLBACK_MODEL, ...llmResult.usage },
        fallbackUsed: true,
        at: new Date().toISOString(),
      };
    } else {
      throw err;
    }
  }

  return {
    design: {
      colors,
      logo,
      ...llmResult.subset,
    },
    scrapeUsage,
  };
}

async function runDesignPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ subset: LlmDesignSubset; usage: DesignCallUsage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
      // Structured outputs: the API constrains generation to
      // DESIGN_JSON_SCHEMA, so the response text IS the JSON document —
      // no fences, no prose, no regex extraction.
      output_config: { format: { type: "json_schema", schema: DESIGN_JSON_SCHEMA } },
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "design_pass_failed",
      err,
    );
  }

  const usage = toCallUsage(response.usage);

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // design_parse_failed is now the RARE arm: with structured outputs the
  // only ways JSON.parse can fail are a max_tokens truncation mid-JSON or
  // an empty response. The completed call WAS billed — attach its usage so
  // the fallback path can account for the waste.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fullText);
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass JSON.parse failed (stop_reason=${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }. First 200 chars: ${fullText.slice(0, 200)}`,
      "design_parse_failed",
      err,
      usage,
    );
  }

  // Zod re-validates the constraints the wire schema can't express
  // (confidence range, non-empty reasoning). Keep LlmDesignSubsetSchema in
  // strip (non-strict) mode — see its docblock.
  const result = LlmDesignSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
      usage,
    );
  }

  return { subset: result.data, usage, model };
}
```

Also update the `// 3) Design pass` call site in `runDesignTokenScrape` (line 213) — unchanged code, but verify it reads `const designOutcome = await runDesignPass(extract, input.label);` (it does; only the returned shape changed).

- [ ] Run the suite: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected: all tests PASS (the Task 2/3 suites also keep passing — they don't touch `usage`/`models`).
- [ ] Typecheck (confirms no other file read the deleted `usage`/`models` fields): `pnpm --filter @jab/web typecheck` — expected: clean.
- [ ] Commit:
  - `git add apps/web/lib/ai/scrape-agent.ts apps/web/lib/ai/scrape-agent.test.ts`
  - `git commit -m "feat(saas): scrape-agent returns DesignScrapeUsage incl. wasted primary call"`

---

### Task 5: Persist `projects.design_scrape_usage` from the worker

**Files:**
- Modify: `apps/web/lib/inngest/functions/extract-project-design.ts` — `persist` step `updatePayload` (currently lines 91–94)
- Test: Create `apps/web/lib/inngest/functions/extract-project-design.test.ts`

Prerequisite: Phase 1's migration `0034_ai_cost_telemetry.sql` (`ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_scrape_usage jsonb;`) must be applied to BOTH Supabase projects before live runs — locally the unit test needs nothing. Note `scrape` crosses an Inngest `step.run` boundary (JSON-serialized); `DesignScrapeUsage` is plain JSON, so it round-trips losslessly.

- [ ] Create `apps/web/lib/inngest/functions/extract-project-design.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Capture the Inngest function config + handler ──────────────────────────
const { createFunctionMock, captured } = vi.hoisted(() => {
  const captured: {
    config?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
    handler?: (ctx: unknown) => Promise<unknown>;
  } = {};
  const createFunctionMock = vi.fn(
    (
      config: Record<string, unknown>,
      trigger: Record<string, unknown>,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => {
      captured.config = config;
      captured.trigger = trigger;
      captured.handler = handler;
      return { config, trigger, handler };
    },
  );
  return { createFunctionMock, captured };
});
vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: createFunctionMock },
}));

// ── Scrape result fixture ───────────────────────────────────────────────────
const { scrapeUsageFixture, runDesignTokenScrapeMock } = vi.hoisted(() => {
  const scrapeUsageFixture = {
    primary: { model: "claude-haiku-4-5-20251001", inputTokens: 900, outputTokens: 410 },
    fallback: { model: "claude-sonnet-4-6", inputTokens: 905, outputTokens: 432 },
    fallbackUsed: true,
    at: "2026-06-10T12:00:00.000Z",
  };
  const runDesignTokenScrapeMock = vi.fn(async () => ({
    url: "https://example.com/",
    fetchedAt: "2026-06-10T12:00:00.000Z",
    byteSize: 4096,
    extract: { faviconUrl: null, socialImage: null },
    design: {
      colors: {
        primary: { value: "#112233", confidence: 0.85, reasoning: "rank 1" },
        secondary: { value: null, confidence: 0, reasoning: "none" },
        accent: { value: null, confidence: 0, reasoning: "none" },
      },
      logo: { src: null, confidence: 0, reasoning: "no <img> tags found on page" },
      typography: {
        heading: { value: "Playfair Display", confidence: 0.9, reasoning: "[0]" },
        body: { value: null, confidence: 0, reasoning: "no body samples" },
      },
      buttonPair: {
        primary: { value: "Book now", confidence: 0.8, reasoning: "[0]" },
        secondary: { value: null, confidence: 0, reasoning: "none" },
      },
      personality: {
        tone: { value: "warm", confidence: 0.6, reasoning: "copy register" },
        energy: { value: "medium", confidence: 0.6, reasoning: "copy register" },
        audience: { value: "homeowners", confidence: 0.5, reasoning: "headings" },
      },
    },
    scrapeUsage: scrapeUsageFixture,
  }));
  return { scrapeUsageFixture, runDesignTokenScrapeMock };
});
vi.mock("@/lib/ai/scrape-agent", () => ({
  runDesignTokenScrape: runDesignTokenScrapeMock,
}));

vi.mock("@/lib/ai/asset-capture", () => ({
  captureAssets: vi.fn(async () => ({
    logoPath: null,
    faviconPath: null,
    ogImagePath: null,
    failures: {},
  })),
}));

// ── Supabase admin stub: .update(payload).eq().eq().select() ───────────────
const { dbState, fromMock } = vi.hoisted(() => {
  const dbState: { updatePayload: Record<string, unknown> | null } = { updatePayload: null };
  const fromMock = vi.fn(() => ({
    update: (payload: Record<string, unknown>) => {
      dbState.updatePayload = payload;
      return {
        eq: () => ({
          eq: () => ({
            select: async () => ({ data: [{ id: "p1" }], error: null }),
          }),
        }),
      };
    },
  }));
  return { dbState, fromMock };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

// Importing the module runs the (mocked) createFunction registration.
import "@/lib/inngest/functions/extract-project-design";

function makeStep() {
  return {
    run: async <T>(_name: string, f: () => Promise<T> | T): Promise<T> => f(),
  };
}

describe("extractProjectDesign worker", () => {
  beforeEach(() => {
    dbState.updatePayload = null;
  });

  it("persists design_scrape_usage from the scrape result, alongside design_tokens + personality", async () => {
    await captured.handler!({
      event: { data: { projectId: "p1", tenantId: "t1", wpUrl: "https://example.com" } },
      step: makeStep(),
    });

    expect(dbState.updatePayload).not.toBeNull();
    expect(dbState.updatePayload!.design_scrape_usage).toEqual(scrapeUsageFixture);
    // Pre-existing split behavior unchanged: personality on its own column,
    // the rest in design_tokens; no asset paths when capture returned nulls.
    expect(dbState.updatePayload!).toHaveProperty("design_tokens");
    expect(dbState.updatePayload!).toHaveProperty("personality");
    expect(dbState.updatePayload!).not.toHaveProperty("logo_storage_path");
    expect(Object.keys(dbState.updatePayload!).sort()).toEqual(
      ["design_scrape_usage", "design_tokens", "personality"],
    );
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/inngest/functions/extract-project-design.test.ts` — expected failure: `design_scrape_usage` is `undefined` in the captured payload (and the exact-keys assertion fails listing only `design_tokens`/`personality`).
- [ ] Implement — in `apps/web/lib/inngest/functions/extract-project-design.ts`, replace the `updatePayload` declaration (current lines 91–94) with:

```ts
      const updatePayload: Record<string, unknown> = {
        design_tokens: designTokens,
        personality,
        // Cost/fallback telemetry for the design pass — includes the wasted
        // primary call's usage when the Haiku→Sonnet fallback fired.
        // Column: migration 0034_ai_cost_telemetry.sql (jsonb).
        design_scrape_usage: scrape.scrapeUsage,
      };
```

- [ ] Run it: `pnpm --filter @jab/web test lib/inngest/functions/extract-project-design.test.ts` — expected: PASS.
- [ ] Typecheck: `pnpm --filter @jab/web typecheck` — expected: clean.
- [ ] Commit:
  - `git add apps/web/lib/inngest/functions/extract-project-design.ts apps/web/lib/inngest/functions/extract-project-design.test.ts`
  - `git commit -m "feat(saas): persist projects.design_scrape_usage from extract-project-design"`

---

### Task 6: Prompt caps — h1 `slice(0, 6)` + 200-char per-item clamps

**Files:**
- Modify: `apps/web/lib/ai/scrape-agent.ts` — `buildDesignUserPrompt` (currently lines 397–433: buttons loop at 413–419, h1 loop at line 423, h2 at 424) + export it for tests
- Test: `apps/web/lib/ai/scrape-agent.test.ts` (append)

Closes audit scrape-agent issue 4: `h1` is emitted unbounded in count AND length while `h2` is count-capped only; button text has no per-item length cap either. The clamp lives in the prompt builder (not `scrape-extract.ts`) so the persisted extract keeps full fidelity for debug/audit.

- [ ] Append this suite to `apps/web/lib/ai/scrape-agent.test.ts`, and add `buildDesignUserPrompt` to the import list from `./scrape-agent` at the top of the file (the import statement becomes `import { DESIGN_JSON_SCHEMA, runDesignTokenScrape, ScrapeAgentError, buildDesignUserPrompt } from "./scrape-agent";`):

```ts
// ---------------------------------------------------------------------------
// Task 6 — prompt caps
// ---------------------------------------------------------------------------

import type { ScrapeExtract } from "./scrape-extract";

function makeExtract(overrides: Partial<ScrapeExtract> = {}): ScrapeExtract {
  return {
    url: "https://example.com/",
    title: "Example Co",
    description: null,
    h1: [],
    h2: [],
    sections: [],
    navLinks: [],
    footerText: null,
    images: [],
    socialImage: null,
    faviconUrl: null,
    paletteSamples: [],
    fontSamples: ["Playfair Display"],
    buttons: [],
    ...overrides,
  };
}

describe("buildDesignUserPrompt caps", () => {
  it("emits at most 6 h1 lines and 6 h2 lines", () => {
    const extract = makeExtract({
      h1: Array.from({ length: 10 }, (_, i) => `Heading One ${i}`),
      h2: Array.from({ length: 10 }, (_, i) => `Heading Two ${i}`),
    });
    const prompt = buildDesignUserPrompt(extract);
    expect(prompt.match(/^- h1: /gm)).toHaveLength(6);
    expect(prompt.match(/^- h2: /gm)).toHaveLength(6);
    expect(prompt).not.toContain("Heading One 6");
    expect(prompt).not.toContain("Heading Two 6");
  });

  it("clamps each h1/h2 item to 200 chars", () => {
    const long = "x".repeat(500);
    const prompt = buildDesignUserPrompt(makeExtract({ h1: [long], h2: [long] }));
    expect(prompt).toContain(`- h1: ${"x".repeat(200)}`);
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("clamps button text to 200 chars per item", () => {
    const longBtn = "b".repeat(500);
    const prompt = buildDesignUserPrompt(
      makeExtract({ buttons: [{ text: longBtn, href: "/x", region: "header" }] }),
    );
    expect(prompt).toContain(`"${"b".repeat(200)}"`);
    expect(prompt).not.toContain("b".repeat(201));
  });

  it("leaves short items untouched", () => {
    const prompt = buildDesignUserPrompt(
      makeExtract({
        h1: ["Welcome"],
        buttons: [{ text: "Book now", href: null, region: "header" }],
      }),
    );
    expect(prompt).toContain("- h1: Welcome");
    expect(prompt).toContain('[0] "Book now" (header)');
  });
});
```

- [ ] Run it: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected failure: `SyntaxError: The requested module './scrape-agent' does not provide an export named 'buildDesignUserPrompt'`.
- [ ] Implement — in `apps/web/lib/ai/scrape-agent.ts`, add the constants right above `buildDesignUserPrompt` and replace the function (current lines 397–433) in full, now exported:

```ts
/**
 * Per-item clamp for free-text strings riding into the design prompt.
 * The extractor already count-caps buttons (12) and fonts (8); headings
 * and button TEXT length were the remaining unbounded inputs — broken CMS
 * markup commonly emits dozens of h1s (every card title), each of which
 * used to ride into the Haiku input uncapped.
 */
const MAX_PROMPT_ITEM_CHARS = 200;
const MAX_HEADINGS = 6;

function clampItem(s: string): string {
  return s.length > MAX_PROMPT_ITEM_CHARS ? s.slice(0, MAX_PROMPT_ITEM_CHARS) : s;
}

/** Exported for unit tests only — not part of the module's public API. */
export function buildDesignUserPrompt(extract: ScrapeExtract): string {
  const lines: string[] = [];

  lines.push("Source URL:", extract.url, "");
  if (extract.title) lines.push("Title:", extract.title, "");
  if (extract.description) lines.push("Description:", extract.description);
  lines.push("");

  if (extract.fontSamples.length > 0) {
    lines.push("Font-family samples (frequency-ranked):");
    extract.fontSamples.forEach((f, i) => lines.push(`[${i}] ${f}`));
  } else {
    lines.push("Font-family samples: NONE found in inline styles");
  }
  lines.push("");

  if (extract.buttons.length > 0) {
    lines.push("Button-like elements (for primary/secondary CTA classification):");
    extract.buttons.forEach((b, i) =>
      lines.push(`[${i}] "${clampItem(b.text)}" (${b.region})${b.href ? ` → ${b.href}` : ""}`),
    );
    lines.push("");
  }

  if (extract.h1.length > 0 || extract.h2.length > 0) {
    lines.push("Headings (for personality inference):");
    extract.h1.slice(0, MAX_HEADINGS).forEach((h) => lines.push(`- h1: ${clampItem(h)}`));
    extract.h2.slice(0, MAX_HEADINGS).forEach((h) => lines.push(`- h2: ${clampItem(h)}`));
    lines.push("");
  }

  lines.push(
    "Produce the design JSON now. Cite the indexed evidence in your reasoning.",
  );

  return lines.join("\n");
}
```

  Also update the do-not-casually-edit comment block above the prompts (current lines 355–358): change the line `//   - h2 slice cap (first 6) so the user-prompt payload stays bounded for` to `//   - h1/h2 slice cap (first 6 each) + 200-char per-item clamp (headings` and the following line `//     large pages with deep section trees.` to `//     and button text) so the user-prompt payload stays bounded.`
- [ ] Run the full file suite: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts` — expected: all PASS.
- [ ] Commit:
  - `git add apps/web/lib/ai/scrape-agent.ts apps/web/lib/ai/scrape-agent.test.ts`
  - `git commit -m "feat(saas): clamp design-prompt h1/h2/button items (6 items, 200 chars)"`

---

### Task 7: Duplicate-dispatch guard — per-project debounce on `extract-project-design`

**Files:**
- Modify: `apps/web/lib/inngest/functions/extract-project-design.ts` — `createFunction` config (currently lines 38–43) + docblock (lines 30–36)
- Test: `apps/web/lib/inngest/functions/extract-project-design.test.ts` (append)

**Decision (justification per assignment):** `debounce: { key: "event.data.projectId", period: "2m" }` — NOT Inngest `idempotency`. Idempotency dedupes same-key events for 24 hours, which would break the worker's two documented behaviors: "Manual re-trigger via re-running the probe is the recovery path" (lines 32–33) and "Idempotency: latest write wins. The user can re-run the probe" (lines 35–36). Debounce coalesces all `project/design.requested` events sharing a `projectId` within a rolling 2-minute window into ONE run executed with the latest event — exactly the latest-write-wins semantic — and the documented race (onboarding dispatch at `onboarding.ts:218–226` + discover-site's `warn-design-tokens` re-dispatch at `discover-site.ts:784–787` while `design_tokens` is still null) collapses to one billed call. The only cost is a ~2-minute start delay on a worker nothing blocks on (onboarding is explicitly fire-and-forget, `onboarding.ts:212–217`; the first consumer is compose, minutes later). Residual: a duplicate arriving MORE than 2 minutes after the last event while the first run is still in flight would still double-run — that window requires a pathologically slow scrape and costs ~half a cent; accepted.

- [ ] Append this test to the `describe("extractProjectDesign worker", ...)` block in `apps/web/lib/inngest/functions/extract-project-design.test.ts`:

```ts
  it("configures a per-project debounce as the duplicate-dispatch guard", () => {
    expect(captured.config!.id).toBe("extract-project-design");
    expect(captured.config!.retries).toBe(0);
    expect(captured.config!.debounce).toEqual({
      key: "event.data.projectId",
      period: "2m",
    });
    expect(captured.trigger).toEqual({ event: "project/design.requested" });
  });
```

- [ ] Run it: `pnpm --filter @jab/web test lib/inngest/functions/extract-project-design.test.ts` — expected failure: `captured.config!.debounce` is `undefined`.
- [ ] Implement — in `apps/web/lib/inngest/functions/extract-project-design.ts`, replace the `createFunction` config object (current lines 38–43) with:

```ts
export const extractProjectDesign = inngest.createFunction(
  {
    id: "extract-project-design",
    retries: 0,
    // Duplicate-dispatch guard: connectWpAction (onboarding.ts) and
    // discover-site's warn-design-tokens step both dispatch
    // project/design.requested — the latter whenever design_tokens is
    // still null, i.e. exactly while an onboarding-dispatched run may
    // still be in flight. Debounce coalesces same-project events inside
    // a rolling 2-minute window into ONE run executed with the LATEST
    // event (matching the documented latest-write-wins semantics below).
    // Deliberately NOT `idempotency`: that dedupes for 24h and would
    // break the documented recovery path (re-running the probe must be
    // able to re-extract immediately).
    debounce: { key: "event.data.projectId", period: "2m" },
  },
  { event: "project/design.requested" },
```

  And extend the module docblock's idempotency paragraph (current lines 35–36) to:

```ts
 * Idempotency: latest write wins. The user can re-run the probe; each
 * dispatch overwrites the previous extraction. Asset uploads use upsert.
 * A per-project debounce (2m) coalesces the onboarding + discover-site
 * duplicate-dispatch race into a single billed run.
```

- [ ] Run it: `pnpm --filter @jab/web test lib/inngest/functions/extract-project-design.test.ts` — expected: PASS.
- [ ] Manual verification note (optional, dev-only — Inngest executes debounce server-side, the unit test pins the config): with `pnpm dev` + the Inngest dev server running, fire two `project/design.requested` events for the same `projectId` within a few seconds and confirm the dev UI shows ONE run, started ~2 minutes after the second event, carrying the second event's payload.
- [ ] Commit:
  - `git add apps/web/lib/inngest/functions/extract-project-design.ts apps/web/lib/inngest/functions/extract-project-design.test.ts`
  - `git commit -m "feat(saas): debounce extract-project-design per project (duplicate-dispatch guard)"`

---

### Task 8: Full verification sweep

**Files:** none modified — verification only.

- [ ] Run the two new suites: `pnpm --filter @jab/web test lib/ai/scrape-agent.test.ts lib/inngest/functions/extract-project-design.test.ts` — expected: all tests PASS (≈16 tests across both files).
- [ ] Run the FULL app suite to catch any collateral: `pnpm --filter @jab/web test` — expected: green (the senior-review baseline plus this phase's additions; no pre-existing test reads `DesignTokenScrapeResult.usage`/`.models`, `extractJsonBlock`, or the old fenced-block prompt — verified by grep before drafting, but the full run is the proof).
- [ ] Typecheck: `pnpm --filter @jab/web typecheck` — expected: clean.
- [ ] Grep proof that the fenced-block era is fully gone: `grep -rn "extractJsonBlock" apps/web --include="*.ts"` → no matches; `grep -n '```json' apps/web/lib/ai/scrape-agent.ts` → no matches.
- [ ] Confirm `apps/web/lib/ai/scrape-errors.ts` is untouched: `git status --short apps/web/lib/ai/scrape-errors.ts` → empty (the PublicError surface is decoupled from agent codes; `ai_failed` copy still covers every agent failure).
- [ ] Commit anything stray only if the sweep surfaced a fix; otherwise no commit.

---

## Operator notes (post-merge)

- **Migration 0034 must be applied to BOTH Supabase projects** — local "JAB WP" (`ajfurojjxthhzkjqttri`) AND prod "jab-prod" (`celzwcxkrmsbwiswkxug`) — before any live `project/design.requested` run, or the `persist` step will throw on the unknown `design_scrape_usage` column and the project row will be left without design tokens. Note 0032 + 0033 were still pending application at the time of drafting; 0034 stacks after them in order.
- **Reading the telemetry:** `select id, design_scrape_usage from projects where design_scrape_usage is not null;` — `fallbackUsed: true` rows show the real double-pay events; the ratio of fallbacks to total passes decides whether Haiku stays the design default (it should: structured outputs removes the formatting-miss class that drove fallbacks).
- **Behavior change to be aware of:** design extraction now starts ~2 minutes after the last dispatch for a project (debounce). Nothing user-facing blocks on it; if an operator needs an immediate run during debugging, dispatch and wait out the window, or temporarily remove the debounce key in dev.
