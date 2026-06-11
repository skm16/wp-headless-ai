# Batch generation runbook (JAB_BATCH_GENERATE)

Operator guide for the Message-Batches build path (Phase 3 of the
2026-06-10 AI-call-optimization campaign,
`docs/superpowers/plans/2026-06-10-ai-call-optimization/03-batch-api.md`).

## What the flag does

`JAB_BATCH_GENERATE=1` (in the **Inngest worker process env** — the dev
server reads `.env.local` at boot, same dual-process trap as
`JAB_GENERATE_MOCK`) routes:

- **generate-components (Phase B):** all LLM-tier block entries into one
  Message Batch (custom_id = sanitized block_name) → 30s poll loop (60-poll
  cap ≈ 30 min) → local validateTsx → a wave-2 corrective batch (`*_r2`
  custom_ids) for validation/truncation failures → synchronous
  `generateComponent` fallback for anything the batch never finished.
  Passthrough rows never batch (zero-LLM path, unchanged).
- **compose-site (Phase C):** header+footer into one batch on FULL builds
  only. Edit builds and chat-edit regens ALWAYS stay synchronous.

Telemetry is persisted identically to the sync path (same
`block_inventory` / `shell_generations` columns; batch waves accumulate into
the same token counters, `compile_attempt_count` counts waves + sync
fallback attempts). Requires migration 0034 applied to BOTH Supabase
projects first (see the two-supabase-projects memory note).

## Do NOT toggle the flag while builds are in flight

Inngest re-evaluates `JAB_BATCH_GENERATE` from `process.env` on **every
replay/wakeup** of a run — the flag is not snapshotted at dispatch time.
Flipping it while a `generate-components` or `compose-site` run is mid-flight
makes the function body diverge from the journaled step IDs, which can
**double-generate components** (a batch wave already persisted its rows +
the sync path re-running the same entries) and corrupt the run's step
journal. Toggle only when no generate-components / compose-site runs are
active, or accept re-dispatching the affected builds after the flip.

## The tradeoff

| | Sync (default) | Batch (`JAB_BATCH_GENERATE=1`) |
| --- | --- | --- |
| Token price | 100% | **50%** (all tokens, incl. output + cache) |
| Phase B wall time | ~1–3 min | typically +5–20 min; worst case +~60 min (two waves) then sync recovery |
| Use for | demos, edit loops, anything human-watched | overnight/bulk full builds, scoped rebuilds, cost-sensitive pilots |

## Watching a batch

1. **Inngest dev UI** (http://localhost:8288): the run shows
   `batch-submit-wave-1` (output carries the `batchId`), then alternating
   `batch-wave1-poll-N` / sleep steps. The batch id is also logged:
   `[generate-components] batch wave-1 submitted: N items, batch msgbatch_...`.
2. **Anthropic Console** → Usage → Batches: shows request_counts
   (processing/succeeded/errored/canceled/expired).
3. **API:**

   ```bash
   curl https://api.anthropic.com/v1/messages/batches/msgbatch_XXX \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01"
   ```

   Watch `processing_status` (`in_progress` → `ended`) and `request_counts`.

## Cancelling a batch

```bash
curl -X POST https://api.anthropic.com/v1/messages/batches/msgbatch_XXX/cancel \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```

- Cancelling moves the batch `canceling` → `ended`; already-finished rows
  remain collectable, cancelled rows return `result.type: "canceled"`.
- The worker treats canceled/expired rows as sync-fallback stragglers — it
  will regenerate them synchronously and the build still completes. You do
  NOT need to touch the build row.
- The worker also cancels automatically when a wave exceeds the 60-poll cap.
- To stop the BUILD (not just the batch), use the normal build-discard path;
  the worker's terminal-state guards stop before dispatching compose.

## Caching interaction

Batch requests carry the same cache_control blocks as sync requests and the
50% discount stacks with cache reads. BUT: identical cached prefixes
submitted in one batch may all be processed concurrently and miss the cache
(readable only after a first response). Do not expect `input_tokens_cached`
to be high inside a single batch — the 50% batch discount, not the cache,
is the dominant saving on this path.

## Quick smoke

`JAB_BATCH_GENERATE=1` in `.env.local`, restart `pnpm dev` + Inngest, then
`pnpm --filter @jab/web smoke:generate` against a discovered build. Expect
the wave steps in the Inngest UI and non-zero token columns on
block_inventory afterward. With `JAB_GENERATE_MOCK=1` also set, mock wins:
no batch steps appear and cost stays $0.
