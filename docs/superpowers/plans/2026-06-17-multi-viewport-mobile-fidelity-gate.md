# Multi-Viewport Mobile Fidelity Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score the already-captured 375px (mobile) screenshots alongside 1280px (desktop) in the verify-fidelity pass, persist per-viewport scores, surface desktop + mobile source-vs-generated thumbnails on the review screen, and block publish on catastrophic mobile failures — without changing component generation.

**Architecture:** All real logic lands in pure, unit-tested helpers in `fidelity-score.ts` and a new `review-thumbnails.ts`; the Inngest worker (`verify-fidelity.ts`), the Playwright capture (`playwright-verify.ts`), and the review server component (`review/page.tsx`) are thin wiring over those helpers. One additive JSONB column (`fidelity_reports.viewport_scores`) carries the per-viewport breakdown; the existing `score`/`pixel_diff` columns stay canonical-desktop so the publish gate, `fidelity_avg`, and every existing consumer keep working byte-identically. The "gate" reuses the established desktop-404 posture — a catastrophic mobile failure drives the canonical page score to 0 and emits a high-severity issue, so the page lands on the review screen screaming and must be consciously approved-with-issues or rebuilt.

**Tech Stack:** TypeScript, Next.js 15 App Router (RSC server component), Supabase (Postgres + private Storage, signed URLs), Drizzle (schema source of truth), Playwright (capture, not unit-tested), Vitest, pngjs + pixelmatch (pixel diff).

## Global Constraints

- **Two Supabase projects — apply migration 0036 to BOTH.** local/dev = "JAB WP" `ajfurojjxthhzkjqttri` (the `.env.local` target) and prod = "jab-prod" `celzwcxkrmsbwiswkxug`. Application is an operator step performed at merge time (see Task 8), not part of subagent execution. The column is additive with a default, so deployed worker code that writes it must not run against a DB that lacks it — apply 0036 before deploying.
- **No generation changes.** This plan does not touch `component-generator.ts`, `generate-components.ts`, prompts, or the component-batch path. The LLM keeps generating from the 1280 screenshot + desktop computed styles. (Feeding mobile evidence to the LLM is a deliberately-deferred, measured follow-up.)
- **No tablet scoring.** Capture still grabs all three viewports (375 / 768 / 1280) unchanged. Scoring covers `1280` (canonical desktop) + `375` (mobile) only. 768 stays captured-but-unscored.
- **Canonical columns are desktop.** `fidelity_reports.score` / `pixel_diff` remain the 1280 values for every existing consumer (publish gate, `fidelity_avg`, project/dashboard cards). The mobile breakdown lives only in the new `viewport_scores` JSONB and (when catastrophic) in `issues`.
- **Errors are loud; vision/advisory is fail-soft.** A catastrophic mobile failure must surface (high-severity issue + score 0). A *missing* mobile capture is fail-soft — the page keeps its desktop score, records the mobile viewport as skipped, never throws.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test runner:** `pnpm --filter @jab/web test -- <file>` for a single file; full suite is `pnpm --filter @jab/web test`. Typecheck gate is the package's `typecheck` script (`tsc --noEmit`), invoked as `pnpm --filter @jab/web run typecheck`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/web/drizzle/migrations/0036_fidelity_viewport_scores.sql` | Add `fidelity_reports.viewport_scores jsonb NOT NULL DEFAULT '{}'`. | Create |
| `apps/web/lib/db/schema.ts` | Drizzle source of truth — add `viewportScores` column to `fidelityReports`. | Modify |
| `apps/web/lib/ai/fidelity-score.ts` | Pure scoring helpers — viewport-labelled HTTP failure, catastrophic-mobile rule, viewport-scores builder, canonical-score resolver, scored-viewport constant. | Modify |
| `apps/web/lib/ai/fidelity-score.test.ts` | Tests for the new pure helpers. | Modify |
| `apps/web/lib/jab/playwright-verify.ts` | Record HTTP status per scored viewport (not just 1280). | Modify |
| `apps/web/lib/inngest/functions/verify-fidelity.ts` | Score 375 + 1280, assemble `viewport_scores`, apply mobile blocking issues + canonical penalty, persist the new column. | Modify |
| `apps/web/lib/jab/review-thumbnails.ts` | Pure helpers — batch thumbnail-path request builder + per-viewport score picker. | Create |
| `apps/web/lib/jab/review-thumbnails.test.ts` | Tests for the thumbnail helpers. | Create |
| `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx` | Batch-sign + render desktop + mobile thumbnails; show mobile score; select the new column. | Modify |
| `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md` | Mark finding #4 status. | Modify |
| `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` | Mark fleet-gap A6 (desktop-1280-only) progress. | Modify |
| `CLAUDE.md` | Add the snapshot line for this campaign. | Modify |

---

### Task 1: Schema + migration for `viewport_scores`

**Files:**
- Create: `apps/web/drizzle/migrations/0036_fidelity_viewport_scores.sql`
- Modify: `apps/web/lib/db/schema.ts:349-377` (the `fidelityReports` table)
- Test: `apps/web/lib/db/schema.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `fidelityReports.viewportScores` Drizzle column (jsonb, not null, default `{}`). The persisted JSON shape (authored in Task 3 / 5) is:
  ```ts
  // viewport_scores: Record<"375" | "768" | "1280", ViewportScoreEntry>
  interface ViewportScoreEntry {
    score: number | null;      // 1 - diffRatio, or null when skipped
    pixel_diff: number | null; // diffRatio, or null when skipped
    http_status: number | null;
    size_mismatch: boolean;
    height_delta_px: number;
    skipped: boolean;          // true when source/generated capture missing
  }
  ```

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/db/schema.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, it, expect } from "vitest";
import { fidelityReports } from "./schema";

describe("fidelityReports schema", () => {
  it("has a viewport_scores jsonb column", () => {
    // Drizzle exposes columns on the table object keyed by JS property name.
    const col = (fidelityReports as unknown as { viewportScores?: { name: string } }).viewportScores;
    expect(col).toBeDefined();
    expect(col!.name).toBe("viewport_scores");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test -- lib/db/schema.test.ts`
Expected: FAIL — `viewportScores` is undefined.

- [ ] **Step 3: Add the Drizzle column**

In `apps/web/lib/db/schema.ts`, inside the `fidelityReports` table definition, immediately after the `generatedScreenshotPaths` line (currently line 369), add:

