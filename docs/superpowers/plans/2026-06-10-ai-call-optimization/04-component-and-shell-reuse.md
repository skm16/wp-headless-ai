# Component Carry-Forward and Edit-Build Shell Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-paying LLM generation for unchanged work — reuse prior-build component TSX when its prompt inputs hash-match (behind `JAB_COMPONENT_REUSE=1`), and make edit builds reuse their cloned Header/Footer shells by default instead of re-rolling both on every chat edit.

**Architecture:** A new pure module `apps/web/lib/jab/component-carry-forward.ts` computes a deterministic sha256 over every input that feeds a component prompt; the `generate-components` worker persists that hash on every LLM-tier generation and, when the reuse flag is on, copies the prior ready build's `.tsx` Storage object plus a zero-token telemetry row instead of calling the LLM. On the shell side, `edit-site`'s Storage clone is extended to cover the `project/components/site/` prefix (today it provably does NOT clone `Header.tsx`/`Footer.tsx` — verified below), and `shouldReuseShell` gains an `isEditBuild` input so compose reuses cloned shells by default on `config.mode === "edit"` builds, with the existing `hasEditGuidance` carve-out still forcing regeneration of the edit's own target shell.

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 4 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: **Phase 1** (migration `0034_ai_cost_telemetry.sql` adds `block_inventory.prompt_inputs_hash`, `block_inventory.reused_from_build_id`, `block_inventory.input_tokens_cache_creation`, `block_inventory.failure_kind`; `model-client.ts` exports `COMPONENT_TASK_BY_TIER` and resolves models via `getModelFor`; `GenerateResult.model` ground truth; persist-generation telemetry math fix) and **Phase 2** (`component-generator.ts` exports `COMPONENT_PROMPT_VERSION = 2`).

---

## Audit findings this phase resolves

- **component-generator issue 7 (medium/cost)** — "No cross-build component reuse — every rebuild re-pays full LLM generation for unchanged block types." Phase B has no component cache; generations are pure functions of (block name, tier, attr samples, DOM sample, computed styles, tokens, sourceHost, screenshot) + model + prompt version. Digest recommendation: opt-in carry-forward keyed on a deterministic hash of prompt inputs, mirroring the `JAB_INCREMENTAL_SKIP` pattern and its flag-off byte-identical guarantee. CORRECTED note scope: only LLM-tier (visual/standard/trivial) rows matter — passthrough rows already early-return at zero cost.
- **edit-planner issue 1 (high/cost)** — "Every component-scope chat edit pays two redundant shell LLM calls (header + footer)." Compose unconditionally re-runs BOTH shell generations on Sonnet (visual tier, 8192 max_tokens, shellDom up to 100KB each) for every edit build. The skip path (`shouldReuseShell`) exists but is gated behind `JAB_SKIP_SHELL_REGEN`, off by default. **CORRECTED premise (verified during drafting):** the audit's assumption that "the source build's artifacts were just cloned" so the skip path would work is wrong — `edit-site.ts`'s `clone-storage-artifacts` step (lines 178–206) copies only the `builds/<id>/components` and `builds/<id>/source` prefixes (line 181: `for (const prefix of ["components", "source"])`), while shells are persisted at `builds/<id>/project/components/site/{Header,Footer}.tsx` (`buildShellStoragePath`, persist-shell-generation.ts:18–24). `Header.tsx`/`Footer.tsx` are therefore **never cloned**, and `shellArtifactExists(resultBuildId, kind)` is always false on a fresh edit build. Task 5 fixes the clone first; Task 6 then flips the default.

## Verified current state (line refs from branch `feat/saas-e2e-loop`, 2026-06-10 — re-verify before each task; Phases 1–3 of this campaign will have shifted some line numbers, so anchor on the quoted code, step names, and function names)

| Fact | Where |
|---|---|
| `clone-storage-artifacts` walks only `components/` + `source/` prefixes | `apps/web/lib/inngest/functions/edit-site.ts:178-206` |
| Shells persist to `builds/<id>/project/components/site/<Kind>.tsx` | `apps/web/lib/ai/persist-shell-generation.ts:18-24` (`buildShellStoragePath`) |
| `shouldReuseShell({skipEnabled, hasEditGuidance, artifactExists})` | `apps/web/lib/ai/persist-shell-generation.ts:41-47` |
| `shellArtifactExists` fail-soft download probe | `apps/web/lib/ai/persist-shell-generation.ts:54-67` |
| Compose shell steps + `JAB_SKIP_SHELL_REGEN` gate | `apps/web/lib/inngest/functions/compose-site.ts:660-715` (guidance helper :660-663, env flag :669-670, `Promise.all` of `generate-header`/`generate-footer` :672-715; results are not consumed) |
| `buildConfig` loaded via `load-build-config` step | `apps/web/lib/inngest/functions/compose-site.ts:252-261`; `isEditConfig` imported at :57 |
| Phase B batch fan-out, generate + persist per entry | `apps/web/lib/inngest/functions/generate-components.ts:270-343` (per-entry closure :309-338, `generateComponent` + `persistGeneration` at :335-336) |
| `sourceHosts` computed once, fail-soft | `apps/web/lib/inngest/functions/generate-components.ts:176-183` |
| Prompt uses only the FIRST host variant: `const sourceHost = opts.sourceHosts?.[0] ?? null;` | `apps/web/lib/ai/component-generator.ts:709` |
| `GeneratedComponent` shape | `apps/web/lib/ai/component-generator.ts:35-46` (Phase 2 may add `failureKind` — verify) |
| Passthrough early-return (zero LLM) | `apps/web/lib/ai/component-generator.ts:687-700` |
| `persistGeneration` Storage upsert + `block_inventory` UPDATE payload | `apps/web/lib/ai/persist-generation.ts:30-90` (payload :70-83 pre-Phase-1; Phase 1 changes `input_tokens_uncached` to `component.inputTokens` as-is and adds `input_tokens_cache_creation`) |
| `regenerateComponentUnit` persists via injected `deps.persist` with no hash | `apps/web/lib/jab/regenerate-unit.ts:130-142` |
| `loadPriorReadyBuild` "latest ready build" query shape | `apps/web/lib/jab/load-prior-build.ts:64-101` |
| `JAB_INCREMENTAL_SKIP` flag-gate convention (`=== "1"`) | `apps/web/lib/inngest/functions/discover-site.ts:340` |
| `BLOCK_INVENTORY_CLONE_COLUMNS` + schema-derived completeness test | `apps/web/lib/inngest/functions/edit-site.helpers.ts:34-35`, `apps/web/lib/inngest/functions/edit-site.helpers.test.ts:87-105` |
| `blockInventory` drizzle table | `apps/web/lib/db/schema.ts:243-288` |
| Migrations currently end at `0033_page_inventory_link.sql` | `apps/web/drizzle/migrations/` (Phase 1 adds 0034) |
| Test runner | `apps/web/package.json:11` → `"test": "vitest run"`; run as `pnpm --filter @jab/web test` from repo root; typecheck via `pnpm --filter @jab/web typecheck` |
| `server-only` is stubbed in vitest | `apps/web/vitest.setup.ts` (`vi.mock("server-only", ...)`) |

