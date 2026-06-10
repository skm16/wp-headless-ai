import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { GenerateUsage } from "@/lib/ai/model-client";
import { modelConfigForTier } from "@/lib/ai/model-client";
import {
  addUsage,
  buildComponentRequestParts,
  buildRetryUserSuffix,
  failedBatchComponent,
  finalizeBatchGeneration,
  type GeneratedComponent,
  type GenerateComponentOptions,
} from "@/lib/ai/component-generator";
import {
  sanitizeBatchCustomId,
  type BatchRequestItem,
  type BatchResultItem,
} from "@/lib/ai/batch-client";
import {
  persistGeneration,
  type PersistGenerationInput,
} from "@/lib/ai/persist-generation";

/**
 * component-batch.ts — pure planning engine for the JAB_BATCH_GENERATE=1
 * Phase B batch path. The generate-components worker is a thin orchestrator
 * over these functions; everything decision-shaped lives here so it is
 * unit-testable without Inngest.
 */

/** 60 polls × 30s ≈ 30 minutes per wave before the sync fallback takes over. */
export const MAX_BATCH_POLLS = 60;
export const BATCH_POLL_INTERVAL = "30s";
/** Phase 2 parity: max_tokens retries raise the cap 1.5x, hard-capped at 16000. */
export const MAX_TOKENS_RETRY_CAP = 16_000;

export const ZERO_USAGE: GenerateUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Batch mode gate. Exactly "1" enables; JAB_GENERATE_MOCK=1 wins (a mock
 * smoke run must never touch the batches API — MockModelClient only exists
 * on the sync path). Anything else → the sync path, byte-identical.
 *
 * Parameter is env-shaped rather than NodeJS.ProcessEnv: Next.js augments
 * ProcessEnv with a REQUIRED `NODE_ENV`, which would reject plain test
 * literals. `process.env` remains assignable to this type.
 */
export function isBatchGenerateEnabled(env: Record<string, string | undefined>): boolean {
  return env.JAB_BATCH_GENERATE === "1" && env.JAB_GENERATE_MOCK !== "1";
}

export function partitionInventoryForBatch(queue: EnrichedInventoryEntry[]): {
  llmEntries: EnrichedInventoryEntry[];
  passthroughEntries: EnrichedInventoryEntry[];
} {
  const llmEntries: EnrichedInventoryEntry[] = [];
  const passthroughEntries: EnrichedInventoryEntry[] = [];
  for (const entry of queue) {
    if (entry.tier === "passthrough" || entry.blockName === null) {
      passthroughEntries.push(entry);
    } else {
      llmEntries.push(entry);
    }
  }
  return { llmEntries, passthroughEntries };
}

/**
 * The taken set used to dedupe these items' custom_ids is local to
 * buildComponentBatchItems and not exposed. Wave-2 submissions must pass a
 * FRESH Set to buildWave2Item — custom_id uniqueness is scoped per Batches
 * API submission, not globally across waves.
 */
export interface ComponentBatchPlan {
  items: BatchRequestItem[];
  blockNameByCustomId: Record<string, string>;
}

/** Wave-1 items: one per LLM-tier entry, custom_id = sanitized block_name. */
export function buildComponentBatchItems(
  entryOptions: Array<{ entry: EnrichedInventoryEntry; options: GenerateComponentOptions }>,
): ComponentBatchPlan {
  const taken = new Set<string>();
  const items: BatchRequestItem[] = [];
  const blockNameByCustomId: Record<string, string> = {};
  for (const { entry, options } of entryOptions) {
    if (entry.tier === "passthrough" || entry.blockName === null) {
      throw new Error(
        `[component-batch] passthrough entry ${entry.blockName ?? "__null__"} must not reach the batch path`,
      );
    }
    const parts = buildComponentRequestParts(options);
    const cfg = modelConfigForTier(entry.tier);
    const customId = sanitizeBatchCustomId(entry.blockName, taken);
    blockNameByCustomId[customId] = entry.blockName;
    items.push({
      customId,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      cachedSystemPrefix: parts.cachedSystemPrefix,
      system: parts.systemPrompt,
      user: parts.userPrompt,
      // Mirror the sync path: only the visual tier carries a screenshot.
      screenshotBase64: entry.tier === "visual" ? options.screenshotBase64 ?? undefined : undefined,
    });
  }
  return { items, blockNameByCustomId };
}