```ts
    // Per-viewport fidelity breakdown (migration 0036). Keyed by viewport
    // width as a string: { "1280": {...}, "375": {...} }. The top-level
    // score/pixel_diff columns stay the canonical DESKTOP (1280) values so
    // every existing consumer is unchanged; this carries the mobile axis.
    viewportScores: jsonb("viewport_scores").notNull().default({}),
```

- [ ] **Step 4: Write the migration SQL**

Create `apps/web/drizzle/migrations/0036_fidelity_viewport_scores.sql`:

```sql
-- 0036_fidelity_viewport_scores.sql
-- Multi-viewport mobile fidelity gate: per-viewport score breakdown.
-- Additive + defaulted, so existing rows backfill to an empty object and
-- every existing consumer (publish gate, fidelity_avg, review UI) is
-- unaffected. The canonical score / pixel_diff columns remain the desktop
-- (1280) values.

ALTER TABLE fidelity_reports
  ADD COLUMN IF NOT EXISTS viewport_scores jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `pnpm --filter @jab/web test -- lib/db/schema.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/drizzle/migrations/0036_fidelity_viewport_scores.sql apps/web/lib/db/schema.ts apps/web/lib/db/schema.test.ts
git commit -m "feat(fidelity): add fidelity_reports.viewport_scores column (migration 0036)"
```

---

### Task 2: Catastrophic-mobile rule + viewport-labelled HTTP failure

**Files:**
- Modify: `apps/web/lib/ai/fidelity-score.ts`
- Test: `apps/web/lib/ai/fidelity-score.test.ts`

**Interfaces:**
- Consumes: existing `VisionScoreResult["issues"][number]` issue shape (`{ block_name, severity, description }`).
- Produces:
  - `SCORED_VIEWPORTS: readonly ["1280", "375"]` — the viewports the verify pass pixel-diffs (desktop canonical first).
  - `CATASTROPHIC_MOBILE_DIFF_FLOOR = 0.6`, `CATASTROPHIC_MOBILE_RATIO = 2` — exported constants.
  - `httpFailureRow(status, routePath, viewport?)` — existing signature gains an optional 3rd arg; default keeps current output byte-identical.
  - `mobileDivergenceIssue(desktopDiffRatio, mobileDiffRatio, routePath): VisionScoreResult["issues"][number] | null` — high-severity issue ONLY when mobile is catastrophically worse than desktop; null otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/ai/fidelity-score.test.ts`:

```ts
import {
  SCORED_VIEWPORTS,
  CATASTROPHIC_MOBILE_DIFF_FLOOR,
  CATASTROPHIC_MOBILE_RATIO,
  httpFailureRow,
  mobileDivergenceIssue,
} from "./fidelity-score";

describe("SCORED_VIEWPORTS", () => {
  it("scores desktop (canonical, first) + mobile, not tablet", () => {
    expect(SCORED_VIEWPORTS).toEqual(["1280", "375"]);
  });
});

describe("httpFailureRow viewport label", () => {
  it("is byte-identical to the legacy output when no viewport is passed", () => {
    const row = httpFailureRow(404, "/about");
    expect(row).not.toBeNull();
    expect(row!.issues[0].description).toBe(
      "HTTP 404 loading /about — the deployed page failed to load. Routing or data fetch is broken for this page.",
    );
  });
  it("labels the viewport when one is passed", () => {
    const row = httpFailureRow(500, "/about", "mobile");
    expect(row!.issues[0].severity).toBe("high");
    expect(row!.issues[0].description).toContain("(mobile)");
    expect(row!.issues[0].description).toContain("HTTP 500");
  });
  it("still returns null for a healthy status", () => {
    expect(httpFailureRow(200, "/about", "mobile")).toBeNull();
  });
});

describe("mobileDivergenceIssue (catastrophic-only)", () => {
  it("returns null when mobile is comparable to desktop", () => {
    expect(mobileDivergenceIssue(0.05, 0.08, "/")).toBeNull();
  });
  it("returns null when mobile diff is high but desktop is equally high (whole page is just off)", () => {
    // desktop already bad → desktop flagging owns it; mobile must not double-fire.
    expect(mobileDivergenceIssue(0.55, 0.6, "/")).toBeNull();
  });
  it("returns null below the absolute floor even if relatively worse", () => {
    // 0.4 is 4x worse than 0.1 but under the 0.6 floor → not catastrophic.
    expect(mobileDivergenceIssue(0.1, 0.4, "/")).toBeNull();
  });
  it("fires a high-severity issue when mobile is above the floor AND >=2x desktop", () => {
    const issue = mobileDivergenceIssue(0.1, 0.7, "/menu");
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe("high");
    expect(issue!.block_name).toBe("_page");
    expect(issue!.description).toContain("mobile");
    expect(issue!.description).toContain("/menu");
  });
  it("fires when desktop is perfect (0) and mobile is broken (above floor)", () => {
    // ratio guard must not divide by zero: desktop 0 → only the floor gates.
    expect(mobileDivergenceIssue(0, 0.65, "/")).not.toBeNull();
  });
  it("uses the exported constants as the exact boundary (floor inclusive, ratio inclusive)", () => {
    // exactly at the floor and exactly 2x → fires.
    expect(
      mobileDivergenceIssue(
        CATASTROPHIC_MOBILE_DIFF_FLOOR / CATASTROPHIC_MOBILE_RATIO,
        CATASTROPHIC_MOBILE_DIFF_FLOOR,
        "/",
      ),
    ).not.toBeNull();
    // a hair under the floor → null.
    expect(mobileDivergenceIssue(0, CATASTROPHIC_MOBILE_DIFF_FLOOR - 0.001, "/")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web test -- lib/ai/fidelity-score.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement the helpers**

In `apps/web/lib/ai/fidelity-score.ts`:

Add near the top-level constants (e.g. after `VISION_PER_BUILD_CAP`):

```ts
/**
 * Viewports the verify pass pixel-diffs. Capture still grabs all three
 * (375/768/1280); scoring covers desktop (canonical, FIRST) + mobile only.
 * 768 (tablet) is captured-but-unscored — it rarely diverges from desktop in
 * ways 1280 doesn't already catch, and skipping it halves the diff/download
 * work.
 */
export const SCORED_VIEWPORTS = ["1280", "375"] as const;

