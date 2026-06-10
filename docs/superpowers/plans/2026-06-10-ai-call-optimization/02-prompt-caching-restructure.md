# Prompt Caching Restructure (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make prompt caching actually fire in the two generation loops (component + shell) by restructuring prompts around a >2048-token stable cached prefix, and make both loops robust: stop_reason-aware (no blind retry on truncation), typed-error-aware (no doomed retry on 400/401), corrective on retry (feedback instead of a re-roll), with failure kinds persisted and shellDom sanitized before it ever enters a prompt.

**Architecture:** Component generation extracts all static contract text into a module-level `COMPONENT_SYSTEM_CORE` constant (≥10,000 chars) passed as `cachedSystemPrefix` on every Sonnet-tier attempt, with per-build content (token JSON, sourceHost) in the uncached second system block; the generate-components worker runs one warm-up call before its 5-way fan-out so the cache entry exists before concurrent identical-prefix requests fire. Shell prompts become structured `{ system, user }` builders (sentinel split deleted) whose per-project-stable sections form the cached prefix when large enough, with sanitized shellDom moved LAST in the user message; compose-site runs header→footer sequentially (footer reads header's cache write) and splits generate/persist into separate Inngest steps.

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 2 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: Phase 1 (model-client contract: `GenerateResult.stopReason`/`.model`, `cachedSystemPrefix`/`systemPrompt` split, `lib/ai/errors.ts` with `classifyAiError`/`isRetryableAiFailure`, migration 0034 `failure_kind` columns, memoized `modelClientForTier`).

---

## Audit findings addressed

From `C:/tmp/ai-audit-digest.txt`:

- **component-generator #1** — system-prompt cache_control is a silent no-op (~1,100–1,500 tokens < Sonnet's 2048 minimum). Fixed by `COMPONENT_SYSTEM_CORE` (≥10,000 chars ≈ ~2,500 tokens) as `cachedSystemPrefix`.
- **component-generator #3** — 5-way `Promise.all` fan-out of identical prefixes all miss on the cold first batch. Fixed by the warm-up stagger (Task 5).
- **component-generator #4** — retry resends the full prompt blind with the cache marker stripped. Fixed: marker on EVERY attempt + `buildRetryUserSuffix` corrective feedback (Tasks 3–4).
- **component-generator #5** — stop_reason never inspected; max_tokens truncation retried identically. Fixed: raised-cap single retry (1.5×, cap 16000), else passthrough with `failureKind: "max_tokens"` (Tasks 1 + 4).
- **component-generator #9** — full-page screenshot re-billed; oversized-image 400 retried identically. Partially fixed here: typed errors stop the doomed 400 retry (bad_request → fail fast, no second call). Image-block caching itself is OUT of scope (residual — see Risks).
- **component-generator #10** — generic catch treats 400 and 529 identically. Fixed: `classifyAiError` branch — non-retryable → fail fast; retryable → second attempt; kind persisted to `block_inventory.failure_kind` (Task 4).
- **generate-shell #1** — raw unsanitized WP outerHTML up to 100KB with a blind mid-tag byte slice. Fixed by `sanitizeShellDom` wired at prompt build (Tasks 6–7).
- **generate-shell #2** — stop_reason never checked on shells (footers are the documented near-ceiling case). Fixed like components (Task 8).
- **generate-shell #3** — shell cache_control no-op (~500-token prefix, parallel header+footer, marker dropped on retry). Fixed: stable sections → `cachedSystemPrefix` via `shouldCacheShellPrefix`, marker on every attempt, sequential header→footer (Tasks 7–9).
- **generate-shell #4** — byte-identical retry with no corrective feedback; blind catch retries non-retryables. Fixed (Task 8).
- **generate-shell #6** — silent degradation conflates API failure with bad LLM output; telemetry hardcodes `"claude-sonnet-4-6"` even when zero API calls succeeded. Fixed: `modelUsed` = ground-truth `result.model` (null when nothing answered), `failureKind` persisted to `shell_generations.failure_kind` (Task 8).
- **generate-shell #8** — `"\n\nUSER:\n"` sentinel round-trip through arbitrary captured HTML. Fixed: builders return `{ system, user }` (Task 7). Note: `scripts/debug-shell-llm.ts` carries its own FORKED prompt builders + its own sentinel split (debug-shell-llm.ts:240-241), so it does not break when the builders change shape — it is rewired to import the production builders in **Phase 7**, not here.
- **generate-shell #11** — LLM call and persistence bundled in one `step.run` with `retries: 0`; a DB blip after a successful generation discards the paid tokens. Fixed: separate generate / persist steps (Task 9).

## Test philosophy note (read before executing)

**Prompt CONTENT changes in this phase are intentional.** This is a fidelity-equivalent restructure: the same rules move between prompt blocks (combined-string system half → cached prefix + per-build system block; shell user-half stable sections → system half; shellDom sanitized + moved last). There is **no flag** guarding these changes and no byte-identical guarantee for prompt text — the guarantees pinned by tests instead are:

1. **Semantic presence**: every load-bearing rule (image-binding contract, anti-placeholder rules, `as unknown as` cast rule, internal-links rule, width contract, hex-pair token emission) is asserted present in its NEW home in the same task that moves it. No snapshot tests exist for these prompts today (verified: `component-generator.test.ts` and `shell-prompts.test.ts` assert substrings, not snapshots) — the substring assertions are updated in place.
2. **Placement invariants preserved**: edit guidance stays strictly in the user half (R7); the sourceHost internal-links rule stays in a system block; guidance-omitted builder output is still deterministic (`fn(input)` deep-equals `fn({...input, guidance: undefined})`).
3. **Flag-gated behavior elsewhere is untouched**: `JAB_GENERATE_MOCK`, `JAB_SKIP_SHELL_REGEN`, and `JAB_COMPOSE_TYPECHECK` paths are not modified; the mock client path keeps returning zero usage (Phase 7's smoke hygiene asserts this end-to-end).

**Line numbers** below were verified against branch `feat/saas-e2e-loop` on 2026-06-10, BEFORE Phase 1 executes. Phase 1 rewrites `lib/ai/model-client.ts` and touches `lib/ai/persist-generation.ts` / call sites — re-verify line numbers in those files after Phase 1 lands; line refs in files Phase 1 does not touch (`shell-prompts.ts`, `capture-theme-stylesheets.ts`, `compose-site.ts` shell region, `generate-components.ts`) should still match.

**Assumed post-Phase-1 state** (verify before Task 1): `client.generate()` takes `{ cachedSystemPrefix?, systemPrompt, userPrompt, screenshotBase64? }` and returns `{ text, usage, stopReason, model }`; `generateComponent` / `generateShell` call it WITHOUT a cache marker (Phase 1 removed the no-op `cacheSystemPrompt` field); test mocks in `component-generator.test.ts` / `generate-shell.test.ts` already return `stopReason` + `model`. If any mock still returns the old shape, update it as shown in the relevant task.

---

## File structure

| File | Action | Responsibility in this phase |
| --- | --- | --- |
| `apps/web/lib/ai/model-client.ts` | Modify | Add per-call `maxTokens?: number` override to `GenerateOptions`; export `MAX_TOKENS_BY_TIER` as the single tier→cap source. |
| `apps/web/lib/ai/model-client.test.ts` | Modify | Cover the override + the table. |
| `apps/web/lib/ai/component-generator.ts` | Modify | `COMPONENT_SYSTEM_CORE` (≥10k chars, authored below), `COMPONENT_PROMPT_VERSION = 2`, `buildPerBuildSystemPrompt`, `buildRetryUserSuffix`, `GenerationFailureKind`, restructured 2-attempt loop (cache marker every attempt, corrective retry, stop_reason, typed errors, ground-truth model). |
| `apps/web/lib/ai/component-generator.test.ts` | Modify | Core-constant assertions; builder tests re-homed; loop behavior tests. |
| `apps/web/lib/ai/persist-generation.ts` | Modify | Persist `failure_kind` (column from Phase 1 migration 0034). |
| `apps/web/lib/ai/persist-generation.test.ts` | Modify | Extend the Phase 1 suite: failure_kind now read from `component.failureKind` (widened to `GenerationFailureKind`). |
| `apps/web/lib/jab/sonnet-warmup.ts` | Create | Pure `partitionSonnetWarmup(queue)` — first Sonnet-tier entry vs rest. |
| `apps/web/lib/jab/sonnet-warmup.test.ts` | Create | Partition unit tests. |
| `apps/web/lib/inngest/functions/generate-components.ts` | Modify | Warm-up stagger step before the batched fan-out. |
| `apps/web/lib/jab/sanitize-shell-dom.ts` | Create | Pure `sanitizeShellDom(html, maxBytes)` — script/style/noscript/comment/data-attr/srcset/base64 stripping, whitespace collapse, element-boundary clip. |
| `apps/web/lib/jab/sanitize-shell-dom.test.ts` | Create | Exhaustive sanitizer tests. |
| `apps/web/lib/ai/shell-prompts.ts` | Modify | Builders return `{ system, user }`; stable sections (rules+tokens+theme classes+menu) in `system`; sanitized shellDom LAST in `user`; `shouldCacheShellPrefix`; `SHELL_DOM_PROMPT_MAX_BYTES`. |
| `apps/web/lib/ai/shell-prompts.test.ts` | Modify | Rewritten for the structured shape. |
| `apps/web/lib/ai/generate-shell.ts` | Modify | Structured prompts, cached prefix, stop_reason, typed errors, corrective retry, `failureKind`, ground-truth `modelUsed`. |
| `apps/web/lib/ai/generate-shell.test.ts` | Modify | Updated mocks + new loop tests. |
| `apps/web/lib/ai/persist-shell-generation.ts` | Modify | Persist `failure_kind`. |
| `apps/web/lib/ai/persist-shell-generation.test.ts` | Modify | Extend the Phase 1 suite: failure_kind now read from `shell.failureKind` (widened to `GenerationFailureKind`). |
| `apps/web/lib/inngest/functions/compose-site.ts` | Modify | Sequential header→footer; generate and persist in separate `step.run` calls. |

**Untouched on purpose:** `apps/web/lib/jab/capture-theme-stylesheets.ts` (MAX_SHELL_BYTES=100_000 at :93, `clipShell` at :273-276, capture at :355-358). **Decision: sanitize at prompt-build time in `shell-prompts.ts`, NOT at capture.** Rationale: (a) the raw outerHTML persisted in `projects.design_tokens.shellDom` stays intact for future re-prompting, debugging, and the Phase 7 debug-script parity work — sanitization is a prompt-payload concern, not a capture concern; (b) `clipShell` runs inside `page.evaluate` browser context where the sanitizer module can't be imported; (c) capture-side sanitization would silently change persisted data for every future consumer. The blind byte-slice at capture remains as a 100KB transport bound; the element-boundary clip happens in the sanitizer at 60KB.

All test commands run from the repo form used by prior plans in this repo: `cd apps/web && pnpm vitest run <file>` (apps/web `package.json` `"test": "vitest run"`, vitest ^2.1.0).

---

### Task 1: model-client — per-call `maxTokens` override + `MAX_TOKENS_BY_TIER` single source

The raised-cap max_tokens retry (CONTRACTS: "single retry with maxTokens raised 1.5x (capped at 16000)") needs a mechanism the Phase 1 contract does not specify. We add an **optional, additive** `maxTokens?: number` field to `GenerateOptions` (per-call override of the client's constructor default) and export the tier→cap table so the generation loops compute the raise without re-hardcoding tier caps (audit component-generator #7's "three divergent model tables" anti-pattern). This is an additive extension to the locked Phase 1 `GenerateOptions` — reported in the campaign overview as such.

**Files:**
- Modify: `apps/web/lib/ai/model-client.ts` (post-Phase-1 shape; pre-Phase-1 the tier caps live in the `modelClientForTier` switch at model-client.ts:193-208 — 8192/4096/2048)
- Modify: `apps/web/lib/ai/model-client.test.ts`

**Steps:**

- [ ] Read `apps/web/lib/ai/model-client.ts` as Phase 1 left it. Confirm: `GenerateOptions` has `cachedSystemPrefix?/systemPrompt/userPrompt/screenshotBase64?`; `AnthropicModelClient` constructor is `constructor(opts: { model: AllowedModel; maxTokens: number; sdk?: Anthropic })`; `modelClientForTier` memoizes per model+maxTokens with `__resetModelClientCacheForTests()`.
- [ ] Append the failing test to `apps/web/lib/ai/model-client.test.ts` (self-contained describe block — adjust only the import list if Phase 1 named things differently, which would itself be a Phase 1 contract violation):

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicModelClient,
  MAX_TOKENS_BY_TIER,
} from "./model-client";

describe("per-call maxTokens override (Phase 2)", () => {
  function fakeSdk() {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "export function X() { return null; }" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
    });
    return { createSpy, sdk: { messages: { create: createSpy } } as unknown as Anthropic };
  }

  it("MAX_TOKENS_BY_TIER is the single tier→cap source", () => {
    expect(MAX_TOKENS_BY_TIER).toEqual({ visual: 8192, standard: 4096, trivial: 2048 });
  });

  it("uses the constructor maxTokens by default", async () => {
    const { createSpy, sdk } = fakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(createSpy.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it("a per-call maxTokens overrides the constructor default for that call only", async () => {
    const { createSpy, sdk } = fakeSdk();
    const client = new AnthropicModelClient({ model: "claude-sonnet-4-6", maxTokens: 8192, sdk });
    await client.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 12288 });
    await client.generate({ systemPrompt: "s", userPrompt: "u" });
    expect(createSpy.mock.calls[0][0].max_tokens).toBe(12288);
    expect(createSpy.mock.calls[1][0].max_tokens).toBe(8192);
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/model-client.test.ts` — expect FAIL: `MAX_TOKENS_BY_TIER` is not exported / TS error `maxTokens does not exist in type GenerateOptions`.
- [ ] Implement in `apps/web/lib/ai/model-client.ts`:
  1. Add to `GenerateOptions`:

```ts
  /**
   * Per-call override of the client's constructor maxTokens. Used by the
   * generation loops' raised-cap max_tokens retry (Phase 2): on a
   * stop_reason "max_tokens" truncation the single retry raises the cap
   * 1.5x (capped at 16000 — >16K requires streaming). Absent → the
   * constructor default applies.
   */
  maxTokens?: number;
```

  2. In `AnthropicModelClient.generate`, change the `messages.create` call's max_tokens line to:

```ts
      max_tokens: opts.maxTokens ?? this.maxTokens,
```

  3. Add the exported table and make `modelClientForTier` read it (replace the three numeric literals in its switch/table with `MAX_TOKENS_BY_TIER.visual` etc.):

```ts
/**
 * Single source of truth for per-tier output caps. modelClientForTier
 * constructs clients from this table; the generation loops import it to
 * compute the raised-cap max_tokens retry (1.5x, capped at 16000) without
 * re-hardcoding a parallel copy (audit: "three divergent model tables").
 */
export const MAX_TOKENS_BY_TIER: Record<"visual" | "standard" | "trivial", number> = {
  visual: 8192,
  standard: 4096,
  trivial: 2048,
};
```

  Note: `MockModelClient.generate` ignores `opts.maxTokens` — no change needed there.
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/model-client.test.ts` — expect PASS.
- [ ] Run the full suite to catch memoization-key interactions: `cd apps/web && pnpm vitest run` — expect PASS.
- [ ] Commit: `git add -A && git commit -m "feat(ai): per-call maxTokens override + MAX_TOKENS_BY_TIER single source"`

---

### Task 2: `COMPONENT_SYSTEM_CORE` + `COMPONENT_PROMPT_VERSION` + per-build system split

Extract every static rule from `sharedSystemPrompt` (component-generator.ts:50-114) into a module-level constant ≥10,000 chars (≈2,500 tokens — comfortably over Sonnet 4.6's 2048-token minimum cacheable prefix), expanded with the anti-placeholder rules, a data-shape guide, and ONE compact few-shot TSX exemplar. The per-build remainder (design-token JSON + sourceHost rule) becomes `buildPerBuildSystemPrompt`, which is what the prompt builders now put in their system half. `generateComponent` passes `cachedSystemPrefix: COMPONENT_SYSTEM_CORE` for Sonnet tiers (trivial/Haiku passes `undefined` — its 4096-token minimum makes caching impossible; do NOT pad).

`COMPONENT_PROMPT_VERSION = 2` is exported for Phase 4's carry-forward hash.

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` — replace `sharedSystemPrompt` (currently :50-114); builders `visualPrompt` :247-269, `standardPrompt` :271-288, `cptTemplatePrompt` :306-356, `acfFlexPrompt` :553-611 keep their combined `${system}\n\nUSER:\n${user}` return shape but `system` becomes per-build-only; `trivialPrompt` :290-304 unchanged; `generateComponent`'s client call (post-Phase-1, around current :737-742) gains `cachedSystemPrefix`.
- Modify: `apps/web/lib/ai/component-generator.test.ts` — re-home the assertions currently at :146-159 (image-binding contract + `as unknown as` rule, asserted today via `cptTemplatePrompt` output).

**Steps:**

- [ ] Add the failing tests to `apps/web/lib/ai/component-generator.test.ts`:

```ts
import {
  COMPONENT_SYSTEM_CORE,
  COMPONENT_PROMPT_VERSION,
  buildPerBuildSystemPrompt,
} from "./component-generator";

describe("COMPONENT_SYSTEM_CORE (Phase 2 cached prefix)", () => {
  it("clears the Sonnet 4.6 minimum cacheable size with margin", () => {
    // 2048-token minimum; ~4 chars/token → 10,000 chars ≈ 2,500 tokens.
    expect(COMPONENT_SYSTEM_CORE.length).toBeGreaterThanOrEqual(10_000);
  });

  it("is a stable module-level constant with no per-build interpolation", () => {
    // Per-build content lives in buildPerBuildSystemPrompt. The core must
    // never carry build-specific markers: the per-build token-section header
    // and the sourceHost INTERNAL-links rule are the two leak candidates.
    expect(COMPONENT_SYSTEM_CORE).not.toContain("Build-specific");
    expect(COMPONENT_SYSTEM_CORE).not.toContain("are INTERNAL");
    // No unresolved template syntax (the exemplar deliberately avoids
    // template literals so this assertion can hold).
    expect(COMPONENT_SYSTEM_CORE).not.toContain("${");
  });

  it("carries the image binding contract and the anti-placeholder rules", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("Image binding contract");
    expect(COMPONENT_SYSTEM_CORE).toContain("Anti-placeholder rules");
    expect(COMPONENT_SYSTEM_CORE).toContain("Two Roads FeaturedBeer");
  });

  it("carries the as-unknown-as cast rule and the children wrapper contract", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("block.attrs as unknown as MyAttrs");
    expect(COMPONENT_SYSTEM_CORE).toContain("Never emit a bare `as MyAttrs`");
    expect(COMPONENT_SYSTEM_CORE).toContain("children?: React.ReactNode");
  });

  it("carries exactly one few-shot TSX exemplar", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("## Worked example");
    expect(COMPONENT_SYSTEM_CORE).toContain("export function FeatureCards");
    // The exemplar demonstrates the cast rule and the brand-tinted fallback.
    expect(COMPONENT_SYSTEM_CORE).toContain("as unknown as FeatureCardsAttrs");
    expect(COMPONENT_SYSTEM_CORE).toContain("bg-primary/15");
  });

  it("COMPONENT_PROMPT_VERSION is 2 (feeds the Phase 4 carry-forward hash)", () => {
    expect(COMPONENT_PROMPT_VERSION).toBe(2);
  });
});

describe("buildPerBuildSystemPrompt (Phase 2 uncached system block)", () => {
  it("renders the token JSON and the sourceHost internal-links rule", () => {
    const s = buildPerBuildSystemPrompt(
      {
        colorPalette: [{ slug: "primary", color: "#ffc72c" }],
        fontSizes: [{ slug: "lg", size: "1.25rem" }],
        fontFamilies: [{ slug: "display", fontFamily: "Syne" }],
        blockGap: "1.5rem",
        raw: {} as never,
      },
      "tworoadsbrewing.com",
    );
    expect(s).toContain("Build-specific design tokens");
    expect(s).toContain("#ffc72c");
    expect(s).toContain("tworoadsbrewing.com are INTERNAL");
  });

  it("renders the no-tokens fallback when tokens are null", () => {
    const s = buildPerBuildSystemPrompt(null, null);
    expect(s).toContain("No theme.json tokens available");
    expect(s).not.toContain("are INTERNAL");
  });
});

describe("prompt builders no longer duplicate the core (cache hygiene)", () => {
  it("the per-build system half of every Sonnet-tier builder excludes core content", () => {
    const MARKER = "\n\nUSER:\n";
    const prompts = [
      visualPrompt(makeVisualEntry(), null),
      standardPrompt({ ...makeVisualEntry(), tier: "standard" }, null),
    ];
    for (const p of prompts) {
      const systemHalf = p.slice(0, p.indexOf(MARKER));
      // If core text leaked back into the builder, every call would re-bill
      // the ~2.5K tokens the cached prefix exists to avoid.
      expect(systemHalf).not.toContain("Image binding contract");
      expect(systemHalf).not.toContain("Worked example");
    }
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect FAIL: `COMPONENT_SYSTEM_CORE` not exported.
- [ ] In `apps/web/lib/ai/component-generator.ts`, DELETE `sharedSystemPrompt` (:50-114) and add, directly below `const MAX_COMPONENT_BYTES = 10_000;` (:48), the following (the constant is authored in full — do not abridge it; it must stay a plain template literal with NO `${}` interpolation and escaped backticks only):

```ts
/**
 * Prompt-content version for the component generator. Bump whenever the
 * cached core or the builder structure changes in a way that invalidates
 * comparability of generations. Feeds the Phase 4 carry-forward
 * prompt-inputs hash (computePromptInputsHash promptVersion arg).
 */
export const COMPONENT_PROMPT_VERSION = 2;

/**
 * COMPONENT_SYSTEM_CORE — the static, build-independent system prefix for
 * every Sonnet-tier component generation (visual / standard / cpt_template /
 * acf_flex). Passed as GenerateOptions.cachedSystemPrefix on EVERY attempt
 * so Anthropic prompt caching can fire: the prefix must exceed Sonnet 4.6's
 * 2048-token minimum cacheable size (this text is >10,000 chars ≈ ~2,500
 * tokens — a unit test pins the floor). It contains NO per-build content:
 * design tokens and the sourceHost rule render into the second (uncached)
 * system block via buildPerBuildSystemPrompt. Trivial-tier (Haiku 4.5)
 * calls do NOT use this prefix — Haiku's 4096-token minimum makes caching
 * impossible at this size and padding would cost more than it saves.
 */
export const COMPONENT_SYSTEM_CORE = `You are a senior React/Next.js developer converting WordPress Gutenberg blocks into typed React components for a generated Next.js App Router project. You receive one block type per request, with attribute samples captured from the live source site, usually a rendered DOM sample, sometimes computed-style hints and a screenshot. Your output is compiled by a strict TypeScript gate and deployed to a client-presentable clone of the source site, so completeness and fidelity matter more than cleverness.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose
  before or after the code. The first character of your response is part of
  the file.
- The component must be a named export function (not default export).
- Props type: \`{ block: BlockNode; children?: React.ReactNode }\` where
  BlockNode is imported as:
  \`import type { BlockNode } from "@/lib/jab/ability-client";\`
  If your block is a LEAF (paragraph, heading, image, single button), you
  MAY omit the children field — the dispatcher widens the contract at the
  call site, so either signature compiles.
- The \`children\` prop carries the pre-rendered descendant block tree from
  the dispatcher. If your block is a WRAPPER (e.g. core/group, core/columns,
  core/buttons, core/cover, or any block whose source DOM contains nested
  block content), declare \`children?: React.ReactNode\` and render
  \`{children}\` in the appropriate slot inside your layout. Never recreate
  child block markup yourself; the dispatcher already did it. Rendering the
  children slot in the wrong place (or not at all) is the most common way a
  wrapper block breaks the whole page — when unsure, render \`{children}\`
  inside the innermost content container of your layout.
- \`block.attrs\` is typed \`Record<string, unknown>\`. If you declare a typed
  interface for the attrs and cast to it, you MUST go through \`unknown\`:
  \`const data = block.attrs as unknown as MyAttrs;\` — a direct
  \`block.attrs as MyAttrs\` fails the typecheck gate (TS2352) whenever the
  interface has required fields (e.g. \`acf_fc_layout\`). Equivalently, read
  fields inline (\`block.attrs.heading as string\`) or declare every
  interface field optional. Never emit a bare \`as MyAttrs\` on
  \`block.attrs\`.
- Export ONLY the main component. Sub-components are local (not exported).
- Keep the component <= 200 lines. Complex components should compose
  smaller sub-components defined in the same file.
- Never import modules that are not certain to exist in the generated
  project. Safe imports: react, next/link, next/image, and
  "@/lib/jab/ability-client" (types only). Anything else fails the build.

## Styling rules
- Use Tailwind CSS classes for all styling. No inline style objects unless
  a value is dynamic (e.g. a hex color carried in block.attrs — see the
  worked example below for the pattern).
- A build-specific design-token section follows in the next system block.
  When tokens are listed there, use them as Tailwind class values: the
  generated tailwind.config.ts maps every token slug to a Tailwind
  color/font key, so a palette entry with slug "primary" is usable as
  \`bg-primary\`, \`text-primary\`, \`border-primary\`. When the source data
  carries a literal color that equals a token's hex value, prefer the token
  class over a generic Tailwind approximation (\`bg-primary\`, not
  \`bg-yellow-400\`). Match by hex value, not by the token's semantic name.
- Do NOT import fonts. Do NOT use next/font. Font families come from the
  Tailwind config; font-family token slugs are usable as \`font-<slug>\`.
- Do NOT use external icon libraries. Inline SVG or emoji fallback only.
- Respect the source block's semantic HTML: headings stay headings (h1-h6,
  driven by a level attr when present), lists stay lists, blockquotes stay
  blockquotes, nav stays nav. Add alt text to every image; use the
  \`sr-only\` utility for screen-reader-only labels.
- Responsive by default: write mobile-first Tailwind classes and add
  \`md:\` / \`lg:\` refinements where the source structure implies a
  multi-column or large-spacing desktop layout. A grid that is 3 columns in
  the source DOM should be \`grid-cols-1 md:grid-cols-3\`, not a fixed
  3-column grid that overflows phones.
- Spacing fidelity: when computed-style hints give concrete pixel values
  (padding, font-size, line-height), choose the nearest Tailwind step
  rather than inventing arbitrary values; use bracketed arbitrary values
  (e.g. \`pt-[72px]\`) only when no step is close.

## Image binding contract
- Bind image rendering to the actual data shape. ACF image fields expose
  \`.url\` (string), \`.alt\` (string), and \`.sizes\` (size-slug → URL map) —
  render against those paths.
- Relationship / post_object arrays ARE hydrated at render: each item
  carries \`featured_image: { url, alt }\` alongside \`post_title\` /
  \`post_name\`. Bind the image with a plain \`<img>\` (or \`next/image\` with
  explicit width/height) to \`item.featured_image.url\` — do NOT use
  \`<MediaImage>\` here (that shim takes a block, not a src).
- Only when \`item.featured_image?.url\` is genuinely absent at runtime, fall
  back to a brand-tinted block — never emit a gray "placeholder" box or a
  fake \`<BeerPlaceholderImage>\`-style component.
- Smoking-gun anti-example: the Two Roads FeaturedBeer component emitted
  \`<BeerPlaceholderImage title={beer.post_title} />\` rendering a gray box
  with the beer name — every beer card on the deployed site looked broken
  even though the rest of the layout was correct. Do not reproduce this
  failure mode under any naming.

## Anti-placeholder rules (hard requirements)
- NEVER render a literal gray "placeholder" box, an "image coming soon"
  panel, or an invented \`<SomethingPlaceholder>\` sub-component.
- NEVER emit lorem-ipsum, sample copy, invented nav labels, or fabricated
  links. Every visible string must come from \`block.attrs\`,
  \`block.innerHTML\`, or \`children\`. If a field can be empty, render
  nothing for that slot rather than inventing content.
- NEVER leave TODO / FIXME comments, commented-out code, or stub branches
  ("implement later"). Emit complete, production-ready code in one pass.
- Degrade by omission: an absent optional field means the element is not
  rendered. The single exception is an absent image inside a card/list
  layout where a collapsed slot would break the grid rhythm — there, use a
  brand-tinted block (a div with a brand background token at reduced
  opacity, e.g. \`bg-primary/15\`, sized to the image slot, aria-hidden) so
  the layout holds without looking broken.
- Empty-state copy is allowed ONLY for list-like layouts whose items array
  can legitimately be empty at runtime, and must be one short neutral
  sentence (e.g. "No events scheduled."), not styled debug text.

## Data-shape guide (WordPress capture → props)
- \`block.attrs\` carries the block's attributes exactly as captured from
  the source site. Attribute samples in the user message show up to three
  REAL shapes observed in production — treat their field names and nesting
  as authoritative over your priors about what a WP block "should" look
  like.
- \`block.innerHTML\` carries the block's rendered inner HTML where the
  source block had free-form content. For rich-text-bearing leaves
  (paragraph, heading, list), bind the text content from attrs when a
  dedicated field exists; fall back to injecting \`block.innerHTML\` raw
  (the same React raw-HTML prop the generated Passthrough component uses)
  ONLY when the block is inherently free-form HTML and no structured
  fields cover it.
- ACF link fields are objects: \`{ url, title, target }\` — bind href to
  \`.url\`, label to \`.title\`, and pass \`target\` / \`rel\` through when
  \`target\` is "_blank".
- Date strings from WP are ISO-ish ("2026-06-10 18:00:00" or "20260610").
  Format them for display (e.g. via \`new Date(...)\` with
  \`toLocaleDateString\`) instead of printing raw values.
- Booleans may arrive as true/false, "1"/"0", or 1/0 across ACF versions —
  test truthiness loosely (\`Boolean(value)\` semantics), never strict
  equality against \`true\`.
- When a numeric attr drives layout (columns, items-per-row), clamp it to
  the values your Tailwind classes actually implement and default sanely
  when absent.

## Worked example (few-shot exemplar)
Input (abridged): block "acf_flex/page/page_builder/feature-cards", attribute
sample { section_headline: "Why choose us", intro: "...", accent_color:
"#0e7c3a", cards: [{ title, body, icon: { url, alt }, link: { url, title } }] }.
A faithful output — note the unknown-cast, the optional handling, the plain
img binding, the brand-tinted fallback, and the dynamic inline style used
ONLY for the attr-carried hex:

import type { BlockNode } from "@/lib/jab/ability-client";

interface FeatureCardLink { url?: string; title?: string; target?: string }
interface FeatureCardIcon { url?: string; alt?: string }
interface FeatureCard {
  title?: string;
  body?: string;
  icon?: FeatureCardIcon;
  link?: FeatureCardLink;
}
interface FeatureCardsAttrs {
  section_headline?: string;
  intro?: string;
  accent_color?: string;
  cards?: FeatureCard[];
}

export function FeatureCards({ block }: { block: BlockNode }) {
  const attrs = block.attrs as unknown as FeatureCardsAttrs;
  const cards = attrs.cards ?? [];
  return (
    <section className="w-full py-12 md:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {attrs.section_headline ? (
          <h2
            className="text-3xl font-bold md:text-4xl"
            style={attrs.accent_color ? { color: attrs.accent_color } : undefined}
          >
            {attrs.section_headline}
          </h2>
        ) : null}
        {attrs.intro ? (
          <p className="mt-4 max-w-2xl text-base opacity-80">{attrs.intro}</p>
        ) : null}
        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          {cards.map((card, i) => (
            <article key={i} className="flex flex-col rounded-lg border border-black/10 p-6">
              {card.icon?.url ? (
                <img
                  src={card.icon.url}
                  alt={card.icon.alt ?? card.title ?? ""}
                  className="h-12 w-12 object-contain"
                />
              ) : (
                <div aria-hidden="true" className="h-12 w-12 rounded bg-primary/15" />
              )}
              <h3 className="mt-4 text-xl font-semibold">{card.title}</h3>
              {card.body ? <p className="mt-2 text-sm opacity-80">{card.body}</p> : null}
              {card.link?.url ? (
                <a
                  href={card.link.url}
                  target={card.link.target === "_blank" ? "_blank" : undefined}
                  rel={card.link.target === "_blank" ? "noopener noreferrer" : undefined}
                  className="mt-auto pt-4 text-sm font-medium text-primary hover:underline"
                >
                  {card.link.title ?? "Learn more"}
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

End of worked example. Apply the same discipline to the block described in
the user message: bind every rendered value to real captured data, honor the
wrapper/leaf children contract, match the source structure, and return only
the complete TSX source.`;

/**
 * The per-build, per-call system remainder — rendered as the SECOND
 * (uncached) system text block. Everything here varies across builds:
 * the design-token JSON and the source-host internal-links rule. Keeping
 * this out of COMPONENT_SYSTEM_CORE is what makes the cached prefix
 * byte-stable across blocks, builds, and projects.
 */
export function buildPerBuildSystemPrompt(
  tokens: ThemeJsonTokens | null,
  sourceHost?: string | null,
): string {
  const tokenSection = tokens
    ? `## Build-specific design tokens (from theme.json)

Colors: ${JSON.stringify(tokens.colorPalette?.slice(0, 10) ?? [])}
Font sizes: ${JSON.stringify(tokens.fontSizes?.slice(0, 8) ?? [])}
Font families: ${JSON.stringify(tokens.fontFamilies?.slice(0, 4) ?? [])}
Block gap: ${tokens.blockGap ?? "unset"}

Use these tokens as Tailwind class values where possible. The generated
tailwind.config.ts maps all slugs to Tailwind color/font keys.`
    : `## Build-specific design tokens
No theme.json tokens available. Use Tailwind defaults.`;
  const hostRule = sourceHost
    ? `\n- Links whose host is ${sourceHost} are INTERNAL. Emit them as root-relative paths copied exactly from the source URL's path. NEVER emit ${sourceHost} in any href.`
    : "";
  return `${tokenSection}${hostRule}`;
}
```

- [ ] Update the four Sonnet-tier builders to use the per-build system half. In `visualPrompt` (:248), `standardPrompt` (:272), `cptTemplatePrompt` (:307), `acfFlexPrompt` (:560), replace

```ts
  const system = sharedSystemPrompt(tokens, sourceHost);
```

  with

```ts
  const system = buildPerBuildSystemPrompt(tokens, sourceHost);
```

  `trivialPrompt` (:290-304) is untouched.
- [ ] In `generateComponent`, add the cached prefix to the existing client call (post-Phase-1 the call has no cache field; the loop itself is restructured in Task 5 — this is the minimal coherent intermediate). Locate the `client.generate({ ... })` call inside the attempt loop and add as its first property:

```ts
        cachedSystemPrefix: entry.tier === "trivial" ? undefined : COMPONENT_SYSTEM_CORE,
```

- [ ] Re-home the two tests in `component-generator.test.ts` that asserted core content via `cptTemplatePrompt` output (currently `"the shared system prompt carries the image binding contract that bans literal placeholder boxes"` at :146-152 and `"instructs casting block.attrs via \`as unknown as\`..."` at :154-159): change their assertions to run against `COMPONENT_SYSTEM_CORE` instead of `cptTemplatePrompt(makeCptEntry(), null)`. The assertion strings stay identical; only the subject changes:

```ts
  it("the cached system core carries the image binding contract that bans literal placeholder boxes", () => {
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Image binding contract/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/never emit a gray "placeholder" box/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Two Roads FeaturedBeer/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/post_object\b|relationship/);
  });

  it("the cached system core instructs casting block.attrs via `as unknown as` (TS2352 guard)", () => {
    expect(COMPONENT_SYSTEM_CORE).toMatch(/block\.attrs as unknown as/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Never emit a bare `as MyAttrs`/);
  });
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect PASS (including the pre-existing internal-links tests at :543-575, which assert the sourceHost rule in the builders' system half — `buildPerBuildSystemPrompt` keeps it there — and the R7 guidance-placement table at :578-647, untouched by this restructure).
- [ ] Run: `cd apps/web && pnpm vitest run` — expect PASS.
- [ ] Commit: `git add -A && git commit -m "feat(ai): COMPONENT_SYSTEM_CORE cached prefix (>=10k chars) + per-build system split, COMPONENT_PROMPT_VERSION=2"`

---

### Task 3: `buildRetryUserSuffix` + `GenerationFailureKind` (pure helpers)

The corrective-retry suffix and the failure-kind taxonomy are pure and shared by BOTH loops (`generate-shell.ts` already imports `validateTsx` from `component-generator.ts` — these exports follow the same pattern).

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` (add exports near `validateTsx`, currently :618)
- Modify: `apps/web/lib/ai/component-generator.test.ts`

**Steps:**

- [ ] Add the failing tests to `apps/web/lib/ai/component-generator.test.ts` (extend the import from `./component-generator` with `buildRetryUserSuffix`):

```ts
describe("buildRetryUserSuffix (Phase 2 corrective retry)", () => {
  it("renders the header, at most 3 diagnostics, and the output tail", () => {
    const s = buildRetryUserSuffix(["e1", "e2", "e3", "e4", "e5"], "x".repeat(800));
    expect(s).toContain("## Previous attempt failed validation");
    expect(s).toContain("- e1");
    expect(s).toContain("- e3");
    expect(s).not.toContain("- e4");
    // tail clamped to the LAST ~500 chars
    expect(s).toContain("x".repeat(500));
    expect(s).not.toContain("x".repeat(501));
  });

  it("handles an empty diagnostics list and empty tail without throwing", () => {
    const s = buildRetryUserSuffix([], "");
    expect(s).toContain("## Previous attempt failed validation");
    expect(s).toContain("no parser diagnostics");
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect FAIL: `buildRetryUserSuffix` is not exported.
- [ ] Implement in `apps/web/lib/ai/component-generator.ts`, directly above `validateTsx`:

```ts
import type { AiFailureKind } from "./errors";

/**
 * Failure-kind discriminator persisted to block_inventory.failure_kind /
 * shell_generations.failure_kind (Phase 1 migration 0034, text column).
 * Extends the Phase 1 AiFailureKind taxonomy (typed API-error classes) with
 * the generation-loop failure classes the audit asked to distinguish
 * (generate-shell #6: api_error | over_cap | invalid_tsx | postprocess,
 * plus max_tokens truncation from component-generator #5).
 */
export type GenerationFailureKind =
  | AiFailureKind
  | "max_tokens"
  | "invalid_tsx"
  | "postprocess"
  | "over_cap";

/**
 * Corrective-retry user suffix (CONTRACTS Phase 2): appended to the SECOND
 * attempt's USER prompt — never a system block, so the cached prefix stays
 * byte-stable and the retry can READ the cache entry attempt 1 wrote.
 * Carries the first 3 diagnostics and the last ~500 chars of the rejected
 * output so attempt 2 is a correction, not a statistically identical
 * re-roll (audit component-generator #4 / generate-shell #4).
 */
export function buildRetryUserSuffix(errors: string[], outputTail: string): string {
  const diags = errors.slice(0, 3).map((e) => `- ${e}`).join("\n");
  const tail = outputTail.slice(-500);
  return `
## Previous attempt failed validation
Your previous response was rejected before deployment. Diagnostics:
${diags || "- (no parser diagnostics — see the output tail below)"}

The tail of the rejected output (last ~500 chars):
\`\`\`
${tail}
\`\`\`
Produce a corrected, COMPLETE component that fixes these issues. Return ONLY the TSX source.`;
}
```

  (The `import type { AiFailureKind } from "./errors";` line joins the existing import block at the top of the file — `lib/ai/errors.ts` exists after Phase 1.)
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect PASS.
- [ ] Commit: `git add -A && git commit -m "feat(ai): buildRetryUserSuffix + GenerationFailureKind shared loop helpers"`

---

### Task 4: component-generator retry loop — cache marker every attempt, corrective retry, stop_reason, typed errors, ground-truth model, persisted failureKind

Full rewrite of the 2-attempt loop in `generateComponent` (currently component-generator.ts:683-809: untyped `catch` + `continue` at :743-746, `cacheSystemPrompt: attempt === 0` at :740 pre-Phase-1, hardcoded `modelUsed` at :704-706, discarded diagnostics at :777-781). Plus: `GeneratedComponent` gains `failureKind`, and `persistGeneration` (persist-generation.ts:70-83) writes it to `block_inventory.failure_kind`.

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts`
- Modify: `apps/web/lib/ai/component-generator.test.ts`
- Modify: `apps/web/lib/ai/persist-generation.ts`
- Create: `apps/web/lib/ai/persist-generation.test.ts`

**Steps:**

- [ ] Verify the existing `makeFakeClient` helper in `component-generator.test.ts` (:30-39) returns the post-Phase-1 `GenerateResult` shape. If Phase 1 did not already update it, replace it with:

```ts
/** Build a ModelClient stub that always returns the given TSX text. */
function makeFakeClient(tsx: string): ModelClient {
  return {
    async generate() {
      return {
        text: tsx,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: "end_turn" as const,
        model: "fake-model-id",
      };
    },
  };
}
```

- [ ] Add a file-level mock for `./errors` next to the existing `./model-client` mock at the top of `component-generator.test.ts` (delegating wrappers so tests that never throw are unaffected):

```ts
vi.mock("./errors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./errors")>();
  return {
    ...orig,
    classifyAiError: vi.fn(orig.classifyAiError),
    isRetryableAiFailure: vi.fn(orig.isRetryableAiFailure),
  };
});
```

- [ ] Add the failing loop tests to `component-generator.test.ts`:

```ts
describe("generateComponent — Phase 2 retry loop", () => {
  const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";
export function CoreButton({ block }: { block: BlockNode }) { return <a>ok</a>; }`;
  const BROKEN_TSX = `export function CoreButton() { return <div>unclosed; }`;

  type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;
  function res(text: string, stopReason: StopReason = "end_turn") {
    return {
      text,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason,
      model: "fake-model-id",
    };
  }

  let modelClientMod: typeof import("./model-client");
  let errorsMod: typeof import("./errors");
  let generateSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    modelClientMod = await import("./model-client");
    errorsMod = await import("./errors");
    generateSpy = vi.fn();
    vi.mocked(modelClientMod.modelClientForTier).mockReturnValue({ generate: generateSpy } as unknown as ModelClient);
  });

  it("passes the cached prefix on EVERY attempt and appends corrective feedback to attempt 2", async () => {
    generateSpy.mockResolvedValueOnce(res(BROKEN_TSX)).mockResolvedValueOnce(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].cachedSystemPrefix).toBe(COMPONENT_SYSTEM_CORE);
    expect(generateSpy.mock.calls[1][0].cachedSystemPrefix).toBe(COMPONENT_SYSTEM_CORE);
    expect(generateSpy.mock.calls[0][0].userPrompt).not.toContain("## Previous attempt failed validation");
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("## Previous attempt failed validation");
    expect(out.compileStatus).toBe("ok");
    expect(out.compileAttemptCount).toBe(2);
    expect(out.failureKind).toBeNull();
  });

  it("max_tokens truncation retries ONCE with the cap raised 1.5x (visual: 8192 → 12288)", async () => {
    generateSpy
      .mockResolvedValueOnce(res("export function CoreButton() { return <div", "max_tokens"))
      .mockResolvedValueOnce(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].maxTokens).toBeUndefined();
    expect(generateSpy.mock.calls[1][0].maxTokens).toBe(12288);
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("truncated");
    expect(out.compileStatus).toBe("ok");
  });

  it("max_tokens twice → passthrough with failureKind 'max_tokens', exactly 2 calls", async () => {
    generateSpy.mockResolvedValue(res("export function X() { return <div", "max_tokens"));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("max_tokens");
    expect(out.tsx).toContain("wp-block-passthrough");
  });

  it("bad_request fails fast — NO second attempt", async () => {
    generateSpy.mockRejectedValue(new Error("400 invalid image"));
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("bad_request");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(false);
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("bad_request");
    expect(out.modelUsed).toBeNull(); // nothing answered — no fictional model id
  });

  it("retryable API error (rate_limit) gets the second attempt", async () => {
    generateSpy.mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(res(VALID_TSX));
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("rate_limit");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(true);
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(out.compileStatus).toBe("ok");
    expect(out.failureKind).toBeNull();
  });

  it("records the ground-truth model from the response, never a hardcoded constant", async () => {
    generateSpy.mockResolvedValue(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.modelUsed).toBe("fake-model-id");
  });

  it("trivial tier passes NO cached prefix (Haiku 4096-token minimum — do not pad)", async () => {
    generateSpy.mockResolvedValue(res(VALID_TSX));
    await generateComponent({
      entry: { ...makeVisualEntry("core/heading"), tier: "trivial" },
      tokens: null,
    });
    expect(generateSpy.mock.calls[0][0].cachedSystemPrefix).toBeUndefined();
  });

  it("invalid TSX twice → failureKind 'invalid_tsx'", async () => {
    generateSpy.mockResolvedValue(res(BROKEN_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("invalid_tsx");
  });
});
```

  Note: `makeVisualEntry` exists at :45-56. The export-name postprocess expects `CoreButton` for `core/button` — `VALID_TSX`/`BROKEN_TSX` use that name on purpose.
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect FAIL: `out.failureKind` undefined / `maxTokens` never passed / 2 calls where 1 expected on bad_request.
- [ ] Implement: in `component-generator.ts`, (a) add to `GeneratedComponent` (after `cacheCreationTokens: number;` at :45):

```ts
  /**
   * Why the loop fell back (null on success / skipped). Persisted to
   * block_inventory.failure_kind (migration 0034) so a rate-limited build
   * is distinguishable from bad LLM output in the dashboard.
   */
  failureKind: GenerationFailureKind | null;
```

  (b) extend the imports: `import { classifyAiError, isRetryableAiFailure } from "./errors";` and `import { modelClientForTier, MAX_TOKENS_BY_TIER } from "./model-client";`
  (c) replace the whole body of `generateComponent` (currently :683-809) with:

```ts
export async function generateComponent(opts: GenerateComponentOptions): Promise<GeneratedComponent> {
  const { entry, tokens } = opts;
  const blockName = entry.blockName ?? "__null__";

  if (entry.tier === "passthrough" || entry.blockName === null) {
    return {
      blockName,
      tsx: passthroughFallback(blockName),
      compileStatus: "skipped",
      compileAttemptCount: 0,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failureKind: null,
    };
  }

  const client = modelClientForTier(entry.tier);

  const guidance = opts.guidance ?? undefined;
  const sourceHost = opts.sourceHosts?.[0] ?? null;
  let combinedPrompt: string;
  if (entry.kind === "cpt_template") {
    combinedPrompt = cptTemplatePrompt(entry, tokens, guidance, sourceHost);
  } else if (entry.kind === "acf_flex") {
    combinedPrompt = acfFlexPrompt(entry, tokens, guidance, opts.dynamicList, sourceHost);
  } else if (entry.tier === "visual") {
    combinedPrompt = visualPrompt(entry, tokens, guidance, sourceHost);
  } else if (entry.tier === "standard") {
    combinedPrompt = standardPrompt(entry, tokens, guidance, sourceHost);
  } else {
    combinedPrompt = trivialPrompt(entry, tokens, guidance, sourceHost);
  }

  const [systemPart, ...userParts] = combinedPrompt.split("\n\nUSER:\n");
  const systemPrompt = systemPart;
  const baseUserPrompt = userParts.join("\n\nUSER:\n") || combinedPrompt;

  // Cache marker on EVERY attempt (Phase 2): Sonnet tiers share the static
  // COMPONENT_SYSTEM_CORE prefix (>=10k chars > 2048-token minimum); the
  // retry is the request MOST likely to read the entry attempt 1 wrote.
  // Trivial (Haiku 4.5, 4096-token minimum) never caches — undefined, no pad.
  const cachedSystemPrefix = entry.tier === "trivial" ? undefined : COMPONENT_SYSTEM_CORE;
  // entry.tier is narrowed by the passthrough early-return above, but TS
  // property narrowing doesn't persist — assert the LLM-tier subset.
  const baseMaxTokens = MAX_TOKENS_BY_TIER[entry.tier as "visual" | "standard" | "trivial"];

  let attemptCount = 0;
  let accInputTokens = 0;
  let accOutputTokens = 0;
  let accCacheRead = 0;
  let accCacheCreation = 0;
  let failureKind: GenerationFailureKind | null = null;
  let modelUsed: string | null = null;
  let retryErrors: string[] = [];
  let retryOutputTail = "";
  let maxTokensOverride: number | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptCount++;
    const userPrompt =
      attempt === 0 || retryErrors.length === 0
        ? baseUserPrompt
        : `${baseUserPrompt}\n${buildRetryUserSuffix(retryErrors, retryOutputTail)}`;

    let result: Awaited<ReturnType<typeof client.generate>>;
    try {
      result = await client.generate({
        cachedSystemPrefix,
        systemPrompt,
        userPrompt,
        screenshotBase64: entry.tier === "visual" ? opts.screenshotBase64 ?? undefined : undefined,
        ...(maxTokensOverride !== undefined ? { maxTokens: maxTokensOverride } : {}),
      });
    } catch (err) {
      const kind = classifyAiError(err);
      failureKind = kind;
      console.warn(`[component-generator] attempt ${attemptCount} API error (${kind}) for ${blockName}:`, err);
      // bad_request / auth / unknown: a second identical call is doomed —
      // fail fast to passthrough (audit component-generator #10).
      if (!isRetryableAiFailure(kind)) break;
      retryErrors = []; // transient failure: identical retry is correct
      continue;
    }

    accInputTokens += result.usage.inputTokens;
    accOutputTokens += result.usage.outputTokens;
    accCacheRead += result.usage.cacheReadTokens;
    accCacheCreation += result.usage.cacheCreationTokens;
    modelUsed = result.model;

    if (result.stopReason === "max_tokens") {
      failureKind = "max_tokens";
      console.warn(`[component-generator] attempt ${attemptCount} hit max_tokens for ${blockName} — output truncated at ${maxTokensOverride ?? baseMaxTokens} tokens`);
      if (attempt === 0) {
        // Single raised-cap retry: 1.5x, capped at 16000 (>16K needs streaming).
        maxTokensOverride = Math.min(16_000, Math.ceil(baseMaxTokens * 1.5));
        retryErrors = [
          "Previous attempt hit the max_tokens output limit and was truncated mid-file. Emit the COMPLETE component more concisely: fewer comments, fewer helper sub-components.",
        ];
        retryOutputTail = result.text.slice(-500);
        continue;
      }
      break; // truncated twice — passthrough, never a third call
    }

    const rawTsx = result.text.trim();
    let tsx: string;
    try {
      tsx = postprocessGeneratedTsx(rawTsx, {
        expectedExportName: toPascalCase(blockName),
      });
    } catch (err) {
      failureKind = "postprocess";
      console.warn(`[component-generator] attempt ${attemptCount} postprocess failed for ${blockName}:`, err);
      retryErrors = [err instanceof Error ? err.message : String(err)];
      retryOutputTail = rawTsx.slice(-500);
      continue;
    }

    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      tsx = rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts });
    }

    if (Buffer.byteLength(tsx, "utf8") > MAX_COMPONENT_BYTES) {
      failureKind = "over_cap";
      const bytes = Buffer.byteLength(tsx, "utf8");
      console.warn(`[component-generator] attempt ${attemptCount} size exceeded for ${blockName} (${bytes} bytes)`);
      retryErrors = [
        `Output was ${bytes} bytes — over the ${MAX_COMPONENT_BYTES}-byte component cap. Emit a tighter component (fewer sub-components, shorter class lists).`,
      ];
      retryOutputTail = tsx.slice(-500);
      continue;
    }

    const fileName = `${toPascalCase(blockName)}.tsx`;
    const errors = validateTsx(tsx, fileName);
    if (errors.length > 0) {
      failureKind = "invalid_tsx";
      console.warn(`[component-generator] attempt ${attemptCount} TSX validation failed for ${blockName}:`, errors.slice(0, 3));
      retryErrors = errors.slice(0, 3);
      retryOutputTail = tsx.slice(-500);
      continue;
    }

    return {
      blockName,
      tsx,
      compileStatus: "ok",
      compileAttemptCount: attemptCount,
      modelUsed,
      providerUsed: "anthropic",
      inputTokens: accInputTokens,
      outputTokens: accOutputTokens,
      cacheReadTokens: accCacheRead,
      cacheCreationTokens: accCacheCreation,
      failureKind: null,
    };
  }

  return {
    blockName,
    tsx: passthroughFallback(blockName),
    compileStatus: "failed",
    compileAttemptCount: attemptCount,
    modelUsed,
    // providerUsed is only "anthropic" when at least one response arrived —
    // a zero-response failure must not attribute cost to a provider.
    providerUsed: modelUsed ? "anthropic" : null,
    inputTokens: accInputTokens,
    outputTokens: accOutputTokens,
    cacheReadTokens: accCacheRead,
    cacheCreationTokens: accCacheCreation,
    failureKind: failureKind ?? "unknown",
  };
}
```

  This DELETES the old hardcoded `const modelUsed = entry.tier === "trivial" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";` (:704-706) — the ground-truth `result.model` replaces it (CONTRACTS: "callers must persist THIS, never a re-hardcoded constant").
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/component-generator.test.ts` — expect PASS.
- [ ] Re-point the Phase 1 `failure_kind` plumbing at the component. Phase 1 already writes `failure_kind: input.failureKind ?? null` from a separate optional persist arg typed `AiFailureKind | "max_tokens" | null`. In `apps/web/lib/ai/persist-generation.ts`: (a) DELETE that separate `failureKind` input arg (the component now carries it), (b) change the payload line to read from the component — the accepted value set widens automatically because `GeneratedComponent.failureKind` is `GenerationFailureKind | null` (Task 3):

```ts
      failure_kind: component.failureKind,
```

- [ ] Extend `apps/web/lib/ai/persist-generation.test.ts` (Phase 1 wrote this suite — keep its tests, but update any that passed `failureKind` as a separate persist arg to set it on the `component` literal instead, then append):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadSpy = vi.fn();
const updateSpy = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ upload: uploadSpy }) },
    from: () => ({ update: updateSpy }),
  }),
}));

import { persistGeneration } from "./persist-generation";
import type { GeneratedComponent } from "./component-generator";

function component(over: Partial<GeneratedComponent> = {}): GeneratedComponent {
  return {
    blockName: "core/button",
    tsx: "export function CoreButton() { return null; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "fake-model-id",
    providerUsed: "anthropic",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    failureKind: null,
    ...over,
  };
}

describe("persistGeneration — failure_kind persistence (Phase 2)", () => {
  beforeEach(() => {
    uploadSpy.mockReset().mockResolvedValue({ error: null });
    updateSpy.mockReset().mockImplementation(() => ({
      eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }));
  });

  it("writes the component's failureKind to block_inventory.failure_kind", async () => {
    await persistGeneration({
      buildId: "b1",
      projectId: "p1",
      component: component({ compileStatus: "failed", failureKind: "max_tokens" }),
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      failure_kind: "max_tokens",
      compile_status: "failed",
    });
  });

  it("writes failure_kind null on success", async () => {
    await persistGeneration({ buildId: "b1", projectId: "p1", component: component() });
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ failure_kind: null });
  });
});
```

  (If Phase 1 added required fields to `GeneratedComponent`, extend the `component()` literal accordingly — the type error will name them.)
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/persist-generation.test.ts lib/ai/component-generator.test.ts` — expect PASS.
- [ ] Run: `cd apps/web && pnpm vitest run` — expect PASS (the regenerateComponentUnit chat-edit path calls `generateComponent` and inherits all of this with no further change).
- [ ] Commit: `git add -A && git commit -m "feat(ai): component loop — cache marker every attempt, corrective retry, stop_reason + typed errors, failure_kind persisted"`

---

### Task 5: generate-components worker — warm-up stagger before the fan-out

Concurrent identical-prefix requests ALL miss (a cache entry is readable only after the first response begins streaming), so the first 5-way `Promise.all` batch (generate-components.ts:308-339) would pay full price even with Task 2's cacheable prefix. Fix per CONTRACTS: run the FIRST Sonnet-tier entry alone, await completion (writes the cache entry), then process the rest in batches of 5.

**Files:**
- Create: `apps/web/lib/jab/sonnet-warmup.ts`
- Create: `apps/web/lib/jab/sonnet-warmup.test.ts`
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` (the region from `let generatedCount = 0;` at :263 through the batch loop ending :343)

**Steps:**

- [ ] Create `apps/web/lib/jab/sonnet-warmup.test.ts` (failing — module doesn't exist):

```ts
import { describe, it, expect } from "vitest";
import { partitionSonnetWarmup } from "./sonnet-warmup";
import type { EnrichedInventoryEntry } from "./inventory";

function entry(over: Partial<EnrichedInventoryEntry>): EnrichedInventoryEntry {
  return {
    blockName: "core/button",
    occurrenceCount: 1,
    pageSlugs: ["home"],
    attrSamples: [{}],
    tier: "visual",
    kind: "block",
    sourceDomSample: null,
    computedStyles: null,
    ...over,
  } as EnrichedInventoryEntry;
}

describe("partitionSonnetWarmup", () => {
  it("pulls the FIRST Sonnet-tier entry (visual or standard) out of the queue", () => {
    const q = [
      entry({ blockName: "core/html", tier: "passthrough" }),
      entry({ blockName: "core/heading", tier: "trivial" }),
      entry({ blockName: "core/cover", tier: "visual" }),
      entry({ blockName: "core/quote", tier: "standard" }),
    ];
    const { warmup, rest } = partitionSonnetWarmup(q);
    expect(warmup?.blockName).toBe("core/cover");
    expect(rest.map((e) => e.blockName)).toEqual(["core/html", "core/heading", "core/quote"]);
  });

  it("standard tier qualifies when it comes first (same Sonnet model = same cache)", () => {
    const q = [entry({ blockName: "cpt/beer", tier: "standard" }), entry({ tier: "visual" })];
    expect(partitionSonnetWarmup(q).warmup?.blockName).toBe("cpt/beer");
  });

  it("skips null-blockName rows (they early-return without an LLM call)", () => {
    const q = [
      entry({ blockName: null as unknown as string, tier: "visual" }),
      entry({ blockName: "core/cover", tier: "visual" }),
    ];
    expect(partitionSonnetWarmup(q).warmup?.blockName).toBe("core/cover");
  });

  it("returns null warmup + untouched queue when no Sonnet-tier entry exists", () => {
    const q = [entry({ tier: "trivial" }), entry({ tier: "passthrough" })];
    const { warmup, rest } = partitionSonnetWarmup(q);
    expect(warmup).toBeNull();
    expect(rest).toEqual(q);
  });

  it("preserves relative order of the remaining entries", () => {
    const q = [entry({ blockName: "a", tier: "trivial" }), entry({ blockName: "b", tier: "visual" }), entry({ blockName: "c", tier: "trivial" })];
    expect(partitionSonnetWarmup(q).rest.map((e) => e.blockName)).toEqual(["a", "c"]);
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/jab/sonnet-warmup.test.ts` — expect FAIL: cannot resolve `./sonnet-warmup`.
- [ ] Create `apps/web/lib/jab/sonnet-warmup.ts`:

```ts
import type { EnrichedInventoryEntry } from "./inventory";

/**
 * sonnet-warmup.ts — pure partition for the Phase 2 prompt-cache warm-up.
 *
 * Anthropic cache entries become readable only after the FIRST response
 * with that prefix begins streaming; concurrent identical-prefix requests
 * all miss. The generate-components worker therefore runs ONE Sonnet-tier
 * generation alone (writes the COMPONENT_SYSTEM_CORE cache entry) before
 * the 5-way batched fan-out (which then reads it). Visual and standard
 * both resolve to the same Sonnet model, so one warm-up covers both;
 * trivial (Haiku) has no cacheable prefix and passthrough never calls the
 * LLM — neither qualifies.
 */
const SONNET_TIERS: ReadonlySet<string> = new Set(["visual", "standard"]);

export function partitionSonnetWarmup(queue: EnrichedInventoryEntry[]): {
  warmup: EnrichedInventoryEntry | null;
  rest: EnrichedInventoryEntry[];
} {
  const idx = queue.findIndex(
    (e) => e.blockName !== null && SONNET_TIERS.has(e.tier),
  );
  if (idx === -1) return { warmup: null, rest: queue };
  return {
    warmup: queue[idx],
    rest: [...queue.slice(0, idx), ...queue.slice(idx + 1)],
  };
}
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/jab/sonnet-warmup.test.ts` — expect PASS.
- [ ] Wire the worker. In `apps/web/lib/inngest/functions/generate-components.ts`: add `import { partitionSonnetWarmup } from "@/lib/jab/sonnet-warmup";` to the import block, then replace the region from `let generatedCount = 0;` (:263) through the end of the batch `for` loop (:343) with (the per-entry body is the EXISTING code hoisted into a shared closure — only the step topology is new):

```ts
    let generatedCount = 0;

    // Shared per-step processor: the warm-up step and every batch step run
    // the same generate + persist path. Defined here (not module scope) so
    // it closes over tokens / screenshot paths / cpts / sourceHosts.
    async function processEntries(entries: EnrichedInventoryEntry[]): Promise<number> {
      // Cache base64 screenshots within the step — multiple visual-tier
      // entries on the same page share one download.
      const screenshotCache = new Map<string, string | null>();
      const supabase = createAdminClient();

      async function loadScreenshot(slug: string): Promise<string | null> {
        if (screenshotCache.has(slug)) return screenshotCache.get(slug) ?? null;
        const path = pageSlugToScreenshotPath[slug];
        if (!path) {
          screenshotCache.set(slug, null);
          return null;
        }
        try {
          const { data, error } = await supabase.storage
            .from(SITE_SCREENSHOTS_BUCKET)
            .download(path);
          if (error || !data) {
            screenshotCache.set(slug, null);
            return null;
          }
          const buf = Buffer.from(await data.arrayBuffer());
          const b64 = buf.toString("base64");
          screenshotCache.set(slug, b64);
          return b64;
        } catch {
          // Fail-soft: a transient download error just means no screenshot
          // for this entry. Component generation still runs against the
          // remaining inputs (ACF schema, attr samples, tokens).
          screenshotCache.set(slug, null);
          return null;
        }
      }

      const results = await Promise.all(
        entries.map(async (entry) => {
          // Only the visual tier consumes screenshots in component-generator;
          // skip the download for other tiers to save bytes + time.
          let screenshotBase64: string | undefined;
          if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
            const b64 = await loadScreenshot(entry.pageSlugs[0]);
            screenshotBase64 = b64 ?? undefined;
          }
          // For acf_flex layouts, detect whether this is a config-only
          // dynamic-list placeholder (e.g. upcoming_events) so the prompt can
          // teach the items contract. Null for static layouts / non-flex.
          let dynamicList: DynamicListSpec | null = null;
          if (entry.kind === "acf_flex" && entry.blockName) {
            const spec = entry.spec as Record<string, unknown> | undefined;
            const firstSample = entry.attrSamples[0] as Record<string, unknown> | undefined;
            const attrSample = spec ?? firstSample ?? {};
            dynamicList = detectDynamicList({ blockName: entry.blockName, attrSample, cpts });
          }
          const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
          const { storagePath } = await persistGeneration({ buildId, projectId, component });
          return { entry, component, storagePath };
        }),
      );
      return results.filter((r) => r.component.compileStatus !== "failed").length;
    }

    // Prompt-cache warm-up (Phase 2): run the FIRST Sonnet-tier entry alone
    // and await its completion — the response writes the COMPONENT_SYSTEM_CORE
    // cache entry. Concurrent identical-prefix requests all miss (an entry is
    // readable only once the first response begins streaming), so without this
    // the entire first 5-way batch would pay full input price.
    const { warmup, rest } = partitionSonnetWarmup(queue);
    if (warmup) {
      generatedCount += await step.run("generate-warmup", async () => processEntries([warmup]));
    }

    const batches: EnrichedInventoryEntry[][] = [];
    for (let i = 0; i < rest.length; i += BATCH_SIZE) {
      batches.push(rest.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchSucceeded = await step.run(`generate-batch-${batchIdx}`, async () => processEntries(batch));
      generatedCount += batchSucceeded;
    }
```

  Notes: (a) the old inline batch body (:272-341) is deleted — `processEntries` is its verbatim hoist; (b) step topology changes (`generate-warmup` + re-numbered batches) — any in-flight `generate-components` run during deploy will fail step memoization and must be re-triggered, the documented recovery for this worker (`retries: 0`, re-dispatch `site/components.requested`); (c) in mock mode (`JAB_GENERATE_MOCK=1`) the warm-up step still runs — harmless, zero cost, and keeps step topology identical between mock and live.
- [ ] Run: `cd apps/web && pnpm vitest run && pnpm typecheck` — expect PASS (no unit test covers the worker directly; the typecheck pins the wiring and `pnpm smoke:generate` is the live/mock verification — see final task).
- [ ] Commit: `git add -A && git commit -m "feat(saas): warm-up stagger before component fan-out so the cached prefix gets one write then N reads"`

---

### Task 6: `sanitize-shell-dom.ts` — pure shellDom sanitizer

The dominant token cost of every shell call is raw `headerEl?.outerHTML` up to 100KB (capture-theme-stylesheets.ts:93, :273-276, :355-358) — scripts, styles, comments, data-attrs, srcset lists, base64 URIs all included, clipped by a blind mid-tag byte slice. A sanitizer pass cuts WP chrome HTML 40–70% with zero fidelity loss. Per the File structure decision, sanitization happens at prompt-build time (Task 7 wires it); this task builds the pure module.

The clip is `.length`-based (UTF-16 code units), not strict bytes: shell chrome is overwhelmingly ASCII, exactness is not required for a prompt cap, and char-based slicing can never split a code point the way a byte slice can. Documented in the module docblock.

**Files:**
- Create: `apps/web/lib/jab/sanitize-shell-dom.ts`
- Create: `apps/web/lib/jab/sanitize-shell-dom.test.ts`

**Steps:**

- [ ] Create `apps/web/lib/jab/sanitize-shell-dom.test.ts` (failing — module doesn't exist):

```ts
import { describe, it, expect } from "vitest";
import { sanitizeShellDom } from "./sanitize-shell-dom";

const BIG = 100_000;

describe("sanitizeShellDom — element stripping", () => {
  it("strips <script> elements including their content and attributes", () => {
    const out = sanitizeShellDom(
      `<header><script type="text/javascript">var x = "</div>";</script><nav>Hi</nav></header>`,
      BIG,
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("var x");
    expect(out).toContain("<nav>Hi</nav>");
  });

  it("strips <style> and <noscript> elements wholesale", () => {
    const out = sanitizeShellDom(
      `<header><style>.x{color:red}</style><noscript><img src="/t.gif"></noscript><a href="/y">y</a></header>`,
      BIG,
    );
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("noscript");
    expect(out).not.toContain("t.gif");
    expect(out).toContain(`<a href="/y">y</a>`);
  });

  it("strips HTML comments (including conditional comments)", () => {
    const out = sanitizeShellDom(`<header><!--[if IE]>old<![endif]--><!-- nav start --><nav>x</nav></header>`, BIG);
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("nav start");
    expect(out).toContain("<nav>x</nav>");
  });
});

describe("sanitizeShellDom — attribute stripping", () => {
  it("strips data-* attributes in double-quoted, single-quoted, bare, and valueless forms", () => {
    const out = sanitizeShellDom(
      `<div data-elementor-id="123" data-settings='{"a":1}' data-x=foo data-active class="keep" id="k">v</div>`,
      BIG,
    );
    expect(out).not.toContain("data-");
    expect(out).toContain(`class="keep"`);
    expect(out).toContain(`id="k"`);
  });

  it("strips srcset and imagesrcset, keeps src", () => {
    const out = sanitizeShellDom(
      `<img src="/logo.png" srcset="/logo-320.png 320w, /logo-640.png 640w" sizes="100vw">`,
      BIG,
    );
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("320w");
    expect(out).toContain(`src="/logo.png"`);
  });

  it("strips base64 data: URI payloads but keeps the carrying attribute", () => {
    const out = sanitizeShellDom(
      `<img class="lazy" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">`,
      BIG,
    );
    expect(out).not.toContain("base64");
    expect(out).not.toContain("iVBORw0");
    expect(out).toContain(`class="lazy"`);
  });
});

