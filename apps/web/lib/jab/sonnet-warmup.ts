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
