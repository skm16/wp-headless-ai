# Real Vision Fidelity Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `visionScore` pixel-echo stub with a real Anthropic vision call that scores how faithfully the generated clone reproduces the original WordPress page, behind a default-off flag so the change is zero-risk to merge.

**Architecture:** Mirror the existing planner seam (`lib/jab/edit-plan.ts` schema ↔ `lib/ai/edit-planner.ts` server-only client). A new **pure** module (`lib/ai/vision-prompt.ts`) holds the tool schema, the system/user prompt builders, the defensive tool-input parser, and the flag reader — all unit-testable with no SDK. A new **server-only** module (`lib/ai/vision-scorer.ts`) holds the `AnthropicVisionScorerClient` that sends both screenshots as base64 image blocks with a forced `tool_choice`, then parses the structured result. The `verify-fidelity` worker chooses the real client over the existing stub when `JAB_VISION_SCORING=1`; everything else (selection, budget cap, fail-soft fallback, persistence, score-replace semantics) is unchanged.

**Tech Stack:** TypeScript, Next.js App Router, `@anthropic-ai/sdk`, Inngest worker, vitest. Anthropic Messages API tool-use (forced) for structured output; image content blocks for vision.

## Global Constraints

- **Default-off flag.** `JAB_VISION_SCORING=1` enables the real call. When unset/anything-else, behavior is **byte-identical** to today's stub (`visionScore` echoes the pixel score, empty issues). No new API cost, no score change, when off.
- **Score-replace semantics (decided 2026-06-18).** When on, the LLM's `score` REPLACES the canonical desktop pixel score for the ≤15 worst flagged pages (the existing `row.score = vision.score` contract). `issues` are appended either way. No new gating machinery — the publish gate stays approval-status-driven; high-severity vision issues flow through the existing `isBlockingFidelityRow` carry-forward path already in place.
- **Fail-soft, always.** Vision is advisory infrastructure. ANY failure (missing buffer, no tool block, API error, bad parse) must fall back to the page's already-set pixel-derived score plus a `visionUnavailableIssue` marker — never throw past the worker's existing per-page try/catch, never fail a build.
- **No DB migration.** `fidelity_reports.score` / `pixel_diff` / `issues` / `viewport_scores` already exist and are unchanged in shape.
- **No new model registry entry.** `fidelity-vision` is already registered in `lib/ai/model.ts` (default `claude-sonnet-4-6`, override `JAB_AI_MODEL_FIDELITY_VISION`). Resolve through `getModelFor("fidelity-vision")` per call.
- **SDK singleton only.** Never `new Anthropic()` outside `lib/ai/client.ts`; use `getAnthropicClient()`. Tests inject a fake via an `sdk` constructor option (mirror `AnthropicPlannerClient`).
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `apps/web/lib/ai/vision-prompt.ts` (PURE, not server-only) — `VISION_SCORE_TOOL_SCHEMA`, `VISION_MAX_OUTPUT_TOKENS`, `buildVisionSystemPrompt()`, `buildVisionUserText()`, `parseVisionToolUse()`, `isVisionScoringEnabled()`.
- **Create** `apps/web/lib/ai/vision-prompt.test.ts` — schema shape, prompt content, parser coercion, flag reader.
- **Create** `apps/web/lib/ai/vision-scorer.ts` (SERVER-ONLY) — `VisionScorerClient` interface, `AnthropicVisionScorerClient`.
- **Create** `apps/web/lib/ai/vision-scorer.test.ts` — call shape (two image blocks, source-first, forced tool_choice, model), result parsing, missing-buffer + no-tool-block throws.
- **Modify** `apps/web/lib/ai/fidelity-score.ts` — `export` the existing private `clamp01` so `vision-prompt.ts` can reuse it (one keyword). The `visionScore` stub stays unchanged (default-off path).
- **Modify** `apps/web/lib/inngest/functions/verify-fidelity.ts` — Phase B chooses `AnthropicVisionScorerClient.score` vs the `visionScore` stub via `isVisionScoringEnabled()`; fail-soft try/catch unchanged.
- **Modify** `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` (done at plan authoring), `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`, `CLAUDE.md` — documentation.

---

### Task 1: Pure vision schema, prompts, parser, flag (`vision-prompt.ts`)