/**
 * Catastrophic-mobile thresholds. A mobile page is "catastrophically worse"
 * — almost always overflow / off-canvas / collapsed layout — only when BOTH
 * hold: its pixel divergence clears an absolute FLOOR (so a uniformly-mediocre
 * page doesn't trip it) AND it is at least RATIO times worse than desktop (so
 * a page that's merely globally-off, already owned by desktop scoring, doesn't
 * double-fire). Deliberately conservative: false positives erode trust in the
 * gate, and legitimate mobile reflow can move 30-50% of pixels on a full-page
 * diff without anything being broken.
 */
export const CATASTROPHIC_MOBILE_DIFF_FLOOR = 0.6;
export const CATASTROPHIC_MOBILE_RATIO = 2;
```

Replace the existing `httpFailureRow` function with the viewport-aware version (keeps the no-arg output byte-identical):

```ts
/**
 * Zero-score row for a page whose deployed URL answered 4xx/5xx. A 404
 * previously pixel-scored ~0.5 (dimension-mismatch fallback) and sailed
 * through to 'ready' — the most severe fidelity failure was the least
 * visible one. Score 0 + a high issue makes the review screen block it.
 *
 * `viewport` labels a NON-desktop failure (e.g. "mobile") so a page that
 * loads on desktop but 4xx/5xx on mobile reads correctly. Omitted → the
 * legacy desktop output, byte-identical.
 */
export function httpFailureRow(
  status: number | null | undefined,
  routePath: string,
  viewport?: string,
): { score: 0; issues: Array<{ block_name: string; severity: "high"; description: string }> } | null {
  if (typeof status !== "number" || status < 400) return null;
  const label = viewport ? ` (${viewport})` : "";
  return {
    score: 0,
    issues: [
      {
        block_name: "_page",
        severity: "high",
        description: `HTTP ${status} loading ${routePath}${label} — the deployed page failed to load. Routing or data fetch is broken for this page.`,
      },
    ],
  };
}

/**
 * High-severity issue when the MOBILE render is catastrophically worse than
 * desktop (see CATASTROPHIC_MOBILE_DIFF_FLOOR / _RATIO). Returns null when
 * mobile is comparable, merely mediocre, or only as-bad-as an already-bad
 * desktop. Same posture as httpFailureRow: the caller pairs a non-null return
 * with a canonical score of 0 so the review screen surfaces the breakage.
 */
export function mobileDivergenceIssue(
  desktopDiffRatio: number,
  mobileDiffRatio: number,
  routePath: string,
): VisionScoreResult["issues"][number] | null {
  const aboveFloor = mobileDiffRatio >= CATASTROPHIC_MOBILE_DIFF_FLOOR;
  // Multiplicative form avoids divide-by-zero when desktop is a perfect 0.
  const relativelyWorse = mobileDiffRatio >= desktopDiffRatio * CATASTROPHIC_MOBILE_RATIO;
  if (!aboveFloor || !relativelyWorse) return null;
  return {
    block_name: "_page",
    severity: "high",
    description: `mobile_layout_broken: the deployed page at ${routePath} diverges far more on mobile (375px, ${Math.round(
      mobileDiffRatio * 100,
    )}% pixel diff) than on desktop (${Math.round(
      desktopDiffRatio * 100,
    )}%) — almost always overflow, off-canvas content, or a collapsed responsive layout. Check the page on a phone before approving.`,
  };
}
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm --filter @jab/web test -- lib/ai/fidelity-score.test.ts`
Expected: PASS (including the pre-existing `httpFailureRow` tests, unchanged).
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/fidelity-score.ts apps/web/lib/ai/fidelity-score.test.ts
git commit -m "feat(fidelity): catastrophic-mobile rule + viewport-labelled HTTP failure"
```

---

### Task 3: `buildViewportScores` + `resolveCanonicalScore`

**Files:**
- Modify: `apps/web/lib/ai/fidelity-score.ts`
- Test: `apps/web/lib/ai/fidelity-score.test.ts`

