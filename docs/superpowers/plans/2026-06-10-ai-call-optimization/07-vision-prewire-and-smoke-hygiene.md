# Phase 7: Vision Pre-Wiring and Smoke Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Defuse the vision-scoring landmines (synthetic 0.5 diff, first-come vision budget, build-fatal vision errors, unimplementable stub signature) before Phase 7.1 wires a real vision model, and make the operator smoke/debug scripts honest (verified $0 mock runs, spend banners, a debug tool that reproduces production).

**Architecture:** All vision-path math stays in the pure module `apps/web/lib/ai/fidelity-score.ts` (pngjs + pixelmatch, no server-only, fully unit-testable); the `verify-fidelity` Inngest worker becomes a thin two-phase consumer (phase A: measure every page; phase B: spend the capped vision budget worst-first, fail-soft). Script hygiene follows the repo's pure-helper pattern: testable text/predicate helpers live under `apps/web/scripts/lib/`, smoke scripts import them, and `debug-shell-llm.ts` is de-forked to import the production prompt builders / postprocess / cap / model resolution — which requires dropping the `server-only` marker from five pure modules (verified: the `server-only` package is not installed; Next's bundler aliases it, so any transitive import hard-fails under `tsx`).

**Tech Stack:** TypeScript, Next.js App Router (apps/web), @anthropic-ai/sdk, Inngest, Drizzle/Supabase, Vitest

**Campaign:** Phase 7 of docs/superpowers/plans/2026-06-10-ai-call-optimization/ (see 00-campaign-overview.md). Depends on: **Phase 1** (model.ts gains the `"shell"` task + `envKeyFor` hyphen fix + opus-4-8 swap; `getAnthropicClient()` is the only SDK construction point; migration `0034_ai_cost_telemetry.sql` adds `input_tokens_cache_creation` to `block_inventory` AND `shell_generations`) and **Phase 2** (shell prompt builders return `{ system: string; user: string }` — the `"\n\nUSER:\n"` sentinel is deleted; pure module `apps/web/lib/jab/sanitize-shell-dom.ts` exists). Phases 3–6 are NOT prerequisites.

> **Line-number caveat:** refs into `apps/web/lib/ai/fidelity-score.ts`, `apps/web/lib/inngest/functions/verify-fidelity.ts`, and the four scripts were verified on the pre-campaign tree and those files are untouched by Phases 1–6 — they are accurate. Refs into `model.ts`, `client.ts`, `shell-prompts.ts`, `generate-shell.ts` are pre-campaign; Phases 1–2 rewrite parts of those files, so each task that touches them starts with a re-verification grep. Run all commands from `apps/web/` unless stated otherwise. The repo test runner is `pnpm test` (= `vitest run`, per `apps/web/package.json:11`); a single file runs as `pnpm test <path>`.

> **No env flags are introduced by this phase.** Behavior changes are unconditional and covered by tests; the only behavioral deltas are inside the verify worker's scoring allocation (documented in Task 3) and script console output.

---

## File structure