**Files:**
- Create: `apps/web/lib/ai/vision-prompt.ts`
- Modify: `apps/web/lib/ai/fidelity-score.ts` (export `clamp01`)
- Test: `apps/web/lib/ai/vision-prompt.test.ts`

**Interfaces:**
- Consumes: `VisionScoreResult` from `./fidelity-score`; `clamp01` from `./fidelity-score` (newly exported).
- Produces:
  - `VISION_SCORE_TOOL_SCHEMA` — `{ name: "report_fidelity", description: string, input_schema: {...} }` (`as const`).
  - `VISION_MAX_OUTPUT_TOKENS: number` (= `1024`).
  - `buildVisionSystemPrompt(): string`.
  - `buildVisionUserText(args: { routePath?: string; blockNames?: string[]; pixelDiffScore: number }): string`.
  - `parseVisionToolUse(input: Record<string, unknown>, pixelDiffScore: number): VisionScoreResult`.
  - `isVisionScoringEnabled(env?: NodeJS.ProcessEnv): boolean`.

- [ ] **Step 1: Export `clamp01` from fidelity-score.ts**

Change the existing private function signature at the bottom of `apps/web/lib/ai/fidelity-score.ts`:

```ts
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
```

(Only the `export` keyword is added; body is unchanged.)

- [ ] **Step 2: Write the failing test**

Create `apps/web/lib/ai/vision-prompt.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VISION_SCORE_TOOL_SCHEMA,
  VISION_MAX_OUTPUT_TOKENS,
  buildVisionSystemPrompt,
  buildVisionUserText,
  parseVisionToolUse,
  isVisionScoringEnabled,
} from "./vision-prompt";

afterEach(() => vi.unstubAllEnvs());

describe("VISION_SCORE_TOOL_SCHEMA", () => {
  it("declares a report_fidelity tool with score + issues required", () => {
    expect(VISION_SCORE_TOOL_SCHEMA.name).toBe("report_fidelity");
    const props = VISION_SCORE_TOOL_SCHEMA.input_schema.properties;
    expect(props.score.type).toBe("number");
    expect(props.issues.type).toBe("array");
    expect(VISION_SCORE_TOOL_SCHEMA.input_schema.required).toEqual(["score", "issues"]);
    const itemProps = props.issues.items.properties;
    expect(itemProps.severity.enum).toEqual(["low", "medium", "high"]);
    expect(props.issues.items.required).toEqual(["block_name", "severity", "description"]);
  });
});

describe("buildVisionSystemPrompt", () => {
  it("instructs holistic faithfulness and to ignore expected content swaps", () => {
    const p = buildVisionSystemPrompt();
    expect(p.toLowerCase()).toContain("faithful");
    // The defining instruction: stock/dynamic content differences are NOT defects.
    expect(p.toLowerCase()).toMatch(/stock|photo|dynamic|content/);
    expect(p).toContain("report_fidelity");
  });
});

describe("buildVisionUserText", () => {
  it("labels original-first / generated-second, names the route, lists blocks, and gives the pixel context", () => {
    const t = buildVisionUserText({
      routePath: "/about",
      blockNames: ["core/cover", "core/columns"],
      // pixelDiffScore is the pixel-derived SIMILARITY score (1 = identical),
      // not a diff ratio — the worker passes diff.score (= 1 - diffRatio).
      pixelDiffScore: 0.42,
    });
    expect(t).toContain("/about");
    expect(t).toContain("core/cover");
    expect(t.toLowerCase()).toContain("first");
    expect(t.toLowerCase()).toContain("second");
    // 0.42 similarity → "~42% similar"; surfaced so the model understands why it's asked.
    expect(t).toMatch(/42%|pixel/i);
  });

  it("is robust to missing route/blocks", () => {
    const t = buildVisionUserText({ pixelDiffScore: 0.1 });
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(0);
  });
});

describe("parseVisionToolUse", () => {
  it("clamps a valid score and coerces issues", () => {
    const r = parseVisionToolUse(
      {
        score: 0.87,
        issues: [{ block_name: "core/cover", severity: "high", description: "hero image missing" }],
      },
      0.4,
    );
    expect(r.score).toBe(0.87);
    expect(r.issues).toEqual([
      { block_name: "core/cover", severity: "high", description: "hero image missing" },
    ]);
  });

  it("falls back to the pixel score when score is missing or NaN", () => {
    expect(parseVisionToolUse({ issues: [] }, 0.55).score).toBe(0.55);
    expect(parseVisionToolUse({ score: Number.NaN, issues: [] }, 0.55).score).toBe(0.55);
    expect(parseVisionToolUse({ score: "high", issues: [] }, 0.55).score).toBe(0.55);
  });

  it("clamps out-of-range scores", () => {
    expect(parseVisionToolUse({ score: 1.4, issues: [] }, 0.4).score).toBe(1);
    expect(parseVisionToolUse({ score: -0.2, issues: [] }, 0.4).score).toBe(0);
  });

  it("defaults a bad severity to low and a missing block_name to _page", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ severity: "catastrophic", description: "x" }] },
      0.4,
    );
    expect(r.issues[0].severity).toBe("low");
    expect(r.issues[0].block_name).toBe("_page");
  });

  it("drops issues with no description and non-object entries", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ block_name: "a", severity: "low", description: "" }, "nope", null, 7] },
      0.4,
    );
    expect(r.issues).toEqual([]);
  });

  it("returns an empty issues list when issues is missing or not an array", () => {
    expect(parseVisionToolUse({ score: 0.5 }, 0.4).issues).toEqual([]);
    expect(parseVisionToolUse({ score: 0.5, issues: "x" }, 0.4).issues).toEqual([]);
  });
});

describe("isVisionScoringEnabled", () => {
  it("is true only for the exact '1' value", () => {
    expect(isVisionScoringEnabled({ JAB_VISION_SCORING: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isVisionScoringEnabled({ JAB_VISION_SCORING: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isVisionScoringEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("JAB_VISION_SCORING", "1");
    expect(isVisionScoringEnabled()).toBe(true);
  });

  it("VISION_MAX_OUTPUT_TOKENS is a small fixed budget", () => {
    expect(VISION_MAX_OUTPUT_TOKENS).toBe(1024);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/vision-prompt.test.ts`
