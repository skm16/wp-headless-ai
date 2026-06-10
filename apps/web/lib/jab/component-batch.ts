import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { GenerateUsage } from "@/lib/ai/model-client";
import { modelConfigForTier } from "@/lib/ai/model-client";
import {
  buildComponentRequestParts,
  buildRetryUserSuffix,
  type GenerateComponentOptions,
} from "@/lib/ai/component-generator";
import { sanitizeBatchCustomId, type BatchRequestItem } from "@/lib/ai/batch-client";

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