**Create**
| Path | Responsibility |
|---|---|
| `apps/web/scripts/lib/zero-spend.ts` | Pure detector: which telemetry rows carry non-zero token counts (mock-run verification). |
| `apps/web/scripts/lib/zero-spend.test.ts` | Unit tests for the detector. |
| `apps/web/scripts/lib/smoke-banners.ts` | Pure text builders: spend-mode banner + "pipeline continues" notes shared by smoke scripts. |
| `apps/web/scripts/lib/smoke-banners.test.ts` | Unit tests for the banner/note text. |
| `apps/web/scripts/lib/script-source-pins.test.ts` | Source-text pins that smoke/debug scripts stay wired (scripts run `main()` on import, so they can't be imported by tests). |
| `apps/web/lib/ai/script-importable.test.ts` | Pins that the script-imported pure modules carry no `import "server-only"`. |

**Modify**
| Path | Change |
|---|---|
| `apps/web/lib/ai/fidelity-score.ts` | Overlap-crop pixel diff (measured ratio + `heightDeltaPx`), `sizeMismatchIssue` / `visionUnavailableIssue` helpers, `selectVisionPages`, extended `VisionScoreInput`, corrected `visionScore` docblock. |
| `apps/web/lib/ai/fidelity-score.test.ts` | New/updated tests incl. synthetic-PNG construction. |
| `apps/web/lib/inngest/functions/verify-fidelity.ts` | Two-phase scoring (measure all → spend cap worst-first), size-mismatch reason persisted in `issues` jsonb, per-page vision fail-soft. |
| `apps/web/scripts/smoke-generate-components.ts` | Mock-mode zero-token assertion on `block_inventory`; closing pipeline-continues note. |
| `apps/web/scripts/smoke-build.ts` | Mock-mode zero-token assertion on `block_inventory` + `shell_generations`. |
| `apps/web/scripts/smoke-compose-site.ts` | Live/mock spend banner + `JAB_SKIP_SHELL_REGEN` mention; closing pipeline-continues note. |
| `apps/web/lib/ai/shell-prompts.ts` | Drops `server-only`; gains `MAX_SHELL_BYTES` (moved from generate-shell.ts) + `SHELL_MAX_TOKENS`. |
| `apps/web/lib/ai/shell-prompts.test.ts` | Pins the two constants. |
| `apps/web/lib/ai/generate-shell.ts` | Imports `MAX_SHELL_BYTES` from `./shell-prompts` instead of a local const. |
| `apps/web/lib/ai/generated-tsx-postprocess.ts` | Drops `server-only` (pure string transforms; its only dep `lib/jab/import-rewrite.ts` is already deliberately server-only-free). |
| `apps/web/lib/ai/model.ts` | Drops `server-only` (pure env→model-id resolution, no secrets). |
| `apps/web/lib/ai/client.ts` | Drops `server-only` (key read at call time from `process.env`; absent in client bundles → loud throw, no leak) so scripts can honor the "never `new Anthropic()` outside client.ts" contract. |
| `apps/web/lib/jab/global-styles.ts` | Drops `server-only` (pure token distillation; only other import is type-only). |
| `apps/web/scripts/debug-shell-llm.ts` | Full de-fork rewrite: production prompts, production gate order, `getModelFor("shell")`, `getAnthropicClient()`, `MAX_SHELL_BYTES` (24 KB) replaces the stale `12_000` cap. |

**No migration.** The size-mismatch reason and the `vision_unavailable` marker persist into the existing `fidelity_reports.issues` JSONB column (`apps/web/drizzle/migrations/0014_saas_v2_schema.sql:267` — `issues JSONB NOT NULL DEFAULT '[]'`), and the measured ratio persists into the existing `pixel_diff NUMERIC(6,5)` column (line 263). Adding dedicated columns would duplicate what the structured issues list already models for the review screen.

---

### Task 1: Overlap-crop pixel diff — measured ratio + `heightDeltaPx` replace the synthetic 0.5

**Why:** `pixelDiffScore` returns a hardcoded `diffRatio: 0.5` on any dimension mismatch (`fidelity-score.ts:62-70`). Both capture passes are `fullPage: true` (`playwright-verify.ts:151`), so heights are content-dependent and a 1-px delta lands in this branch — when Phase 7.1 wires a real vision model, nearly every page would auto-flag (0.5 > 0.10) and saturate the 15-call cap with zero-signal pairs.

**Files:**
- Modify: `apps/web/lib/ai/fidelity-score.ts` (docblock 51-57, `PixelDiffResult` 39-49, `pixelDiffScore` 58-91)
- Test: `apps/web/lib/ai/fidelity-score.test.ts` (replaces the 0.5 pin at lines 56-63)

**Steps:**

- [ ] In `apps/web/lib/ai/fidelity-score.test.ts`, add a banded-PNG helper below the existing `solidPng` helper (lines 16-32 — keep `solidPng` unchanged), and replace the existing test `"handles size mismatch with sizeMismatch=true and a conservative score=0.5"` (lines 56-63) with the new describe block:

```ts
/**
 * Build a PNG with `topRows` rows of one color and the remainder of another.
 * Proves the overlap crop is anchored at the top-left (both captures start
 * at the page top; height drift accumulates at the bottom).
 */
function bandedPng(
  width: number,
  height: number,
  topRows: number,
  topRgba: [number, number, number, number],
  bottomRgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const rgba = y < topRows ? topRgba : bottomRgba;
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

describe("pixelDiffScore — dimension mismatch (overlap crop)", () => {
  it("measures the overlapping region instead of returning a synthetic 0.5", () => {
    // Identical content where the images overlap; generated is 4px taller.
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(10, 14, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(4);
    expect(result.diffRatio).toBe(0); // measured, not the old placeholder 0.5
    expect(result.score).toBe(1);
    expect(result.diffPixels).toBe(0);
    expect(result.totalPixels).toBe(100); // 10 × min(10, 14)
  });

  it("still reports real divergence inside the overlap", () => {
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(10, 14, [0, 255, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.diffRatio).toBeGreaterThan(0.99);
    expect(result.score).toBeLessThan(0.01);
  });

  it("crops from the top-left (page top), not an arbitrary region", () => {
    // 4×4: top 2 rows red, bottom 2 rows blue. Generated is 2 rows taller
    // with the same top-anchored content — overlap must diff to zero.
    const source = bandedPng(4, 4, 2, [255, 0, 0, 255], [0, 0, 255, 255]);
    const generated = bandedPng(4, 6, 2, [255, 0, 0, 255], [0, 0, 255, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(2);
    expect(result.diffRatio).toBe(0);
  });

  it("handles width mismatches and reports heightDeltaPx=0", () => {
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(8, 10, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.totalPixels).toBe(80); // min(10,8) × 10
  });

  it("reports sizeMismatch=false and heightDeltaPx=0 for equal dimensions", () => {
    const a = solidPng(10, 10, [255, 0, 0, 255]);
    const b = solidPng(10, 10, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: a, generatedBuffer: b });
    expect(result.sizeMismatch).toBe(false);
    expect(result.heightDeltaPx).toBe(0);
  });
});
```

- [ ] Run (from `apps/web/`): `pnpm test lib/ai/fidelity-score.test.ts` — expect failures: `heightDeltaPx` is `undefined` and `diffRatio` is `0.5` on the mismatch tests (the current implementation returns the placeholder).

- [ ] Implement in `apps/web/lib/ai/fidelity-score.ts`. Replace the `PixelDiffResult` interface (lines 39-49), the docblock above `pixelDiffScore` (lines 51-57), and the whole `pixelDiffScore` body (lines 58-91) with:

```ts
export interface PixelDiffResult {
  /** Ratio of differing pixels in [0, 1], measured on the overlapping region. */
  diffRatio: number;
  /** 1 - diffRatio, clamped to [0, 1]. */
  score: number;
  /** Pixels-differing / total-pixels metadata for telemetry. */
  diffPixels: number;
  totalPixels: number;
  /**
   * True when source/generated dimensions differ. The diff is still MEASURED
   * (on the top-left overlapping region); sizeMismatch is a flag-reason for
   * the row, never a synthetic score.
   */
  sizeMismatch: boolean;
  /** abs(source.height − generated.height) in px; 0 when heights match. */
  heightDeltaPx: number;
}

/** Crop a decoded PNG to the top-left `width × height` region (no-op when already that size). */
function cropToRegion(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
  return out;
}

/**
 * Compare two PNG buffers pixel-by-pixel. When dimensions differ (the COMMON
 * case for fullPage captures — heights are content-dependent), both PNGs are
 * cropped to the overlapping top-left region (min width × min height) and the
 * diff is measured there. Pre-2026-06-10 this branch returned a synthetic
 * diffRatio of 0.5, which auto-flagged nearly every page for the vision pass
 * and saturated VISION_PER_BUILD_CAP with zero-signal pairs.
 */
export function pixelDiffScore(input: PixelDiffInput): PixelDiffResult {
  const source = PNG.sync.read(input.sourceBuffer);
  const generated = PNG.sync.read(input.generatedBuffer);

  const sizeMismatch =
    source.width !== generated.width || source.height !== generated.height;
  const heightDeltaPx = Math.abs(source.height - generated.height);
  const width = Math.min(source.width, generated.width);
  const height = Math.min(source.height, generated.height);
  const totalPixels = width * height;

  if (totalPixels === 0) {
    // Degenerate capture (zero-dimension PNG) — nothing measurable.
    return { diffRatio: 1, score: 0, diffPixels: 0, totalPixels: 0, sizeMismatch, heightDeltaPx };
  }

  const croppedSource = cropToRegion(source, width, height);
  const croppedGenerated = cropToRegion(generated, width, height);
  const diffPixels = pixelmatch(
    croppedSource.data,
    croppedGenerated.data,
    null,
    width,
    height,
    { threshold: input.threshold ?? 0.1 },
  );
  const diffRatio = diffPixels / totalPixels;
  return {
    diffRatio,
    score: clamp01(1 - diffRatio),
    diffPixels,
    totalPixels,
    sizeMismatch,
    heightDeltaPx,
  };
}
```

- [ ] Run: `pnpm test lib/ai/fidelity-score.test.ts` — expect PASS (all describes).
- [ ] Run the full suite to catch downstream pins: `pnpm test` — expect green (the only other consumer of `pixelDiffScore` is `verify-fidelity.ts`, which compiles unchanged because the result type only gained a field).
- [ ] Commit:
```
git add apps/web/lib/ai/fidelity-score.ts apps/web/lib/ai/fidelity-score.test.ts
git commit -m "fix(verify): overlap-crop pixel diff - measured ratio + heightDeltaPx replace the synthetic 0.5"
```

---

### Task 2: Vision allocation + fail-soft helpers; `VisionScoreInput` extension; docblock fix

**Why:** The vision budget is spent first-come-first-served in DB order (`verify-fidelity.ts:157-158, 230-235`); the stub's input type `{ pixelDiffScore: number }` cannot carry what a real call needs, and its docblock wrongly instructs "keep the function signature stable" (`fidelity-score.ts:114-132`). All allocation logic must be pure and unit-tested before the worker consumes it.

**Files:**
- Modify: `apps/web/lib/ai/fidelity-score.ts` (after Task 1; `VisionScoreInput` at the post-Task-1 location of the old lines 114-117, `visionScore` docblock at old 128-132)
- Test: `apps/web/lib/ai/fidelity-score.test.ts`

**Steps:**

- [ ] Append to `apps/web/lib/ai/fidelity-score.test.ts` (and add `selectVisionPages`, `sizeMismatchIssue`, `visionUnavailableIssue` to the import list at the top of the file):

```ts
describe("selectVisionPages", () => {
  it("spends the cap on the worst measured divergence, not DB order", () => {
    const candidates = [
      { pageInventoryId: "a", diffRatio: 0.12 },
      { pageInventoryId: "b", diffRatio: 0.95 },
      { pageInventoryId: "c", diffRatio: 0.4 },
    ];
    expect(selectVisionPages(candidates, 2)).toEqual(["b", "c"]);
  });

  it("excludes pages at or below the flag threshold", () => {
    const candidates = [
      { pageInventoryId: "a", diffRatio: 0.1 },
      { pageInventoryId: "b", diffRatio: 0.05 },
      { pageInventoryId: "c", diffRatio: 0.11 },
    ];
    expect(selectVisionPages(candidates)).toEqual(["c"]);
  });

  it("defaults the cap to VISION_PER_BUILD_CAP and orders worst-first", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      pageInventoryId: `p${i}`,
      diffRatio: 0.2 + i * 0.001,
    }));
    const selected = selectVisionPages(candidates);
    expect(selected).toHaveLength(VISION_PER_BUILD_CAP);
    expect(selected[0]).toBe("p39"); // highest diffRatio first
  });

  it("accepts a custom threshold", () => {
    expect(selectVisionPages([{ pageInventoryId: "a", diffRatio: 0.06 }], 15, 0.05)).toEqual(["a"]);
  });
});

describe("sizeMismatchIssue / visionUnavailableIssue", () => {
  it("records the height delta as a low-severity page-level reason", () => {
    const issue = sizeMismatchIssue(742);
    expect(issue.block_name).toBe("_page");
    expect(issue.severity).toBe("low");
    expect(issue.description).toContain("viewport_size_mismatch");
    expect(issue.description).toContain("742px");
  });

  it("marks the vision fallback with the vision_unavailable marker", () => {
    const issue = visionUnavailableIssue("storage download returned null");
    expect(issue.block_name).toBe("_page");
    expect(issue.severity).toBe("low");
    expect(issue.description).toContain("vision_unavailable");
    expect(issue.description).toContain("storage download returned null");
  });
});

describe("visionScore — extended input (stub)", () => {
  it("accepts the extended VisionScoreInput and still echoes the pixel score", async () => {
    const result = await visionScore({
      pixelDiffScore: 0.4,
      sourceBuffer: Buffer.from("not-a-real-png"),
      generatedBuffer: Buffer.from("not-a-real-png"),
      routePath: "/about",
      blockNames: ["core/cover"],
    });
    expect(result.score).toBe(0.4);
    expect(result.issues).toEqual([]);
  });
});
```

- [ ] Run: `pnpm test lib/ai/fidelity-score.test.ts` — expect failures: `selectVisionPages` / `sizeMismatchIssue` / `visionUnavailableIssue` are not exported (`does not provide an export named ...`), and the extended-input test fails type-compile only at runtime if TS objects — esbuild strips types, so it passes if the stub already echoes; the missing-export failures are the gate.

- [ ] Implement in `apps/web/lib/ai/fidelity-score.ts`. Replace the existing `VisionScoreInput` interface and the `visionScore` docblock, and add the three helpers after `VISION_PER_BUILD_CAP`:

```ts
/**
 * Candidate row for vision-budget allocation: page identity + the measured
 * pixel divergence from phase A of the verify worker.
 */
export interface VisionCandidate {
  pageInventoryId: string;
  diffRatio: number;
}

/**
 * Pick which pages get the (capped) vision pass: every flagged page, sorted
 * by measured divergence DESCENDING, truncated to the cap. Replaces the old
 * first-come-first-served decrement so the budget always lands on the worst
 * pages regardless of page_inventory query order.
 */
export function selectVisionPages(
  candidates: VisionCandidate[],
  cap: number = VISION_PER_BUILD_CAP,
  threshold: number = DEFAULT_VISION_FLAG_THRESHOLD,
): string[] {
  return candidates
    .filter((c) => flagForVision(c.diffRatio, threshold))
    .sort((a, b) => b.diffRatio - a.diffRatio)
    .slice(0, cap)
    .map((c) => c.pageInventoryId);
}

/**
 * Row-level reason for a dimension mismatch. Recorded in the persisted
 * `issues` list — never as a score (the score is the measured overlap diff).
 */
export function sizeMismatchIssue(
  heightDeltaPx: number,
): VisionScoreResult["issues"][number] {
  return {
    block_name: "_page",
    severity: "low",
    description: `viewport_size_mismatch: generated full-page height differs from source by ${heightDeltaPx}px; pixel diff was measured on the overlapping region.`,
  };
}

/**
 * Fail-soft marker appended when the vision pass could not run for a page
 * (download failure, future API error). The page keeps its pixel-derived
 * score; vision is advisory and must never fail a build.
 */
export function visionUnavailableIssue(
  reason: string,
): VisionScoreResult["issues"][number] {
  return {
    block_name: "_page",
    severity: "low",
    description: `vision_unavailable: ${reason} — score is pixel-derived.`,
  };
}

export interface VisionScoreInput {
  /** Pixel-derived score for the page. The v1 stub echoes this as the LLM score. */
  pixelDiffScore: number;
  /** Source (WP) full-page PNG at 1280w — provided so the Phase 7.1 real call is a stub-body swap. */
  sourceBuffer?: Buffer;
  /** Generated (clone) full-page PNG at 1280w. */
  generatedBuffer?: Buffer;
  /** Clone route path (e.g. "/about") for prompt grounding. */
  routePath?: string;
  /** Block names present on the page, for grounded issue attribution (issues key on block_name). */
  blockNames?: string[];
}
```

  and replace the `visionScore` docblock (currently "Placeholder LLM scoring pass... keep the function signature stable.") with:

```ts
/**
 * Placeholder LLM scoring pass. v1 returns the pixel-derived score with an
 * empty issues list — no API call is made. Wiring a real Anthropic vision
 * call is the tracked Phase 7.1 follow-up.
 *
 * Stability contract: the RESULT shape (VisionScoreResult) and the
 * worker/persistence contract are the stable surface. VisionScoreInput is
 * the EXTENSION POINT — it already carries the buffers/route the real call
 * needs and may grow further (e.g. storage paths if scoring moves to a
 * Batch step).
 */
```

  (the `visionScore` body itself is unchanged).

- [ ] Run: `pnpm test lib/ai/fidelity-score.test.ts` — expect PASS.
- [ ] Run: `pnpm typecheck` — expect clean (worker still compiles: optional fields only).
- [ ] Commit:
```
git add apps/web/lib/ai/fidelity-score.ts apps/web/lib/ai/fidelity-score.test.ts
git commit -m "feat(verify): vision allocation + fail-soft helpers; VisionScoreInput carries buffers/route"
```

---

### Task 3: Two-phase scoring in verify-fidelity; mismatch reason persisted; vision fail-soft

**Why:** Today the worker decrements `visionCallsRemaining` on the first 15 flagged pages in query order (`verify-fidelity.ts:157, 230-235`), never reads `diff.sizeMismatch`, and any future exception from `visionScore` would propagate to the function-level catch → `markBuildFailed` (`verify-fidelity.ts:323-326`) — killing a build at its most-expensive-to-reach phase for an advisory signal.

**Files:**
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts` (imports at lines 11-17; `score-pages` step at lines 146-246)

**No new unit test file:** all decision logic was extracted and tested in Tasks 1–2 (`pixelDiffScore`, `selectVisionPages`, the issue helpers, the stub). The worker becomes pure wiring; there is no Inngest test harness in this repo (only `edit-site.helpers.test.ts` / `shared-failure.test.ts` test extracted helpers, which is exactly the pattern followed here). Verification is `pnpm typecheck` + full suite + the existing mock smoke (`pnpm smoke:build`).

**Persistence decision (no migration):** the measured ratio goes to the existing `fidelity_reports.pixel_diff NUMERIC(6,5)` column (already written at `verify-fidelity.ts:257`), and the mismatch reason / vision-unavailable marker go into the existing `fidelity_reports.issues JSONB` column (migration `0014_saas_v2_schema.sql:263-267`) as structured `{block_name:"_page", severity:"low", ...}` entries — the exact shape the review screen already renders. A dedicated column would duplicate this.

**Steps:**

- [ ] Update the import block at `apps/web/lib/inngest/functions/verify-fidelity.ts:11-17`. Replace:

```ts
import {
  pixelDiffScore,
  flagForVision,
  visionScore,
  VISION_PER_BUILD_CAP,
  httpFailureRow,
} from "@/lib/ai/fidelity-score";
```

  with:

```ts
import {
  pixelDiffScore,
  visionScore,
  selectVisionPages,
  sizeMismatchIssue,
  visionUnavailableIssue,
  httpFailureRow,
} from "@/lib/ai/fidelity-score";
```

  (`flagForVision` and `VISION_PER_BUILD_CAP` are now defaults inside `selectVisionPages` and stay exported for their own tests.)

- [ ] Replace the entire `score-pages` step (lines 146-246, from `const scoring = await step.run("score-pages", async () => {` through its closing `});`) with:

```ts
      // Pair source ↔ generated screenshots and score per page.
      //
      // Two-phase allocation (campaign Phase 7):
      //   Phase A — pixel-diff EVERY page first. No vision-budget decisions
      //             happen here, so the cap is never consumed by whatever
      //             happens to come first in DB order.
      //   Phase B — sort flagged pages by measured diffRatio DESC and spend
      //             VISION_PER_BUILD_CAP on the worst ones. Each call is
      //             individually fail-soft: vision is advisory, so any error
      //             falls back to the pixel score with a vision_unavailable
      //             marker instead of failing a build that already paid for
      //             discovery, generation, compose, and a Vercel deploy.
      //
      // Buffers do not survive phase A (a 40-page site × 2 full-page PNGs
      // would be unbounded memory), so phase B re-downloads the ≤15 selected
      // pairs — bounded, and it keeps Buffers out of the step's JSON-
      // serialized return value.
      const scoring = await step.run("score-pages", async () => {
        const supabase = createAdminClient();
        const rows: Array<{
          page_inventory_id: string;
          score: number | null;
          pixel_diff: number | null;
          issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }>;
          generated_screenshot_paths: VerifyPageResult["generatedScreenshotPaths"];
          skipped: boolean;
        }> = [];

        // ── Phase A: measure every page ─────────────────────────────────
        const candidates: Array<{ pageInventoryId: string; diffRatio: number }> = [];
        const visionMeta = new Map<
          string,
          { rowIndex: number; pixelScore: number; sourcePath: string; generatedPath: string; routePath: string }
        >();

        for (const page of pages) {
          const generated = generatedResults.find(
            (g) => g.pageInventoryId === page.id,
          );

          // HTTP-failure short-circuit: a 4xx/5xx page must not pixel-score
          // (it would read as "mediocre fidelity" instead of "broken").
          // Build still goes ready — the review gate blocks publish.
          const httpFail = httpFailureRow(generated?.httpStatus, page.route_path);
          if (httpFail) {
            rows.push({
              page_inventory_id: page.id,
              score: httpFail.score,
              pixel_diff: null,
              issues: httpFail.issues,
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              skipped: false,
            });
            continue;
          }

          const sourcePaths =
            (page.source_screenshot_paths?.source as Record<string, string> | undefined) ?? {};
          // v1: score against the 1280 viewport only. The page_inventory
          // schema accepts multiple viewports; verification only needs one
          // axis to flag drift. Multi-viewport scoring is a follow-up.
          const sourcePath = sourcePaths["1280"] ?? null;
          const generatedPath =
            generated?.generatedScreenshotPaths.source["1280"] ?? null;

          if (!sourcePath || !generatedPath) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? {
                source: {},
              },
              skipped: true,
            });
            continue;
          }

          const [sourceBuf, generatedBuf] = await Promise.all([
            downloadBucket(supabase, sourcePath),
            downloadBucket(supabase, generatedPath),
          ]);
          if (!sourceBuf || !generatedBuf) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? {
                source: {},
              },
              skipped: true,
            });
            continue;
          }

          const diff = pixelDiffScore({
            sourceBuffer: sourceBuf,
            generatedBuffer: generatedBuf,
          });
          // Dimension mismatch is a persisted row REASON (issues jsonb),
          // never a synthetic score — pixel_diff carries the measured ratio.
          const issues = diff.sizeMismatch ? [sizeMismatchIssue(diff.heightDeltaPx)] : [];
          rows.push({
            page_inventory_id: page.id,
            score: diff.score,
            pixel_diff: diff.diffRatio,
            issues,
            generated_screenshot_paths: generated!.generatedScreenshotPaths,
            skipped: false,
          });
          candidates.push({ pageInventoryId: page.id, diffRatio: diff.diffRatio });
          visionMeta.set(page.id, {
            rowIndex: rows.length - 1,
            pixelScore: diff.score,
            sourcePath,
            generatedPath,
            routePath: page.route_path,
          });
        }

        // ── Phase B: spend the vision cap on the worst measured pages ───
        for (const pageId of selectVisionPages(candidates)) {
          const meta = visionMeta.get(pageId);
          if (!meta) continue;
          const row = rows[meta.rowIndex];
          try {
            const [sourceBuf, generatedBuf] = await Promise.all([
              downloadBucket(supabase, meta.sourcePath),
              downloadBucket(supabase, meta.generatedPath),
            ]);
            const vision = await visionScore({
              pixelDiffScore: meta.pixelScore,
              sourceBuffer: sourceBuf ?? undefined,
              generatedBuffer: generatedBuf ?? undefined,
              routePath: meta.routePath,
              // blockNames deliberately unwired (optional): grounded
              // block-level attribution needs the page's block inventory —
              // wire it in Phase 7.1 alongside the real call.
            });
            row.score = vision.score;
            row.issues = [...row.issues, ...vision.issues];
          } catch (err) {
            // Fail-soft skeleton for the Phase 7.1 real call: the page keeps
            // its pixel-derived score and the row records why vision skipped.
            row.issues = [
              ...row.issues,
              visionUnavailableIssue(err instanceof Error ? err.message : String(err)),
            ];
          }
        }
        return rows;
      });