Expected: FAIL — `vision-prompt.ts` does not exist (module-not-found).

- [ ] **Step 4: Write the implementation**

Create `apps/web/lib/ai/vision-prompt.ts`:

```ts
// PURE module (deliberately NOT "server-only"): the vision tool schema, prompt
// builders, defensive tool-input parser, and the feature-flag reader. Mirrors
// lib/jab/edit-plan.ts (schema) ↔ lib/ai/edit-planner.ts (server-only client):
// keeping these here means they unit-test with no SDK and the server-only
// client (vision-scorer.ts) stays a thin wire.

import { clamp01, type VisionScoreResult } from "./fidelity-score";

/** Small output budget: a score + a handful of short issues. */
export const VISION_MAX_OUTPUT_TOKENS = 1024;

/**
 * Forced tool-use schema for the vision scorer. The model's ONLY output channel
 * is this tool (tool_choice forces it), so we never regex a number out of prose.
 */
export const VISION_SCORE_TOOL_SCHEMA = {
  name: "report_fidelity",
  description:
    "Report how faithfully the generated clone reproduces the original WordPress page.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "number",
        description:
          "Fidelity in [0,1]. 1 = a visually faithful clone (same layout, section order, branding, typography, colors, and the same KINDS of content present). 0 = unrecognizable or broken. Judge structure and branding, NOT exact pixels: different stock/hero photos, different dynamic content (latest posts, product lists), and minor text reflow are EXPECTED and must NOT lower the score. Penalize missing sections, broken/overlapping layout, wrong colors or fonts, collapsed/empty regions, and images absent where the original clearly had content imagery.",
      },
      issues: {
        type: "array",
        description:
          "Concrete visual defects in the clone. Empty array when the clone is faithful.",
        items: {
          type: "object",
          properties: {
            block_name: {
              type: "string",
              description:
                'The affected block name from the provided list, or "_page" for a whole-page issue.',
            },
            severity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description:
                "high = the area is broken/unusable; medium = clearly wrong but legible; low = minor cosmetic.",
            },
            description: {
              type: "string",
              description: "What is visually wrong, in one short sentence.",
            },
          },
          required: ["block_name", "severity", "description"],
        },
      },
    },
    required: ["score", "issues"],
  },
} as const;

export function buildVisionSystemPrompt(): string {
  return `You are the JAB fidelity reviewer. You compare two full-page screenshots of the SAME web page: the ORIGINAL WordPress site and a GENERATED clone of it. Decide how faithfully the clone reproduces the original, then call the ${VISION_SCORE_TOOL_SCHEMA.name} tool with a score and any issues.