**Out of scope / explicitly unchanged:** the chat-edit regen path (`regenerateComponentUnit`) never reuses — guidance changes the desired output, and its `persist` call passing no hash deliberately NULLs `prompt_inputs_hash` on the regenerated row so future builds can never hash-match a guidance-modified component. `JAB_SKIP_SHELL_REGEN` semantics for full builds are unchanged. The Batch API path (Phase 3) and smoke-script cost assertions (Phase 7) are separate phases.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/web/lib/jab/component-carry-forward.ts` | **Create** | Pure, DB-free engine: `stableStringify`, `sha256Hex`, `computePromptInputsHash` (CONTRACTS shape), `componentEntryHash` (worker-facing wrapper incl. spec/dynamicList), `PriorComponentRow`, `buildPriorHashIndex`, `selectReusablePrior` (flag-off → never reuse). |
| `apps/web/lib/jab/component-carry-forward.test.ts` | **Create** | Unit tests: key-order invariance, screenshot/model/promptVersion sensitivity, passthrough → null hash, flag-off decision. |
| `apps/web/lib/jab/load-prior-build.ts` | Modify | Add `loadPriorReadyComponentRows(projectId)` — JSON-safe prior `block_inventory` rows for the latest `ready` build. |
| `apps/web/lib/ai/persist-generation.ts` | Modify | `PersistGenerationInput` gains optional `promptInputsHash`/`reusedFromBuildId`; extract pure `blockInventoryTelemetryPayload`; add `copyComponentArtifact` (copy → download+upsert fallback). |
| `apps/web/lib/ai/persist-generation.test.ts` | Modify | Payload tests: new columns written; omitted opts → NULL (guidance-regen hash invalidation). |
| `apps/web/lib/inngest/functions/generate-components.ts` | Modify | Always compute+persist `prompt_inputs_hash` for LLM tiers; flag-gated `load-prior-components` step + per-entry reuse branch (Storage copy + zero-token telemetry); `reusedCount` in result. |
| `apps/web/lib/inngest/functions/edit-site.helpers.ts` | Modify | Add pure `shellCloneObjects(sourceBuildId, resultBuildId)`. |
| `apps/web/lib/inngest/functions/edit-site.helpers.test.ts` | Modify | Test for `shellCloneObjects` path pairs. |
| `apps/web/lib/inngest/functions/edit-site.ts` | Modify | `clone-storage-artifacts` also copies the two shell artifacts (fail-soft). |
| `apps/web/lib/ai/persist-shell-generation.ts` | Modify | `shouldReuseShell` gains `isEditBuild`; guidance still wins; flag semantics for full builds unchanged. |
| `apps/web/lib/ai/persist-shell-generation.test.ts` | Modify | New matrix: component-edit reuses both, shell-edit regenerates only target, full build unchanged. |
| `apps/web/lib/inngest/functions/compose-site.ts` | Modify | Thread `isEditBuild: isEditConfig(buildConfig)` into both shell steps; reason-aware log line. |
| `apps/web/.env.local.example` | Modify | Document `JAB_COMPONENT_REUSE`; amend `JAB_SKIP_SHELL_REGEN` note (edit builds now reuse by default). |

---

### Task 1: Pure hashing engine — `component-carry-forward.ts`

**Files:**
- Create: `apps/web/lib/jab/component-carry-forward.ts`
- Create: `apps/web/lib/jab/component-carry-forward.test.ts`

This is a pure module (no `server-only`, no Supabase) mirroring the conventions of `apps/web/lib/jab/carry-forward.ts` (deterministic, DB-free, unit-tested). `computePromptInputsHash` follows the CONTRACTS signature exactly. Inputs are JSONB-derived values (no cycles, no functions) — documented assumption.

- [ ] **Write the failing test.** Create `apps/web/lib/jab/component-carry-forward.test.ts` with EXACTLY:

```ts
import { describe, it, expect } from "vitest";
import {
  stableStringify,
  sha256Hex,
  computePromptInputsHash,
  componentEntryHash,
  buildPriorHashIndex,
  selectReusablePrior,
  type PriorComponentRow,
} from "./component-carry-forward";

const BASE_HASH_ARGS = {
  blockName: "core/cover",
  tier: "visual",
  model: "claude-sonnet-4-6",
  promptVersion: 2,
  attrSamples: [{ url: "x", dimRatio: 50 }],
  domSample: "<div class=\"wp-block-cover\"/>",
  computedStyles: { viewports: { "1280": { ".wp-block-cover": ["color: red"] } } },
  tokens: { colors: [{ slug: "primary", color: "#111111" }] },
  sourceHost: "tworoadsbrewing.com",
  screenshotSha256: "abc123",
};

describe("stableStringify", () => {
  it("is key-order invariant for objects at every depth", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (arrays are NOT sorted)", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("drops undefined object values (JSON.stringify parity) and keeps null", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe(stableStringify({ b: null }));
    expect(stableStringify({ b: null })).toContain("null");
  });

  it("handles primitives and top-level null", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("s")).toBe(JSON.stringify("s"));
    expect(stableStringify(3)).toBe("3");
  });
});

describe("computePromptInputsHash", () => {
  it("returns a 64-char sha256 hex string", () => {
    expect(computePromptInputsHash(BASE_HASH_ARGS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to key order inside nested input objects", () => {
    const reordered = {
      ...BASE_HASH_ARGS,
      computedStyles: { viewports: { "1280": { ".wp-block-cover": ["color: red"] } } },
      tokens: { colors: [{ color: "#111111", slug: "primary" }] }, // keys flipped
    };
    expect(computePromptInputsHash(reordered)).toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the screenshot hash changes (visual-tier sensitivity)", () => {
    const other = { ...BASE_HASH_ARGS, screenshotSha256: "def456" };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the screenshot goes from present to null", () => {
    const other = { ...BASE_HASH_ARGS, screenshotSha256: null };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when the model changes", () => {
    const other = { ...BASE_HASH_ARGS, model: "claude-haiku-4-5-20251001" };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when promptVersion is bumped", () => {
    const other = { ...BASE_HASH_ARGS, promptVersion: 3 };
    expect(computePromptInputsHash(other)).not.toBe(computePromptInputsHash(BASE_HASH_ARGS));
  });

  it("changes when domSample / attrSamples / tokens / sourceHost change", () => {
    const base = computePromptInputsHash(BASE_HASH_ARGS);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, domSample: null })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, attrSamples: [] })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, tokens: null })).not.toBe(base);
    expect(computePromptInputsHash({ ...BASE_HASH_ARGS, sourceHost: null })).not.toBe(base);
  });
});