```

- [ ] Run: `pnpm typecheck` — expect clean.
- [ ] Run: `pnpm test` — expect the full suite green (no worker unit tests exist; this proves no compile/type/pin regressions).
- [ ] Behavioral deltas to note in the commit body (all intended): (1) sizeMismatch pages now persist measured `pixel_diff`/`score` instead of 0.5/0.5 — `fidelity_avg` will shift vs. historical builds; (2) vision allocation is worst-first instead of DB-order; (3) flagged rows can now carry issues even while `visionScore` is a stub (the size-mismatch reason).
- [ ] Commit:
```
git add apps/web/lib/inngest/functions/verify-fidelity.ts
git commit -m "feat(verify): two-phase vision allocation, measured mismatch persistence, per-page fail-soft"
```

---

### Task 4: Pure zero-spend detector for smoke verification

**Why:** Both smoke scripts print "Cost: $0" claims based on the SCRIPT's env, but `MockModelClient` is controlled by the Inngest/Next dev-server's env (`smoke-generate-components.ts:73-87`). A stale worker silently turns a "dry run" into live spend with a green PASS. Token telemetry in the DB is the ground truth; the detector that inspects it must be pure and tested.

**Files:**
- Create: `apps/web/scripts/lib/zero-spend.ts`
- Test: `apps/web/scripts/lib/zero-spend.test.ts` (vitest already includes `scripts/**/*.test.ts` per `apps/web/vitest.config.ts:7`)

**Steps:**

- [ ] Create `apps/web/scripts/lib/zero-spend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findNonZeroSpend, type SpendRow } from "./zero-spend";

