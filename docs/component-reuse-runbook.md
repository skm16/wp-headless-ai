# Component reuse runbook (JAB_COMPONENT_REUSE + edit-build shell reuse)

Operator guide for cross-build component carry-forward and the edit-build
shell-reuse default (Phase 4 of the 2026-06-10 AI-call-optimization campaign,
`docs/superpowers/plans/2026-06-10-ai-call-optimization/04-component-and-shell-reuse.md`).

## What ships in Phase 4

Two distinct mechanisms:

1. **`JAB_COMPONENT_REUSE=1`** (in the **Inngest worker process env** — the
   dev server reads `.env.local` at boot, same dual-process trap as
   `JAB_GENERATE_MOCK` / `JAB_BATCH_GENERATE`): in `generate-components`, when
   an LLM-tier entry's prompt-inputs hash matches the prior READY build's
   `block_inventory.prompt_inputs_hash` AND that row compiled clean, the
   worker copies the prior build's `.tsx` Storage object and writes a
   zero-token telemetry row (`reused_from_build_id` set, all four token
   counters 0, `compile_status: ok`) instead of calling the LLM. Copy failure
   falls back to the LLM. Works on the sync path AND the
   `JAB_BATCH_GENERATE` wave-1 submit path. Off by default — flag-off
   performs zero prior-build reads and the LLM path is byte-identical.
   Engine: `apps/web/lib/jab/component-carry-forward.ts`.
2. **Edit-build shell reuse — DEFAULT behavior, no flag:** `edit-site` clones
   the source build's `Header.tsx`/`Footer.tsx` into the result build's
   `project/` prefix (`shellCloneObjects`), and compose's `shouldReuseShell`
   now reuses them on `config.mode === "edit"` builds. A shell-scope edit
   still regenerates its own target shell (guidance wins), and a missing
   cloned artifact (source build predates Phase 4) regenerates fail-soft.
   `JAB_SKIP_SHELL_REGEN` semantics are unchanged and now apply to FULL
   builds only.

Hashes are computed and persisted for EVERY LLM-tier generation regardless of
the flag, so flag-off builds still seed the index that a later reuse-enabled
build can match against. Chat-edit regens (`regenerateComponentUnit`) never
reuse and persist NO hash — a guidance-modified component can never be
hash-matched by a future build.

## Do NOT toggle the flag while builds are in flight

Same warning class as `JAB_BATCH_GENERATE`
(`docs/batch-generation-runbook.md`): Inngest re-evaluates
`JAB_COMPONENT_REUSE` from `process.env` on **every replay/wakeup** of a run —
the flag is not snapshotted at dispatch time. Flipping it mid-flight makes the
`load-prior-components` step appear or disappear relative to the journaled
step IDs, so the function body diverges from the journal (step-ID divergence —
the same failure mode as toggling `JAB_BATCH_GENERATE` mid-run). Toggle only
when no `generate-components` runs are active, or accept re-dispatching the
affected builds after the flip.

## JAB_GENERATE_MOCK interaction — mock builds can never seed reuse

`hashEntryPromptInputs` in `generate-components.ts` returns `null` whenever
`JAB_GENERATE_MOCK=1`, so **mock-mode builds persist NULL
`prompt_inputs_hash` on every row, by design**. MockModelClient emits
identical placeholder TSX for every block regardless of inputs; without this
guard, a mock build reaching `ready` would seed the reuse index with hashes
pointing at MOCK artifacts, and a later real build with
`JAB_COMPONENT_REUSE=1` would hash-match them and copy the mock amber-badge
component into a production build. NULL hashes mean `buildPriorHashIndex`
skips every mock row, so a real build after a mock build simply regenerates
everything (full LLM pass — expected, not a bug).

## Residuals — edit builds and the four 0034 columns

The four migration-0034 `block_inventory` columns (`prompt_inputs_hash`,
`reused_from_build_id`, `input_tokens_cache_creation`, `failure_kind`) remain
**EXCLUDED** from the edit-build row clone (`BLOCK_INVENTORY_CLONE_COLUMNS`
in `edit-site.helpers.ts`; the schema-derived completeness test pins the
exclusion). Consequences:

- **Every `block_inventory` row on an edit build has a NULL
  `prompt_inputs_hash`** — cloned rows exclude it, and the targeted chat-edit
  regen deliberately persists without one. The regenerated unit re-persists
  fresh telemetry at generation time; non-regenerated cloned rows keep the
  source build's legacy token columns with the two new 0034 telemetry
  columns NULL.
- **This is acceptable, but not because edit builds are skipped:** the reuse
  loader (`loadPriorReadyComponentRows`) reads the LATEST ready build
  regardless of mode. When that build is an edit build, its all-NULL hashes
  make the reuse index empty, so the next build regenerates everything —
  safe degradation (never stale reuse), with hashes re-seeded by that next
  full build. Reuse hit-rates therefore drop to zero for the first full
  build after any edit build goes ready.

## What to expect

- Worker log on reuse: `[generate-components] N/M components reused from
  prior build (JAB_COMPONENT_REUSE)`; reused rows show
  `reused_from_build_id` + zero tokens in `block_inventory`.
- **Visual-tier reuse is rare on real sites:** the page screenshot is a hash
  input, so any pixel change invalidates visual-tier matches. The wins are
  standard/trivial tiers and unchanged pages.
- **Reused rows skip Phase B validation** — the copied TSX was validated when
  generated and is re-checked by compose's `tsc --noEmit` compile gate
  (`JAB_COMPOSE_TYPECHECK`, on by default).
- **Kill-switch:** bumping `COMPONENT_PROMPT_VERSION`
  (`lib/ai/component-generator.ts`, owned by Phase 2) invalidates every prior
  hash — use it when a platform-shim/emitter/prompt change must force full
  regeneration despite matching inputs.
- **`shell_generations` has no row for a reused shell:** dashboards joining
  shells per build must treat absence as "reused/zero-spend", not missing
  data (same as the pre-existing `JAB_SKIP_SHELL_REGEN` path).

## Quick smoke (operator steps; requires migrations 0032–0034 applied)

1. Seed hashes with a full build: `pnpm --filter @jab/web smoke:build`.
2. Re-run components scoped with the flag:
   `JAB_COMPONENT_REUSE=1 pnpm --filter @jab/web smoke:generate` → expect the
   `N/M components reused from prior build` log and `block_inventory` rows
   with `reused_from_build_id` set + zero tokens.
3. Dispatch a component-scope chat edit and confirm compose logs
   `edit build (no shell guidance for header): reusing existing Header.tsx`
   (and the footer equivalent) and `shell_generations` has no new rows for
   the result build.