What "faithful" means:
- Same overall layout and section order, same branding (logo, colors, fonts), same typography scale, the same KINDS of content present in each region.

What is EXPECTED and must NOT lower the score:
- Different stock/hero photographs or illustrations (the clone hotlinks live media and dynamic content; exact images legitimately differ).
- Different dynamic content (latest posts, product/event lists, counts) and minor text reflow or wrapping.

What DOES lower the score:
- Missing or empty sections, broken or overlapping layout, content spilling off-canvas.
- Wrong brand colors or fonts, obviously unstyled / default-looking regions.
- Images absent where the original clearly showed content imagery (not decorative swaps).

Be critical but fair: a clone that is structurally and visually equivalent with only expected media/content differences deserves a high score (0.9+). Reserve low scores for genuine breakage. Attribute each issue to a block_name from the provided list when you can, otherwise "_page".`;
}

export function buildVisionUserText(args: {
  routePath?: string;
  blockNames?: string[];
  /** Pixel-derived SIMILARITY score in [0,1] (1 = identical) — the worker passes
   *  diff.score (= 1 - diffRatio), so this is NOT a diff ratio. */
  pixelDiffScore: number;
}): string {
  const pct = Math.round(clamp01(args.pixelDiffScore) * 100);
  const blocks =
    args.blockNames && args.blockNames.length
      ? args.blockNames.join(", ")
      : "(block list unavailable — attribute issues to _page)";
  return `The FIRST image is the ORIGINAL WordPress page. The SECOND image is the GENERATED clone.
Route: ${args.routePath ?? "(unknown)"}
Blocks present on this page: ${blocks}

Context: an automated pixel-diff scored this clone ~${pct}% similar. That number is often deflated by EXPECTED photo/dynamic-content differences, which is exactly why your visual judgment is needed. Score the clone's structural and brand fidelity and report any real defects via the ${VISION_SCORE_TOOL_SCHEMA.name} tool.`;
}

const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

function coerceSeverity(v: unknown): Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v)
    ? (v as Severity)
    : "low";
}

/**
 * Coerce arbitrary tool-call JSON to a typed VisionScoreResult (defensive —
 * NEVER throws). A missing/NaN/non-number score falls back to the pixel-derived
 * score so a malformed tool call degrades to today's behavior rather than a
 * zero. Malformed issue entries are dropped, not surfaced.
 */
export function parseVisionToolUse(
  input: Record<string, unknown>,
  pixelDiffScore: number,
): VisionScoreResult {
  const rawScore = input.score;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? clamp01(rawScore)
      : clamp01(pixelDiffScore);

  const rawIssues = Array.isArray(input.issues) ? input.issues : [];
  const issues = rawIssues
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      block_name:
        typeof i.block_name === "string" && i.block_name.length ? i.block_name : "_page",
      severity: coerceSeverity(i.severity),
      description: typeof i.description === "string" ? i.description : "",
    }))
    .filter((i) => i.description.length > 0);

  return { score, issues };
}

/** Default-off feature flag for the real vision call. Exact "1" only. */
export function isVisionScoringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAB_VISION_SCORING === "1";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/vision-prompt.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/ai/vision-prompt.ts apps/web/lib/ai/vision-prompt.test.ts apps/web/lib/ai/fidelity-score.ts
git commit -m "feat(fidelity): vision scorer tool schema, prompts, parser, flag (pure)"
```

---

### Task 2: Anthropic vision client (`vision-scorer.ts`)

**Files:**
- Create: `apps/web/lib/ai/vision-scorer.ts`
- Test: `apps/web/lib/ai/vision-scorer.test.ts`

**Interfaces:**
- Consumes: `getAnthropicClient` (`./client`), `getModelFor` (`./model`), the Task-1 exports (`VISION_SCORE_TOOL_SCHEMA`, `VISION_MAX_OUTPUT_TOKENS`, `buildVisionSystemPrompt`, `buildVisionUserText`, `parseVisionToolUse`), `VisionScoreInput` / `VisionScoreResult` (`./fidelity-score`).
- Produces:
  - `interface VisionScorerClient { score(input: VisionScoreInput): Promise<VisionScoreResult> }`.
  - `class AnthropicVisionScorerClient implements VisionScorerClient` with `constructor(opts?: { sdk?: Anthropic })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/vision-scorer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVisionScorerClient } from "./vision-scorer";