describe("findNonZeroSpend", () => {
  it("returns [] when every token column is zero or null", () => {
    const rows: SpendRow[] = [
      { label: "core/cover", tokens: [0, 0, 0, 0] },
      { label: "core/paragraph", tokens: [null, null, null, null] }, // passthrough rows never write tokens
      { label: "header", tokens: [0, null, 0, 0] },
    ];
    expect(findNonZeroSpend(rows)).toEqual([]);
  });

  it("returns exactly the rows with any positive token count", () => {
    const hot: SpendRow = { label: "core/cover", tokens: [0, 1432, 0, 812] };
    const rows: SpendRow[] = [
      { label: "core/paragraph", tokens: [0, 0, 0, 0] },
      hot,
    ];
    expect(findNonZeroSpend(rows)).toEqual([hot]);
  });

  it("treats negative values as not-spend (defensive against bad telemetry)", () => {
    expect(findNonZeroSpend([{ label: "x", tokens: [-5, null] }])).toEqual([]);
  });
});
```

- [ ] Run: `pnpm test scripts/lib/zero-spend.test.ts` — expect failure: `Cannot find module './zero-spend'`.

- [ ] Create `apps/web/scripts/lib/zero-spend.ts`:

```ts
/**
 * zero-spend.ts — pure detector behind the smoke scripts' "verified Cost: $0"
 * invariant (AI-call optimization campaign, Phase 7).
 *
 * Mock mode (JAB_GENERATE_MOCK=1) writes zero-token telemetry by design
 * (MockModelClient). The flag that actually controls the worker lives in the
 * Inngest/Next dev server's process env — NOT the smoke script's — so the
 * scripts verify the claim against the DB telemetry instead of trusting
 * their own env.
 */

export interface SpendRow {
  /** Human label for the offending row (block_name or shell_kind). */
  label: string;
  /** Token-count columns; null = column never written (passthrough/skipped rows). */
  tokens: Array<number | null>;
}

/** Rows that recorded real token spend (any strictly-positive count). */
export function findNonZeroSpend(rows: SpendRow[]): SpendRow[] {
  return rows.filter((r) => r.tokens.some((t) => typeof t === "number" && t > 0));
}
```

- [ ] Run: `pnpm test scripts/lib/zero-spend.test.ts` — expect PASS.
- [ ] Commit:
```
git add apps/web/scripts/lib/zero-spend.ts apps/web/scripts/lib/zero-spend.test.ts
git commit -m "feat(smoke): pure zero-spend detector for mock-mode verification"
```

---

### Task 5: Wire the verified-$0 assertion into smoke-generate-components and smoke-build

**Files:**
- Modify: `apps/web/scripts/smoke-generate-components.ts` (imports ~line 34; insertion after the compile summary / WARN block, lines 183-195)
- Modify: `apps/web/scripts/smoke-build.ts` (imports ~line 27; insertion inside the `data.status === "ready"` branch, lines 179-186, before `process.exit(0)`)
- Create/extend: `apps/web/scripts/lib/script-source-pins.test.ts`

> Scripts execute `main()` on import, so they cannot be imported by unit tests. The wiring is pinned by source-text assertions (the only cheap guard for run-on-import scripts) plus the tested pure helper from Task 4.

**Token columns (verified):** `block_inventory.input_tokens_cached / input_tokens_uncached / output_tokens` (migration `0014_saas_v2_schema.sql:180-182`) + `input_tokens_cache_creation` (Phase 1 migration `0034_ai_cost_telemetry.sql`); `shell_generations` has the same four (`0021_shell_generations.sql:21-23` + 0034). **Migration 0034 must be applied to the target Supabase project before a mock smoke runs this assertion** — see Risks.

**Steps:**

- [ ] Create `apps/web/scripts/lib/script-source-pins.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs with cwd = apps/web (vitest.config.ts lives there).
function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("smoke zero-spend wiring (scripts run main() on import — pin by source)", () => {
  it("smoke-generate-components verifies block_inventory token columns in mock mode", () => {
    const s = src("scripts/smoke-generate-components.ts");
    expect(s).toContain("findNonZeroSpend");
    expect(s).toContain("input_tokens_cache_creation");
  });

  it("smoke-build verifies block_inventory AND shell_generations token columns in mock mode", () => {
    const s = src("scripts/smoke-build.ts");
    expect(s).toContain("findNonZeroSpend");
    expect(s).toContain("shell_generations");
    expect(s).toContain("input_tokens_cache_creation");
  });
});
```

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts` — expect both tests FAIL (strings absent).

- [ ] In `apps/web/scripts/smoke-generate-components.ts` add the import after the existing imports (line 37, after `import { resolve } from "node:path";`):

```ts
import { findNonZeroSpend } from "./lib/zero-spend";
```

  Then insert the verification AFTER the compile-summary/WARN block (after line 195, the `forEach` printing failed blocks — and BEFORE the Storage listing at line 197):

```ts
  // Mock-mode invariant: the DRY RUN banner promised "Cost: $0". Verify it
  // against the DB — the flag that actually controls MockModelClient is the
  // Inngest dev server's process env, not this script's, so a stale worker
  // silently turns a "dry run" into live spend. Token telemetry is ground truth.
  if (mockMode) {
    const { data: spendRows, error: spendErr } = await supabase
      .from("block_inventory")
      .select(
        "block_name, input_tokens_cached, input_tokens_uncached, input_tokens_cache_creation, output_tokens",
      )
      .eq("site_build_id", buildId)
      .eq("project_id", projectId);
    if (spendErr) {
      console.error(`[smoke] FAIL: zero-spend verification query failed: ${spendErr.message}`);
      process.exit(1);
    }
    const nonZero = findNonZeroSpend(
      (spendRows ?? []).map((r) => ({
        label: r.block_name as string,
        tokens: [
          r.input_tokens_cached,
          r.input_tokens_uncached,
          r.input_tokens_cache_creation,
          r.output_tokens,
        ] as Array<number | null>,
      })),
    );
    if (nonZero.length > 0) {
      console.error("[smoke] FAIL: DRY RUN claimed Cost: $0 but block_inventory recorded real token spend:");
      nonZero.forEach((r) => console.error(`  - ${r.label}: tokens=${JSON.stringify(r.tokens)}`));
      console.error(
        "[smoke] The WORKER process is live. JAB_GENERATE_MOCK=1 must be set in the Inngest/Next dev server's env — restart `pnpm dev` after editing .env.local.",
      );
      process.exit(1);
    }
    console.log("[smoke] verified Cost: $0 — all block_inventory token columns are zero/null.");
  }
```

- [ ] In `apps/web/scripts/smoke-build.ts` add the same import after line 30 (`import { resolve } from "node:path";`):

```ts
import { findNonZeroSpend } from "./lib/zero-spend";
```

  Then modify the `ready` branch (lines 179-186). Replace:

```ts
    if (data.status === "ready") {
      console.log(
        `[smoke:build] PASS — ready in ${Math.round(
          (Date.now() - start) / 1000,
        )}s; preview=${data.preview_url} fidelity=${data.fidelity_avg ?? "n/a"} pages=${data.page_count} blocks=${data.block_type_count} components=${data.component_count}`,
      );
      process.exit(0);
    }
```

  with:

```ts
    if (data.status === "ready") {
      console.log(
        `[smoke:build] PASS — ready in ${Math.round(
          (Date.now() - start) / 1000,
        )}s; preview=${data.preview_url} fidelity=${data.fidelity_avg ?? "n/a"} pages=${data.page_count} blocks=${data.block_type_count} components=${data.component_count}`,
      );
      // Mock-mode invariant: verify "Cost: $0" against block_inventory AND
      // shell_generations telemetry. The worker's env (not this script's)
      // controls MockModelClient, so the DB is the only trustworthy signal.
      if (process.env.JAB_GENERATE_MOCK === "1") {
        const [{ data: blockRows, error: blockErr }, { data: shellRows, error: shellErr }] =
          await Promise.all([
            supabase
              .from("block_inventory")
              .select(
                "block_name, input_tokens_cached, input_tokens_uncached, input_tokens_cache_creation, output_tokens",
              )
              .eq("site_build_id", buildId)
              .eq("project_id", projectId),
            supabase
              .from("shell_generations")
              .select(
                "shell_kind, input_tokens_cached, input_tokens_uncached, input_tokens_cache_creation, output_tokens",
              )
              .eq("site_build_id", buildId),
          ]);
        if (blockErr || shellErr) {
          console.error(
            `[smoke:build] FAIL: zero-spend verification query failed: ${blockErr?.message ?? shellErr?.message}`,
          );
          process.exit(1);
        }
        const nonZero = findNonZeroSpend([
          ...(blockRows ?? []).map((r) => ({
            label: `block_inventory:${r.block_name}`,
            tokens: [
              r.input_tokens_cached,
              r.input_tokens_uncached,
              r.input_tokens_cache_creation,
              r.output_tokens,
            ] as Array<number | null>,
          })),
          ...(shellRows ?? []).map((r) => ({
            label: `shell_generations:${r.shell_kind}`,
            tokens: [
              r.input_tokens_cached,
              r.input_tokens_uncached,
              r.input_tokens_cache_creation,
              r.output_tokens,
            ] as Array<number | null>,
          })),
        ]);
        if (nonZero.length > 0) {
          console.error("[smoke:build] FAIL: mock run recorded real token spend:");
          nonZero.forEach((r) => console.error(`  - ${r.label}: tokens=${JSON.stringify(r.tokens)}`));
          console.error(
            "[smoke:build] The WORKER process is live. Restart `pnpm dev` after setting JAB_GENERATE_MOCK=1 in .env.local.",
          );
          process.exit(1);
        }
        console.log("[smoke:build] verified Cost: $0 — block_inventory + shell_generations token columns all zero/null.");
      }
      process.exit(0);
    }
```

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts` — expect PASS.
- [ ] Sanity: `pnpm tsx scripts/smoke-build.ts` (no args) — expect the usage error and exit 1 (proves the new import graph loads; `scripts/lib/zero-spend.ts` is pure).
- [ ] Commit:
```
git add apps/web/scripts/smoke-generate-components.ts apps/web/scripts/smoke-build.ts apps/web/scripts/lib/script-source-pins.test.ts
git commit -m "feat(smoke): verified Cost:\$0 - mock smokes fail when token telemetry is non-zero"
```

---

### Task 6: Spend banner for smoke-compose-site + pipeline-continues notes

**Why:** `smoke-compose-site.ts` has no spend banner at all and its header cost note (line 9) is stale on three counts (mockable via `JAB_GENERATE_MOCK`, skippable via `JAB_SKIP_SHELL_REGEN`, doubled on compile-gate retry). Both `smoke-generate-components` (exits at `composing`, lines 153-157) and `smoke-compose-site` (exits at `building`, line 98) report PASS while the dispatched pipeline keeps spending (compose shells / Vercel deploy / verify).

**Files:**
- Create: `apps/web/scripts/lib/smoke-banners.ts`
- Test: `apps/web/scripts/lib/smoke-banners.test.ts`
- Modify: `apps/web/scripts/smoke-compose-site.ts` (imports ~line 11; banner before the dispatch at line 78; note after line 136), `apps/web/scripts/smoke-generate-components.ts` (note before the final PASS at line 208)
- Extend: `apps/web/scripts/lib/script-source-pins.test.ts`

**Steps:**

- [ ] Create `apps/web/scripts/lib/smoke-banners.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spendModeBanner, pipelineContinuesNote } from "./smoke-banners";

describe("spendModeBanner", () => {
  it("mock mode states $0 and the dual-process caveat", () => {
    const lines = spendModeBanner({ mockMode: true, skipShellRegen: false }).join("\n");
    expect(lines).toContain("DRY RUN");
    expect(lines).toContain("JAB_GENERATE_MOCK=1");
    expect(lines).toContain("restart `pnpm dev`");
    expect(lines).toContain("$0");
  });

  it("live mode states the cost and offers both zero-cost paths", () => {
    const lines = spendModeBanner({ mockMode: false, skipShellRegen: false }).join("\n");
    expect(lines).toContain("LIVE RUN");
    expect(lines).toContain("JAB_GENERATE_MOCK=1");
    expect(lines).toContain("JAB_SKIP_SHELL_REGEN");
  });

  it("live mode with JAB_SKIP_SHELL_REGEN active says the shell calls are skipped", () => {
    const lines = spendModeBanner({ mockMode: false, skipShellRegen: true }).join("\n");
    expect(lines).toContain("JAB_SKIP_SHELL_REGEN=1");
    expect(lines).toContain("skipped");
  });
});

describe("pipelineContinuesNote", () => {
  it("after components: names the shell calls + deploy that still run", () => {
    const note = pipelineContinuesNote("components");
    expect(note).toContain("pipeline continues (compose shells + deploy)");
    expect(note).toContain("AFTER this PASS");
  });

  it("after compose: names the deploy + verify that still run", () => {
    const note = pipelineContinuesNote("compose");
    expect(note).toContain("pipeline continues (deploy + verify)");
    expect(note).toContain("AFTER this PASS");
  });
});
```

- [ ] Run: `pnpm test scripts/lib/smoke-banners.test.ts` — expect failure: `Cannot find module './smoke-banners'`.

- [ ] Create `apps/web/scripts/lib/smoke-banners.ts`:

```ts
/**
 * smoke-banners.ts — pure text builders for the smoke scripts' operator
 * cost signaling (AI-call optimization campaign, Phase 7).
 *
 * Kept pure (no env reads, no I/O) so the wording is unit-tested; the
 * scripts read their own env and pass flags in.
 */

export function spendModeBanner(opts: { mockMode: boolean; skipShellRegen: boolean }): string[] {
  if (opts.mockMode) {
    return [
      "[smoke] DRY RUN — JAB_GENERATE_MOCK=1 detected in this script's env.",
      "[smoke] MockModelClient is controlled by the Inngest/Next dev server's process env, not this script's — restart `pnpm dev` after editing .env.local.",
      "[smoke] Expected cost: $0 (shell LLM calls mocked).",
    ];
  }
  return [
    "[smoke] LIVE RUN — Header + Footer fire real Sonnet-tier calls (~$0.08; x2 if the compile gate retries).",
    "[smoke] Set JAB_GENERATE_MOCK=1 in .env.local (and restart `pnpm dev`) for a zero-cost dry run.",
    opts.skipShellRegen
      ? "[smoke] JAB_SKIP_SHELL_REGEN=1 — existing Header.tsx/Footer.tsx are reused; both shell LLM calls are skipped ($0)."
      : "[smoke] Tip: JAB_SKIP_SHELL_REGEN=1 reuses the build's existing Header.tsx/Footer.tsx and skips both shell LLM calls on a re-compose.",
  ];
}

export function pipelineContinuesNote(after: "components" | "compose"): string {
  return after === "components"
    ? "[smoke] NOTE: pipeline continues (compose shells + deploy) AFTER this PASS — 2 Sonnet-tier shell calls, a Vercel deploy, and the verify pass still run. Watch /projects/<id>/builds/<buildId>/progress before re-running."
    : "[smoke] NOTE: pipeline continues (deploy + verify) AFTER this PASS — a Vercel deploy and the verify pass still run. Watch /projects/<id>/builds/<buildId>/progress before re-running.";
}
```

- [ ] Run: `pnpm test scripts/lib/smoke-banners.test.ts` — expect PASS.

- [ ] Extend `apps/web/scripts/lib/script-source-pins.test.ts` with:

```ts
describe("smoke banner / continuation wiring", () => {
  it("smoke-compose-site prints the spend-mode banner and mentions JAB_SKIP_SHELL_REGEN", () => {
    const s = src("scripts/smoke-compose-site.ts");
    expect(s).toContain("spendModeBanner");
    expect(s).toContain("JAB_SKIP_SHELL_REGEN");
    expect(s).toContain("pipelineContinuesNote");
  });

  it("smoke-generate-components prints the pipeline-continues note", () => {
    expect(src("scripts/smoke-generate-components.ts")).toContain("pipelineContinuesNote");
  });
});
```

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts` — expect the two new tests FAIL.

- [ ] Wire `apps/web/scripts/smoke-compose-site.ts`:
  - After the imports (line 14, `import { resolve } from "node:path";`) add:
    ```ts
    import { spendModeBanner, pipelineContinuesNote } from "./lib/smoke-banners";
    ```
  - Update the stale header comment (lines 8-9) to:
    ```ts
    // Prereqs: Inngest dev + Next dev running, .env.local has
    // SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, ANTHROPIC_API_KEY.
    // Spend: Header + Footer are Sonnet-tier (~$0.08, x2 on compile-gate retry);
    // JAB_GENERATE_MOCK=1 mocks them to $0; JAB_SKIP_SHELL_REGEN=1 reuses
    // existing shells on a re-compose ($0). The banner below states the mode.
    ```
  - Immediately before the dispatch log (line 78, `console.log(`[smoke] dispatching site/compose.requested for build ${buildId}…`);`) insert:
    ```ts
      const mockMode = process.env.JAB_GENERATE_MOCK === "1";
      const skipShellRegen =
        process.env.JAB_SKIP_SHELL_REGEN === "1" || process.env.JAB_SKIP_SHELL_REGEN === "true";
      for (const line of spendModeBanner({ mockMode, skipShellRegen })) console.log(line);
    ```
  - After the final `console.log(`[smoke] PASS — Phase C smoke complete.`);` (line 136) add:
    ```ts
      console.log(pipelineContinuesNote("compose"));
    ```