/** Wave-1 → wave-2 carry descriptor (small: safe as an Inngest step output). */
export interface Wave2Descriptor {
  blockName: string;
  reason: "validation" | "max_tokens";
  errors: string[]; // first 3 diagnostics
  outputTail: string; // last ≤500 chars of the failed output
  usage: GenerateUsage; // wave-1 spend, merged into the final row
  attempts: number; // attempts consumed so far (1 after wave-1)
}

/** Entries that exhausted the batch path and recover via sync generateComponent. */
export interface SyncFallbackDescriptor {
  blockName: string;
  usage: GenerateUsage;
  attempts: number;
}

/** Wave-2 corrective item: same prompt + Phase 2 corrective suffix; raised cap on truncation. */
export function buildWave2Item(args: {
  descriptor: Wave2Descriptor;
  options: GenerateComponentOptions;
  taken: Set<string>;
}): BatchRequestItem {
  const entry = args.options.entry;
  if (entry.tier === "passthrough" || entry.blockName === null) {
    throw new Error("[component-batch] buildWave2Item called with a passthrough entry");
  }
  const parts = buildComponentRequestParts(args.options);
  const cfg = modelConfigForTier(entry.tier);
  const maxTokens =
    args.descriptor.reason === "max_tokens"
      ? Math.min(Math.ceil(cfg.maxTokens * 1.5), MAX_TOKENS_RETRY_CAP)
      : cfg.maxTokens;
  return {
    customId: sanitizeBatchCustomId(`${entry.blockName}_r2`, args.taken),
    model: cfg.model,
    maxTokens,
    cachedSystemPrefix: parts.cachedSystemPrefix,
    system: parts.systemPrompt,
    user: parts.userPrompt + buildRetryUserSuffix(args.descriptor.errors, args.descriptor.outputTail),
    screenshotBase64: entry.tier === "visual" ? args.options.screenshotBase64 ?? undefined : undefined,
  };
}

/**
 * Poll-loop decision: collect | wait | timeout. "errored" from getBatchStatus
 * (which also maps transient retrieve failures to "errored") is treated as
 * wait, because retrieve is idempotent and batch processing continues
 * server-side regardless of a failed status read. A genuinely stuck batch is
 * eventually caught by the polls >= cap → "timeout" path
 * (MAX_BATCH_POLLS × BATCH_POLL_INTERVAL ≈ 30 minutes).
 */
export function pollVerdict(
  status: "in_progress" | "ended" | "canceling" | "errored",
  polls: number,
  cap: number = MAX_BATCH_POLLS,
): "collect" | "wait" | "timeout" {
  if (status === "ended") return "collect";
  if (polls >= cap) return "timeout";
  return "wait";
}

export interface WaveFinalizeArgs {
  buildId: string;
  projectId: string;
  /** Collected batch results ([] when the batch timed out uncollectable). */
  results: BatchResultItem[];
  blockNameByCustomId: Record<string, string>;
  /** The LLM-tier entries this wave covered. */
  entries: EnrichedInventoryEntry[];
  attempt: 1 | 2;
  sourceHosts: string[];
  priorUsageByBlockName: Record<string, GenerateUsage>;
  priorAttemptsByBlockName?: Record<string, number>;
  /** Injectable for tests; defaults to the real persistGeneration. */
  persist?: (input: PersistGenerationInput) => Promise<{ storagePath: string | null }>;
}

export interface WaveFinalizeOutcome {
  okCount: number;
  retry: Wave2Descriptor[];
  syncFallback: SyncFallbackDescriptor[];
}

/**
 * Route every entry of a finished (or timed-out) wave:
 *   ok + valid            → persist ok
 *   ok + invalid (wave 1) → wave-2 corrective descriptor
 *   ok + invalid (wave 2) → persist failed passthrough (2 attempts total)
 *   bad_request | auth    → persist failed passthrough + failureKind (fail fast)
 *   anything else         → sync-fallback descriptor (batch produced nothing)
 * Persists terminal rows immediately so the Inngest step output stays small
 * (descriptors only — never TSX).
 *
 * Persists are per-entry fail-soft: a persist failure never throws out of the
 * wave (the worker runs retries:0, so a mid-wave throw would lose the rest of
 * the wave's routing). Instead the failed entry is downgraded to a
 * SyncFallbackDescriptor carrying the usage/attempts the persisted component
 * would have carried — the sync path regenerates it (costs one regen, never
 * loses the wave). Callers should still invoke this inside a single step.run.
 */