/** Fake SDK whose messages.create resolves a single tool_use response. */
function fakeSdk(input: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "tu_1", name: "report_fidelity", input }],
    stop_reason: "tool_use",
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...over,
  });
  return { sdk: { messages: { create } } as unknown as Anthropic, create };
}

const src = Buffer.from([1, 2, 3]);
const gen = Buffer.from([4, 5, 6]);

describe("AnthropicVisionScorerClient.score", () => {
  it("sends source-first then generated image blocks, forces the tool, and resolves the parsed score", async () => {
    const { sdk, create } = fakeSdk({ score: 0.91, issues: [] });
    const client = new AnthropicVisionScorerClient({ sdk });
    const res = await client.score({
      pixelDiffScore: 0.4,
      sourceBuffer: src,
      generatedBuffer: gen,
      routePath: "/about",
      blockNames: ["core/cover"],
    });
    expect(res.score).toBe(0.91);

    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.tool_choice).toEqual({ type: "tool", name: "report_fidelity" });
    const content = req.messages[0].content;
    expect(content[0].type).toBe("image");
    expect(content[0].source.data).toBe(src.toString("base64"));
    expect(content[1].type).toBe("image");
    expect(content[1].source.data).toBe(gen.toString("base64"));
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("/about");
  });

  it("parses issues and clamps the score from the tool input", async () => {
    const { sdk } = fakeSdk({
      score: 1.5,
      issues: [{ block_name: "core/cover", severity: "high", description: "broken hero" }],
    });
    const client = new AnthropicVisionScorerClient({ sdk });
    const res = await client.score({ pixelDiffScore: 0.2, sourceBuffer: src, generatedBuffer: gen });
    expect(res.score).toBe(1);
    expect(res.issues[0].description).toBe("broken hero");
  });

  it("throws when a screenshot buffer is missing (worker catches → fail-soft)", async () => {
    const { sdk } = fakeSdk({ score: 0.9, issues: [] });
    const client = new AnthropicVisionScorerClient({ sdk });
    await expect(
      client.score({ pixelDiffScore: 0.4, sourceBuffer: src, generatedBuffer: undefined }),
    ).rejects.toThrow(/buffer/i);
  });

  it("throws when the model returns no tool_use block", async () => {
    const { sdk } = fakeSdk(
      {},
      { content: [{ type: "text", text: "no tool" }], stop_reason: "end_turn" },
    );
    const client = new AnthropicVisionScorerClient({ sdk });
    await expect(
      client.score({ pixelDiffScore: 0.4, sourceBuffer: src, generatedBuffer: gen }),
    ).rejects.toThrow(/tool_use/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/vision-scorer.test.ts`
Expected: FAIL — `vision-scorer.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/ai/vision-scorer.ts`:

```ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./client";
import { getModelFor } from "./model";
import {
  VISION_SCORE_TOOL_SCHEMA,
  VISION_MAX_OUTPUT_TOKENS,
  buildVisionSystemPrompt,
  buildVisionUserText,
  parseVisionToolUse,
} from "./vision-prompt";
import type { VisionScoreInput, VisionScoreResult } from "./fidelity-score";

/**
 * vision-scorer — the real Anthropic-backed vision fidelity scorer (Phase 7.1).
 *
 * Forces report_fidelity tool-use so the only output channel is a structured
 * { score, issues }. Mirrors AnthropicPlannerClient: SDK singleton, injectable
 * `sdk` for tests, model resolved per-call via getModelFor("fidelity-vision").
 *
 * The SDK retries transient failures (rate_limit / overloaded / 5xx / network)
 * with its built-in backoff; we add none. Any error that survives that — or a
 * missing buffer / no tool block — throws, and the verify-fidelity worker's
 * existing per-page try/catch converts it to a pixel-score + vision_unavailable
 * fallback. Vision must never fail a build.
 */
export interface VisionScorerClient {
  score(input: VisionScoreInput): Promise<VisionScoreResult>;
}

export class AnthropicVisionScorerClient implements VisionScorerClient {
  private readonly sdk: Anthropic;

  constructor(opts?: { sdk?: Anthropic }) {
    this.sdk = opts?.sdk ?? getAnthropicClient();
  }

  async score(input: VisionScoreInput): Promise<VisionScoreResult> {
    if (!input.sourceBuffer || !input.generatedBuffer) {
      throw new Error(
        "vision-scorer: missing source/generated screenshot buffer — cannot run the vision pass",
      );
    }

    const userContent: Anthropic.Messages.ContentBlockParam[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: input.sourceBuffer.toString("base64") },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: input.generatedBuffer.toString("base64") },
      },
      {
        type: "text",
        text: buildVisionUserText({
          routePath: input.routePath,
          blockNames: input.blockNames,
          pixelDiffScore: input.pixelDiffScore,
        }),
      },
    ];

    const response = await this.sdk.messages.create({
      model: getModelFor("fidelity-vision"),
      max_tokens: VISION_MAX_OUTPUT_TOKENS,
      system: buildVisionSystemPrompt(),
      tools: [VISION_SCORE_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: VISION_SCORE_TOOL_SCHEMA.name },
      messages: [{ role: "user", content: userContent }],
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput =
      toolBlock && toolBlock.type === "tool_use"
        ? (toolBlock.input as Record<string, unknown>)
        : null;
    if (!rawInput) {
      throw new Error(
        `vision-scorer: model returned no tool_use block (stop_reason=${response.stop_reason})`,
      );
    }

    const u = response.usage;
    console.log(
      `[vision-scorer] ${input.routePath ?? "?"} model=${response.model} in=${u.input_tokens} out=${u.output_tokens}`,
    );

    return parseVisionToolUse(rawInput, input.pixelDiffScore);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/vision-scorer.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/vision-scorer.ts apps/web/lib/ai/vision-scorer.test.ts
git commit -m "feat(fidelity): real Anthropic vision scorer client (forced tool-use)"
```

---

### Task 3: Wire the worker to the flag (`verify-fidelity.ts`)

**Files:**
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts`

**Interfaces:**
- Consumes: `isVisionScoringEnabled` (`@/lib/ai/vision-prompt`), `AnthropicVisionScorerClient` (`@/lib/ai/vision-scorer`), plus the existing `visionScore` stub (`@/lib/ai/fidelity-score`).
- Produces: no exported surface change — internal wiring only.

This is a thin wiring change; its deliverable is verified by `tsc --noEmit` + the full suite staying green (the flag logic itself is unit-tested in Task 1; the SDK call in Task 2). There is no Inngest-step unit test in the repo, and the worker contract is unchanged.

- [ ] **Step 1: Add the imports**

In `apps/web/lib/inngest/functions/verify-fidelity.ts`, alongside the existing `@/lib/ai/fidelity-score` import (keep `visionScore` imported — it is the default-off fallback), add:

```ts
import { isVisionScoringEnabled } from "@/lib/ai/vision-prompt";
import { AnthropicVisionScorerClient } from "@/lib/ai/vision-scorer";
```

- [ ] **Step 2: Construct the scorer once inside the `score-pages` step, before Phase B**

Immediately before the `// ── Phase B:` comment block (currently around line 306), add:

```ts
        // When JAB_VISION_SCORING=1, the worst flagged pages get a real
        // Anthropic vision pass whose score REPLACES the pixel score; otherwise
        // the stub echoes the pixel score (byte-identical to pre-flag behavior).
        // One client per build — it wraps the SDK singleton.
        const visionEnabled = isVisionScoringEnabled();
        const visionClient = visionEnabled ? new AnthropicVisionScorerClient() : null;
```

- [ ] **Step 3: Use the chosen scorer in the Phase B loop**

Replace the existing `visionScore({...})` call inside the Phase B `try` (currently around lines 316-324) with a branch that uses the real client when enabled:

```ts
            const vision = visionClient
              ? await visionClient.score({
                  pixelDiffScore: meta.pixelScore,
                  sourceBuffer: sourceBuf ?? undefined,
                  generatedBuffer: generatedBuf ?? undefined,
                  routePath: meta.routePath,
                  // blockNames deliberately unwired (optional): grounded
                  // block-level attribution needs the page's block inventory —
                  // a documented follow-up. Issues key on _page until then.
                })
              : await visionScore({
                  pixelDiffScore: meta.pixelScore,
                  sourceBuffer: sourceBuf ?? undefined,
                  generatedBuffer: generatedBuf ?? undefined,
                  routePath: meta.routePath,
                });
            row.score = vision.score;
            row.issues = [...row.issues, ...vision.issues];
```

The surrounding `try { ... } catch (err) { ... visionUnavailableIssue ... }` is unchanged — a thrown vision error still falls back to the page's pixel score.

- [ ] **Step 4: Verify the whole app typechecks and the suite is green**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @jab/web test`
Expected: full suite green (existing `fidelity-score.test.ts` stub tests still pass — the stub is unchanged; new `vision-prompt`/`vision-scorer` suites pass).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/inngest/functions/verify-fidelity.ts
git commit -m "feat(fidelity): wire verify-fidelity to real vision scorer behind JAB_VISION_SCORING"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`
- Modify: `CLAUDE.md`
- (Already done at plan authoring: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md`)

- [ ] **Step 1: Mark recommendation #6 resolved**

In `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`, update the entry for the vision-scoring follow-up (#6) to RESOLVED-behind-flag, noting: real Anthropic vision call (forced tool-use, `{score, issues}`), score-replace semantics, `JAB_VISION_SCORING=1` default-off, no migration; remaining gate before default-on = live validation against a real build.

- [ ] **Step 2: Add a CLAUDE.md snapshot line**

Add a short paragraph to the "Current state" snapshot section of `CLAUDE.md` describing the real vision scorer landing behind `JAB_VISION_SCORING=1` (default-off), the score-replace semantics, the new pure (`vision-prompt.ts`) + server-only (`vision-scorer.ts`) modules, and the live-validation gate before default-on. Reference this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-17-independent-review-recommendations.md CLAUDE.md
git commit -m "docs(fidelity): record real vision scoring behind JAB_VISION_SCORING"
```

---

## Validation (operator, post-merge — gate before default-on)

The flag is default-off, so merge is zero-risk. Before flipping `JAB_VISION_SCORING` on by default, validate against one real build (the worker host is a production build reading `.env.local` — see the saas-worker-host-prod-build note):

1. Set `JAB_VISION_SCORING=1` and a valid `ANTHROPIC_API_KEY` in `apps/web/.env.local`; `pnpm build` + `pnpm start` with `INNGEST_DEV=1` (rebuild required — workers are hosted by the prod build).
2. Trigger a Two Roads rebuild. Watch the worker log for `[vision-scorer]` lines (≤15, one per worst flagged page).
3. On the build review screen, confirm: flagged pages show LLM-derived scores (a clone with swapped hero photos should now score HIGH despite a high pixel diff), and any real defects appear as block-attributed issues.
4. Confirm fail-soft: a page whose vision call errors keeps its pixel score and shows a `vision_unavailable` low issue — the build still reaches `ready`.

## Out of scope (documented follow-ups)

- **Grounded `blockNames`.** Wiring the page's real block list into the prompt (loading `block_inventory` / `page_inventory.block_tree` in the worker) for block-attributed issues — issues key on `_page` until then.
- **Image-size optimization.** Tall full-page PNGs are sent as-is (matches the existing `component-visual` path); the API downscales. Pre-downscaling to ≤1568px long edge would cut token cost — a follow-up. A too-large image returns a `bad_request` and degrades fail-soft today.
- **Cost telemetry to a column.** Vision token usage is logged, not persisted to `fidelity_reports` (no migration). A `fidelity_reports` cost column mirroring `block_inventory` is a follow-up.
- **Default-on.** Gated on the live validation above.
```