- [ ] Wire `apps/web/scripts/smoke-generate-components.ts`: extend the Task-5 import line to:
    ```ts
    import { findNonZeroSpend } from "./lib/zero-spend";
    import { pipelineContinuesNote } from "./lib/smoke-banners";
    ```
    and immediately before `console.log("\n[smoke] PASS — Phase B smoke complete.");` (line 208 pre-Task-5; locate by the PASS string) add:
    ```ts
    console.log(pipelineContinuesNote("components"));
    ```

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts scripts/lib/smoke-banners.test.ts` — expect PASS.
- [ ] Sanity: `pnpm tsx scripts/smoke-compose-site.ts` (no args) — expect the usage error and exit 1 (import graph loads).
- [ ] Commit:
```
git add apps/web/scripts/lib/smoke-banners.ts apps/web/scripts/lib/smoke-banners.test.ts apps/web/scripts/smoke-compose-site.ts apps/web/scripts/smoke-generate-components.ts apps/web/scripts/lib/script-source-pins.test.ts
git commit -m "feat(smoke): spend-mode banner for compose smoke + pipeline-continues notes"
```

---

### Task 7: Make the script-imported pure modules importable under tsx (drop `server-only`)

**Why (verified empirically):** `server-only` is NOT in `apps/web/package.json` — Next's bundler aliases it internally, so under `tsx` any transitive import fails with `Cannot find package 'server-only' imported from ...` (reproduced against `lib/ai/shell-prompts.ts`). The de-fork (Task 9) needs five modules script-side; all five are pure:

| Module | Runtime imports besides `server-only` | Why safe without the marker |
|---|---|---|
| `lib/ai/shell-prompts.ts` (line 1) | none (`ThemeJsonTokens` import is type-only) | Pure string/prompt builders, no secrets. (Contract-sanctioned removal.) |
| `lib/ai/generated-tsx-postprocess.ts` (line 1) | `@/lib/jab/import-rewrite` — itself deliberately server-only-free ("no `server-only`… allows unit testing", import-rewrite.ts:7-8) | Pure text transforms. |
| `lib/ai/model.ts` (line 1) | none | Pure env-var → model-ID resolution; model IDs aren't secrets. **Phase 1 rewrites this file — re-verify the line before editing.** |
| `lib/jab/global-styles.ts` (line 1) | none (`GlobalStylesResponse` import is type-only; `ScrapedBrandTokens` is defined in-file at line 70) | Pure token distillation. |
| `lib/ai/client.ts` (line 1) | `@anthropic-ai/sdk` | Key is read from `process.env` at CALL time; in a client bundle the var is absent → `getAnthropicClient()` throws loudly. No secret can be inlined. Removal is what lets scripts honor the campaign rule "NEVER `new Anthropic()` outside client.ts". |

`lib/jab/sanitize-shell-dom.ts` (created pure by Phase 2) is included in the pin so it never grows the marker.

**Files:**
- Modify: the five modules above (line 1 of each)
- Create: `apps/web/lib/ai/script-importable.test.ts`

**Steps:**

- [ ] Re-verify current markers: `grep -n "server-only" apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/generated-tsx-postprocess.ts apps/web/lib/ai/model.ts apps/web/lib/jab/global-styles.ts apps/web/lib/ai/client.ts apps/web/lib/jab/sanitize-shell-dom.ts` — expect a line-1 hit in the first five and none in sanitize-shell-dom (Phase 2 created it pure). If Phase 1/2 already removed any, skip that file's edit.

- [ ] Create `apps/web/lib/ai/script-importable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Operator scripts (scripts/debug-shell-llm.ts) import these modules under
 * tsx, where the `server-only` marker package is unresolvable (it is not
 * installed — Next's bundler aliases it). Re-adding the marker to any of
 * them silently re-breaks the debug tooling, so pin its absence here.
 */
const SCRIPT_IMPORTED_PURE_MODULES = [
  "lib/ai/shell-prompts.ts",
  "lib/ai/generated-tsx-postprocess.ts",
  "lib/ai/model.ts",
  "lib/jab/global-styles.ts",
  "lib/ai/client.ts",
  "lib/jab/sanitize-shell-dom.ts",
];

describe("script-importable modules carry no server-only marker", () => {
  for (const rel of SCRIPT_IMPORTED_PURE_MODULES) {
    it(rel, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/import\s+"server-only"/);
    });
  }
});
```

- [ ] Run: `pnpm test lib/ai/script-importable.test.ts` — expect 5 failures (sanitize-shell-dom passes already).

- [ ] In each of the five modules, replace line 1 (`import "server-only";`) with a module-appropriate comment. Exact replacements:

  `lib/ai/shell-prompts.ts`:
  ```ts
  // NOTE: deliberately NOT "server-only". Pure prompt/string builders with no
  // secrets and no Node APIs — operator scripts (scripts/debug-shell-llm.ts)
  // import this module under tsx, where the server-only marker package is
  // unresolvable (provided by Next's bundler, not node_modules).
  ```

  `lib/ai/generated-tsx-postprocess.ts`:
  ```ts
  // NOTE: deliberately NOT "server-only". Pure text transforms (its dep
  // lib/jab/import-rewrite.ts is server-only-free for the same reason) —
  // imported by scripts/debug-shell-llm.ts under tsx.
  ```

  `lib/ai/model.ts`:
  ```ts
  // NOTE: deliberately NOT "server-only". Pure env-var → model-ID resolution;
  // model IDs are not secrets. Imported by scripts/debug-shell-llm.ts under
  // tsx, where the server-only marker package is unresolvable.
  ```

  `lib/jab/global-styles.ts`:
  ```ts
  // NOTE: deliberately NOT "server-only". Pure token distillation (the only
  // other import is type-only) — imported by scripts/debug-shell-llm.ts.
  ```

  `lib/ai/client.ts`:
  ```ts
  // NOTE: deliberately NOT "server-only", so operator scripts can share the
  // singleton ("never new Anthropic() outside client.ts"). The API key is
  // read from process.env at call time; in a client bundle that var is
  // absent and getAnthropicClient() throws loudly — no secret can leak via
  // bundling.
  ```

- [ ] Run: `pnpm test lib/ai/script-importable.test.ts` — expect PASS.
- [ ] Run the full suite + typecheck (`pnpm test && pnpm typecheck`) — expect green (vitest already mocked `server-only` via `vitest.setup.ts`, so removing it changes nothing for existing tests; server consumers are unaffected because the marker has no runtime behavior under Next).
- [ ] Empirical check: `pnpm tsx -e "import('@/lib/ai/shell-prompts').then(m=>console.log('LOAD_OK')).catch(e=>{console.error('LOAD_FAIL',e.message);process.exit(1)})"` — expect `LOAD_OK` (this was `LOAD_FAIL: Cannot find package 'server-only'` before).
- [ ] Commit:
```
git add apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/generated-tsx-postprocess.ts apps/web/lib/ai/model.ts apps/web/lib/jab/global-styles.ts apps/web/lib/ai/client.ts apps/web/lib/ai/script-importable.test.ts
git commit -m "chore(scripts): make pure prompt/model modules importable from tsx scripts (drop server-only)"
```

---

### Task 8: Re-home `MAX_SHELL_BYTES` + add `SHELL_MAX_TOKENS` (shared constants the debug tool can import)

**Why:** `MAX_SHELL_BYTES = 24_000` is a non-exported const inside `generate-shell.ts` (pre-campaign line 43), and `generate-shell.ts` stays `server-only` (it imports `validateTsx` from the worker-heavy `component-generator.ts`) — so the debug script cannot import the cap from there. The script's fork pinned the RETIRED `12_000` cap (`debug-shell-llm.ts:268`), printing false "OVER CAP" verdicts for outputs production accepts. The max_tokens literal (8192 at `debug-shell-llm.ts:254`) has the same drift problem.

**Files:**
- Modify: `apps/web/lib/ai/shell-prompts.ts` (post-Task-7), `apps/web/lib/ai/generate-shell.ts`
- Test: `apps/web/lib/ai/shell-prompts.test.ts`

**Steps:**

- [ ] Re-verify current state (Phase 2 rewrote generate-shell.ts): `grep -n "MAX_SHELL_BYTES" apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/shell-prompts.ts` — expect a `const MAX_SHELL_BYTES = 24_000;` definition in generate-shell.ts (pre-campaign line 43; Phase 2 may have shifted it) and no hit in shell-prompts.ts. If Phase 2 already exported it from shell-prompts.ts, skip the move and only add `SHELL_MAX_TOKENS`.

- [ ] Add to `apps/web/lib/ai/shell-prompts.test.ts` (append a describe block; add `MAX_SHELL_BYTES, SHELL_MAX_TOKENS` to the file's import from `./shell-prompts`):

```ts
describe("shared shell constants (single source for worker + debug script)", () => {
  it("MAX_SHELL_BYTES is the 24KB evidence-driven cap", () => {
    expect(MAX_SHELL_BYTES).toBe(24_000);
  });

  it("SHELL_MAX_TOKENS matches the visual-tier ceiling shells run with", () => {
    expect(SHELL_MAX_TOKENS).toBe(8192);
  });
});
```

- [ ] Run: `pnpm test lib/ai/shell-prompts.test.ts` — expect failure (`does not provide an export named 'MAX_SHELL_BYTES'`).

- [ ] In `apps/web/lib/ai/shell-prompts.ts`, add near the top (after the imports/types, before `extractThemeClassNames`) — move the 24KB rationale docblock verbatim from generate-shell.ts along with the constant:

```ts
/**
 * Size cap for an emitted shell component (post code-fence strip, post
 * origin-link rewrite).
 *
 * Originally 12KB based on a "typical" shell estimate. Bumped to 24KB after
 * validating against Two Roads (build 982f0d57): the high-fidelity footer
 * came in at 14.8KB — driven by 7 inline social SVG icons, 5-column nav
 * grid, 3 physical addresses, and a legal bar. The output had 0 TS
 * diagnostics — it was rejected purely on size, then replaced by the
 * deterministic fallback. That's a quality regression, not a safety win.
 *
 * Lives here (not generate-shell.ts) so operator tooling
 * (scripts/debug-shell-llm.ts) imports the SAME cap production enforces —
 * the debug fork previously pinned the retired 12KB cap and reported false
 * "OVER CAP" verdicts.
 */