export async function finalizeComponentWave(args: WaveFinalizeArgs): Promise<WaveFinalizeOutcome> {
  const persist = args.persist ?? persistGeneration;
  const resultByBlockName = new Map<string, BatchResultItem>();
  for (const result of args.results) {
    const blockName = args.blockNameByCustomId[result.customId];
    if (blockName) resultByBlockName.set(blockName, result);
  }

  let okCount = 0;
  const retry: Wave2Descriptor[] = [];
  const syncFallback: SyncFallbackDescriptor[] = [];

  /**
   * Fail-soft persist: on failure, warn and push the entry to syncFallback
   * with the usage/attempts the persisted row would have carried, so the
   * sync path regenerates it. Returns whether the persist succeeded.
   */
  const persistEntry = async (blockName: string, component: GeneratedComponent): Promise<boolean> => {
    try {
      await persist({ buildId: args.buildId, projectId: args.projectId, component });
      return true;
    } catch (err) {
      console.warn(
        `[component-batch] persist failed for ${blockName} — downgrading to sync fallback`,
        err,
      );
      syncFallback.push({
        blockName,
        usage: {
          inputTokens: component.inputTokens,
          outputTokens: component.outputTokens,
          cacheReadTokens: component.cacheReadTokens,
          cacheCreationTokens: component.cacheCreationTokens,
        },
        attempts: component.compileAttemptCount,
      });
      return false;
    }
  };

  for (const entry of args.entries) {
    const blockName = entry.blockName;
    if (blockName === null) continue; // partition guarantees this never happens
    const prior = args.priorUsageByBlockName[blockName] ?? ZERO_USAGE;
    const priorAttempts = args.priorAttemptsByBlockName?.[blockName] ?? args.attempt - 1;
    const result = resultByBlockName.get(blockName);

    if (!result) {
      // Unfinished / lost row — the batch never billed us for it.
      syncFallback.push({ blockName, usage: prior, attempts: priorAttempts });
      continue;
    }

    if (!result.ok) {
      if (result.errorKind === "bad_request" || result.errorKind === "auth") {
        // Phase 2 rule: non-retryable → no second attempt, fail to passthrough.
        // mapBatchRow yields zero usage on errored rows today, but merge
        // result.usage anyway so billing stays correct if that ever changes.
        const component = failedBatchComponent({
          entry,
          usage: addUsage(prior, result.usage),
          attemptCount: priorAttempts + 1,
          failureKind: result.errorKind,
          model: null,
        });
        await persistEntry(blockName, component);
        continue;
      }
      // rate_limit / overloaded / server_error / connection / unknown
      // (incl. expired + canceled) → recover on the sync path.
      syncFallback.push({
        blockName,
        usage: addUsage(prior, result.usage),
        attempts: priorAttempts + 1,
      });
      continue;
    }

    const outcome = finalizeBatchGeneration({
      entry,
      text: result.text,
      usage: result.usage,
      stopReason: result.stopReason,
      model: result.model,
      attemptCount: priorAttempts + 1,
      priorUsage: prior,
      sourceHosts: args.sourceHosts,
    });

    if (outcome.kind === "ok") {
      if (await persistEntry(blockName, outcome.component)) okCount++;
      continue;
    }

    if (args.attempt === 1) {
      retry.push({
        blockName,
        reason: outcome.reason,
        errors: outcome.errors,
        outputTail: outcome.outputTail,
        usage: addUsage(prior, result.usage),
        attempts: priorAttempts + 1,
      });
    } else {
      const component = failedBatchComponent({
        entry,
        usage: addUsage(prior, result.usage),
        attemptCount: priorAttempts + 1,
        failureKind: outcome.reason === "max_tokens" ? "max_tokens" : null,
        model: result.model,
      });
      await persistEntry(blockName, component);
    }
  }

  return { okCount, retry, syncFallback };
}