**Interfaces:**
- Consumes: `PixelDiffResult` (existing) and a per-viewport "measured or skipped" shape.
- Produces:
  - `ViewportScoreEntry` interface (see Task 1's shape).
  - `viewportScoreEntry(diff: PixelDiffResult, httpStatus: number | null): ViewportScoreEntry` — maps a measured diff to a persisted entry.
  - `skippedViewportEntry(httpStatus: number | null): ViewportScoreEntry` — the entry for a viewport whose capture was missing.
  - `buildViewportScores(entries: Partial<Record<string, ViewportScoreEntry>>): Record<string, ViewportScoreEntry>` — drops undefined viewports, returns the JSONB-ready object.
  - `resolveCanonicalScore(desktopScore: number, mobileBlocking: boolean): number` — returns 0 when a mobile blocking issue exists, else the desktop score.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/ai/fidelity-score.test.ts`:

```ts
import {
  viewportScoreEntry,
  skippedViewportEntry,
  buildViewportScores,
  resolveCanonicalScore,
  pixelDiffScore,
} from "./fidelity-score";
import { PNG } from "pngjs";

function solidPng(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

describe("viewportScoreEntry / skippedViewportEntry", () => {
  it("maps a measured diff to a persisted entry", () => {
    const diff = pixelDiffScore({
      sourceBuffer: solidPng(10, 10, [0, 0, 0, 255]),
      generatedBuffer: solidPng(10, 10, [0, 0, 0, 255]),
    });
    const entry = viewportScoreEntry(diff, 200);
    expect(entry.score).toBe(1);
    expect(entry.pixel_diff).toBe(0);
    expect(entry.http_status).toBe(200);
    expect(entry.size_mismatch).toBe(false);
    expect(entry.skipped).toBe(false);
  });
  it("marks a skipped viewport with null score and skipped=true", () => {
    const entry = skippedViewportEntry(null);
    expect(entry.score).toBeNull();
    expect(entry.pixel_diff).toBeNull();
    expect(entry.skipped).toBe(true);
  });
});

describe("buildViewportScores", () => {
  it("drops undefined viewports and keeps populated ones", () => {
    const desktop = viewportScoreEntry(
      pixelDiffScore({
        sourceBuffer: solidPng(4, 4, [1, 2, 3, 255]),
        generatedBuffer: solidPng(4, 4, [1, 2, 3, 255]),
      }),
      200,
    );
    const out = buildViewportScores({ "1280": desktop, "375": undefined });
    expect(Object.keys(out)).toEqual(["1280"]);
    expect(out["1280"].score).toBe(1);
  });
});

describe("resolveCanonicalScore", () => {
  it("returns the desktop score when mobile is fine", () => {
    expect(resolveCanonicalScore(0.96, false)).toBe(0.96);
  });
  it("zeroes the canonical score when a mobile blocking issue exists", () => {
    expect(resolveCanonicalScore(0.96, true)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web test -- lib/ai/fidelity-score.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement the helpers**

Append to `apps/web/lib/ai/fidelity-score.ts`:

```ts
/**
 * One viewport's persisted fidelity entry. Lives under
 * fidelity_reports.viewport_scores keyed by viewport width string.
 */
export interface ViewportScoreEntry {
  score: number | null;
  pixel_diff: number | null;
  http_status: number | null;
  size_mismatch: boolean;
  height_delta_px: number;
  skipped: boolean;
}

/** Map a measured pixel-diff to a persisted viewport entry. */
export function viewportScoreEntry(
  diff: PixelDiffResult,
  httpStatus: number | null,
): ViewportScoreEntry {
  return {
    score: diff.score,
    pixel_diff: diff.diffRatio,
    http_status: httpStatus,
    size_mismatch: diff.sizeMismatch,
    height_delta_px: diff.heightDeltaPx,
    skipped: false,
  };
}

/** Entry for a viewport whose source/generated capture was missing. */
export function skippedViewportEntry(httpStatus: number | null): ViewportScoreEntry {
  return {
    score: null,
    pixel_diff: null,
    http_status: httpStatus,
    size_mismatch: false,
    height_delta_px: 0,
    skipped: true,
  };
}

/** Assemble the persisted viewport_scores object, dropping undefined viewports. */
export function buildViewportScores(
  entries: Partial<Record<string, ViewportScoreEntry>>,
): Record<string, ViewportScoreEntry> {
  const out: Record<string, ViewportScoreEntry> = {};
  for (const [vp, entry] of Object.entries(entries)) {
    if (entry) out[vp] = entry;
  }
  return out;
}

/**
 * The canonical (persisted `score` column) value. Stays the desktop score
 * UNLESS a catastrophic mobile failure exists — then it drops to 0 so the
 * page reads as broken on the review screen, identical posture to the desktop
 * httpFailureRow. The true per-viewport numbers are preserved in viewport_scores.
 */
export function resolveCanonicalScore(desktopScore: number, mobileBlocking: boolean): number {
  return mobileBlocking ? 0 : desktopScore;
}
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm --filter @jab/web test -- lib/ai/fidelity-score.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/fidelity-score.ts apps/web/lib/ai/fidelity-score.test.ts
git commit -m "feat(fidelity): viewport-scores builder + canonical-score resolver"
```

---

### Task 4: Per-viewport HTTP status in the verify capture

**Files:**
- Modify: `apps/web/lib/jab/playwright-verify.ts:39-55` (the `VerifyPageResult` interface) and `:134-159` (the capture loop)
- Test: none feasible at unit level (the capture launches Chromium). Verified by `tsc` + the verify smoke. This task is intentionally small and type-driven.

**Interfaces:**
- Produces: `VerifyPageResult.httpStatusByViewport: Partial<Record<string, number | null>>` — per-viewport HTTP status keyed by viewport width string. The existing `httpStatus` field (1280) is retained for back-compat with `verify-fidelity.ts`'s current desktop-404 check until Task 5 migrates it.

- [ ] **Step 1: Add the field to the result interface**

In `apps/web/lib/jab/playwright-verify.ts`, inside `VerifyPageResult`, after the `httpStatus` field (currently line 52), add:

```ts
  /** HTTP status per captured viewport, keyed by width string. */
  httpStatusByViewport?: Partial<Record<string, number | null>>;
```

- [ ] **Step 2: Initialise + populate it in the capture loop**

In `captureGeneratedScreenshots`, where `pageResult` is constructed (currently lines 127-133), add the field:

```ts
      const pageResult: VerifyPageResult = {
        pageInventoryId: page.pageInventoryId,
        slug: page.slug,
        postType: page.postType,
        generatedScreenshotPaths: { source: {} },
        failures: [],
        httpStatusByViewport: {},
      };
```

Inside the per-viewport `try` block, replace the existing 1280-only status capture (currently lines 147-149):

```ts
          if (viewport === 1280) {
            pageResult.httpStatus = response ? response.status() : null;
          }
```

with per-viewport recording that keeps the 1280 back-compat field:

```ts
          const status = response ? response.status() : null;
          pageResult.httpStatusByViewport![String(viewport)] = status;
          if (viewport === 1280) {
            pageResult.httpStatus = status;
          }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 4: Run the full test suite (guard against interface-shape breakage)**

Run: `pnpm --filter @jab/web test`
Expected: PASS (no test constructs `VerifyPageResult` without the new optional field; it is optional, so existing constructions stay valid).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/playwright-verify.ts
git commit -m "feat(fidelity): record HTTP status per scored viewport in verify capture"
```

---

### Task 5: Score 375 + 1280 in the verify-fidelity worker

**Files:**
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts` — the `load-pages` select, the `score-pages` step, and the `persist-fidelity` step.
- Test: none feasible at unit level (the worker news up the admin client inside `step.run`). Verified by `tsc`, the Task 2/3 pure-helper tests it composes, and the verify smoke. Keep the worker a thin composition of the tested helpers.

**Interfaces:**
- Consumes: `SCORED_VIEWPORTS`, `httpFailureRow`, `mobileDivergenceIssue`, `viewportScoreEntry`, `skippedViewportEntry`, `buildViewportScores`, `resolveCanonicalScore` (Tasks 2-3); `VerifyPageResult.httpStatusByViewport` (Task 4).
- Produces: a `viewport_scores` value upserted into `fidelity_reports` per page; the canonical `score` reflects catastrophic-mobile penalty; `issues` includes any mobile blocking issue.

- [ ] **Step 1: Extend the imports**

In `verify-fidelity.ts`, extend the `@/lib/ai/fidelity-score` import (currently lines 11-18) to add the new helpers:

```ts
import {
  pixelDiffScore,
  visionScore,
  selectVisionPages,
  sizeMismatchIssue,
  visionUnavailableIssue,
  httpFailureRow,
  mobileDivergenceIssue,
  viewportScoreEntry,
  skippedViewportEntry,
  buildViewportScores,
  resolveCanonicalScore,
  SCORED_VIEWPORTS,
  type ViewportScoreEntry,
} from "@/lib/ai/fidelity-score";
```

- [ ] **Step 2: Widen the score-pages row type + add viewport_scores**

In the `score-pages` step, the `rows` array type (currently lines 165-172) gains a `viewport_scores` field:

```ts
        const rows: Array<{
          page_inventory_id: string;
          score: number | null;
          pixel_diff: number | null;
          issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }>;
          generated_screenshot_paths: VerifyPageResult["generatedScreenshotPaths"];
          viewport_scores: Record<string, ViewportScoreEntry>;
          skipped: boolean;
        }> = [];
```

- [ ] **Step 3: Replace the per-page scoring body with the multi-viewport version**

Replace the per-page loop body in `score-pages` (currently lines 181-266, from `for (const page of pages) {` through the end of the loop) with the version below. It keeps the desktop path canonical, adds the mobile path, and is a thin composition of the Task 2/3 helpers. The HTTP-failure short-circuit now consults BOTH viewports.

```ts
        for (const page of pages) {
          const generated = generatedResults.find(
            (g) => g.pageInventoryId === page.id,
          );
          const statusByVp = generated?.httpStatusByViewport ?? {};

          // HTTP-failure short-circuit, desktop OR mobile. A 4xx/5xx on either
          // scored viewport means the page is broken — score 0, high issue,
          // build still goes ready (the review gate forces a human decision).
          const desktopHttpFail = httpFailureRow(statusByVp["1280"] ?? generated?.httpStatus, page.route_path);
          const mobileHttpFail = httpFailureRow(statusByVp["375"], page.route_path, "mobile");
          if (desktopHttpFail || mobileHttpFail) {
            const issues = [...(desktopHttpFail?.issues ?? []), ...(mobileHttpFail?.issues ?? [])];
            rows.push({
              page_inventory_id: page.id,
              score: 0,
              pixel_diff: null,
              issues,
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              viewport_scores: buildViewportScores({
                "1280": skippedViewportEntry(statusByVp["1280"] ?? generated?.httpStatus ?? null),
                "375": skippedViewportEntry(statusByVp["375"] ?? null),
              }),
              skipped: false,
            });
            continue;
          }

          const sourcePaths =
            (page.source_screenshot_paths?.source as Record<string, string> | undefined) ?? {};

          // Measure each scored viewport independently; desktop is canonical.
          const perViewport: Partial<Record<string, ViewportScoreEntry>> = {};
          let desktopDiffRatio: number | null = null;
          let desktopScore: number | null = null;
          let desktopSizeMismatch = false;
          let desktopHeightDelta = 0;
          let mobileDiffRatio: number | null = null;

          for (const vp of SCORED_VIEWPORTS) {
            const sourcePath = sourcePaths[vp] ?? null;
            const generatedPath = generated?.generatedScreenshotPaths.source[vp] ?? null;
            if (!sourcePath || !generatedPath) {
              perViewport[vp] = skippedViewportEntry(statusByVp[vp] ?? null);
              continue;
            }
            const [sourceBuf, generatedBuf] = await Promise.all([
              downloadBucket(supabase, sourcePath),
              downloadBucket(supabase, generatedPath),
            ]);
            if (!sourceBuf || !generatedBuf) {
              perViewport[vp] = skippedViewportEntry(statusByVp[vp] ?? null);
              continue;
            }
            const diff = pixelDiffScore({ sourceBuffer: sourceBuf, generatedBuffer: generatedBuf });
            perViewport[vp] = viewportScoreEntry(diff, statusByVp[vp] ?? null);
            if (vp === "1280") {
              desktopDiffRatio = diff.diffRatio;
              desktopScore = diff.score;
              desktopSizeMismatch = diff.sizeMismatch;
              desktopHeightDelta = diff.heightDeltaPx;
            } else if (vp === "375") {
              mobileDiffRatio = diff.diffRatio;
            }
          }

          const viewport_scores = buildViewportScores(perViewport);

          // Desktop is the canonical axis. With no desktop measurement the page
          // is unscored/skipped (same as the prior single-viewport behavior),
          // but we persist whatever viewport_scores we did gather.
          if (desktopDiffRatio === null || desktopScore === null) {
            rows.push({
              page_inventory_id: page.id,
              score: null,
              pixel_diff: null,
              issues: [],
              generated_screenshot_paths: generated?.generatedScreenshotPaths ?? { source: {} },
              viewport_scores,
              skipped: true,
            });
            continue;
          }

          // Catastrophic-mobile gate (only when mobile actually measured).
          const mobileIssue =
            mobileDiffRatio !== null
              ? mobileDivergenceIssue(desktopDiffRatio, mobileDiffRatio, page.route_path)
              : null;

          const issues: Array<{ block_name: string; severity: "low" | "medium" | "high"; description: string }> = [];
          if (desktopSizeMismatch) issues.push(sizeMismatchIssue(desktopHeightDelta));
          if (mobileIssue) issues.push(mobileIssue);

          rows.push({
            page_inventory_id: page.id,
            score: resolveCanonicalScore(desktopScore, mobileIssue !== null),
            pixel_diff: desktopDiffRatio,
            issues,
            generated_screenshot_paths: generated!.generatedScreenshotPaths,
            viewport_scores,
            skipped: false,
          });

          // Vision budget is desktop-driven, unchanged. A page zeroed by a
          // mobile block is NOT a vision candidate (its score is already 0 by
          // policy, not by measured desktop divergence).
          if (!mobileIssue) {
            candidates.push({ pageInventoryId: page.id, diffRatio: desktopDiffRatio });
            visionMeta.set(page.id, {
              rowIndex: rows.length - 1,
              pixelScore: desktopScore,
              sourcePath: sourcePaths["1280"]!,
              generatedPath: generated!.generatedScreenshotPaths.source["1280"]!,
              routePath: page.route_path,
            });
          }
        }
```

Note: `candidates` and `visionMeta` are still declared above this loop exactly as today (lines 175-179) — keep them. The Phase B vision loop (lines 268-297) is unchanged.

- [ ] **Step 4: Persist the new column**

In the `persist-fidelity` step, add `viewport_scores` to the upsert object (currently lines 304-314):

```ts
          const { error } = await supabase.from("fidelity_reports").upsert(
            {
              site_build_id: buildId,
              project_id: projectId,
              page_inventory_id: row.page_inventory_id,
              score: row.score,
              pixel_diff: row.pixel_diff,
              issues: row.issues,
              generated_screenshot_paths: row.generated_screenshot_paths,
              viewport_scores: row.viewport_scores,
            },
            { onConflict: "site_build_id,page_inventory_id" },
          );
```

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.
Run: `pnpm --filter @jab/web test`
Expected: PASS (no unit test exercises the worker body directly; the pure helpers it composes are covered by Tasks 2-3).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/inngest/functions/verify-fidelity.ts
git commit -m "feat(fidelity): score mobile (375) + desktop (1280), persist viewport_scores, mobile gate"
```

---

### Task 6: Review-thumbnail pure helpers

**Files:**
- Create: `apps/web/lib/jab/review-thumbnails.ts`
- Test: `apps/web/lib/jab/review-thumbnails.test.ts`

**Interfaces:**
- Produces:
  - `THUMBNAIL_VIEWPORTS: readonly ["1280", "375"]` — the viewports rendered as thumbnails (desktop, mobile).
  - `type ThumbKind = "source" | "generated"`.
  - `interface ThumbRequest { key: string; path: string }` where `key` is `"<pageInventoryId>:<viewport>:<kind>"`.
  - `buildThumbnailRequests(pages, fidelityByPageId): ThumbRequest[]` — the de-duplicated list of bucket paths to batch-sign. `pages` is `Array<{ id: string; source_screenshot_paths: { source?: Record<string,string> } | null }>`; `fidelityByPageId` is `Map<string, { generated_screenshot_paths: { source?: Record<string,string> } | null }>`. Emits a request only for paths that exist.
  - `pickViewportScore(viewportScores: unknown, viewport: string): { score: number | null; blocking: boolean } | null` — reads one viewport's entry from the persisted JSONB; `blocking` is true when that viewport's entry carries `skipped:false` and `score === 0` OR an `http_status >= 400` (so the UI can badge it). Returns null when the viewport is absent.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/jab/review-thumbnails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  THUMBNAIL_VIEWPORTS,
  buildThumbnailRequests,
  pickViewportScore,
  type ThumbRequest,
} from "./review-thumbnails";

describe("THUMBNAIL_VIEWPORTS", () => {
  it("renders desktop then mobile", () => {
    expect(THUMBNAIL_VIEWPORTS).toEqual(["1280", "375"]);
  });
});

describe("buildThumbnailRequests", () => {
  it("emits source + generated requests per viewport that has a path", () => {
    const pages = [
      {
        id: "p1",
        source_screenshot_paths: { source: { "1280": "s/1280/p1.png", "375": "s/375/p1.png" } },
      },
    ];
    const fidelity = new Map([
      ["p1", { generated_screenshot_paths: { source: { "1280": "g/1280/p1.png", "375": "g/375/p1.png" } } }],
    ]);
    const reqs = buildThumbnailRequests(pages, fidelity);
    const keys = reqs.map((r: ThumbRequest) => r.key).sort();
    expect(keys).toEqual([
      "p1:1280:generated",
      "p1:1280:source",
      "p1:375:generated",
      "p1:375:source",
    ]);
    expect(reqs.find((r) => r.key === "p1:1280:source")!.path).toBe("s/1280/p1.png");
  });

  it("omits requests for absent paths (no fabricated entries)", () => {
    const pages = [{ id: "p1", source_screenshot_paths: { source: { "1280": "s/1280/p1.png" } } }];
    const fidelity = new Map([["p1", { generated_screenshot_paths: { source: {} } }]]);
    const reqs = buildThumbnailRequests(pages, fidelity);
    expect(reqs.map((r) => r.key)).toEqual(["p1:1280:source"]);
  });

  it("tolerates a page with no fidelity row and null screenshot paths", () => {
    const pages = [{ id: "p1", source_screenshot_paths: null }];
    const fidelity = new Map<string, { generated_screenshot_paths: { source?: Record<string, string> } | null }>();
    expect(buildThumbnailRequests(pages, fidelity)).toEqual([]);
  });
});

describe("pickViewportScore", () => {
  it("returns the score and non-blocking for a healthy viewport", () => {
    const vs = { "375": { score: 0.92, pixel_diff: 0.08, http_status: 200, skipped: false } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0.92, blocking: false });
  });
  it("flags blocking when score is 0 and not skipped", () => {
    const vs = { "375": { score: 0, pixel_diff: 0.7, http_status: 200, skipped: false } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0, blocking: true });
  });
  it("flags blocking on a 4xx/5xx http_status", () => {
    const vs = { "375": { score: null, pixel_diff: null, http_status: 500, skipped: true } };
    expect(pickViewportScore(vs, "375")!.blocking).toBe(true);
  });
  it("returns null when the viewport is absent", () => {
    expect(pickViewportScore({ "1280": {} }, "375")).toBeNull();
    expect(pickViewportScore(null, "375")).toBeNull();
    expect(pickViewportScore(undefined, "375")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @jab/web test -- lib/jab/review-thumbnails.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/lib/jab/review-thumbnails.ts`:

```ts
/**
 * review-thumbnails — pure helpers for the build-review screen's
 * source-vs-generated thumbnail grid. No I/O: the server component builds the
 * request list here, batch-signs it via Supabase Storage, then renders.
 */

/** Viewports rendered as thumbnails on the review row: desktop then mobile. */
export const THUMBNAIL_VIEWPORTS = ["1280", "375"] as const;

export type ThumbKind = "source" | "generated";

export interface ThumbRequest {
  /** "<pageInventoryId>:<viewport>:<kind>" */
  key: string;
  /** Bucket-relative storage path to sign. */
  path: string;
}

interface PageLike {
  id: string;
  source_screenshot_paths: { source?: Record<string, string> } | null;
}
interface FidelityLike {
  generated_screenshot_paths: { source?: Record<string, string> } | null;
}

/** De-duplicated list of bucket paths to batch-sign, one per existing thumbnail. */
export function buildThumbnailRequests(
  pages: PageLike[],
  fidelityByPageId: Map<string, FidelityLike>,
): ThumbRequest[] {
  const out: ThumbRequest[] = [];
  for (const page of pages) {
    const sourceMap = page.source_screenshot_paths?.source ?? {};
    const generatedMap = fidelityByPageId.get(page.id)?.generated_screenshot_paths?.source ?? {};
    for (const vp of THUMBNAIL_VIEWPORTS) {
      const sourcePath = sourceMap[vp];
      if (sourcePath) out.push({ key: `${page.id}:${vp}:source`, path: sourcePath });
      const generatedPath = generatedMap[vp];
      if (generatedPath) out.push({ key: `${page.id}:${vp}:generated`, path: generatedPath });
    }
  }
  return out;
}

/**
 * Read one viewport's entry from the persisted viewport_scores JSONB.
 * `blocking` is true when the viewport scored a hard 0 (and was actually
 * measured) or answered 4xx/5xx — the UI badges these.
 */
export function pickViewportScore(
  viewportScores: unknown,
  viewport: string,
): { score: number | null; blocking: boolean } | null {
  if (!viewportScores || typeof viewportScores !== "object") return null;
  const entry = (viewportScores as Record<string, unknown>)[viewport];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { score?: unknown; http_status?: unknown; skipped?: unknown };
  const score = typeof e.score === "number" ? e.score : null;
  const httpStatus = typeof e.http_status === "number" ? e.http_status : null;
  const skipped = e.skipped === true;
  const blocking = (!skipped && score === 0) || (httpStatus !== null && httpStatus >= 400);
  return { score, blocking };
}
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm --filter @jab/web test -- lib/jab/review-thumbnails.test.ts`
Expected: PASS.
Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/review-thumbnails.ts apps/web/lib/jab/review-thumbnails.test.ts
git commit -m "feat(review): pure thumbnail-request + viewport-score helpers"
```

---

### Task 7: Render desktop + mobile thumbnails on the review screen

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx`
- Test: none feasible at unit level (`force-dynamic` server component with Supabase I/O). Verified by `tsc`, the Task 6 helper tests, and visual smoke at execution time. Keep the component a thin renderer over the tested helpers.

**Interfaces:**
- Consumes: `buildThumbnailRequests`, `pickViewportScore`, `THUMBNAIL_VIEWPORTS` (Task 6); `SITE_SCREENSHOTS_BUCKET`; the new `viewport_scores` column.

- [ ] **Step 1: Select the new column + extend the row type**

In the `fidelity_reports` select (currently lines 86-90), add `viewport_scores`:

```ts
    supabase
      .from("fidelity_reports")
      .select(
        "id, page_inventory_id, score, pixel_diff, issues, approval_status, generated_screenshot_paths, viewport_scores, approved_at, approved_by_user_id",
      )
      .eq("site_build_id", buildId),
```

In the `FidelityRow` interface (currently lines 29-43), add:

```ts
  viewport_scores: Record<string, { score: number | null; pixel_diff: number | null; http_status: number | null; skipped: boolean }> | null;
```

- [ ] **Step 2: Batch-sign thumbnails for the visible pages**

Add the imports at the top of the file:

```ts
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  buildThumbnailRequests,
  pickViewportScore,
  THUMBNAIL_VIEWPORTS,
} from "@/lib/jab/review-thumbnails";
```

After `listPages` is computed (currently line 131) — so we only sign what we render — build the signed-URL map:

```ts
  // Batch-sign source + generated thumbnails for the pages we will render.
  // The site-screenshots bucket is private, so each <img> needs a signed URL.
  // One createSignedUrls call covers the whole visible page set.
  const thumbRequests = buildThumbnailRequests(
    listPages.map((p) => ({ id: p.id, source_screenshot_paths: p.source_screenshot_paths })),
    fidelityByPage,
  );
  const signedThumbs = new Map<string, string>();
  if (thumbRequests.length > 0) {
    const { data: signed } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .createSignedUrls(
        thumbRequests.map((r) => r.path),
        60 * 30, // 30 min — comfortably longer than a review session.
      );
    if (signed) {
      signed.forEach((s, i) => {
        if (s.signedUrl) signedThumbs.set(thumbRequests[i].key, s.signedUrl);
      });
    }
  }
```

- [ ] **Step 3: Thread the signed map + viewport scores into the row**

Update the `PageReviewRow` call site (currently lines 247-254) to pass the signed URLs:

```ts
                <PageReviewRow
                  key={page.id}
                  page={page}
                  fidelity={fidelityRow ?? null}
                  signedThumbs={signedThumbs}
                  approveAction={approveAction}
                  approveWithIssuesAction={approveWithIssuesAction}
                  rejectAction={rejectAction}
                />
```

Extend `PageReviewRowProps` (currently lines 313-319):

```ts
interface PageReviewRowProps {
  page: PageRow;
  fidelity: FidelityRow | null;
  signedThumbs: Map<string, string>;
  approveAction: (formData: FormData) => Promise<void>;
  approveWithIssuesAction: (formData: FormData) => Promise<void>;
  rejectAction: (formData: FormData) => Promise<void>;
}
```

- [ ] **Step 4: Render the thumbnail grid + mobile score in `PageReviewRow`**

In `PageReviewRow`, accept the new prop and render the thumbnails. Add `signedThumbs` to the destructure (currently lines 321-327), then insert the thumbnail block + mobile-score line. Add this helper component above `PageReviewRow`:

```tsx
function ViewportThumbs({
  pageId,
  viewport,
  label,
  signedThumbs,
  viewportScore,
}: {
  pageId: string;
  viewport: string;
  label: string;
  signedThumbs: Map<string, string>;
  viewportScore: { score: number | null; blocking: boolean } | null;
}) {
  const source = signedThumbs.get(`${pageId}:${viewport}:source`);
  const generated = signedThumbs.get(`${pageId}:${viewport}:generated`);
  if (!source && !generated) return null;
  const pct =
    viewportScore && viewportScore.score !== null ? `${Math.round(viewportScore.score * 100)}%` : "—";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-gry-d">
        <span>{label}</span>
        <span>·</span>
        <span className={viewportScore?.blocking ? "text-red" : "text-gry"}>{pct}</span>
        {viewportScore?.blocking && (
          <span className="rounded-sm border border-red/40 bg-red/10 px-1 text-[9px] text-red">broken</span>
        )}
      </div>
      <div className="flex gap-1">
        {[
          { url: source, alt: `${label} source` },
          { url: generated, alt: `${label} generated` },
        ].map(({ url, alt }, i) =>
          url ? (
            <a key={i} href={url} target="_blank" rel="noreferrer noopener" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={alt}
                loading="lazy"
                className="h-24 w-20 rounded border border-bord object-cover object-top"
              />
            </a>
          ) : (
            <div
              key={i}
              className="flex h-24 w-20 items-center justify-center rounded border border-dashed border-bord text-[9px] text-gry-d"
            >
              none
            </div>
          ),
        )}
      </div>
    </div>
  );
}
```

Then inside `PageReviewRow`, add the destructure for `signedThumbs` and render the grid. Change the `<li>` to stack the metadata row and the thumbnails. After the existing metadata `<div className="min-w-0 flex-1">…</div>` block (closes at line 374), insert:

```tsx
      <div className="flex shrink-0 gap-3">
        <ViewportThumbs
          pageId={page.id}
          viewport="1280"
          label="desktop"
          signedThumbs={signedThumbs}
          viewportScore={pickViewportScore(fidelity?.viewport_scores, "1280")}
        />
        <ViewportThumbs
          pageId={page.id}
          viewport="375"
          label="mobile"
          signedThumbs={signedThumbs}
          viewportScore={pickViewportScore(fidelity?.viewport_scores, "375")}
        />
      </div>
```

(`THUMBNAIL_VIEWPORTS` is imported for the helper layer; the two explicit `<ViewportThumbs>` give per-viewport labels. If a reviewer prefers a loop, map `THUMBNAIL_VIEWPORTS` with a label lookup — functionally identical.)

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @jab/web run typecheck`
Expected: exit 0.
Run: `pnpm --filter @jab/web test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx"
git commit -m "feat(review): render desktop + mobile source/generated thumbnails with mobile score"
```

---

### Task 8: Docs + cross-project migration application

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`
- Modify: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md`
- Modify: `CLAUDE.md`
- Operator action (orchestrator, at merge time): apply migration 0036 to BOTH Supabase projects.

- [ ] **Step 1: Update the recommendations doc**

In `docs/superpowers/specs/2026-06-17-independent-review-recommendations.md`, change finding #4's status from OPEN to FIXED with a one-line summary: mobile (375) now scored alongside desktop, per-viewport `viewport_scores` persisted (migration 0036), desktop + mobile thumbnails on the review screen, catastrophic-mobile failures drive score 0 + a high-severity issue (same posture as the desktop-404 gate). Note the deferred follow-up: multi-viewport *generation* (feeding mobile evidence to the LLM) remains intentionally out of scope.

- [ ] **Step 2: Update the fleet-gap register**

In `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md`, annotate fleet-gap A6 (desktop-1280-only generation + fidelity): the **fidelity half is now closed** (mobile scored + gated + reviewable); the **generation half remains open** (still desktop-1280-only generation) — split the entry or add a status line accordingly.

- [ ] **Step 3: Add the CLAUDE.md snapshot line**

In `CLAUDE.md`, in the SaaS-track snapshot section, add a short paragraph (same style as the existing dated campaign entries) summarizing: multi-viewport mobile fidelity gate landed (branch `feat/multi-viewport-mobile-fidelity-gate`), what shipped, migration 0036 → both Supabase projects, and the deferred generation follow-up.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-17-independent-review-recommendations.md docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md CLAUDE.md
git commit -m "docs(fidelity): mark finding #4 + fleet-gap A6 fidelity-half closed"
```

- [ ] **Step 5: Apply migration 0036 to both Supabase projects (orchestrator, post-merge)**

Apply `0036_fidelity_viewport_scores.sql` to BOTH projects via `mcp__supabase__apply_migration` (or the dashboard SQL editor):
- local/dev "JAB WP" `ajfurojjxthhzkjqttri`
- prod "jab-prod" `celzwcxkrmsbwiswkxug`

Verify with a `list_tables` / column check that `fidelity_reports.viewport_scores` exists on both. This is the only non-code deliverable and is performed by the orchestrator, not a subagent.

---

## Self-Review

**1. Spec coverage (against the chosen scope — scoring + mobile gate, catastrophic-only block, no generation):**
- Score mobile alongside desktop → Task 5 (loop over `SCORED_VIEWPORTS`). ✓
- Persist per-viewport scores → Task 1 (column) + Task 3 (builder) + Task 5 (persist). ✓
- Surface mobile + desktop thumbnails on review → Task 6 (helpers) + Task 7 (render). ✓
- Block publish on catastrophic mobile → Task 2 (`mobileDivergenceIssue` + mobile `httpFailureRow`) + Task 3/5 (`resolveCanonicalScore` → 0 + high issue, same posture as desktop 404, enforced by the existing unapproved-pages gate). ✓
- No generation changes → enforced by Global Constraints; no task touches the generator. ✓
- No tablet scoring → `SCORED_VIEWPORTS = ["1280","375"]`; capture untouched. ✓
- Both Supabase projects → Global Constraint + Task 8 Step 5. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows real code. ✓

**3. Type consistency:**
- `ViewportScoreEntry` defined in Task 3, imported by name in Task 5. ✓
- `SCORED_VIEWPORTS` (`["1280","375"]`, fidelity-score.ts) vs `THUMBNAIL_VIEWPORTS` (`["1280","375"]`, review-thumbnails.ts) — deliberately separate constants in separate modules (scoring vs rendering concerns) with identical values; not a drift bug. ✓
- `httpFailureRow` 3rd-arg addition is backward-compatible (optional, default reproduces legacy string) — verified by a dedicated test in Task 2. ✓
- `httpStatusByViewport` (Task 4) consumed in Task 5 via `generated?.httpStatusByViewport ?? {}`. ✓
- `pickViewportScore` return `{ score, blocking }` consumed by `ViewportThumbs` in Task 7. ✓

**Risk notes for the executing agent:**
- The catastrophic-mobile constants (0.6 floor, 2× ratio) are conservative by design to avoid false positives on legitimate mobile reflow; they are exported so a reviewer can tune them. Do not lower them without evidence.
- The verify worker body (Task 5) is not unit-tested in isolation (it news up the admin client inside `step.run`, matching the existing code). Its correctness rests on the Task 2/3 pure helpers it composes — keep the worker a thin composition; do not inline new logic there.
- Signing 4 URLs × N visible pages in one `createSignedUrls` call is bounded by `listPages` (scoped edit builds show only changed pages); a full 45-page build signs ≤180 URLs in a single batch call — acceptable for a `force-dynamic` page.