export const MAX_SHELL_BYTES = 24_000;

/**
 * max_tokens for shell generations — mirrors the visual-tier ceiling the
 * compose worker's ModelClient runs shells with. Shared so the debug script
 * cannot drift from production. ~32KB worst-case output keeps MAX_SHELL_BYTES
 * meaningful as a runaway-generation flag.
 */
export const SHELL_MAX_TOKENS = 8192;
```

- [ ] In `apps/web/lib/ai/generate-shell.ts`: delete the local `const MAX_SHELL_BYTES = 24_000;` and its (now moved) docblock, and add `MAX_SHELL_BYTES` to the existing import from `./shell-prompts` (pre-campaign lines 5-10):

```ts
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  MAX_SHELL_BYTES,
  type ShellMenu,
} from "./shell-prompts";
```

  (All uses inside `generateShell` — the over-cap check at pre-campaign lines 164-165 — are unchanged.)

- [ ] Run: `pnpm test lib/ai/shell-prompts.test.ts lib/ai/generate-shell.test.ts` — expect PASS (behavior byte-identical; only the constant's home moved).
- [ ] Run: `pnpm typecheck` — expect clean.
- [ ] Commit:
```
git add apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/shell-prompts.test.ts apps/web/lib/ai/generate-shell.ts
git commit -m "refactor(shell): re-home MAX_SHELL_BYTES + add SHELL_MAX_TOKENS to shell-prompts"
```

---

### Task 9: De-fork debug-shell-llm — production prompts, production gate, production model resolution

**Why (audit-verified drift):** the script's hand-copied builders omit the theme-class inventory + EITHER/OR rule, the computed shellColors section, the sourceHost internal-links rule, the width contract, and emit slug-only tokens vs production's slug+hex pairs (`debug-shell-llm.ts:65-95` vs `shell-prompts.ts:65-172`); its cap is the retired `12_000` (`debug-shell-llm.ts:268`) vs production's 24,000; it skips `postprocessGeneratedTsx` and the `rewriteWpOriginUrls` pass entirely; it hardcodes `"claude-sonnet-4-6"` (`debug-shell-llm.ts:249`) and constructs `new Anthropic()` directly (`debug-shell-llm.ts:248`); its line-311 "would have passed" verdict ignores the cap and postprocess legs. Every ~$0.05 run tests a different prompt and a different gate than production.

**Files:**
- Modify: `apps/web/scripts/debug-shell-llm.ts` (full rewrite below)
- Extend: `apps/web/scripts/lib/script-source-pins.test.ts`

**Pre-flight (Phase 2 landed before this task — verify its exact shapes):**

- [ ] `grep -n "export function headerPrompt\|export function footerPrompt" apps/web/lib/ai/shell-prompts.ts` and confirm the post-Phase-2 return type is `{ system: string; user: string }` (CONTRACTS, Phase 2). If the builders still return a single sentinel-joined string, STOP — Phase 2 has not executed; this task depends on it.
- [ ] `grep -n "sanitizeShellDom" apps/web/lib/ai/generate-shell.ts apps/web/lib/jab/sanitize-shell-dom.ts apps/web/lib/jab/capture-theme-stylesheets.ts` — note WHERE production applies it and with what `maxBytes`:
  - If `generate-shell.ts` calls `sanitizeShellDom(shellDom, N)` before prompting → keep the `sanitizeShellDom(rawShellDom, N)` call in the script below, using the same `N`.
  - If sanitization happens at capture time only (capture-theme-stylesheets) → DELETE the `sanitizeShellDom` import + call from the script below and pass `rawShellDom` directly (the stored `design_tokens.shellDom` is then already what production prompts with).
- [ ] `grep -n "\"shell\"" apps/web/lib/ai/model.ts` — confirm Phase 1 added the `"shell"` task (default `claude-sonnet-4-6`).

**Steps:**

- [ ] Extend `apps/web/scripts/lib/script-source-pins.test.ts` with:

```ts
describe("debug-shell-llm de-fork (paid runs must reproduce production)", () => {
  const script = () => src("scripts/debug-shell-llm.ts");

  it("imports the production prompt builders, postprocess, cap, and model resolution", () => {
    const s = script();
    expect(s).toContain('from "@/lib/ai/shell-prompts"');
    expect(s).toContain("postprocessGeneratedTsx");
    expect(s).toContain("MAX_SHELL_BYTES");
    expect(s).toContain("SHELL_MAX_TOKENS");
    expect(s).toContain('getModelFor("shell")');
    expect(s).toContain("getAnthropicClient");
    expect(s).toContain("rewriteWpOriginUrls");
    expect(s).toContain("resolveThemeTokens");
  });

  it("carries no forked prompt builders, stale cap, sentinel split, or direct SDK construction", () => {
    const s = script();
    expect(s).not.toContain("12_000");
    expect(s).not.toContain("function sharedShellSystemPrompt");
    expect(s).not.toContain("function headerPrompt");
    expect(s).not.toContain("function footerPrompt");
    expect(s).not.toContain("new Anthropic(");
    expect(s).not.toContain("USER:\\n"); // the deleted prompt-sentinel round-trip
  });
});
```

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts` — expect the two new tests FAIL against the current fork.

- [ ] Rewrite `apps/web/scripts/debug-shell-llm.ts` in full:

```ts
// apps/web/scripts/debug-shell-llm.ts
//
// Re-runs a shell (Header or Footer) LLM call with the SAME inputs the
// Phase C worker uses for a given project, captures the raw response, and
// reports the FULL production gate verdict (postprocess → origin rewrite →
// byte cap → TSX parse) — bypassing generate-shell.ts's "discard on
// failure" behaviour.
//
// De-forked 2026-06-10 (AI-call optimization campaign, Phase 7): prompt
// builders, postprocess, size cap, max_tokens, and model resolution are
// IMPORTED from the production modules. Do NOT re-inline production logic
// here — the previous fork drifted (12KB vs 24KB cap, missing prompt
// sections) and misdiagnosed paid runs. scripts/lib/script-source-pins.test.ts
// pins this.
//
// Usage:
//   pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> [header|footer]
//
// Outputs (c:/tmp/shell-debug/<ts>-<kind>/):
//   prompt.md           — the system + user prompt sent to the model
//   response-raw.txt    — the model's text reply, unmodified
//   response-final.tsx  — after postprocess + origin-link rewrite (what production would persist)
//   diagnostics.json    — ts.createSourceFile parseDiagnostics output
//   meta.json           — token usage + stop_reason + model + gate verdict
//
// This is a debug tool, not part of the production worker. It uses the
// real Anthropic API — ~$0.05 per run on the Sonnet-tier shell model.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import * as ts from "typescript";

import {
  headerPrompt,
  footerPrompt,
  extractThemeClassNames,
  MAX_SHELL_BYTES,
  SHELL_MAX_TOKENS,
  type ShellMenu,
  type ShellPromptInput,
} from "@/lib/ai/shell-prompts";
import { postprocessGeneratedTsx } from "@/lib/ai/generated-tsx-postprocess";
import { getModelFor } from "@/lib/ai/model";
import { getAnthropicClient } from "@/lib/ai/client";
import {
  resolveThemeTokens,
  type ThemeJsonTokens,
  type ScrapedBrandTokens,
} from "@/lib/jab/global-styles";
import { rewriteWpOriginUrls, hostVariants } from "@/lib/jab/rewrite-origin-links";
import { sanitizeShellDom } from "@/lib/jab/sanitize-shell-dom";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Local copy of compose-site.ts's non-exported extractPrimaryMenu (verified
// byte-identical behaviour, compose-site.ts:822-836). compose-site.ts is a
// server-only worker module and cannot be imported here. If menus
// persistence lands and compose changes its menu source, update this copy.
function extractPrimaryMenu(manifest: unknown): ShellMenu | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as { menus?: unknown };
  if (!Array.isArray(m.menus) || m.menus.length === 0) return null;
  const first = m.menus[0] as { name?: unknown; items?: unknown };
  if (typeof first.name !== "string" || !Array.isArray(first.items)) return null;
  const items = first.items
    .filter((i): i is { title: string; url: string } => {
      if (!i || typeof i !== "object") return false;
      const o = i as { title?: unknown; url?: unknown };
      return typeof o.title === "string" && typeof o.url === "string";
    })
    .slice(0, 30);
  return { name: first.name, items };
}

// Local parse-level TSX gate. Equivalent check to component-generator.ts's
// validateTsx (same ts.createSourceFile + parseDiagnostics), kept local
// because component-generator.ts is server-only + worker-heavy; this copy
// reports line/character detail the production string-formatter drops.
interface Diagnostic {
  line: number;
  character: number;
  code: number;
  category: string;
  messageText: string;
}

function validateTsx(source: string, fileName: string): Diagnostic[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    return {
      line: pos.line + 1,
      character: pos.character + 1,
      code: d.code,
      category: ts.DiagnosticCategory[d.category],
      messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, kindArg] = process.argv;
  if (!projectId || !tenantId) {
    console.error("Usage: pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> [header|footer]");
    process.exit(1);
  }
  const kind: "header" | "footer" = kindArg === "header" ? "header" : "footer";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  console.log(`[debug-shell] loading project ${projectId} (tenant ${tenantId})…`);
  // Same columns compose-site's load-project step selects (compose-site.ts:239).
  const { data: project, error } = await supabase
    .from("projects")
    .select("name, wp_url, design_tokens, manifest, logo_storage_path")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .single();
  if (error || !project) {
    console.error(`load-project failed: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  // Mirror compose-site.ts's design_tokens decode (compose-site.ts:264-294).
  const designTokens = (project.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens;
    themeStylesheets?: Array<{ css: string }>;
    shellDom?: { header: string | null; footer: string | null };
    shellStyles?: {
      header: { backgroundColor?: string; color?: string } | null;
      footer: { backgroundColor?: string; color?: string } | null;
    };
    personality?: { description?: string | null };
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  const rawShellDom = designTokens.shellDom?.[kind] ?? "";
  if (!rawShellDom) {
    console.error(`No ${kind} DOM captured in design_tokens.shellDom.${kind} — nothing to debug.`);
    process.exit(1);
  }
  // Mirror generate-shell's pre-prompt transform (Phase 2 sanitize pass) —
  // see the plan's pre-flight: the maxBytes here MUST match generate-shell's.
  const shellDom = sanitizeShellDom(rawShellDom, 100_000);

  // Composite token resolution exactly as compose-site does it: prefer
  // themeJson (FSE/block themes), fall back to the scrape-agent's brand
  // inference (classic themes — Two Roads). Reading themeJson alone regresses
  // classic-theme repros to "Colors: (none)".
  const themeTokens = resolveThemeTokens(designTokens.themeJson, {
    colors: designTokens.colors,
    typography: designTokens.typography,
  });

  // Production passes the BUNDLED public logo path, not the storage path
  // (compose-site.ts:610-626). Mirror the filename derivation.
  const logoExt =
    (project.logo_storage_path?.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const logoUrl = project.logo_storage_path ? `/logo.${logoExt}` : null;

  const input: ShellPromptInput = {
    shellDom,
    themeTokens,
    themeClassNames: extractThemeClassNames(designTokens.themeStylesheets ?? []),
    shellColors: designTokens.shellStyles?.[kind] ?? null,
    menu: extractPrimaryMenu(project.manifest),
    logoUrl,
    siteName: project.name,
    siteDescription: designTokens.personality?.description ?? null,
    sourceHost: new URL(project.wp_url).hostname,
  };

  // Post-Phase-2 builders return { system, user } — no sentinel round-trip.
  const { system, user } = kind === "header" ? headerPrompt(input) : footerPrompt(input);
  const model = getModelFor("shell");

  console.log(`[debug-shell] shellDom: ${shellDom.length} chars (raw ${rawShellDom.length})`);
  console.log(`[debug-shell] menu items: ${input.menu?.items.length ?? 0}`);
  console.log(`[debug-shell] system: ${system.length} chars  user: ${user.length} chars`);
  console.log(`[debug-shell] dispatching to ${model} (max_tokens ${SHELL_MAX_TOKENS})…`);

  const sdk = getAnthropicClient();
  const t0 = Date.now();
  // One-shot operator run: no cache_control. A 5-min ephemeral entry could
  // never be re-read by a later manual run, so the write premium is pure
  // waste; the prompt TEXT is identical to production's, so the repro holds.
  const response = await sdk.messages.create({
    model,
    max_tokens: SHELL_MAX_TOKENS,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
  });
  const elapsed = Date.now() - t0;
  console.log(`[debug-shell] response received in ${elapsed}ms (stop_reason=${response.stop_reason})`);

  const rawText = response.content.find((b) => b.type === "text")?.text ?? "";
  const expectedName = kind === "header" ? "Header" : "Footer";
  const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";

  // ── Production gate, in production order (generate-shell.ts):
  //    postprocess → origin-link rewrite → byte cap → TSX parse.
  let finalTsx: string | null = null;
  let postprocessError: string | null = null;
  try {
    finalTsx = postprocessGeneratedTsx(rawText.trim(), { expectedExportName: expectedName });
  } catch (err) {
    postprocessError = err instanceof Error ? err.message : String(err);
  }
  if (finalTsx !== null) {
    // routePathMap omitted: it needs a build's page_inventory; without it the
    // rewriter falls back to plain origin-stripping (same as pre-0033 builds).
    finalTsx = rewriteWpOriginUrls(finalTsx, { sourceHosts: hostVariants(project.wp_url) });
  }
  const sizeRaw = Buffer.byteLength(rawText, "utf8");
  const sizeFinal = finalTsx !== null ? Buffer.byteLength(finalTsx, "utf8") : 0;
  const overCap = finalTsx !== null && sizeFinal > MAX_SHELL_BYTES;
  const diagnostics = finalTsx !== null ? validateTsx(finalTsx, fileName) : [];
  const truncated = response.stop_reason === "max_tokens";
  const wouldPass = postprocessError === null && !overCap && diagnostics.length === 0;

  const ts2 = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `c:/tmp/shell-debug/${ts2}-${kind}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "prompt.md"), `# SYSTEM\n\n${system}\n\n# USER\n\n${user}\n`, "utf8");
  writeFileSync(join(outDir, "response-raw.txt"), rawText, "utf8");
  writeFileSync(join(outDir, "response-final.tsx"), finalTsx ?? "", "utf8");
  writeFileSync(join(outDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8");
  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(
      {
        kind,
        model,
        elapsedMs: elapsed,
        usage: response.usage,
        stopReason: response.stop_reason,
        sizeBytes: { raw: sizeRaw, final: sizeFinal, cap: MAX_SHELL_BYTES, overCap },
        gate: { postprocessError, overCap, truncated, diagnosticsCount: diagnostics.length, wouldPass },
        inputs: {
          shellDomChars: shellDom.length,
          themeClassNames: input.themeClassNames?.length ?? 0,
          menuItems: input.menu?.items.length ?? 0,
          siteName: input.siteName,
          siteDescription: input.siteDescription,
          logoUrl,
          sourceHost: input.sourceHost,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\n[debug-shell] wrote artifacts → ${outDir}`);
  console.log(
    `[debug-shell] raw: ${sizeRaw}B  final: ${sizeFinal}B  (cap ${MAX_SHELL_BYTES}B)${overCap ? "  ⚠ OVER CAP" : ""}`,
  );
  if (truncated) {
    console.log(`[debug-shell] ⚠ stop_reason=max_tokens — output truncated at ${SHELL_MAX_TOKENS} tokens; the gate verdict below reflects a truncated artifact.`);
  }
  if (postprocessError) console.log(`[debug-shell] ✗ postprocess failed: ${postprocessError}`);
  console.log(`[debug-shell] diagnostics: ${diagnostics.length}`);
  for (const d of diagnostics.slice(0, 5)) {
    console.log(`  ${fileName}:${d.line}:${d.character}  TS${d.code} ${d.category}: ${d.messageText}`);
  }
  console.log(
    wouldPass
      ? `[debug-shell] ✓ would have PASSED the production gate (postprocess + cap + parse)`
      : `[debug-shell] ✗ would have FAILED the production gate — postprocess=${postprocessError ? "fail" : "ok"} cap=${overCap ? "over" : "ok"} parse=${diagnostics.length === 0 ? "ok" : `${diagnostics.length} diagnostics`}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

  (Apply the pre-flight decision on `sanitizeShellDom`: keep with production's `maxBytes`, or delete the import + call and use `rawShellDom` directly.)

- [ ] Run: `pnpm test scripts/lib/script-source-pins.test.ts` — expect PASS (all de-fork pins).
- [ ] Module-graph check (no args; imports are evaluated before the argv guard, so this proves Task 7's removals + the `@/` alias resolve under tsx — verified working with tsx 4.19 in this repo): `pnpm tsx scripts/debug-shell-llm.ts` — expect exactly the usage error and exit code 1, NO `Cannot find package 'server-only'`.
- [ ] Run the full suite once more: `pnpm test && pnpm typecheck` — expect green.
- [ ] OPTIONAL paid verification (operator judgment, ~$0.05): run against the Two Roads pilot project, `pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> footer`, and confirm `meta.json` reports `cap: 24000` and the prompt.md contains the width-contract + slug+hex token sections (the previously-missing production sections).
- [ ] Commit:
```
git add apps/web/scripts/debug-shell-llm.ts apps/web/scripts/lib/script-source-pins.test.ts
git commit -m "fix(scripts): de-fork debug-shell-llm - production prompts, full gate verdict, getModelFor(shell)"
```

---

## Execution risks / notes for the campaign overview

1. **Cross-phase file contention:** Tasks 7–9 edit `model.ts`, `client.ts`, `shell-prompts.ts`, `generate-shell.ts` AFTER Phases 1–2 rewrite them. Every such task opens with a re-verification grep; line refs for those files in this plan are pre-campaign. Phase 7 must execute after Phases 1 and 2 are merged.
2. **Migration 0034 ordering:** the zero-spend assertions select `input_tokens_cache_creation`. Running a mock smoke against a Supabase project where 0034 (and the still-pending 0032/0033) haven't been applied fails the SELECT — apply migrations to BOTH projects (local "JAB WP" `ajfurojjxthhzkjqttri`, prod "jab-prod" `celzwcxkrmsbwiswkxug`) first.
3. **Scoring drift vs. history:** after Task 3, size-mismatched pages persist measured scores instead of 0.5/0.5 — `fidelity_avg` on new builds is not comparable to pre-Phase-7 builds, and pages that previously auto-flagged at 0.5 may no longer receive vision slots (intended).
4. **`sanitizeShellDom` integration point** is decided by Phase 2's executed code; Task 9's pre-flight resolves it explicitly (keep-with-same-args or delete-the-call).
5. **Source-text pins are textual** — brittle to benign refactors of the scripts, but scripts run `main()` on import and cannot be imported by tests; the pins are the only cheap regression guard.