describe("componentEntryHash", () => {
  const ENTRY = {
    blockName: "core/cover" as string | null,
    tier: "visual",
    model: "claude-sonnet-4-6",
    promptVersion: 2,
    attrSamples: [{ url: "x" }],
    spec: null as unknown,
    dynamicList: null as unknown,
    domSample: "<div/>",
    computedStyles: null as unknown,
    tokens: null as unknown,
    sourceHost: null as string | null,
    screenshotSha256: null as string | null,
  };

  it("returns null for passthrough tier and for null blockName (no LLM call, nothing to reuse)", () => {
    expect(componentEntryHash({ ...ENTRY, tier: "passthrough" })).toBeNull();
    expect(componentEntryHash({ ...ENTRY, blockName: null })).toBeNull();
  });

  it("returns a hash for visual / standard / trivial tiers", () => {
    for (const tier of ["visual", "standard", "trivial"]) {
      expect(componentEntryHash({ ...ENTRY, tier })).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("changes when the acf_flex spec changes (prompt-relevant input)", () => {
    const a = componentEntryHash({ ...ENTRY, spec: { sub_fields: ["a"] } });
    const b = componentEntryHash({ ...ENTRY, spec: { sub_fields: ["b"] } });
    expect(a).not.toBe(b);
  });

  it("changes when the detected dynamicList changes (prompt contract input)", () => {
    const a = componentEntryHash({ ...ENTRY, dynamicList: { postType: "events" } });
    const b = componentEntryHash({ ...ENTRY, dynamicList: null });
    expect(a).not.toBe(b);
  });
});

describe("buildPriorHashIndex / selectReusablePrior", () => {
  const okRow: PriorComponentRow = {
    block_name: "core/cover",
    prompt_inputs_hash: "h1",
    compile_status: "ok",
    model_used: "claude-sonnet-4-6",
    provider_used: "anthropic",
  };

  it("indexes only compile_status='ok' rows with a non-null hash", () => {
    const index = buildPriorHashIndex([
      okRow,
      { ...okRow, block_name: "core/group", prompt_inputs_hash: "h2", compile_status: "failed" },
      { ...okRow, block_name: "core/list", prompt_inputs_hash: null },
    ]);
    expect(index.get("h1")?.block_name).toBe("core/cover");
    expect(index.has("h2")).toBe(false);
    expect(index.size).toBe(1);
  });

  it("FLAG OFF: never reuses, even on a perfect hash match (byte-identical default path)", () => {
    const index = buildPriorHashIndex([okRow]);
    expect(selectReusablePrior({ flagEnabled: false, hash: "h1", index })).toBeNull();
  });

  it("flag on + matching hash → returns the prior row; null hash or miss → null", () => {
    const index = buildPriorHashIndex([okRow]);
    expect(selectReusablePrior({ flagEnabled: true, hash: "h1", index })?.block_name).toBe("core/cover");
    expect(selectReusablePrior({ flagEnabled: true, hash: null, index })).toBeNull();
    expect(selectReusablePrior({ flagEnabled: true, hash: "nope", index })).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("hashes the well-known empty-string vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
```

- [ ] **Run it; expect module-resolution failure.** From repo root:
  `pnpm --filter @jab/web test -- component-carry-forward`
  Expected: FAIL — `Failed to resolve import "./component-carry-forward"` (file does not exist yet).

- [ ] **Implement.** Create `apps/web/lib/jab/component-carry-forward.ts` with EXACTLY:

```ts
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
 * spec (acf_flex sub_fields / cpt_template union) and the detected
 * dynamicList are prompt-relevant but are not separate args on the
 * campaign-contract signature, so they are folded into the `attrSamples`
 * slot as a composite — the signature is unchanged and the hash covers them.
 */
export interface ComponentEntryHashInput {
  blockName: string | null;
  tier: string;
  model: string;
  promptVersion: number;
  attrSamples: unknown;
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
      samples: input.attrSamples,
      spec: input.spec ?? null,
      dynamicList: input.dynamicList ?? null,
    },
    domSample: input.domSample,
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
```

- [ ] **Run the test; expect PASS.**
  `pnpm --filter @jab/web test -- component-carry-forward`
  Expected: all tests in `component-carry-forward.test.ts` PASS.

- [ ] **Commit.**
  `git add apps/web/lib/jab/component-carry-forward.ts apps/web/lib/jab/component-carry-forward.test.ts`
  `git commit -m "feat(saas): pure component carry-forward hash engine (prompt-inputs sha256 + reuse decision)"`

---

### Task 2: Prior-build component-row loader

**Files:**
- Modify: `apps/web/lib/jab/load-prior-build.ts` (current: `loadPriorReadyBuild` at lines 64–101 is the template — same "latest ready build" query shape)

This is thin service-role IO following the file's existing conventions (JSON-safe arrays across the Inngest `step.run` boundary — see the `PriorBuildArtifacts` docblock at load-prior-build.ts:43-48). No unit test for the IO wrapper itself (repo convention: thin IO wrappers are exercised by worker smokes; pure shaping was tested in Task 1).

- [ ] **Implement.** In `apps/web/lib/jab/load-prior-build.ts`, add the import at the top (alongside the existing `carry-forward` import at line 5):

```ts
import type { PriorComponentRow } from "./component-carry-forward";
```

  and append at the end of the file:

```ts
/** JSON-safe (crosses an Inngest step.run boundary — no Maps). */
export interface PriorComponentArtifacts {
  buildId: string;
  rows: PriorComponentRow[];
}

/**
 * Load the latest READY build's block_inventory reuse slice for the project
 * (AI-call-optimization Phase 4, JAB_COMPONENT_REUSE). Same "latest ready"
 * query shape as loadPriorReadyBuild above. Returns null when no prior ready
 * build exists (first build → nothing to reuse). The worker builds the
 * hash index from `rows` AFTER the step (Maps don't survive JSON).
 */
export async function loadPriorReadyComponentRows(
  projectId: string,
): Promise<PriorComponentArtifacts | null> {
  const supabase = createAdminClient();
  const { data: build } = await supabase
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!build) return null;

  const { data: blocks } = await supabase
    .from("block_inventory")
    .select("block_name, prompt_inputs_hash, compile_status, model_used, provider_used")
    .eq("site_build_id", build.id);

  return { buildId: build.id, rows: (blocks ?? []) as PriorComponentRow[] };
}
```

- [ ] **Typecheck.** `pnpm --filter @jab/web typecheck` — expect zero errors. (Requires Phase 1's migration 0034 to exist only at the DB layer; this query is untyped Supabase string-select, so it compiles regardless.)

- [ ] **Commit.**
  `git add apps/web/lib/jab/load-prior-build.ts`
  `git commit -m "feat(saas): loadPriorReadyComponentRows — prior ready build reuse slice"`

---

### Task 3: persist-generation — write `prompt_inputs_hash` + `reused_from_build_id`; add `copyComponentArtifact`

**Files:**
- Modify: `apps/web/lib/ai/persist-generation.ts` (pre-Phase-1 payload at lines 70–83; **Phase 1 will already have changed** `input_tokens_uncached` to `component.inputTokens` as-is and added `input_tokens_cache_creation` + `failure_kind` — read the file as it exists when you start and preserve every Phase-1/2 field verbatim)
- Modify: `apps/web/lib/ai/persist-generation.test.ts` (currently tests only `buildComponentStoragePath`, lines 1–19)

Semantics that matter: `persistGeneration` is called from two places — the `generate-components` worker (will pass `promptInputsHash`, and `reusedFromBuildId` on reuse) and `regenerateComponentUnit` (`regenerate-unit.ts:142`, passes neither). The defaults therefore write `NULL` for both columns on the chat-edit regen path — **deliberate**: a guidance-modified component no longer corresponds to its source-derived prompt inputs, so NULLing the cloned row's hash guarantees it can never be hash-matched by a later build.

- [ ] **Verify Phase 1 prerequisites before writing code.**
  1. `apps/web/drizzle/migrations/0034_ai_cost_telemetry.sql` exists and adds `prompt_inputs_hash text`, `reused_from_build_id uuid REFERENCES site_builds(id)`, `input_tokens_cache_creation integer NOT NULL DEFAULT 0`, `failure_kind text` to `block_inventory`.
  2. `lib/db/schema.ts` `blockInventory` (currently lines 243–288) declares the four new columns.
  3. Run `pnpm --filter @jab/web test -- edit-site.helpers` — the schema-derived clone-completeness test (edit-site.helpers.test.ts:87-105) must be GREEN, meaning Phase 1 added the four columns to `BLOCK_INVENTORY_CLONE_COLUMNS` (edit-site.helpers.ts:34-35). **If it is RED**, add them now: append `, input_tokens_cache_creation, failure_kind, prompt_inputs_hash, reused_from_build_id` to `BLOCK_INVENTORY_CLONE_COLUMNS` — cloning them on edit builds is correct because the clone is a byte-copy of the artifact, so hash + provenance stay true. Commit that fix separately: `git commit -m "fix(saas): clone 0034 telemetry columns on edit builds"`.

- [ ] **Write the failing test.** Append to `apps/web/lib/ai/persist-generation.test.ts`:

```ts
import { blockInventoryTelemetryPayload } from "./persist-generation";
import type { GeneratedComponent } from "./component-generator";

function component(over: Partial<GeneratedComponent> = {}): GeneratedComponent {
  return {
    blockName: "core/cover",
    tsx: "export function CoreCover() { return <div/>; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    ...over,
  };
}

describe("blockInventoryTelemetryPayload", () => {
  it("writes prompt_inputs_hash and reused_from_build_id when provided", () => {
    const payload = blockInventoryTelemetryPayload(component(), {
      promptInputsHash: "h1",
      reusedFromBuildId: "build-prior",
    });
    expect(payload.prompt_inputs_hash).toBe("h1");
    expect(payload.reused_from_build_id).toBe("build-prior");
  });

  it("NULLs both columns when opts are omitted — the guidance-regen path must invalidate the cloned row's hash", () => {
    const payload = blockInventoryTelemetryPayload(component());
    expect(payload.prompt_inputs_hash).toBeNull();
    expect(payload.reused_from_build_id).toBeNull();
  });

  it("still carries the cost-telemetry columns (Phase 1 math: input_tokens_uncached = inputTokens as-is)", () => {
    const payload = blockInventoryTelemetryPayload(component());
    expect(payload.model_used).toBe("claude-sonnet-4-6");
    expect(payload.input_tokens_uncached).toBe(100);
    expect(payload.input_tokens_cached).toBe(10);
    expect(payload.input_tokens_cache_creation).toBe(5);
    expect(payload.output_tokens).toBe(50);
    expect(payload.compile_status).toBe("ok");
  });
});
```

  Note: if Phase 2 added `failureKind` to `GeneratedComponent` as a **required** field, add `failureKind: null,` to the `component()` factory above.

- [ ] **Run it; expect failure.**
  `pnpm --filter @jab/web test -- persist-generation`
  Expected: FAIL — `blockInventoryTelemetryPayload` is not exported.

- [ ] **Implement.** In `apps/web/lib/ai/persist-generation.ts`:

  1. Extend `PersistGenerationInput` (currently lines 24–28):

```ts
export interface PersistGenerationInput {
  buildId: string;
  projectId: string;
  component: GeneratedComponent;
  /**
   * sha256 over the prompt inputs (lib/jab/component-carry-forward.ts).
   * Omitted on the guidance-regen path (regenerate-unit.ts) ON PURPOSE:
   * a guidance-modified component must NULL its row's hash so no future
   * build can hash-match it.
   */
  promptInputsHash?: string | null;
  /** Set ONLY when the tsx was copied from a prior build instead of generated. */
  reusedFromBuildId?: string | null;
}
```

  2. Extract the existing UPDATE payload literal (the object currently passed to `.update({...})` at lines 72–80 — **as Phase 1 left it**, including `input_tokens_cache_creation` and `failure_kind` if present) into a pure exported function, appending the two new columns:

```ts
/**
 * Pure payload shaper for the block_inventory telemetry UPDATE. Extracted so
 * the column set is unit-testable without a Supabase mock. The two Phase 4
 * columns default to NULL — see PersistGenerationInput docblocks.
 */
export function blockInventoryTelemetryPayload(
  component: GeneratedComponent,
  opts: { promptInputsHash?: string | null; reusedFromBuildId?: string | null } = {},
): Record<string, unknown> {
  return {
    model_used: component.modelUsed,
    provider_used: component.providerUsed,
    input_tokens_cached: component.cacheReadTokens,
    // API input_tokens is ALREADY the uncached remainder (Phase 1 fix) —
    // do not subtract cacheReadTokens here.
    input_tokens_uncached: component.inputTokens,
    input_tokens_cache_creation: component.cacheCreationTokens,
    output_tokens: component.outputTokens,
    compile_status: component.compileStatus,
    compile_attempt_count: component.compileAttemptCount,
    // Keep any additional Phase-1/2 fields (e.g. failure_kind) here verbatim
    // from the pre-existing inline literal.
    prompt_inputs_hash: opts.promptInputsHash ?? null,
    reused_from_build_id: opts.reusedFromBuildId ?? null,
  };
}
```

  3. Replace the inline `.update({...})` call in `persistGeneration` with:

```ts
  const { error: dbError } = await supabase
    .from("block_inventory")
    .update(blockInventoryTelemetryPayload(component, {
      promptInputsHash: input.promptInputsHash,
      reusedFromBuildId: input.reusedFromBuildId,
    }))
    .eq("site_build_id", buildId)
    .eq("project_id", projectId)
    .eq("block_name", blockNameKey);
```

  4. Append the Storage copy helper (used by Task 4) at the end of the file:

```ts
/**
 * Copy a prior build's component artifact into this build's components/
 * prefix (JAB_COMPONENT_REUSE). Supabase Storage copy() fails when the
 * destination already exists (re-dispatched site/components.requested run on
 * the same build) — fall back to download + upsert upload, which is
 * idempotent. Returns false on any failure so the caller regenerates via the
 * LLM instead (fail-soft, mirroring edit-site's per-object copy tolerance).
 */
export async function copyComponentArtifact(
  supabase: ReturnType<typeof createAdminClient>,
  fromBuildId: string,
  toBuildId: string,
  blockName: string,
): Promise<boolean> {
  const from = buildComponentStoragePath(fromBuildId, blockName);
  const to = buildComponentStoragePath(toBuildId, blockName);
  const { error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).copy(from, to);
  if (!error) return true;
  const dl = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(from);
  if (dl.error || !dl.data) return false;
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const up = await supabase.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .upload(to, buf, { contentType: "text/plain", upsert: true });
  return !up.error;
}
```

  (`createAdminClient` and `SITE_SCREENSHOTS_BUCKET` are already imported at the top of this file — lines 2–3.)

- [ ] **Run tests; expect PASS.**
  `pnpm --filter @jab/web test -- persist-generation`
  Expected: existing `buildComponentStoragePath` tests + the three new payload tests all PASS.

- [ ] **Run the regen-path guard.** `pnpm --filter @jab/web test -- regenerate-unit` — expect PASS unchanged (the injected `deps.persist` signature widened compatibly; `regenerate-unit.ts:142` passes no opts → NULLs, which is the wanted semantics).

- [ ] **Commit.**
  `git add apps/web/lib/ai/persist-generation.ts apps/web/lib/ai/persist-generation.test.ts`
  `git commit -m "feat(saas): persist prompt_inputs_hash + reused_from_build_id; copyComponentArtifact helper"`

---

### Task 4: generate-components — always persist the hash; flag-gated reuse branch

**Files:**
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` (per-entry closure currently at lines 309–338; batch step boundary 270–343; result return at 373). **Phase 2 restructures this region** (warm-up stagger: first Sonnet-tier entry runs alone before the batched `Promise.all`) and **Phase 3 adds the `JAB_BATCH_GENERATE` branch** — anchor on the per-entry closure body wherever it lives, not on line numbers.

All decision logic was unit-tested in Task 1 (including the flag-off byte-identical guarantee at the decision level: `selectReusablePrior` with `flagEnabled:false` is unconditionally null). This task is wiring; the repo has no Inngest-function test harness (conventions per `edit-site.helpers.test.ts` — pure helpers tested, workers smoke-validated), so verification here is typecheck + full suite + the gated-step code shape, with the live smoke listed at the end as optional validation.

- [ ] **Add imports** at the top of `generate-components.ts` (alongside existing imports, lines 1–17):

```ts
import {
  componentEntryHash,
  buildPriorHashIndex,
  selectReusablePrior,
  sha256Hex,
} from "@/lib/jab/component-carry-forward";
import { loadPriorReadyComponentRows } from "@/lib/jab/load-prior-build";
import { copyComponentArtifact } from "@/lib/ai/persist-generation";
import { getModelFor } from "@/lib/ai/model";
import { COMPONENT_TASK_BY_TIER } from "@/lib/ai/model-client";
import { COMPONENT_PROMPT_VERSION, type GeneratedComponent } from "@/lib/ai/component-generator";
```

  (`COMPONENT_TASK_BY_TIER` is the Phase 1 export from `model-client.ts`; `COMPONENT_PROMPT_VERSION` is the Phase 2 export. `generateComponent` is already imported — extend that line for the type + constant if you prefer one import.)

- [ ] **Add the flag-gated prior-build load step** immediately after the `resolve-front-page` step (currently ends at line 234) and before the `queue` construction (line 243):

```ts
    // ── Cross-build component carry-forward (JAB_COMPONENT_REUSE, OFF by
    // default — audit: component-generator issue 7). Mirrors discover-site's
    // JAB_INCREMENTAL_SKIP gate shape (discover-site.ts:340): with the flag
    // off this performs ZERO extra reads and the per-entry LLM path below is
    // unchanged. The step output is a JSON-safe array; the Map index is
    // built AFTER the step boundary (Inngest serializes step output).
    const reuseEnabled = process.env.JAB_COMPONENT_REUSE === "1";
    const priorComponents = reuseEnabled
      ? await step.run("load-prior-components", () => loadPriorReadyComponentRows(projectId))
      : null;
    const priorHashIndex = buildPriorHashIndex(priorComponents?.rows ?? []);
```

  Note: the current build's own row can never be returned — its status is `components`, and the loader filters `status = 'ready'`.

- [ ] **Add a reuse counter** next to `let generatedCount = 0;` (currently line 263):

```ts
    let generatedCount = 0;
    let reusedCount = 0;
```

- [ ] **Rework the per-entry closure.** Inside the batch step's `batch.map(async (entry) => { ... })` closure (currently lines 309–337), AFTER the existing screenshot load (`screenshotBase64` assignment, lines 314–318) and the existing `dynamicList` detection (lines 322–334), REPLACE the two lines

```ts
            const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
            const { storagePath } = await persistGeneration({ buildId, projectId, component });
            return { entry, component, storagePath };
```

  with:

```ts
            // ── Phase 4: prompt-inputs hash. Computed for EVERY LLM-tier
            // entry regardless of the reuse flag so block_inventory rows
            // accumulate hashes that future reuse-enabled builds can match.
            // Null for passthrough/null-blockName rows (no LLM, no artifact
            // worth reusing). Model resolution matches what
            // modelClientForTier will use (Phase 1: getModelFor by tier
            // task); sourceHost matches component-generator.ts's
            // `opts.sourceHosts?.[0] ?? null` prompt input.
            const entryModel =
              entry.tier === "visual" || entry.tier === "standard" || entry.tier === "trivial"
                ? getModelFor(COMPONENT_TASK_BY_TIER[entry.tier])
                : null;
            const promptInputsHash = entryModel
              ? componentEntryHash({
                  blockName: entry.blockName,
                  tier: entry.tier,
                  model: entryModel,
                  promptVersion: COMPONENT_PROMPT_VERSION,
                  attrSamples: entry.attrSamples,
                  spec: "spec" in entry ? entry.spec : null,
                  dynamicList,
                  domSample: entry.sourceDomSample ?? null,
                  computedStyles: entry.computedStyles ?? null,
                  tokens,
                  sourceHost: sourceHosts[0] ?? null,
                  screenshotSha256: screenshotBase64 ? sha256Hex(screenshotBase64) : null,
                })
              : null;

            // Reuse branch (flag-gated; selectReusablePrior is null when
            // reuseEnabled=false). Copy the prior artifact + write a
            // zero-token telemetry row; fall back to the LLM on copy failure.
            const prior = selectReusablePrior({
              flagEnabled: reuseEnabled,
              hash: promptInputsHash,
              index: priorHashIndex,
            });
            if (prior && priorComponents) {
              const copied = await copyComponentArtifact(
                supabase,
                priorComponents.buildId,
                buildId,
                prior.block_name,
              );
              if (copied) {
                const reusedComponent: GeneratedComponent = {
                  blockName: prior.block_name,
                  // tsx stays null: the artifact was copied object-to-object
                  // above, so persistGeneration must not re-upload.
                  tsx: null,
                  compileStatus: "ok",
                  compileAttemptCount: 0,
                  modelUsed: prior.model_used,
                  providerUsed: prior.provider_used === "anthropic" ? "anthropic" : null,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                };
                const { storagePath } = await persistGeneration({
                  buildId,
                  projectId,
                  component: reusedComponent,
                  promptInputsHash,
                  reusedFromBuildId: priorComponents.buildId,
                });
                return { entry, component: reusedComponent, storagePath, reused: true };
              }
              console.warn(
                `[generate-components] reuse copy failed for ${prior.block_name} — regenerating via LLM`,
              );
            }

            const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
            const { storagePath } = await persistGeneration({ buildId, projectId, component, promptInputsHash });
            return { entry, component, storagePath, reused: false };
```

  If Phase 2 added a required `failureKind` field to `GeneratedComponent`, add `failureKind: null,` to the `reusedComponent` literal — the typechecker will tell you.

  **Phase 2/3 integration notes (read before editing):**
  - If Phase 2's warm-up stagger selects "the first Sonnet-tier entry" to run alone, a reused entry performing zero LLM calls writes no cache entry. Accept this: pick the first Sonnet-tier entry as today; if it happens to reuse, the cold batch simply misses cache once. Do NOT add reuse-aware warm-up selection (YAGNI — the flag is off by default and a mostly-reused build barely benefits from cache warming).
  - If Phase 3's `JAB_BATCH_GENERATE` branch is active, the hash computation + reuse check belong BEFORE an entry is added to the batch request list (a reused entry must not be submitted to the Batch API). Apply the same block ahead of `BatchRequestItem` construction.

- [ ] **Update the batch step return + accumulation.** The batch step currently ends with (lines 340–342):

```ts
        return results.filter((r) => r.component.compileStatus !== "failed").length;
      });
      generatedCount += batchSucceeded;
```

  Replace with:

```ts
        return {
          succeeded: results.filter((r) => r.component.compileStatus !== "failed").length,
          reused: results.filter((r) => r.reused).length,
        };
      });
      generatedCount += batchCounts.succeeded;
      reusedCount += batchCounts.reused;
```

  and rename the binding `const batchSucceeded = await step.run(...)` → `const batchCounts = await step.run(...)`. (Reused rows have `compileStatus: "ok"`, so they correctly count toward `generatedCount` / `component_count` exactly as a fresh generation would.)

- [ ] **Surface the count.** Change the worker's success return (currently line 373) to:

```ts
    return { buildId, generatedCount, reusedCount, queueLength: queue.length };
```

  and add a log line just before it:

```ts
    if (reusedCount > 0) {
      console.log(`[generate-components] ${reusedCount}/${queue.length} components reused from prior build (JAB_COMPONENT_REUSE)`);
    }
```

- [ ] **Verify.**
  `pnpm --filter @jab/web typecheck` — expect zero errors.
  `pnpm --filter @jab/web test` — expect the full suite GREEN (no existing test exercises this worker; the flag-off behavioral guarantee is pinned by the Task 1 `selectReusablePrior` flag-off test plus the gated `load-prior-components` step which never runs when `JAB_COMPONENT_REUSE !== "1"`).

- [ ] **Commit.**
  `git add apps/web/lib/inngest/functions/generate-components.ts`
  `git commit -m "feat(saas): cross-build component reuse behind JAB_COMPONENT_REUSE (hash always persisted)"`

---

### Task 5: FIRST shell-reuse task — clone Header.tsx/Footer.tsx into the edit build's Storage prefix

**Files:**
- Modify: `apps/web/lib/inngest/functions/edit-site.helpers.ts` (add pure `shellCloneObjects`)
- Modify: `apps/web/lib/inngest/functions/edit-site.helpers.test.ts` (test it)
- Modify: `apps/web/lib/inngest/functions/edit-site.ts` (`clone-storage-artifacts` step, lines 178–206)

**Verification finding (the campaign contract required this check FIRST — done during drafting, re-confirm against the file):** `edit-site.ts:181` iterates `for (const prefix of ["components", "source"])` under `builds/<sourceBuildId>/…`; `buildShellStoragePath` (persist-shell-generation.ts:18-24) places shells at `builds/<id>/project/components/site/{Header,Footer}.tsx` — under the `project/` prefix the loop never walks. **Header.tsx/Footer.tsx are NOT cloned today**, so `shellArtifactExists(resultBuildId, kind)` is always false for a fresh edit build and Task 6's default reuse would silently regenerate anyway. This task adds the clone.

- [ ] **Write the failing test.** Append to `apps/web/lib/inngest/functions/edit-site.helpers.test.ts` (extend the existing import from `./edit-site.helpers` with `shellCloneObjects`):

```ts
describe("shellCloneObjects", () => {
  it("maps both shells from the source build's project/ prefix to the result build's (the prefix walk does not cover project/)", () => {
    expect(shellCloneObjects("src-1", "res-2")).toEqual([
      {
        from: "builds/src-1/project/components/site/Header.tsx",
        to: "builds/res-2/project/components/site/Header.tsx",
      },
      {
        from: "builds/src-1/project/components/site/Footer.tsx",
        to: "builds/res-2/project/components/site/Footer.tsx",
      },
    ]);
  });
});
```

- [ ] **Run it; expect failure.**
  `pnpm --filter @jab/web test -- edit-site.helpers`
  Expected: FAIL — `shellCloneObjects` is not exported from `./edit-site.helpers`.

- [ ] **Implement the pure helper.** In `apps/web/lib/inngest/functions/edit-site.helpers.ts`, add the import:

```ts
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";
```

  and the function (place it next to the CLONE_COLUMNS constants, after line 35):

```ts
/**
 * The two shell artifacts an edit build must clone from its source build.
 * Shells live at builds/<id>/project/components/site/{Header,Footer}.tsx —
 * under the project/ prefix, which edit-site's components/+source/ prefix
 * walk does NOT cover. Without this clone, shellArtifactExists() is false
 * on every fresh edit build and compose's edit-build shell reuse (Phase 4)
 * silently regenerates both shells — the exact spend the reuse exists to
 * remove (audit: edit-planner issue 1, CORRECTED clone premise).
 */
export function shellCloneObjects(
  sourceBuildId: string,
  resultBuildId: string,
): Array<{ from: string; to: string }> {
  return (["header", "footer"] as const).map((kind) => ({
    from: buildShellStoragePath(sourceBuildId, kind),
    to: buildShellStoragePath(resultBuildId, kind),
  }));
}
```

- [ ] **Run the test; expect PASS.**
  `pnpm --filter @jab/web test -- edit-site.helpers`

- [ ] **Wire into the worker.** In `apps/web/lib/inngest/functions/edit-site.ts`:
  1. Extend the helpers import (line 11) with `shellCloneObjects`.
  2. In the `clone-storage-artifacts` step, insert after the closing brace of the `for (const prefix of ...)` loop (currently line 204) and before `return copied;` (line 205):

```ts
        // Shell artifacts live under the project/ prefix, which the loop
        // above does NOT walk. Clone them explicitly so compose's edit-build
        // shell reuse has artifacts to reuse. Fail-soft per object: a missing
        // source shell (pre-Phase-4 source build) or transient copy error
        // just means compose regenerates that shell.
        for (const { from, to } of shellCloneObjects(sourceBuildId, resultBuildId!)) {
          const { error } = await supabase.storage
            .from(SITE_SCREENSHOTS_BUCKET)
            .copy(from, to);
          if (error) {
            console.warn(
              `[edit-site] shell clone failed for ${from} → ${to}: ${error.message}`,
            );
            continue;
          }
          copied++;
        }
```

- [ ] **Verify.**
  `pnpm --filter @jab/web typecheck` — zero errors.
  `pnpm --filter @jab/web test -- edit-site` — all edit-site tests PASS.

- [ ] **Commit.**
  `git add apps/web/lib/inngest/functions/edit-site.helpers.ts apps/web/lib/inngest/functions/edit-site.helpers.test.ts apps/web/lib/inngest/functions/edit-site.ts`
  `git commit -m "fix(saas): clone Header/Footer shell artifacts into edit builds (project/ prefix was never copied)"`

---

### Task 6: Default shell reuse on edit builds — `shouldReuseShell` + compose wiring

**Files:**
- Modify: `apps/web/lib/ai/persist-shell-generation.ts` (`shouldReuseShell`, lines 26–47 incl. docblock)
- Modify: `apps/web/lib/ai/persist-shell-generation.test.ts` (lines 18–34 — update existing four cases, add the new matrix)
- Modify: `apps/web/lib/inngest/functions/compose-site.ts` (shell steps, lines 665–715)

Decision precedence (per campaign contract): `hasEditGuidance` for THAT shell still wins and forces regeneration → then artifact existence → then `skipEnabled || isEditBuild`. `JAB_SKIP_SHELL_REGEN` semantics for full builds are byte-identical to today (`isEditBuild=false` reduces the new function to the old one).

- [ ] **Write the failing tests.** In `apps/web/lib/ai/persist-shell-generation.test.ts`, REPLACE the `describe("shouldReuseShell — JAB_SKIP_SHELL_REGEN decision", ...)` block (lines 18–34) with:

```ts
describe("shouldReuseShell — reuse decision (JAB_SKIP_SHELL_REGEN + edit-build default)", () => {
  // ── Full builds: JAB_SKIP_SHELL_REGEN semantics unchanged ──
  it("FULL build: reuses when skip enabled, no edit guidance, artifact exists", () => {
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: false, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("FULL build: flag off → regenerates (production default unchanged — byte-identical path)", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: false, hasEditGuidance: false, artifactExists: true }),
    ).toBe(false);
  });

  it("FULL build: no prior artifact → regenerates (first compose of the build)", () => {
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: false, hasEditGuidance: false, artifactExists: false }),
    ).toBe(false);
  });

  // ── Edit builds: reuse is the DEFAULT (no env flag) ──
  it("EDIT build (component scope): reuses the shell with no flag set — both kinds present this shape", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("EDIT build (shell scope): the TARGETED shell regenerates — guidance wins over everything", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: true, artifactExists: true }),
    ).toBe(false);
    // Guidance wins even with the operator flag on (carve-out preserved).
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: true, hasEditGuidance: true, artifactExists: true }),
    ).toBe(false);
  });

  it("EDIT build (shell scope): the SIBLING shell (no guidance for its kind) reuses", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("EDIT build: missing cloned artifact → regenerates (source build predates the Task-5 clone)", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: false }),
    ).toBe(false);
  });
});
```

- [ ] **Run it; expect failure.**
  `pnpm --filter @jab/web test -- persist-shell-generation`
  Expected: FAIL — TypeScript/object-literal error: `isEditBuild` is not a known property of `shouldReuseShell`'s options (and the edit-build cases return `false` under the old logic).

- [ ] **Implement.** In `apps/web/lib/ai/persist-shell-generation.ts`, replace the docblock + function at lines 26–47 with:

```ts
/**
 * Pure shell-reuse decision.
 *
 * Two reuse triggers share one precedence chain:
 *   - JAB_SKIP_SHELL_REGEN (skipEnabled) — operator/local-dev iteration
 *     affordance on FULL builds. Off by default; production full builds
 *     always regenerate. Semantics unchanged from the original flag.
 *   - isEditBuild — config.mode === "edit" builds reuse BY DEFAULT (no env
 *     flag): edit-site clones the source build's Header.tsx/Footer.tsx into
 *     the result build's project/ prefix (shellCloneObjects), so re-rolling
 *     both shells on Sonnet for every chat edit was pure waste AND caused
 *     un-asked-for shell drift in the review diff (audit: edit-planner
 *     issue 1).
 *
 * Carve-outs, in order:
 *   1. hasEditGuidance — a shell-scope edit targeting THIS kind MUST
 *      regenerate; reusing would no-op the user's requested change. Wins
 *      over both triggers.
 *   2. artifactExists — we can only reuse what exists (first compose of a
 *      full build; edit builds whose source predates the shell clone).
 */
export function shouldReuseShell(opts: {
  skipEnabled: boolean;
  isEditBuild: boolean;
  hasEditGuidance: boolean;
  artifactExists: boolean;
}): boolean {
  if (opts.hasEditGuidance) return false;
  if (!opts.artifactExists) return false;
  return opts.skipEnabled || opts.isEditBuild;
}
```

- [ ] **Run the test; expect PASS.**
  `pnpm --filter @jab/web test -- persist-shell-generation`
  Note: compose-site will now FAIL typecheck (missing `isEditBuild` at the two call sites) — that is the next step, not a regression.

- [ ] **Wire compose-site.** In `apps/web/lib/inngest/functions/compose-site.ts`:
  1. After the `skipShellRegen` const (currently lines 669–670), add:

```ts
    // Edit builds reuse their cloned shells by default — see shouldReuseShell.
    const isEditBuild = isEditConfig(buildConfig);
```

  2. Update BOTH shell steps (header at 673–683, footer at 694–703) to pass the new field and log the reason. Header step head becomes:

```ts
      step.run("generate-header", async () => {
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            isEditBuild,
            hasEditGuidance: shellEditGuidance("header") !== undefined,
            artifactExists: await shellArtifactExists(buildId, "header"),
          })
        ) {
          console.log(
            `[compose-site ${buildId}] ${isEditBuild ? "edit build" : "JAB_SKIP_SHELL_REGEN"}: reusing existing Header.tsx`,
          );
          return { reusedShell: "header" as const };
        }
```

  Footer step head becomes:

```ts
      step.run("generate-footer", async () => {
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            isEditBuild,
            hasEditGuidance: shellEditGuidance("footer") !== undefined,
            artifactExists: await shellArtifactExists(buildId, "footer"),
          })
        ) {
          console.log(
            `[compose-site ${buildId}] ${isEditBuild ? "edit build" : "JAB_SKIP_SHELL_REGEN"}: reusing existing Footer.tsx`,
          );
          return { reusedShell: "footer" as const };
        }
```

  The remainder of both steps (the `generateShell` call + `persistShellGeneration`) is unchanged. The `Promise.all` results are not consumed downstream (verified at lines 672–715), so the reuse return shape needs no other change. Also update the stale comment at lines 665–668 to mention the edit-build default:

```ts
    // Iteration affordance: skip the (unchanged) shell LLM call when re-composing
    // a build that already has Header.tsx / Footer.tsx in Storage. For FULL builds
    // this is gated behind JAB_SKIP_SHELL_REGEN (off by default — production
    // regenerates). EDIT builds reuse their CLONED shells by default; a shell-scope
    // edit still regenerates its own target (guidance wins). See shouldReuseShell.
```

- [ ] **Behavioral matrix this buys (record in the commit message / PR):**
  - Component-scope chat edit → both shells reused (zero shell LLM calls; review diff shows no shell drift).
  - Shell-scope edit targeting `header` → header regenerates with guidance; footer reused. (And vice versa.)
  - Full build → both shells regenerate unless the operator sets `JAB_SKIP_SHELL_REGEN` — unchanged.
  - Edit build sourced from a pre-Task-5 build (no cloned artifact) → regenerates, exactly like today.
  - Known accepted gap: when compose REUSES a shell it writes **no `shell_generations` row** for the result build (same as the existing flag path) — cost dashboards read absence as zero spend, which is true.

- [ ] **Verify.**
  `pnpm --filter @jab/web typecheck` — zero errors.
  `pnpm --filter @jab/web test` — full suite PASS.

- [ ] **Commit.**
  `git add apps/web/lib/ai/persist-shell-generation.ts apps/web/lib/ai/persist-shell-generation.test.ts apps/web/lib/inngest/functions/compose-site.ts`
  `git commit -m "feat(saas): edit builds reuse cloned shells by default; shell-edit target still regenerates"`

---

### Task 7: Flag documentation + final verification

**Files:**
- Modify: `apps/web/.env.local.example` (flags block, lines 81–92)

- [ ] **Document the new flag.** In `apps/web/.env.local.example`, after the `# JAB_INCREMENTAL_SKIP=1` entry (line 83), add:

```
# Cross-build component reuse: when a block type's prompt inputs hash-match the
# prior READY build's row, copy its .tsx + write a zero-token telemetry row
# instead of calling the LLM. Off by default (full regen). Chat-edit regens
# never reuse. See lib/jab/component-carry-forward.ts.
# JAB_COMPONENT_REUSE=1
```

  and amend the `# JAB_SKIP_SHELL_REGEN=1` comment (line 88) to note: `Full builds only — edit builds reuse their cloned shells by default since Phase 4 (shell-scope edits still regenerate their target).`

- [ ] **Full verification sweep.**
  `pnpm --filter @jab/web typecheck` — zero errors.
  `pnpm --filter @jab/web test` — full suite PASS (compare count against the pre-plan baseline; only ADDED tests, none removed except the four rewritten `shouldReuseShell` cases which are superset-replaced).

- [ ] **Optional live validation (not a gate; requires env + applied migrations 0032–0034 on the local "JAB WP" Supabase project):**
  1. Run a full build to seed hashes: `pnpm --filter @jab/web smoke:build`.
  2. Re-run components scoped with the flag: `JAB_COMPONENT_REUSE=1 pnpm --filter @jab/web smoke:generate` → expect the worker log `N/M components reused from prior build` and `block_inventory` rows with `reused_from_build_id` set + zero tokens.
  3. Dispatch a component-scope chat edit and confirm compose logs `edit build: reusing existing Header.tsx` / `...Footer.tsx` and `shell_generations` has no new rows for the result build.

- [ ] **Commit.**
  `git add apps/web/.env.local.example`
  `git commit -m "docs(saas): document JAB_COMPONENT_REUSE + shell-reuse default for edit builds"`

---

## Risks and residuals (carry into the campaign overview)

1. **Stale reuse via un-hashed manifest drift:** `dynamicList` detection depends on `cptListMetaFromManifest(manifest)`; the manifest itself is not a hash input (only the detected `dynamicList` result is, via the composite). A manifest change that alters CPT list metadata WILL change `dynamicList` and therefore the hash — covered — but a manifest change that alters prompt-adjacent behavior elsewhere would not. Bounded by the flag being off by default.
2. **Hash composite is a semantic extension of the contract:** `attrSamples` receives `{ samples, spec, dynamicList }` at the call site (signature unchanged). Documented in `componentEntryHash`'s docblock; reported as a deviation to the campaign overview.
3. **Reused rows skip Phase B validation:** the copied TSX was validated when originally generated and is re-checked by compose's `tsc --noEmit` compile gate (`JAB_COMPOSE_TYPECHECK`, on by default), so a platform-shim/emitter change between builds surfaces at the compile gate, not silently in production. Bumping `COMPONENT_PROMPT_VERSION` (Phase 2 owns it) is the documented kill-switch that invalidates every prior hash.
4. **Screenshot hash sensitivity makes visual-tier reuse rare on real sites:** any pixel change to the page's 1280 screenshot changes `screenshotSha256` → no reuse for visual-tier blocks on that page. This is correct (the screenshot is a prompt input) but means the big wins are standard/trivial tiers and unchanged pages; set expectations accordingly.
5. **Phase ordering:** Tasks 2–4 hard-depend on Phase 1 (0034 columns + `COMPONENT_TASK_BY_TIER`) and Phase 2 (`COMPONENT_PROMPT_VERSION`); line numbers in this plan WILL have shifted after Phases 1–3 — anchor on quoted code and step names. Migration 0034 must be applied to BOTH Supabase projects (local "JAB WP" `ajfurojjxthhzkjqttri` AND prod "jab-prod" `celzwcxkrmsbwiswkxug`; note 0032+0033 are still pending apply and stack first) before any reuse-enabled or edit-build run.
6. **`shell_generations` has no row on reuse:** dashboards that join shells per build must treat absence as "reused/zero-spend", not missing data (same as the pre-existing `JAB_SKIP_SHELL_REGEN` path).
7. **Edit-on-edit chains:** each edit build clones shells from its immediate source, so chains keep working; the artifact content traces back to the last build that actually generated (or shell-edited) it — exactly the previewed bytes, which is the fidelity-preserving choice.