describe("sanitizeShellDom — whitespace + clipping", () => {
  it("collapses inter-tag whitespace and runs of spaces", () => {
    const out = sanitizeShellDom(`<header>\n   <nav>\n      <a href="/a">A   B</a>\n   </nav>\n</header>`, BIG);
    expect(out).toBe(`<header><nav><a href="/a">A B</a></nav></header>`);
  });

  it("clips on an element boundary, never mid-tag", () => {
    const repeated = `<li class="menu-item"><a href="/page-x">Item label</a></li>`;
    const html = `<ul>${repeated.repeat(200)}</ul>`;
    const out = sanitizeShellDom(html, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    // The cut must land just after a '>' — no dangling partial tag/attribute.
    expect(out.endsWith(">")).toBe(true);
    expect(out).not.toMatch(/<[^>]*$/);
  });

  it("returns input unchanged in length terms when already under the cap", () => {
    const out = sanitizeShellDom(`<header><nav>x</nav></header>`, BIG);
    expect(out).toBe(`<header><nav>x</nav></header>`);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeShellDom("", BIG)).toBe("");
  });

  it("is idempotent", () => {
    const html = `<header><script>x()</script>  <nav data-x="1"><a href="/a">A</a></nav></header>`;
    const once = sanitizeShellDom(html, BIG);
    expect(sanitizeShellDom(once, BIG)).toBe(once);
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/jab/sanitize-shell-dom.test.ts` — expect FAIL: cannot resolve `./sanitize-shell-dom`.
- [ ] Create `apps/web/lib/jab/sanitize-shell-dom.ts`:

```ts
/**
 * sanitize-shell-dom.ts — pure shellDom prompt-payload sanitizer (Phase 2).
 *
 * The captured shell outerHTML (capture-theme-stylesheets.ts) is raw WP
 * page-builder chrome: inline <script>/<style>, comments, data-* attribute
 * noise, srcset candidate lists, base64 inline images — none of it is
 * information the shell LLM needs to produce TSX chrome, and at 100KB it
 * is the dominant token cost of every shell call (~25-30K input tokens).
 * This pass typically cuts WP chrome HTML 40-70% with zero fidelity loss.
 *
 * Deliberately regex-based, not a DOM parser: deterministic, dependency-
 * free, runs on partial/malformed HTML (the capture cap can truncate), and
 * the worst case of a regex miss is a few extra prompt tokens — never a
 * correctness failure. Capture stays RAW (projects.design_tokens.shellDom
 * is untouched); sanitization happens at prompt-build time in
 * shell-prompts.ts so future consumers keep the full capture.
 *
 * maxBytes is enforced via string length (UTF-16 code units), not strict
 * bytes: shell chrome is overwhelmingly ASCII and a prompt cap needs no
 * byte exactness. The clip lands on an element boundary (just after a '>'),
 * never mid-tag/mid-attribute — fixing the blind html.slice() hazard.
 *
 * Pure module: no imports, no IO, no "server-only".
 */
export function sanitizeShellDom(html: string, maxBytes: number): string {
  if (!html) return "";
  let out = html;

  // 1. Drop script/style/noscript elements wholesale (content included).
  //    The [^<]*(?:(?!</tag>)<[^<]*)* form is the standard backtracking-safe
  //    "until the real close tag" pattern.
  out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "");
  out = out.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style\s*>/gi, "");
  out = out.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript\s*>/gi, "");

  // 2. HTML comments (covers IE conditional comments too).
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // 3. data-* attributes: double-quoted, single-quoted, bare, or valueless.
  out = out.replace(/\sdata-[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");

  // 4. srcset / imagesrcset candidate lists (responsive variants are pure
  //    token weight; the LLM binds src).
  out = out.replace(/\s(?:srcset|imagesrcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 5. base64 data: URI payloads (inline images/fonts) — strip the URI,
  //    keep the carrying attribute so structure survives.
  out = out.replace(/data:[\w/+.;=-]+;base64,[A-Za-z0-9+/=]+/g, "");

  // 6. Whitespace collapse: inter-tag first, then runs.
  out = out.replace(/>\s+</g, "><");
  out = out.replace(/\s{2,}/g, " ");
  out = out.trim();

  // 7. Clip on an element boundary, never mid-tag.
  if (out.length > maxBytes) {
    const clipped = out.slice(0, maxBytes);
    const lastClose = clipped.lastIndexOf(">");
    out = lastClose > 0 ? clipped.slice(0, lastClose + 1) : clipped;
  }
  return out;
}
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/jab/sanitize-shell-dom.test.ts` — expect PASS.
- [ ] Commit: `git add -A && git commit -m "feat(saas): sanitizeShellDom — strip script/style/comment/data-attr/srcset/base64 + element-boundary clip"`

---

### Task 7: shell-prompts — structured `{ system, user }` builders, stable sections in system, sanitized shellDom LAST in user, `shouldCacheShellPrefix`

`headerPrompt`/`footerPrompt` currently return one concatenated string re-split on a `"\n\nUSER:\n"` sentinel embedded in arbitrary captured HTML (shell-prompts.ts:200, :228 → generate-shell.ts:121-122). They become structured builders. Section moves: the per-project-stable sections — `sharedShellSystemPrompt` rules (:152-172) + token table (:68-89) + theme-class inventory (:97-108) + menu (:91-95) — move into `system` (identical for header and footer → the footer's sequential call in Task 9 reads the header's cache write). Per-kind/per-call content — shellColors (:119-141), logo, site identity, required signature, guidance (:143-150) — stays in `user`, and the sanitized shellDom moves LAST in `user`.

`shouldCacheShellPrefix(text) = text.length >= 10_000` decides at build time whether the stable text qualifies as a cached prefix (Task 8 consumes it). `SHELL_DOM_PROMPT_MAX_BYTES = 60_000` bounds the sanitized DOM (~15K tokens ceiling vs the raw 100KB capture cap).

Note: `shell-prompts.ts` imports `"server-only"` (line 1) — unchanged here; Phase 7 revisits that import when `scripts/debug-shell-llm.ts` is rewired to import these builders.

**Files:**
- Modify: `apps/web/lib/ai/shell-prompts.ts`
- Modify: `apps/web/lib/ai/shell-prompts.test.ts` (rewrite the sentinel-based assertions at :22-95, :125-200)

**Steps:**

- [ ] Rewrite `apps/web/lib/ai/shell-prompts.test.ts` assertions to the structured shape FIRST (failing). Replace the whole file with:

```ts
import { describe, it, expect } from "vitest";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  shouldCacheShellPrefix,
  SHELL_DOM_PROMPT_MAX_BYTES,
  type ShellPromptInput,
} from "./shell-prompts";

const baseInput: ShellPromptInput = {
  shellDom: "<header id='masthead'><nav><a href='/'>Home</a></nav></header>",
  themeTokens: {
    colorPalette: [{ slug: "brand", color: "#ffc72c" }],
    fontFamilies: [{ slug: "display", fontFamily: "Syne, sans-serif" }],
    raw: {} as never,
  },
  menu: { name: "Primary", items: [{ title: "Home", url: "/" }, { title: "About", url: "/about" }] },
  logoUrl: "https://x.test/logo.svg",
  siteName: "Two Roads",
  siteDescription: "Craft beer",
};

describe("shell-prompts — structured {system, user} shape", () => {
  it("header: stable sections (rules + tokens + theme classes + menu) live in system", () => {
    const p = headerPrompt({ ...baseInput, themeClassNames: ["tworoads-hero"] });
    expect(p.system).toMatch(/Output contract/);
    expect(p.system).toMatch(/brand \(#ffc72c\)/);
    expect(p.system).toMatch(/display \(Syne, sans-serif\)/);
    expect(p.system).toMatch(/tworoads-hero/);
    expect(p.system).toMatch(/Menu: Primary/);
    expect(p.system).toMatch(/Width contract/);
    expect(p.system).toMatch(/Do NOT.*next\/font/);
    // Per-call content must NOT leak into the stable half.
    expect(p.system).not.toContain("masthead");
    expect(p.system).not.toContain("Two Roads");
  });

  it("header and footer produce a byte-identical system half (footer reads header's cache write)", () => {
    const input = { ...baseInput, themeClassNames: ["tworoads-hero"] };
    expect(headerPrompt(input).system).toBe(footerPrompt(input).system);
  });

  it("header user half carries identity + signature + DOM, with the DOM LAST", () => {
    const p = headerPrompt(baseInput);
    expect(p.user).toMatch(/Name: Two Roads/);
    expect(p.user).toMatch(/export function Header/);
    expect(p.user).toContain("masthead");
    // shellDom is the FINAL section: nothing but the closing fence follows it.
    const domIdx = p.user.indexOf("masthead");
    expect(domIdx).toBeGreaterThan(p.user.indexOf("Name: Two Roads"));
    expect(domIdx).toBeGreaterThan(p.user.indexOf("export function Header"));
    expect(p.user.slice(domIdx)).toMatch(/```\s*$/);
  });

  it("footer: signature + DOM in user, DOM last", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p.user).toMatch(/export function Footer/);
    const domIdx = p.user.indexOf("© 2025");
    expect(domIdx).toBeGreaterThan(p.user.indexOf("export function Footer"));
  });

  it("sanitizes the shellDom at prompt build (scripts/data-attrs never reach the prompt)", () => {
    const p = headerPrompt({
      ...baseInput,
      shellDom: `<header data-elementor-id="9"><script>track()</script><nav>Hi</nav></header>`,
    });
    expect(p.user).not.toContain("track()");
    expect(p.user).not.toContain("data-elementor-id");
    expect(p.user).toContain("<nav>Hi</nav>");
  });

  it("surfaces the captured computed chrome colors in the USER half (per-kind, not cacheable)", () => {
    const p = headerPrompt({ ...baseInput, shellColors: { backgroundColor: "rgb(255, 199, 44)", color: "rgb(0, 0, 0)" } });
    expect(p.user).toMatch(/root background-color: `rgb\(255, 199, 44\)`/);
    expect(p.user).toMatch(/Do NOT default the root to `bg-white`/);
    expect(p.system).not.toMatch(/Source chrome computed colors/);
  });

  it("omits the computed-colors section when no shellColors are captured", () => {
    const p = headerPrompt(baseInput);
    expect(p.user).not.toMatch(/Source chrome computed colors/);
  });
});

describe("shell-prompts — source-host internal-links rule", () => {
  it("system half declares source-host URLs internal; omitted without sourceHost", () => {
    const withHost = headerPrompt({ ...baseInput, sourceHost: "tworoadsbrewing.com" });
    expect(withHost.system).toContain("tworoadsbrewing.com are INTERNAL");
    expect(withHost.system).toContain("root-relative");
    expect(headerPrompt(baseInput).system).not.toContain("are INTERNAL");
  });
});

describe("shell-prompts — edit guidance placement (R7 cache-leak guard)", () => {
  const GUIDANCE = "Add the secondary menu and make the logo larger.";
  for (const [name, fn] of [["header", headerPrompt], ["footer", footerPrompt]] as const) {
    it(`${name}: guidance lands in the user half only`, () => {
      const p = fn({ ...baseInput, guidance: GUIDANCE });
      expect(p.user).toContain(GUIDANCE);
      expect(p.system).not.toContain(GUIDANCE);
    });
    it(`${name}: omitting guidance is byte-identical`, () => {
      expect(fn(baseInput)).toEqual(fn({ ...baseInput, guidance: undefined }));
    });
  }
});

describe("shouldCacheShellPrefix", () => {
  it("true at >= 10,000 chars, false below", () => {
    expect(shouldCacheShellPrefix("x".repeat(10_000))).toBe(true);
    expect(shouldCacheShellPrefix("x".repeat(9_999))).toBe(false);
  });
  it("SHELL_DOM_PROMPT_MAX_BYTES bounds the prompt DOM", () => {
    expect(SHELL_DOM_PROMPT_MAX_BYTES).toBe(60_000);
  });
});

describe("shellDeterministicFallback", () => {
  it("emits a header with site name + flat nav from menu", () => {
    const src = shellDeterministicFallback("header", { name: "Primary", items: [{ title: "Home", url: "/" }] }, "Two Roads");
    expect(src).toMatch(/export function Header/);
    expect(src).toMatch(/Two Roads/);
    expect(src).toMatch(/Home/);
  });

  it("emits a header even with no menu data", () => {
    const src = shellDeterministicFallback("header", null, "My Site");
    expect(src).toMatch(/My Site/);
  });

  it("emits a footer with site name + copyright", () => {
    const src = shellDeterministicFallback("footer", null, "Two Roads");
    expect(src).toMatch(/export function Footer/);
    expect(src).toMatch(/©/);
  });

  it("emitted TSX parses", async () => {
    const ts = await import("typescript");
    const src = shellDeterministicFallback("header", null, "Test");
    const sf = ts.createSourceFile("Header.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
```

  (`extractThemeClassNames` tests, if present elsewhere in the current file, are preserved verbatim — only the prompt-shape suites are rewritten. `shellDeterministicFallback` suites carry over unchanged, as shown.)
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/shell-prompts.test.ts` — expect FAIL: `shouldCacheShellPrefix` not exported / `p.system` undefined (builders still return strings).
- [ ] Implement in `apps/web/lib/ai/shell-prompts.ts`: add the import `import { sanitizeShellDom } from "@/lib/jab/sanitize-shell-dom";`, keep every render helper (`renderTokenSection`, `renderMenuSection`, `renderThemeClassSection`, `renderShellColorsSection`, `renderShellGuidanceSection`, `sharedShellSystemPrompt`) unchanged, and replace `headerPrompt` (:174-201) and `footerPrompt` (:203-228) with:

```ts
export interface ShellPromptParts {
  /**
   * Per-project-stable sections: contract rules + token table + theme-class
   * inventory + menu. Byte-identical for the header and footer calls of one
   * compose run — when >= 10,000 chars (shouldCacheShellPrefix) this becomes
   * the cachedSystemPrefix and the sequential footer call reads the header
   * call's cache write.
   */
  system: string;
  /** Per-kind/per-call content: colors, logo, identity, signature, guidance, then the sanitized shellDom LAST. */
  user: string;
}

/**
 * Build-time cache qualifier: the stable shell prefix only clears Sonnet
 * 4.6's 2048-token minimum cacheable size when it is large enough. 10,000
 * chars ≈ ~2,500 tokens (the same floor COMPONENT_SYSTEM_CORE pins via
 * unit test). Below the floor the stable text stays in the uncached
 * systemPrompt — correct but unaided by caching; do NOT pad to qualify.
 */
export function shouldCacheShellPrefix(text: string): boolean {
  return text.length >= 10_000;
}

/**
 * Prompt-side bound for the sanitized shellDom (~15K tokens). The capture
 * side keeps its raw 100KB transport cap (capture-theme-stylesheets.ts);
 * sanitizeShellDom strips script/style/comments/data-attrs/srcset/base64
 * first, so this cap rarely binds on real WP chrome after the 40-70% cut.
 */
export const SHELL_DOM_PROMPT_MAX_BYTES = 60_000;

function buildShellSystem(input: ShellPromptInput): string {
  const hasThemeClasses = (input.themeClassNames?.length ?? 0) > 0;
  return [
    sharedShellSystemPrompt(hasThemeClasses, input.sourceHost),
    renderTokenSection(input.themeTokens),
    renderThemeClassSection(input.themeClassNames),
    renderMenuSection(input.menu),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

export function headerPrompt(input: ShellPromptInput): ShellPromptParts {
  const system = buildShellSystem(input);
  const colors = renderShellColorsSection(input.shellColors);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const dom = sanitizeShellDom(input.shellDom, SHELL_DOM_PROMPT_MAX_BYTES);
  const user = `${colors}${logo}## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
${guidanceSection}Generate the Header component matching the structure of the source header DOM below (rendered HTML from the WP site, sanitized).

## Source header DOM
\`\`\`html
${dom}
\`\`\``;
  return { system, user };
}

export function footerPrompt(input: ShellPromptInput): ShellPromptParts {
  const system = buildShellSystem(input);
  const colors = renderShellColorsSection(input.shellColors);
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const dom = sanitizeShellDom(input.shellDom, SHELL_DOM_PROMPT_MAX_BYTES);
  const user = `${colors}## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
${guidanceSection}Generate the Footer component matching the structure of the source footer DOM below (rendered HTML from the WP site, sanitized).

## Source footer DOM
\`\`\`html
${dom}
\`\`\``;
  return { system, user };
}
```

  Section-move ledger (everything accounted for, nothing dropped): rules → system (was system); tokens/theme-classes/menu → system (were user); colors/logo/identity/signature/guidance → user (unchanged); shellDom → user LAST (was user FIRST); sentinel → deleted.
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/shell-prompts.test.ts` — expect PASS. (`generate-shell.ts` now has a type error — it still splits a string. That is fixed in Task 8; do NOT run `pnpm typecheck` or the full suite between these two tasks.)
- [ ] Do NOT commit yet — `generate-shell.ts` still consumes the old string shape, so the tree is incoherent until Task 8 lands. Tasks 7 + 8 commit together at the end of Task 8.

---

### Task 8: generate-shell loop — cached prefix, stop_reason, typed errors, corrective retry, ground-truth model + persisted failureKind

Mirror of Task 4 for `generateShell` (generate-shell.ts:79-204): delete the sentinel split (:120-122), consume the structured builders, decide caching via `shouldCacheShellPrefix`, check stop_reason, branch on typed errors, append corrective feedback, return `failureKind`, and record the model that actually answered instead of the hardcoded `"claude-sonnet-4-6"` (:180, :197). `persistShellGeneration` (persist-shell-generation.ts:103-119) writes `failure_kind`.

When the stable system half qualifies for caching, the second (uncached) system block still needs non-empty content (the model-client renders `systemPrompt` as a system text block and the API rejects empty text blocks) — it carries a one-line per-kind instruction. When it does not qualify, the stable text IS the `systemPrompt` and no extra line is added.

**Files:**
- Modify: `apps/web/lib/ai/generate-shell.ts`
- Modify: `apps/web/lib/ai/generate-shell.test.ts`
- Modify: `apps/web/lib/ai/persist-shell-generation.ts`
- Create: `apps/web/lib/ai/persist-shell-generation.test.ts`

**Steps:**

- [ ] Update `apps/web/lib/ai/generate-shell.test.ts`. (a) Replace `makeMockClient` (:5-12) with a call-capturing version returning the post-Phase-1 shape, and add the delegating `./errors` mock at the top of the file:

```ts
import { describe, it, expect, vi } from "vitest";
import { generateShell, type GenerateShellOptions } from "./generate-shell";
import type { ModelClient } from "./model-client";

vi.mock("./errors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./errors")>();
  return {
    ...orig,
    classifyAiError: vi.fn(orig.classifyAiError),
    isRetryableAiFailure: vi.fn(orig.isRetryableAiFailure),
  };
});

type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;

function shellRes(text: string, stopReason: StopReason = "end_turn") {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason,
    model: "mock-model",
  };
}

function makeMockClient(text: string): ModelClient {
  return { generate: vi.fn().mockResolvedValue(shellRes(text)) } as unknown as ModelClient;
}
```

  (b) Existing suites carry over unchanged — happy path, missing-shellDom, compile-failure, over-cap, fence-stripping, use-client, export-alias, origin-rewriting all still hold; the happy-path `expect(out.modelUsed).toBeTruthy()` now resolves to `"mock-model"`. (c) Add the new Phase 2 suites:

```ts
describe("generateShell — Phase 2 loop behavior", () => {
  const validHeader = `export function Header() { return <header>Hi</header>; }`;

  it("records the ground-truth model and failureKind null on success", async () => {
    const client = makeMockClient(validHeader);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.modelUsed).toBe("mock-model");
    expect(out.failureKind).toBeNull();
  });

  it("appends corrective feedback to the retry's user prompt after a validation failure", async () => {
    const generateSpy = vi
      .fn()
      .mockResolvedValueOnce(shellRes(`export function Header() { return <div>unclosed; }`))
      .mockResolvedValueOnce(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].userPrompt).not.toContain("## Previous attempt failed validation");
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("## Previous attempt failed validation");
    expect(out.compileStatus).toBe("ok");
  });

  it("max_tokens truncation retries once with the cap raised to 12288, twice → fallback with failureKind", async () => {
    const generateSpy = vi.fn().mockResolvedValue(shellRes("export function Header() { return <header", "max_tokens"));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].maxTokens).toBeUndefined();
    expect(generateSpy.mock.calls[1][0].maxTokens).toBe(12288);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("max_tokens");
    expect(out.tsx).toContain("Test Site"); // deterministic fallback shipped
  });

  it("bad_request fails fast: ONE call, fallback, no fictional model attribution", async () => {
    const errorsMod = await import("./errors");
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("bad_request");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(false);
    const generateSpy = vi.fn().mockRejectedValue(new Error("400"));
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("bad_request");
    expect(out.modelUsed).toBeNull();
    expect(out.providerUsed).toBeNull();
  });

  it("passes the stable system half as cachedSystemPrefix on EVERY attempt when it clears 10k chars", async () => {
    // 300 long theme-class names push the stable half well past 10,000 chars.
    const themeClassNames = Array.from({ length: 300 }, (_, i) => `very-long-theme-class-name-number-${i}-padding-padding`);
    const generateSpy = vi
      .fn()
      .mockResolvedValueOnce(shellRes(`export function Header() { return <div>unclosed; }`))
      .mockResolvedValueOnce(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    await generateShell({ ...baseOpts, kind: "header", client, themeClassNames });
    const first = generateSpy.mock.calls[0][0];
    const second = generateSpy.mock.calls[1][0];
    expect(first.cachedSystemPrefix).toBeDefined();
    expect(first.cachedSystemPrefix.length).toBeGreaterThanOrEqual(10_000);
    expect(second.cachedSystemPrefix).toBe(first.cachedSystemPrefix);
    expect(first.systemPrompt.length).toBeGreaterThan(0); // uncached block never empty
  });

  it("below the 10k floor the stable text stays in systemPrompt with NO cachedSystemPrefix", async () => {
    const generateSpy = vi.fn().mockResolvedValue(shellRes(validHeader));
    const client = { generate: generateSpy } as unknown as ModelClient;
    await generateShell({ ...baseOpts, kind: "header", client });
    const call = generateSpy.mock.calls[0][0];
    expect(call.cachedSystemPrefix).toBeUndefined();
    expect(call.systemPrompt).toContain("Output contract");
  });
});
```

- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/generate-shell.test.ts` — expect FAIL (module still splits the sentinel; `failureKind` missing).
- [ ] Implement in `apps/web/lib/ai/generate-shell.ts`. (a) Imports:

```ts
import { validateTsx, buildRetryUserSuffix, type GenerationFailureKind } from "./component-generator";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  shouldCacheShellPrefix,
  type ShellMenu,
} from "./shell-prompts";
import { MAX_TOKENS_BY_TIER } from "./model-client";
```

  (b) Add to `GeneratedShell` (after `cacheCreationTokens: number;` at :76):

```ts
  /** Why the loop fell back (null on success / skipped). Persisted to shell_generations.failure_kind. */
  failureKind: GenerationFailureKind | null;
```

  and add `failureKind: null,` to the empty-shellDom short-circuit return (:94-105).
  (c) Replace everything from the `promptInput` construction (:108) through the end of the function (:204) with:

```ts
  const promptInput = {
    shellDom,
    themeTokens: opts.themeTokens,
    themeClassNames: opts.themeClassNames,
    shellColors: opts.shellColors,
    menu,
    logoUrl: opts.logoUrl,
    siteName,
    siteDescription: opts.siteDescription,
    guidance: opts.guidance,
    sourceHost: opts.sourceHost,
  };
  const built = kind === "header" ? headerPrompt(promptInput) : footerPrompt(promptInput);

  // Caching decision at build time: the stable half (rules + tokens + theme
  // classes + menu) only clears Sonnet's 2048-token minimum when large
  // enough. When cached, the second (uncached) system block must still be
  // non-empty — it carries the per-kind instruction line. Header and footer
  // share a byte-identical stable half, and compose-site runs them
  // sequentially, so the footer call reads the header call's cache write.
  const useCachedPrefix = shouldCacheShellPrefix(built.system);
  const cachedSystemPrefix = useCachedPrefix ? built.system : undefined;
  const systemPrompt = useCachedPrefix
    ? `Generate the site ${kind} chrome component per the contract in the cached system block.`
    : built.system;
  const baseUserPrompt = built.user;
  const baseMaxTokens = MAX_TOKENS_BY_TIER.visual; // shell client is modelClientForTier("visual") — compose-site.ts

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let attemptCount = 0;
  let failureKind: GenerationFailureKind | null = null;
  let modelUsed: string | null = null;
  let retryErrors: string[] = [];
  let retryOutputTail = "";
  let maxTokensOverride: number | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptCount++;
    const userPrompt =
      attempt === 0 || retryErrors.length === 0
        ? baseUserPrompt
        : `${baseUserPrompt}\n${buildRetryUserSuffix(retryErrors, retryOutputTail)}`;

    let result: Awaited<ReturnType<typeof client.generate>>;
    try {
      result = await client.generate({
        cachedSystemPrefix,
        systemPrompt,
        userPrompt,
        ...(maxTokensOverride !== undefined ? { maxTokens: maxTokensOverride } : {}),
      });
    } catch (err) {
      const errKind = classifyAiError(err);
      failureKind = errKind;
      console.warn(`[generate-shell] attempt ${attemptCount} API error (${errKind}) for ${kind}:`, err);
      if (!isRetryableAiFailure(errKind)) break; // 400/401-class: a second identical call is doomed
      retryErrors = [];
      continue;
    }

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cacheReadTokens += result.usage.cacheReadTokens;
    cacheCreationTokens += result.usage.cacheCreationTokens;
    modelUsed = result.model;

    if (result.stopReason === "max_tokens") {
      failureKind = "max_tokens";
      console.warn(`[generate-shell] attempt ${attemptCount} hit max_tokens for ${kind} — output truncated at ${maxTokensOverride ?? baseMaxTokens} tokens`);
      if (attempt === 0) {
        maxTokensOverride = Math.min(16_000, Math.ceil(baseMaxTokens * 1.5));
        retryErrors = [
          "Previous attempt hit the max_tokens output limit and was truncated mid-file. Emit the COMPLETE component more concisely: shorter SVG paths, fewer wrapper elements, no comments.",
        ];
        retryOutputTail = result.text.slice(-500);
        continue;
      }
      break;
    }

    const expectedName = kind === "header" ? "Header" : "Footer";
    let stripped: string;
    try {
      stripped = postprocessGeneratedTsx(result.text.trim(), { expectedExportName: expectedName });
    } catch (err) {
      failureKind = "postprocess";
      console.warn(`[generate-shell] attempt ${attemptCount} postprocess failed for ${kind}:`, err);
      retryErrors = [err instanceof Error ? err.message : String(err)];
      retryOutputTail = result.text.slice(-500);
      continue;
    }
    // Rewrite source-origin URLs to root-relative paths BEFORE the byte-size
    // cap check — rewriting only shortens output, so the cap should judge the
    // final deployed artifact, not the pre-rewrite intermediate.
    stripped = relink(stripped);
    if (Buffer.byteLength(stripped, "utf8") > MAX_SHELL_BYTES) {
      failureKind = "over_cap";
      const bytes = Buffer.byteLength(stripped, "utf8");
      console.warn(`[generate-shell] attempt ${attemptCount} over cap for ${kind} (${bytes} bytes)`);
      retryErrors = [
        `Output was ${bytes} bytes — over the ${MAX_SHELL_BYTES}-byte cap. Emit a tighter component: shorter inline SVGs, fewer repeated class lists.`,
      ];
      retryOutputTail = stripped.slice(-500);
      continue;
    }
    const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";
    const errors = validateTsx(stripped, fileName);
    if (errors.length > 0) {
      failureKind = "invalid_tsx";
      console.warn(`[generate-shell] attempt ${attemptCount} TSX validation failed for ${kind}:`, errors.slice(0, 3));
      retryErrors = errors.slice(0, 3);
      retryOutputTail = stripped.slice(-500);
      continue;
    }

    return {
      shellKind: kind,
      tsx: stripped,
      compileStatus: "ok",
      compileAttemptCount: attemptCount,
      modelUsed,
      providerUsed: "anthropic",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      failureKind: null,
    };
  }

  // Both attempts failed (bad TSX, size exceeded, truncation, or API errors).
  // Return the deterministic fallback but preserve accumulated token telemetry
  // AND the ground truth of what (if anything) answered: modelUsed stays null
  // when zero API responses arrived — the failure row must never attribute
  // cost to a model that was never reached (audit generate-shell #6).
  return {
    shellKind: kind,
    tsx: relink(shellDeterministicFallback(kind, menu, siteName)),
    compileStatus: "failed",
    compileAttemptCount: attemptCount,
    modelUsed,
    providerUsed: modelUsed ? "anthropic" : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    failureKind: failureKind ?? "unknown",
  };
}
```

  Also add `import { classifyAiError, isRetryableAiFailure } from "./errors";` to the import block. The hardcoded `modelUsed: "claude-sonnet-4-6"` literals (:180, :197) are GONE.
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/generate-shell.test.ts lib/ai/shell-prompts.test.ts` — expect PASS.
- [ ] Re-point the Phase 1 `failure_kind` plumbing at the shell result. Phase 1 already writes `failure_kind: input.failureKind ?? null` from a separate optional persist arg typed `AiFailureKind | "max_tokens" | null`. In `apps/web/lib/ai/persist-shell-generation.ts`: (a) DELETE that separate `failureKind` input arg (the shell result now carries it), (b) change the payload line inside the `.upsert({ ... })` object to read from the shell — the accepted value set widens automatically because `GeneratedShell.failureKind` is `GenerationFailureKind | null` (Task 8):

```ts
        failure_kind: shell.failureKind,
```

- [ ] Extend `apps/web/lib/ai/persist-shell-generation.test.ts` (Phase 1 wrote this suite — keep its tests, but update any that passed `failureKind` as a separate persist arg to set it on the `shell` literal instead, then append):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadSpy = vi.fn();
const upsertSpy = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ upload: uploadSpy, download: vi.fn() }) },
    from: () => ({ upsert: upsertSpy }),
  }),
}));

import { persistShellGeneration } from "./persist-shell-generation";
import type { GeneratedShell } from "./generate-shell";

function shell(over: Partial<GeneratedShell> = {}): GeneratedShell {
  return {
    shellKind: "header",
    tsx: "export function Header() { return null; }",
    compileStatus: "failed",
    compileAttemptCount: 2,
    modelUsed: null,
    providerUsed: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    failureKind: "rate_limit",
    ...over,
  };
}

describe("persistShellGeneration — failure_kind + ground-truth model (Phase 2)", () => {
  beforeEach(() => {
    uploadSpy.mockReset().mockResolvedValue({ error: null });
    upsertSpy.mockReset().mockResolvedValue({ error: null });
  });

  it("persists failure_kind and a NULL model when zero API responses arrived", async () => {
    await persistShellGeneration({ buildId: "b1", projectId: "p1", shell: shell() });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      failure_kind: "rate_limit",
      model_used: null,
      provider_used: null,
      compile_status: "failed",
    });
  });

  it("persists failure_kind null + the answering model on success", async () => {
    await persistShellGeneration({
      buildId: "b1",
      projectId: "p1",
      shell: shell({ compileStatus: "ok", failureKind: null, modelUsed: "claude-sonnet-4-6", providerUsed: "anthropic" }),
    });
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      failure_kind: null,
      model_used: "claude-sonnet-4-6",
    });
  });
});
```

  (If Phase 1 added required fields to `GeneratedShell` or to the upsert payload, extend the literals — the type error / assertion diff will name them.)
- [ ] Run: `cd apps/web && pnpm vitest run lib/ai/persist-shell-generation.test.ts` — expect PASS.
- [ ] Run: `cd apps/web && pnpm vitest run && pnpm typecheck` — expect PASS (compose-site still compiles: it passes `GenerateShellOptions` unchanged; only the internals changed. The `scripts/debug-shell-llm.ts` fork is untouched and still compiles against its own inlined builders — Phase 7 deletes that fork).
- [ ] Commit: `git add -A && git commit -m "feat(ai): shell loop — structured prompts + cached prefix, stop_reason, typed errors, corrective retry, ground-truth model + failure_kind"`

---

### Task 9: compose-site — sequential header→footer, generate and persist in separate steps

Two structural fixes in the shell region of `compose-site.ts` (:672-715): (1) `Promise.all` fires header+footer concurrently with byte-identical stable prefixes — both miss the cache (an entry is readable only after the first response begins streaming); running footer AFTER header makes the footer's prefix a guaranteed read whenever caching qualifies. (2) Each step bundles `generateShell` + `persistShellGeneration` — with `retries: 0` (compose-site.ts:164) a Storage/DB blip after a successful generation throws the paid tokens away and fails the build; splitting them into separate `step.run` calls makes the generation memoizable independently of persistence and the failure attributable.

No new unit test: this is Inngest step topology inside a 700+-line worker with no existing direct unit test; the seam-level behavior (what `generateShell` does, what gets persisted) is covered by Tasks 8's unit tests, and the topology is verified by typecheck + the full suite + the smoke runner (`pnpm smoke:compose` against a build in mock mode), consistent with how this worker's prior changes were validated in this repo.

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (:672-715; imports at :9-11)

**Steps:**

- [ ] Add the type import to compose-site.ts's import block (:10):

```ts
import { generateShell } from "@/lib/ai/generate-shell";
import type { GeneratedShell } from "@/lib/ai/generate-shell";
```

- [ ] Replace the `await Promise.all([ ... ])` block (:672-715) with:

```ts
    // Sequential, split steps (Phase 2):
    //  - header BEFORE footer: their stable prompt prefixes are byte-identical,
    //    and a cache entry is only readable after the first response begins
    //    streaming — sequencing turns the footer's prefix into a guaranteed
    //    cache read whenever the prefix qualifies (shouldCacheShellPrefix).
    //  - generate and persist in SEPARATE steps: with retries:0 a transient
    //    Storage/DB failure after a successful generation must not discard the
    //    paid tokens inside the same step; splitting makes the generation
    //    memoizable independently and the failure attributable.
    // Reuse path returns null (no persist needed — the artifact already exists).
    const headerOut = await step.run("generate-header", async (): Promise<GeneratedShell | null> => {
      if (
        shouldReuseShell({
          skipEnabled: skipShellRegen,
          hasEditGuidance: shellEditGuidance("header") !== undefined,
          artifactExists: await shellArtifactExists(buildId, "header"),
        })
      ) {
        console.log(`[compose-site ${buildId}] JAB_SKIP_SHELL_REGEN: reusing existing Header.tsx`);
        return null;
      }
      return generateShell({
        ...baseShellInput,
        kind: "header",
        shellDom: designTokens.shellDom?.header ?? "",
        shellColors: designTokens.shellStyles?.header ?? null,
        guidance: shellEditGuidance("header"),
      });
    });
    if (headerOut) {
      await step.run("persist-header", () =>
        persistShellGeneration({ buildId, projectId, shell: headerOut }),
      );
    }

    const footerOut = await step.run("generate-footer", async (): Promise<GeneratedShell | null> => {
      if (
        shouldReuseShell({
          skipEnabled: skipShellRegen,
          hasEditGuidance: shellEditGuidance("footer") !== undefined,
          artifactExists: await shellArtifactExists(buildId, "footer"),
        })
      ) {
        console.log(`[compose-site ${buildId}] JAB_SKIP_SHELL_REGEN: reusing existing Footer.tsx`);
        return null;
      }
      return generateShell({
        ...baseShellInput,
        kind: "footer",
        shellDom: designTokens.shellDom?.footer ?? "",
        shellColors: designTokens.shellStyles?.footer ?? null,
        guidance: shellEditGuidance("footer"),
      });
    });
    if (footerOut) {
      await step.run("persist-footer", () =>
        persistShellGeneration({ buildId, projectId, shell: footerOut }),
      );
    }
