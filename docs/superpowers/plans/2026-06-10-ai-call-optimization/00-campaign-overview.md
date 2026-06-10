# AI Call Optimization Campaign — Overview

> **For agentic workers:** This is the campaign index, not an executable plan. Execute the phase
> docs in this folder in the order below, each via superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Every phase produces working, testable software
> on its own and ends with the full suite + typecheck green.

**Source:** the 2026-06-10 AI API audit (52-agent review of every Anthropic call site in
`apps/web`; findings adversarially verified against the code). Headline: prompt caching was a
silent no-op everywhere (every prefix below the model minimums), the Batch API was unused for
the dominant queue-shaped spend, rebuilds re-paid for unchanged components, every chat edit
re-rolled both shells, and `stop_reason`/typed errors were never inspected anywhere.

**Goal:** the same builds at roughly 25–40% of current token cost, with truncation, rate-limit
degradation, and model drift made observable instead of silent.

---

## Phases

| # | Doc | Tasks | Depends on | Flags / migrations |
|---|-----|-------|------------|--------------------|
| 1 | [01-ai-infra-foundation.md](01-ai-infra-foundation.md) | 7 | none | **migration 0034** |
| 2 | [02-prompt-caching-restructure.md](02-prompt-caching-restructure.md) | 9 | 1 | — (uses 0034 columns) |
| 3 | [03-batch-api.md](03-batch-api.md) | 11 | 1, 2 | `JAB_BATCH_GENERATE=1` (off default) |
| 4 | [04-component-and-shell-reuse.md](04-component-and-shell-reuse.md) | 7 | 1, 2, 3 | `JAB_COMPONENT_REUSE=1` (off default) |
| 5 | [05-planner-chat-hardening.md](05-planner-chat-hardening.md) | 10 | 1 only | — (no migration; chat stays behind `JAB_CHAT_EDIT`) |
| 6 | [06-scrape-structured-outputs.md](06-scrape-structured-outputs.md) | 8 | 1 only | — (uses 0034 `projects.design_scrape_usage`) |
| 7 | [07-vision-prewire-and-smoke-hygiene.md](07-vision-prewire-and-smoke-hygiene.md) | 9 | 1, 2 | — |

**Total: 61 tasks.**

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (serial is simplest and safe). Phases 5 and 6
depend only on Phase 1 and may be interleaved any time after it; Phases 3 and 4 must stay in
this relative order (both rewrite `generate-components.ts`, and Phase 4's hash persistence must
also run inside Phase 3's `finalizeComponentWave`). Phase 7 goes last — it edits files Phases
1–2 rewrite and de-forks the debug script against the Phase 2 builders.

---

## Deploy gates (read before any live run)

1. **Migrations 0032 → 0033 → 0034 must be applied IN ORDER to BOTH Supabase projects** —
   local "JAB WP" (`ajfurojjxthhzkjqttri`) and prod "jab-prod" (`celzwcxkrmsbwiswkxug`).
   0032 and 0033 were committed but **not yet applied to either project** at campaign-planning
   time. Phase 1's persist code writes the 0034 columns unconditionally; deploying workers
   without 0034 fails every `persistGeneration` call (and with `retries: 0`, fails builds).
   Phase 7's smoke zero-spend assertion and Phase 6's telemetry persist also read/write 0034
   columns.
2. **Vercel env sweep before Phase 1 deploys:** the `ALLOWED` model list drops
   `claude-opus-4-7` (replaced by `claude-opus-4-8`). Any `JAB_AI_MODEL*` env var still
   pinning `claude-opus-4-7` throws at first resolution. (Repo-root
   `scripts/validate-ai/src/main.ts` also pins `claude-opus-4-7` — out of campaign scope,
   bump when next touched.)
3. **Inngest step-topology changes** (Phase 2: warm-up step + split generate/persist shell
   steps; Phase 3: batch branch) break step memoization for in-flight runs at deploy time —
   drain active builds or re-trigger via the documented recovery events afterward.
4. **Telemetry semantic changes:** `model_used` is now NULL when zero API calls succeeded
   (previously a fabricated hardcoded constant); size-mismatched fidelity pages persist
   measured scores instead of synthetic 0.5 after Phase 7. Dashboards/queries comparing
   across the boundary must tolerate both.

## Cross-phase ownership notes (resolved during self-review)

- **`failureKind` type evolution:** Phase 1 introduces the persist plumbing with
  `AiFailureKind | "max_tokens" | null` via a separate persist arg; Phase 2 introduces
  `GenerationFailureKind` (adds `invalid_tsx` / `postprocess` / `over_cap`), moves the value
  onto `GeneratedComponent`/`GeneratedShell`, and deletes the separate arg. The Phase 2 doc's
  persist steps are written as that re-point (not a fresh add).
- **`server-only` module headers:** Phase 7 owns the final state — it removes `server-only`
  from `model.ts`, `client.ts`, `shell-prompts.ts`, `generated-tsx-postprocess.ts`, and
  `lib/jab/global-styles.ts` so the debug script can import production builders under tsx.
  Phases 1–2 must not add new `server-only` imports to those modules.
- **`sanitizeShellDom` integration point:** Phase 2 sanitizes at the prompt-build site
  (capture stays raw). Phase 7 Task 9's pre-flight branch takes the
  "keep-with-same-maxBytes" path.
- **Additive `model-client.ts` exports:** Phase 2 adds `GenerateOptions.maxTokens?` +
  `MAX_TOKENS_BY_TIER`; Phase 3 adds `modelConfigForTier`. Both layer on Phase 1's v2
  contract without changing it.
- **Batch × carry-forward interaction (Phase 4 on top of Phase 3):** reused entries must be
  excluded from warm-up-stagger candidates and from `BatchRequestItem` lists;
  `prompt_inputs_hash` persistence runs in BOTH the sync path and `finalizeComponentWave`.

## Post-campaign live verification

1. First real (non-mock) build after Phase 2: `block_inventory.input_tokens_cached` &gt; 0 on
   Sonnet-tier rows (the audit's headline metric — was structurally always 0).
2. After Phase 3 with `JAB_BATCH_GENERATE=1`: one live smoke build; persisted row shape
   identical to sync (pinned by tests); wall-clock delta acceptable.
3. After Phase 4 with `JAB_COMPONENT_REUSE=1`: rebuild an unchanged site; expect majority
   `reused_from_build_id` rows with zero tokens.
4. After Phase 6: watch `projects.design_scrape_usage.fallbackUsed` ratio — decides whether
   the Haiku default is netting savings.
5. After Phase 5 (requires `JAB_CHAT_EDIT=1` deployment): multi-turn chat shows
   `input_tokens_cached` &gt; 0 from turn 2 once history crosses the 2048-token minimum.

## Deliberately out of scope (tracked residuals)

- Visual-tier screenshot caching in the user message (revisit with Phase 3 batching data).
- Haiku pilot for the planner — enabled by Phase 5's `getModelFor("planner")` seam; flip via
  `JAB_AI_MODEL_PLANNER` and measure clarify-rate; no code change needed.
- The real vision LLM call (project Phase 7.1) — this campaign only defuses its cost
  landmines and shapes the call path (batch-friendly, fail-soft, worst-pages-first).
- `reused_from_build_id` FK has no ON DELETE action — add `ON DELETE SET NULL` before any
  site_builds pruning job ships.
- Streaming seam on `ModelClient` — required before any `max_tokens` &gt; 16K.
