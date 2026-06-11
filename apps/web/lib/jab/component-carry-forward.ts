import { createHash } from "node:crypto";

/**
 * component-carry-forward.ts — pure cross-build component reuse engine
 * (AI-call-optimization Phase 4; audit: component-generator issue 7).
 *
 * Deterministic and DB-free, mirroring lib/jab/carry-forward.ts. A component
 * generation is a pure function of its prompt inputs + model + prompt
 * version; when a prior READY build's row carries an identical
 * prompt_inputs_hash, the .tsx artifact can be copied instead of re-paying
 * the LLM. Gated behind JAB_COMPONENT_REUSE=1 (off by default) — the
 * flag-off path performs zero prior-build reads and selectReusablePrior
 * returns null unconditionally, so the LLM path is unchanged.
 *
 * Inputs are JSONB-derived plain values (no cycles, no functions, no Dates) —
 * stableStringify assumes that and documents it rather than defending it.
 */

/** LLM tiers eligible for reuse. Passthrough rows never call the LLM. */
const REUSABLE_TIERS = new Set(["visual", "standard", "trivial"]);

/**
 * JSON.stringify with recursively sorted object keys. Arrays keep their
 * order (order is meaningful for attr samples). undefined object values are
 * dropped, matching JSON.stringify semantics, so `{a: undefined}` and `{}`
 * hash identically.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // JSON.stringify(undefined) === undefined; normalize to "null" so a
    // top-level undefined cannot produce a non-string.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** sha256 hex digest of a UTF-8 string. Also used for screenshot base64 bodies. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical prompt-inputs hash (campaign contract). sha256 hex of the
 * stable-stringified args object. Every value that can change the rendered
 * prompt (or the model interpreting it) MUST flow through here.
 */
export function computePromptInputsHash(args: {
  blockName: string;
  tier: string;
  model: string;
  promptVersion: number;
  attrSamples: unknown;
  domSample: string | null;
  computedStyles: unknown;
  tokens: unknown;
  sourceHost: string | null;
  screenshotSha256: string | null;
}): string {
  return sha256Hex(stableStringify(args));
}

/**
 * Worker-facing wrapper. Returns null for rows that never call the LLM
 * (passthrough tier / null blockName) — those have nothing to reuse and
 * their block_inventory.prompt_inputs_hash stays NULL.
 *
 * spec (acf_flex sub_fields / cpt_template union), the detected dynamicList,
 * and the occurrence context (occurrenceCount + top-5 pageSlugs, which
 * visualPrompt/standardPrompt interpolate into the user prompt) are
 * prompt-relevant but are not separate args on the campaign-contract
 * signature, so they are folded into the `attrSamples` slot as a composite —
 * the signature is unchanged and the hash covers them.
 */
export interface ComponentEntryHashInput {
  blockName: string | null;
  tier: string;
  model: string;
  promptVersion: number;
  attrSamples: unknown;
  occurrenceCount: number;
  pageSlugs: string[];
  spec: unknown;
  dynamicList: unknown;
  domSample: string | null;
  computedStyles: unknown;
  tokens: unknown;
  sourceHost: string | null;
  screenshotSha256: string | null;
}

export function componentEntryHash(input: ComponentEntryHashInput): string | null {
  if (input.blockName === null || !REUSABLE_TIERS.has(input.tier)) return null;
  return computePromptInputsHash({
    blockName: input.blockName,
    tier: input.tier,
    model: input.model,
    promptVersion: input.promptVersion,
    attrSamples: {
      // trivialPrompt renders only attrSamples[0]; hashing the full list
      // would invalidate trivial reuse on lower-ranked sample drift the
      // prompt never sees. Visual/standard prompts render up to 3 samples,
      // so they keep the full list (extra samples = over-invalidation only).
      samples:
        input.tier === "trivial" && Array.isArray(input.attrSamples) && input.attrSamples.length > 0
          ? [input.attrSamples[0]]
          : input.attrSamples,
      spec: input.spec ?? null,
      dynamicList: input.dynamicList ?? null,
      // visualPrompt/standardPrompt interpolate "appears N times across M
      // pages (slug1, ..., slug5)" — hash only what the prompt renders: the
      // count and the first 5 slugs.
      occurrenceCount: input.occurrenceCount,
      pageSlugsTop5: input.pageSlugs.slice(0, 5),
    },
    domSample: input.domSample,
    // Deliberately over-inclusive: renderComputedStylesSection renders only
    // ~8 priority props from the 1280 (or 768) viewport, but the full
    // computedStyles object is hashed. Worst case is over-invalidation (one
    // wasted LLM call when a non-rendered style drifts) — never staleness.
    computedStyles: input.computedStyles,
    tokens: input.tokens,
    sourceHost: input.sourceHost,
    screenshotSha256: input.screenshotSha256,
  });
}

/** Slice of a prior build's block_inventory row needed for reuse. JSON-safe. */
export interface PriorComponentRow {
  block_name: string;
  prompt_inputs_hash: string | null;
  compile_status: string | null;
  model_used: string | null;
  provider_used: string | null;
}

/**
 * hash → row index over the prior READY build's rows. Only compile-clean
 * rows with a persisted hash are reusable: 'failed' rows hold passthrough
 * fallback TSX and 'skipped' rows never had an LLM artifact worth copying.
 * Hash collisions within a build are impossible in practice (the hash
 * includes block_name, unique per build).
 */
export function buildPriorHashIndex(rows: PriorComponentRow[]): Map<string, PriorComponentRow> {
  const index = new Map<string, PriorComponentRow>();
  for (const r of rows) {
    if (r.prompt_inputs_hash && r.compile_status === "ok") {
      index.set(r.prompt_inputs_hash, r);
    }
  }
  return index;
}

/**
 * Pure reuse decision. flagEnabled=false → null unconditionally: the
 * flag-off path is byte-identical to today's behavior (asserted by test).
 */
export function selectReusablePrior(args: {
  flagEnabled: boolean;
  hash: string | null;
  index: Map<string, PriorComponentRow>;
}): PriorComponentRow | null {
  if (!args.flagEnabled || !args.hash) return null;
  return args.index.get(args.hash) ?? null;
}