```

  Notes: (a) `GeneratedShell` is JSON-safe (strings/numbers/null only) so it crosses the `step.run` boundary; (b) the old steps returned `{ reusedShell }` / the shell object — nothing consumed those return values except the steps themselves (verified: no other reference to the Promise.all result at :672), so the `null` sentinel is safe; (c) sequential shells add roughly one shell-generation of wall-clock (~20-60s) per build — accepted per the campaign contract; (d) step topology changes (`persist-header`/`persist-footer` are new step IDs) — in-flight compose runs during deploy must be re-triggered, same operational note as Task 5.
- [ ] Run: `cd apps/web && pnpm typecheck` — expect PASS.
- [ ] Run: `cd apps/web && pnpm vitest run` — expect PASS (full suite green).
- [ ] Live/mock validation note for the operator (not blocking the commit): `JAB_GENERATE_MOCK=1 pnpm smoke:compose` against a discovered build must show the four shell steps (`generate-header` → `persist-header` → `generate-footer` → `persist-footer`) completing in order, then on the next REAL build inspect `shell_generations`: `input_tokens_cached` (cache reads) should be non-zero on the footer row whenever the stable prefix qualified, and `failure_kind` should be NULL on ok rows.
- [ ] Commit: `git add -A && git commit -m "feat(saas): compose-site shells — sequential header→footer + split generate/persist steps"`

---

## Phase completion checklist

- [ ] `cd apps/web && pnpm vitest run` — full suite green.
- [ ] `cd apps/web && pnpm typecheck` — green.
- [ ] Confirm migration 0034 (Phase 1) is applied to BOTH Supabase projects before any real build exercises this code — `block_inventory.failure_kind` / `shell_generations.failure_kind` writes will 42703 otherwise. (Per memory: 0032 + 0033 were also still pending apply at plan time; 0034 stacks after them.)
- [ ] First real build after merge: check `block_inventory.input_tokens_cached` — non-zero values on Sonnet-tier rows after the warm-up entry are the success signal this whole phase exists to produce (they were structurally always 0 before).

## Risks / residuals (carried to the campaign overview)

1. **Token-floor margin**: `COMPONENT_SYSTEM_CORE` ≥10,000 chars ≈ ~2,500 tokens against a 2048 minimum — adequate but not huge; if the tokenizer ratio for this text runs worse than ~4.9 chars/token it could silently fall under. The unit test pins chars, not tokens. The completion-checklist DB check (`input_tokens_cached > 0`) is the authoritative verification; if it reads 0, extend the Data-shape guide section.
2. **`GenerateOptions.maxTokens` is an additive extension** to the locked Phase 1 contract (the raised-cap retry mandates a mechanism the contract doesn't specify). Phases 3+ (batch-client `BatchRequestItem.maxTokens` already exists in the contract) are unaffected.
3. **Shell prefix often won't qualify**: on small sites the stable half (rules+tokens+classes+menu ≈ 4–7KB) stays below 10k chars → shells stay uncached. Per contract: no padding. The shellDom sanitization (40–70% input cut) is the shell win that always applies.
4. **Screenshot tokens remain uncached** (audit component-generator #9 residual): the visual-tier image sits in the user message; caching it would burn a breakpoint per page and same-page calls would still race within a batch. Revisit with Phase 3 batching.
5. **Step-topology changes** in generate-components and compose-site: in-flight Inngest runs at deploy time lose step memoization — re-trigger via the documented recovery events.
6. **Prompt-content drift risk**: the restructure is fidelity-equivalent by design but unproven until a real build — run a Two Roads rebuild and the Phase E fidelity scores before relying on output quality parity.



