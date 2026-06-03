---
# Phase 3 — Dashboard Real Data + Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every fabricated number on a live project (Lighthouse 94 / TTFB 38ms / Build 2.1s / Content 47 / Types 8 / three fake AI prompts / credits chip) with measured values, omit any stat that isn't measured, give the four "Coming soon" tabs real routes, and make the dashboard badge read "Live · updating" when a live project has an in-flight edit.

**Architecture:** Pure, TDD-first modules (`perf-capture.ts`, `build-quick-stats.ts`) drive the numbers; an impure loader (`load-project-content.ts`) feeds the Content tab; `BuildSummary` grows the three perf columns landed by the Phase 0 migration batch (`0028`); the shared status word (`deriveProjectStatusLabel`) is authored **and rendered** by Phase 1 on the dashboard badge and the project header — this phase only adds a dashboard regression test pinning "Live · updating"; the mock file is purged down to type-only interfaces; and the four tabs become real RLS-scoped routes under a shared tab-bar `layout.tsx` (scoped so it does not render over the immersive `/onboard`, `/workspace`, `/builds/…` routes). This phase owns only the pure `perf-capture` module + the UI that consumes the perf columns — the `verify-fidelity.ts` worker hook that *calls* `extractPerf` is implemented in Phase 2 (the single coordinated edit of that file), referenced here, never duplicated.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM + Supabase (postgres), Inngest workers, Vitest, Tailwind, Anthropic SDK, Vercel REST.

**Spec:** docs/superpowers/specs/2026-06-03-saas-e2e-loop-design.md (this plan implements §3.1 "S1 — Dashboard & Project Data", §2.2 "deriveProjectStatusLabel consumption", and §4 "Phase 3").
---

## Cross-phase dependencies (read before starting)

- **Phase 0 must be merged first.** It authored and applied migration `0028_build_perf_metrics.sql` (`site_builds`: `ttfb_ms integer`, `load_ms integer`, `transfer_bytes bigint`) to **both** Supabase projects and mirrored the columns in `lib/db/schema.ts`. This phase reads those columns; it does **not** author the migration.
- **Phase 1 authored `lib/jab/project-status-label.ts`** (`ProjectStatusLabel`, `deriveProjectStatusLabel`, `projectStatusLabelText`) **and is the sole renderer of the shared status word** — it rewrites both the dashboard `ProjectStatusBadge` and the project-header chip (Phase 1 Task 8). This phase does **not** re-render the status word on either surface; it only adds a dashboard regression test (Task 8) that imports Phase 1's pure functions to pin "Live · updating". If Phase 1 has not merged, Task 8's test import won't resolve — do Tasks 1–7 first (they don't depend on it) and land Task 8 once `project-status-label.ts` exists. The verify barrier note in Task 8 says exactly this. `deriveProjectStatusLabel`'s parameter is the narrow `ProjectStatusLabelInput` (`productionDeployment: { id } | null`, `hasActiveBuild`, `latestBuild: { status } | null`, optional `editAwaitingReview`) — pass only those fields, never the full `ProjectBuildState`.
- **Phase 2 owns the single edit of `verify-fidelity.ts`.** That worker imports `extractPerf` from the module Task 1 creates and writes the three perf columns in `finalize`. **This plan never edits `verify-fidelity.ts`.** Task 1 only creates the pure module + its tests.

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `apps/web/lib/jab/perf-capture.ts` | Create | Pure `extractPerf(nav) → { ttfbMs, loadMs, transferBytes }` from a `PerformanceNavigationTiming` JSON blob. |
| `apps/web/lib/jab/perf-capture.test.ts` | Create | Unit tests for `extractPerf` (happy path, missing fields, null/garbage input). |
| `apps/web/lib/jab/build-quick-stats.ts` | Create | Pure `buildQuickStats(BuildSummary, ContentOwnership|null) → QuickStat[]`, **omits any stat whose value is null**. |
| `apps/web/lib/jab/build-quick-stats.test.ts` | Create | Unit tests proving omit-null behavior, formatting, and ordering. |
| `apps/web/lib/jab/load-project-content.ts` | Create | `loadProjectContent(supabase, buildId) → { pages, blockTypes }` for the Content tab. |
| `apps/web/lib/jab/load-project-content.test.ts` | Create | Unit test of the row→shape mapping against a mocked Supabase chain. |
| `apps/web/lib/jab/load-project-builds.ts` | Modify | Extend `BuildSummary` with `ttfbMs`/`loadMs`/`transferBytes` + map them in `toBuildSummary` + add the columns to the SELECT. |
| `apps/web/lib/jab/load-project-builds.test.ts` | Modify | Assert the three new fields map through (and default to null). |
| `apps/web/app/(app)/projects/[id]/mocks.ts` | Modify | Delete `lighthouse`/`quickStats`/`deploys`/`wpConnection`/`aiHistory`/`aiCreditsRemaining`/`lastDeployedRelative` + `SITE_DETAIL_MOCKS`. Keep nothing here — move the surviving type interfaces to `mocks-types.ts`. |
| `apps/web/app/(app)/projects/[id]/mocks-types.ts` | Create | Type-only home for the row interfaces still referenced by the page (`QuickStat`, `DeployRow`, `WpConnection`, `AiPromptHistoryRow`). |
| `apps/web/app/(app)/projects/[id]/page.tsx` | Modify | Real `quickStats` from `buildQuickStats`; AI card history from `loadWorkspaceEditHistory`; remove credits chip; remove the inline tab block (the tab bar moves to `layout.tsx`); deploy-history `message` from `config.mode`/`config.prompt`. (Header status word is owned by Phase 1 Task 8 — not edited here.) |
| `apps/web/app/(app)/projects/[id]/layout.tsx` | Create | Shared tab bar (Overview/Content/Deploy/AI/Settings), active-tab aware. Hides itself on the immersive drill-in routes (`/onboard`, `/workspace`, `/builds/…`) so it never renders chrome over those full-page surfaces. |
| `apps/web/app/(app)/projects/[id]/tabs/content/page.tsx` | Create | Content tab — pages + block types from `loadProjectContent`. RLS, `notFound()` on PGRST116. |
| `apps/web/app/(app)/projects/[id]/tabs/deploy/page.tsx` | Create | Deploy tab — full deploy history with config-derived labels. RLS, `notFound()`. |
| `apps/web/app/(app)/projects/[id]/tabs/ai/page.tsx` | Create | AI tab — `loadWorkspaceEditHistory` list. RLS, `notFound()`. |
| `apps/web/app/(app)/projects/[id]/tabs/settings/page.tsx` | Create | Settings tab — `DesignTokensReview` + connection summary + Vercel link + labeled "Billing & credits — not available yet" placeholder. No dead-ends. |
| `apps/web/app/(app)/dashboard/dashboard-status.test.ts` | Create | Regression fixture asserting the dashboard badge reads "Live · updating" for a live in-flight edit. The badge **rendering** in `dashboard/page.tsx` is owned by Phase 1 Task 8 (sole renderer of the shared status word) — this phase does not edit `dashboard/page.tsx`. |

---

## Task 1 — Pure `perf-capture.ts` + tests (this phase owns the module; Phase 2 owns the worker hook)

**Files:**
- Create: `apps/web/lib/jab/perf-capture.ts`
- Test: `apps/web/lib/jab/perf-capture.test.ts`

`extractPerf` takes the JSON returned by `performance.getEntriesByType('navigation')[0]` (a `PerformanceNavigationTiming`) and computes the three measured metrics. Per spec §3.1 it is **fail-soft**: any missing/garbage field yields `null` for that metric, never throws. TTFB = `responseStart - requestStart` (time to first byte of the document). Load = `loadEventEnd - startTime` (full document load; `startTime` is 0 for the navigation entry but we subtract it for correctness). Transfer = `transferSize` (bytes over the wire for the document). A computed value that is negative or non-finite is treated as unmeasured → `null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/perf-capture.test.ts
import { describe, it, expect } from "vitest";
import { extractPerf, type PerformanceNavigationTimingJSON } from "./perf-capture";

const FULL: PerformanceNavigationTimingJSON = {
  startTime: 0,
  requestStart: 12.5,
  responseStart: 50.5,
  loadEventEnd: 812.3,
  transferSize: 45_678,
};

describe("extractPerf", () => {
  it("computes ttfb, load, and transfer from a full navigation entry", () => {
    const perf = extractPerf(FULL);
    // ttfb = responseStart - requestStart = 50.5 - 12.5 = 38 -> rounded 38
    expect(perf.ttfbMs).toBe(38);
    // load = loadEventEnd - startTime = 812.3 - 0 = 812.3 -> rounded 812
    expect(perf.loadMs).toBe(812);
    expect(perf.transferBytes).toBe(45_678);
  });

  it("returns null for a metric whose source fields are missing", () => {
    const perf = extractPerf({ startTime: 0, loadEventEnd: 500 });
    expect(perf.ttfbMs).toBeNull(); // no requestStart/responseStart
    expect(perf.loadMs).toBe(500);
    expect(perf.transferBytes).toBeNull(); // no transferSize
  });

  it("returns all-null for null, undefined, or non-object input", () => {
    expect(extractPerf(null)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
    expect(extractPerf(undefined)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
    expect(extractPerf("not an object" as unknown as PerformanceNavigationTimingJSON)).toEqual({
      ttfbMs: null,
      loadMs: null,
      transferBytes: null,
    });
  });

  it("treats negative or non-finite computed timings as unmeasured (null)", () => {
    // responseStart < requestStart -> negative ttfb -> null
    const perf = extractPerf({ startTime: 0, requestStart: 60, responseStart: 50, loadEventEnd: Infinity, transferSize: -3 });
    expect(perf.ttfbMs).toBeNull();
    expect(perf.loadMs).toBeNull(); // Infinity is non-finite
    expect(perf.transferBytes).toBeNull(); // negative bytes are nonsense
  });

  it("rounds fractional milliseconds to the nearest integer", () => {
    const perf = extractPerf({ startTime: 0, requestStart: 0, responseStart: 38.6, loadEventEnd: 100.4, transferSize: 1024 });
    expect(perf.ttfbMs).toBe(39);
    expect(perf.loadMs).toBe(100);
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS**

```
pnpm --filter @jab/web exec vitest run lib/jab/perf-capture.test.ts
```

Expected: fails to resolve `./perf-capture` ("Failed to load url ./perf-capture" / "Cannot find module").

- [ ] **Step 3: Minimal implementation**

```ts
// apps/web/lib/jab/perf-capture.ts

/**
 * perf-capture — pure extraction of the three measured web-perf metrics
 * from a single navigation timing entry.
 *
 * Source: `performance.getEntriesByType('navigation')[0]` serialized to
 * JSON (Playwright `page.evaluate` returns a plain object, not the live
 * PerformanceNavigationTiming instance). The Phase 2 verify-fidelity
 * worker collects this on the home route and calls extractPerf; this
 * module is the only place the arithmetic lives, so the rounding and the
 * fail-soft contract are tested in one spot.
 *
 * Fail-soft contract (spec §3.1): any missing / non-finite / nonsensical
 * field yields `null` for that metric. extractPerf NEVER throws — perf
 * must never fail a build.
 */

export interface PerformanceNavigationTimingJSON {
  startTime?: number;
  requestStart?: number;
  responseStart?: number;
  loadEventEnd?: number;
  transferSize?: number;
}

export interface PerfMetrics {
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
}

const NULL_PERF: PerfMetrics = { ttfbMs: null, loadMs: null, transferBytes: null };

/** A finite, non-negative integer (rounded) or null. */
function nonNegativeMs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export function extractPerf(
  nav: PerformanceNavigationTimingJSON | null | undefined,
): PerfMetrics {
  if (!nav || typeof nav !== "object") return { ...NULL_PERF };

  const startTime = typeof nav.startTime === "number" ? nav.startTime : 0;

  const ttfbMs =
    typeof nav.requestStart === "number" && typeof nav.responseStart === "number"
      ? nonNegativeMs(nav.responseStart - nav.requestStart)
      : null;

  const loadMs =
    typeof nav.loadEventEnd === "number"
      ? nonNegativeMs(nav.loadEventEnd - startTime)
      : null;

  const transferBytes =
    typeof nav.transferSize === "number" && Number.isFinite(nav.transferSize) && nav.transferSize >= 0
      ? Math.round(nav.transferSize)
      : null;

  return { ttfbMs, loadMs, transferBytes };
}
```

- [ ] **Step 4: Run, verify PASS**

```
pnpm --filter @jab/web exec vitest run lib/jab/perf-capture.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/jab/perf-capture.ts apps/web/lib/jab/perf-capture.test.ts
git commit -m "feat(saas): add pure extractPerf for build perf metrics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Re-home Phase 2's duplicate perf math (do this only AFTER Phase 2 has merged).** Phase 2's `playwright-verify.ts` ships an inline `extractNavPerf` returning the identical `{ ttfbMs, loadMs, transferBytes }` shape with identical metric math (ttfb = `responseStart − requestStart`, load = `loadEventEnd − startTime`, transfer = `transferSize`, rounded, negatives/non-finite → null) — a deliberate temporary duplication both plans flagged. `perf-capture.ts` (Task 1) is the canonical home, so once Phase 2 is merged, collapse the duplicate:
  1. Add a parity test (in `perf-capture.test.ts` or a small co-located spec) feeding the same navigation blob to both `extractPerf` and Phase 2's `extractNavPerf` and asserting `toEqual` — proving identical output **before** removal.
  2. Delete Phase 2's inline `extractNavPerf` and re-point `playwright-verify.ts`'s `collectPerfForHomeRoute` to `import { extractPerf } from "@/lib/jab/perf-capture"`.
  3. Run `pnpm --filter @jab/web test` (the Phase 2 verify specs must stay green) + `typecheck`, then commit.

  > This is the single tracked owner of the de-duplication. If Phase 2 has not merged when you finish this plan, leave the duplicate in place and carry this step as the open follow-up — do not delete code that doesn't exist yet.

---

## Task 2 — Extend `BuildSummary` with the perf columns

**Files:**
- Modify: `apps/web/lib/jab/load-project-builds.ts` (`BuildSummary` interface ~L34–45, SELECT string L72, `toBuildSummary` L148–161)
- Test: `apps/web/lib/jab/load-project-builds.test.ts` (existing — append assertions)

The Phase 0 batch added `ttfb_ms`, `load_ms`, `transfer_bytes` to `site_builds`. Surface them on `BuildSummary` so the project page can read them. `live` semantics are unchanged.

- [ ] **Step 1: Write the failing test** (append a new `it` block inside the existing `describe("loadProjectBuildState", ...)` in `load-project-builds.test.ts`)

```ts
  it("maps the perf columns onto BuildSummary, defaulting missing to null", async () => {
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        return [
          {
            id: "build_perf",
            status: "ready",
            failed_phase: null,
            preview_url: "https://p.example",
            page_count: 4,
            block_type_count: 7,
            component_count: 7,
            fidelity_avg: "0.91",
            created_at: "2026-06-03T00:00:00Z",
            finished_at: "2026-06-03T00:05:00Z",
            ttfb_ms: 38,
            load_ms: 812,
            transfer_bytes: 45678,
          },
        ];
      }
      return [];
    });
    const result = await loadProjectBuildState(supabase, "proj_perf");
    expect(result.latestBuild?.ttfbMs).toBe(38);
    expect(result.latestBuild?.loadMs).toBe(812);
    expect(result.latestBuild?.transferBytes).toBe(45678);

    const noPerf = makeChain((table) => {
      if (table === "site_builds") {
        return [
          {
            id: "build_noperf",
            status: "ready",
            failed_phase: null,
            preview_url: null,
            page_count: null,
            block_type_count: null,
            component_count: null,
            fidelity_avg: null,
            created_at: "2026-06-03T00:00:00Z",
            finished_at: null,
          },
        ];
      }
      return [];
    });
    const resultNoPerf = await loadProjectBuildState(noPerf, "proj_noperf");
    expect(resultNoPerf.latestBuild?.ttfbMs).toBeNull();
    expect(resultNoPerf.latestBuild?.loadMs).toBeNull();
    expect(resultNoPerf.latestBuild?.transferBytes).toBeNull();
  });
```

- [ ] **Step 2: Run it, verify it FAILS**

```
pnpm --filter @jab/web exec vitest run lib/jab/load-project-builds.test.ts
```

Expected: `result.latestBuild?.ttfbMs` is `undefined` (property doesn't exist on the mapped object yet) → `expect(undefined).toBe(38)` fails. TypeScript may also flag the missing property; the runtime assertion is the failing signal.

- [ ] **Step 3: Minimal implementation**

In `load-project-builds.ts`, extend the `BuildSummary` interface. Current trailing fields:

```ts
  fidelityAvg: string | null;
  createdAt: string;
  finishedAt: string | null;
}
```

Change to:

```ts
  fidelityAvg: string | null;
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
}
```

Extend the `site_builds` SELECT string (currently):

```ts
        "id, status, failed_phase, preview_url, page_count, block_type_count, component_count, fidelity_avg, created_at, finished_at",
```

to:

```ts
        "id, status, failed_phase, preview_url, page_count, block_type_count, component_count, fidelity_avg, ttfb_ms, load_ms, transfer_bytes, created_at, finished_at",
```

Extend `toBuildSummary` — current body ends:

```ts
    fidelityAvg: (raw.fidelity_avg as string | null) ?? null,
    createdAt: String(raw.created_at),
    finishedAt: (raw.finished_at as string | null) ?? null,
  };
}
```

Change to:

```ts
    fidelityAvg: (raw.fidelity_avg as string | null) ?? null,
    ttfbMs: (raw.ttfb_ms as number | null) ?? null,
    loadMs: (raw.load_ms as number | null) ?? null,
    // transfer_bytes is BIGINT. Phase 0's schema note warns it can arrive as
    // a string (postgres.js / Drizzle path); coerce explicitly so BuildSummary
    // always carries a JS number even if the supabase-js REST client returns
    // a string for out-of-range values. (null stays null.)
    transferBytes: raw.transfer_bytes == null ? null : Number(raw.transfer_bytes),
    createdAt: String(raw.created_at),
    finishedAt: (raw.finished_at as string | null) ?? null,
  };
}
```

- [ ] **Step 4: Run, verify PASS**

```
pnpm --filter @jab/web exec vitest run lib/jab/load-project-builds.test.ts
pnpm --filter @jab/web typecheck
```

Expected: all `load-project-builds` tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/jab/load-project-builds.ts apps/web/lib/jab/load-project-builds.test.ts
git commit -m "feat(saas): surface ttfb/load/transfer perf cols on BuildSummary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Pure `build-quick-stats.ts` (omit-null) + tests

**Files:**
- Create: `apps/web/lib/jab/build-quick-stats.ts`
- Test: `apps/web/lib/jab/build-quick-stats.test.ts`

Builds the header quick-stat row from a `BuildSummary` + the project's `content_ownership` map. **Every stat whose underlying value is null is omitted entirely** — never rendered as `0` or `—` (spec §3.1 guardrail "No invented numbers"). There is no `Lighthouse` stat (no measurement source — dropped) and no `Build time` stat (not measured this round). The five candidate stats and their sources:

| Label | Source | Format |
|-------|--------|--------|
| `Content types` | `ownership` key count (fallback `BuildSummary.blockTypeCount`) | integer |
| `Content items` | `BuildSummary.pageCount` | integer |
| `Components` | `BuildSummary.componentCount` | integer |
| `Fidelity` | `BuildSummary.fidelityAvg` (NUMERIC string 0–1) | `NN%` |
| `TTFB` | `BuildSummary.ttfbMs` | `NNms` |
| `Load` | `BuildSummary.loadMs` | `NNms` (or `N.Ns` when ≥1000) |

`ContentOwnership` is the same shape the page already uses inline (`Record<string, "wp-managed" | "jab-managed">`); define it once here and export it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/build-quick-stats.test.ts
import { describe, it, expect } from "vitest";
import { buildQuickStats, type ContentOwnership } from "./build-quick-stats";
import type { BuildSummary } from "./load-project-builds";

function build(overrides: Partial<BuildSummary> = {}): BuildSummary {
  return {
    id: "b1",
    status: "ready",
    failedPhase: null,
    previewUrl: "https://p.example",
    pageCount: 12,
    blockTypeCount: 8,
    componentCount: 8,
    fidelityAvg: "0.91",
    ttfbMs: 38,
    loadMs: 812,
    transferBytes: 45678,
    createdAt: "2026-06-03T00:00:00Z",
    finishedAt: "2026-06-03T00:05:00Z",
    ...overrides,
  };
}

const OWNERSHIP: ContentOwnership = {
  posts: "wp-managed",
  pages: "wp-managed",
  beers: "jab-managed",
};

describe("buildQuickStats", () => {
  it("builds the full stat row when every value is present", () => {
    const stats = buildQuickStats(build(), OWNERSHIP);
    const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.value]));
    expect(byLabel["Content types"]).toBe("3"); // 3 ownership keys
    expect(byLabel["Content items"]).toBe("12");
    expect(byLabel["Components"]).toBe("8");
    expect(byLabel["Fidelity"]).toBe("91%");
    expect(byLabel["TTFB"]).toBe("38ms");
    expect(byLabel["Load"]).toBe("0.8s"); // 812ms -> 0.8s
  });

  it("omits a stat whose value is null — never renders 0 or a dash", () => {
    const stats = buildQuickStats(
      build({ pageCount: null, fidelityAvg: null, ttfbMs: null, loadMs: null }),
      OWNERSHIP,
    );
    const labels = stats.map((s) => s.label);
    expect(labels).not.toContain("Content items");
    expect(labels).not.toContain("Fidelity");
    expect(labels).not.toContain("TTFB");
    expect(labels).not.toContain("Load");
    // surviving stats are still present
    expect(labels).toContain("Content types");
    expect(labels).toContain("Components");
  });

  it("falls back to blockTypeCount for Content types when ownership is null", () => {
    const stats = buildQuickStats(build({ blockTypeCount: 5 }), null);
    const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.value]));
    expect(byLabel["Content types"]).toBe("5");
  });

  it("omits Content types when ownership is null AND blockTypeCount is null", () => {
    const stats = buildQuickStats(build({ blockTypeCount: null }), null);
    expect(stats.map((s) => s.label)).not.toContain("Content types");
  });

  it("formats sub-second load times in ms and second-plus in seconds", () => {
    const fast = buildQuickStats(build({ loadMs: 640 }), OWNERSHIP);
    expect(Object.fromEntries(fast.map((s) => [s.label, s.value]))["Load"]).toBe("640ms");
    const slow = buildQuickStats(build({ loadMs: 2150 }), OWNERSHIP);
    expect(Object.fromEntries(slow.map((s) => [s.label, s.value]))["Load"]).toBe("2.2s");
  });

  it("returns an empty array when nothing is measured", () => {
    const stats = buildQuickStats(
      build({
        pageCount: null,
        blockTypeCount: null,
        componentCount: null,
        fidelityAvg: null,
        ttfbMs: null,
        loadMs: null,
      }),
      null,
    );
    expect(stats).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS**

```
pnpm --filter @jab/web exec vitest run lib/jab/build-quick-stats.test.ts
```

Expected: cannot resolve `./build-quick-stats`.

- [ ] **Step 3: Minimal implementation**

```ts
// apps/web/lib/jab/build-quick-stats.ts
import type { BuildSummary } from "./load-project-builds";

/**
 * build-quick-stats — the project header's quick-stat row, built ONLY
 * from measured values. Spec §3.1: any stat whose source is null is
 * omitted entirely (never shown as 0 or "—"); builds predating migration
 * 0028 have null perf and simply don't render TTFB/Load. There is no
 * Lighthouse stat (no measurement source) and no Build-time stat (not
 * measured this round).
 */

export type ContentOwnership = Record<string, "wp-managed" | "jab-managed">;

export interface QuickStat {
  label: string;
  value: string;
}

/** Push a stat only when `value` is non-null. */
function pushIf(out: QuickStat[], label: string, value: string | null): void {
  if (value !== null) out.push({ label, value });
}

function fidelityPercent(avg: string | null): string | null {
  if (avg === null) return null;
  const parsed = Number.parseFloat(avg);
  if (!Number.isFinite(parsed)) return null;
  return `${Math.round(parsed * 100)}%`;
}

function loadDisplay(loadMs: number | null): string | null {
  if (loadMs === null) return null;
  if (loadMs >= 1000) return `${(loadMs / 1000).toFixed(1)}s`;
  return `${loadMs}ms`;
}

function contentTypeCount(
  b: BuildSummary,
  ownership: ContentOwnership | null,
): string | null {
  if (ownership) return String(Object.keys(ownership).length);
  if (b.blockTypeCount !== null) return String(b.blockTypeCount);
  return null;
}

export function buildQuickStats(
  b: BuildSummary,
  ownership: ContentOwnership | null,
): QuickStat[] {
  const stats: QuickStat[] = [];
  pushIf(stats, "Content types", contentTypeCount(b, ownership));
  pushIf(stats, "Content items", b.pageCount === null ? null : String(b.pageCount));
  pushIf(stats, "Components", b.componentCount === null ? null : String(b.componentCount));
  pushIf(stats, "Fidelity", fidelityPercent(b.fidelityAvg));
  pushIf(stats, "TTFB", b.ttfbMs === null ? null : `${b.ttfbMs}ms`);
  pushIf(stats, "Load", loadDisplay(b.loadMs));
  return stats;
}
```

- [ ] **Step 4: Run, verify PASS**

```
pnpm --filter @jab/web exec vitest run lib/jab/build-quick-stats.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/jab/build-quick-stats.ts apps/web/lib/jab/build-quick-stats.test.ts
git commit -m "feat(saas): build-quick-stats omits null-valued stats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — `load-project-content.ts` (Content tab loader) + test

**Files:**
- Create: `apps/web/lib/jab/load-project-content.ts`
- Test: `apps/web/lib/jab/load-project-content.test.ts`

Loads the Content tab's two lists for a build: pages (from `page_inventory`) and block types (from `block_inventory`). The caller passes an RLS-scoped client; the function performs no permission check of its own (the page route already does the `notFound()` gate). Shapes are minimal — only what the Content tab renders.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/load-project-content.test.ts
import { describe, it, expect, vi } from "vitest";
import { loadProjectContent } from "./load-project-content";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeChain(resolver: (table: string) => unknown) {
  return {
    from: vi.fn((table: string) => {
      const data = resolver(table);
      const builder: Record<string, unknown> = {};
      const terminal = { data, error: null };
      builder.select = vi.fn().mockReturnValue(builder);
      builder.eq = vi.fn().mockReturnValue(builder);
      // .order is the terminal awaited method for both queries.
      builder.order = vi.fn().mockResolvedValue(terminal);
      builder.then = (resolve: (v: typeof terminal) => unknown) =>
        Promise.resolve(terminal).then(resolve);
      return builder;
    }),
  } as unknown as SupabaseClient;
}

describe("loadProjectContent", () => {
  it("maps page_inventory and block_inventory rows to the content shape", async () => {
    const supabase = makeChain((table) => {
      if (table === "page_inventory") {
        return [
          { id: "p1", slug: "home", post_type: "page", title: "Home", route_path: "/", block_count: 6 },
          { id: "p2", slug: "about", post_type: "page", title: null, route_path: "/about", block_count: 3 },
        ];
      }
      if (table === "block_inventory") {
        return [
          { block_name: "core/heading", occurrence_count: 14, page_slugs: ["home", "about"] },
          { block_name: "acf/hero", occurrence_count: 2, page_slugs: ["home"] },
        ];
      }
      return [];
    });
    const result = await loadProjectContent(supabase, "build_1");
    expect(result.pages).toEqual([
      { id: "p1", slug: "home", postType: "page", title: "Home", routePath: "/", blockCount: 6 },
      { id: "p2", slug: "about", postType: "page", title: null, routePath: "/about", blockCount: 3 },
    ]);
    expect(result.blockTypes).toEqual([
      { blockName: "core/heading", occurrenceCount: 14, pageCount: 2 },
      { blockName: "acf/hero", occurrenceCount: 2, pageCount: 1 },
    ]);
  });

  it("returns empty arrays when the build has no inventory", async () => {
    const supabase = makeChain(() => []);
    const result = await loadProjectContent(supabase, "empty");
    expect(result.pages).toEqual([]);
    expect(result.blockTypes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS**

```
pnpm --filter @jab/web exec vitest run lib/jab/load-project-content.test.ts
```

Expected: cannot resolve `./load-project-content`.

- [ ] **Step 3: Minimal implementation**

```ts
// apps/web/lib/jab/load-project-content.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * load-project-content — the Content tab's data accessor. Pulls the page
 * list (page_inventory) and the unique block-type catalog (block_inventory)
 * for a single build. The caller (the Content tab route) is responsible
 * for the RLS membership / notFound() gate; this accessor just maps rows.
 */

export interface ContentPageRow {
  id: string;
  slug: string;
  postType: string;
  title: string | null;
  routePath: string;
  blockCount: number;
}

export interface ContentBlockTypeRow {
  blockName: string;
  occurrenceCount: number;
  /** number of distinct pages the block appears on (page_slugs length). */
  pageCount: number;
}

export interface ProjectContent {
  pages: ContentPageRow[];
  blockTypes: ContentBlockTypeRow[];
}

export async function loadProjectContent(
  supabase: SupabaseClient,
  buildId: string,
): Promise<ProjectContent> {
  const [{ data: pages }, { data: blocks }] = await Promise.all([
    supabase
      .from("page_inventory")
      .select("id, slug, post_type, title, route_path, block_count")
      .eq("site_build_id", buildId)
      .order("route_path", { ascending: true }),
    supabase
      .from("block_inventory")
      .select("block_name, occurrence_count, page_slugs")
      .eq("site_build_id", buildId)
      .order("occurrence_count", { ascending: false }),
  ]);

  const pageRows = (pages ?? []) as Array<{
    id: string;
    slug: string;
    post_type: string;
    title: string | null;
    route_path: string;
    block_count: number | null;
  }>;
  const blockRows = (blocks ?? []) as Array<{
    block_name: string;
    occurrence_count: number | null;
    page_slugs: string[] | null;
  }>;

  return {
    pages: pageRows.map((p) => ({
      id: String(p.id),
      slug: String(p.slug),
      postType: String(p.post_type),
      title: p.title ?? null,
      routePath: String(p.route_path),
      blockCount: p.block_count ?? 0,
    })),
    blockTypes: blockRows.map((b) => ({
      blockName: String(b.block_name),
      occurrenceCount: b.occurrence_count ?? 0,
      pageCount: (b.page_slugs ?? []).length,
    })),
  };
}
```

- [ ] **Step 4: Run, verify PASS**

```
pnpm --filter @jab/web exec vitest run lib/jab/load-project-content.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/jab/load-project-content.ts apps/web/lib/jab/load-project-content.test.ts
git commit -m "feat(saas): add loadProjectContent for the Content tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Move surviving mock interfaces to `mocks-types.ts`; purge `mocks.ts`

**Files:**
- Create: `apps/web/app/(app)/projects/[id]/mocks-types.ts`
- Modify: `apps/web/app/(app)/projects/[id]/mocks.ts` (delete it after the move; see note)
- Modify: `apps/web/app/(app)/projects/[id]/page.tsx` (one import line — fully changed in Task 6, so here only the import path moves)

The page (today) imports `SITE_DETAIL_MOCKS`, `AiPromptHistoryRow`, `DeployRow`, `QuickStat`, `WpConnection` from `./mocks`. After this phase the page no longer needs `SITE_DETAIL_MOCKS` or `QuickStat` (it imports `QuickStat` from `build-quick-stats.ts`), but it still references `DeployRow`, `WpConnection`, and `AiPromptHistoryRow` as render-row shapes. Move those type-only interfaces to `mocks-types.ts` and delete `mocks.ts` (all data literals are gone). `LighthouseScores`, `SiteDetailMocks`, `DeployEnv`, `DeployStatus` are not referenced by the page after the purge — drop them.

> No unit test for this task (pure type relocation + deletion). Verification is `typecheck` after Task 6 wires the new imports. This task is a refactor seam; commit it together with Task 6's page edit so the tree never has a dangling import. **Do Steps 1–2 here, then proceed directly into Task 6 before committing — they share one commit.**

- [ ] **Step 1: Create `mocks-types.ts`** with the surviving interfaces (copied verbatim from `mocks.ts`):

```ts
// apps/web/app/(app)/projects/[id]/mocks-types.ts

/**
 * Row-shape interfaces for the Site Detail page. These describe the shape
 * of rows the page renders; the data is now real (deploy history from
 * `deployments`, AI history from `workspace_edits`, WP connection derived
 * from project columns). The fabricated literals that used to live beside
 * them were deleted in the Phase-3 dashboard-real-data work.
 */

export type DeployEnv = "prod" | "preview";
export type DeployStatus = "live" | "ready" | "failed";

export interface DeployRow {
  id: string;
  env: DeployEnv;
  message: string;
  status: DeployStatus;
  /** Human-readable relative timestamp, e.g. "2m ago". */
  when: string;
}

export interface WpConnection {
  endpoint: string;
  lastSyncRelative: string;
  contentTypes: string[];
  hiddenContentTypeCount: number;
  autoSyncDescription: string;
}

export interface AiPromptHistoryRow {
  prompt: string;
  /** "Deployed" | "Failed" | "Pending" — drives chip tone. */
  status: "deployed" | "failed" | "pending";
  when: string;
  deployId: string;
}
```

- [ ] **Step 2: Delete `mocks.ts`.** Run:

```
git rm "apps/web/app/(app)/projects/[id]/mocks.ts"
```

(The `QuickStat` interface is intentionally not carried over — the page imports it from `build-quick-stats.ts` in Task 6.)

- [ ] **Step 3 / 4 / 5:** Verification + commit happen at the end of Task 6 (shared commit). Do not commit yet.

---

## Task 6 — Rewire `projects/[id]/page.tsx`: real stats, real AI history, real tabs, real deploy labels

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/page.tsx`

This is the page's substantive change. Specific edits (all referenced against the file you read):

1. **Imports.** Replace the `./mocks` import (L11–17) and add the new modules.
2. **Header status word — NOT this task.** The header chip's shared status word is owned and rendered by Phase 1 Task 8 (it edits this same file). This task leaves `headerStatusFor`/`<StatusChip status={status} />` untouched and does not import `deriveProjectStatusLabel`. See edit (d).
3. **Quick stats.** Build from `buildQuickStats(latestBuild, ownership)` instead of `SITE_DETAIL_MOCKS.quickStats`. Render only when there is at least one stat.
4. **AI history.** From `loadWorkspaceEditHistory(project.id, 5)`, mapped to `AiPromptHistoryRow`. Remove the credits chip (drop `aiCreditsRemaining`).
5. **Deploy history message.** Read `config.mode`/`config.prompt` off the build row joined to each deployment (we already load `buildState.deployHistory`; the build's config is **not** on the deployment row, so load a small `site_builds(id, config)` map for the deploy history's build ids).
6. **Tabs.** Replace the four `<InactiveTab>` spans with real `<Link>` tabs. (The tab bar itself moves to `layout.tsx` in Task 7; this page's inline tab block is removed because the layout renders it. See the edit below.)

- [ ] **Step 1 (no isolated unit test — wiring).** Edit `page.tsx`:

**(a) Imports.** Replace:

```ts
import {
  SITE_DETAIL_MOCKS,
  type AiPromptHistoryRow,
  type DeployRow,
  type QuickStat,
  type WpConnection,
} from "./mocks";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { triggerBuildFormAction } from "@/lib/actions/trigger-build";
import { phaseLabel } from "@/lib/jab/build-status";
import { formatRelative } from "@/lib/format-relative";
```

with:

```ts
import {
  type AiPromptHistoryRow,
  type DeployRow,
  type WpConnection,
} from "./mocks-types";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { buildQuickStats, type ContentOwnership, type QuickStat } from "@/lib/jab/build-quick-stats";
import { loadWorkspaceEditHistory } from "@/lib/actions/workspace-edit";
import { triggerBuildFormAction } from "@/lib/actions/trigger-build";
import { phaseLabel } from "@/lib/jab/build-status";
import { formatRelative } from "@/lib/format-relative";
import type { BuildConfig } from "@/lib/jab/build-config";
import { createAdminClient } from "@/lib/supabase/admin";
```

> `BuildConfig` is authored by Phase 2 in `lib/jab/build-config.ts`. If Phase 2 has not merged, type the config locally as `{ mode?: "full" | "edit"; prompt?: string } | null` inline at the read site (Step note below) instead of importing `BuildConfig`. This phase only *reads* `config.mode`/`config.prompt`, never writes the type.

**(b) Replace the mock destructure** (L61–65):

```ts
  const {
    quickStats,
    aiHistory,
    aiCreditsRemaining,
  } = SITE_DETAIL_MOCKS;
```

with real derivation (place after `const buildState = await loadProjectBuildState(...)` at L57):

```ts
  const ownership = project.content_ownership as ContentOwnership | null;
  const quickStats: QuickStat[] = buildState.latestBuild
    ? buildQuickStats(buildState.latestBuild, ownership)
    : [];

  // AI history — real workspace_edits rows for this project, mapped to the
  // render-row shape the AiUpdateCard expects. Status maps from the edit's
  // linked-build readiness conventions: 'completed'/'discarded' carry their
  // own meaning, everything active is "pending".
  const editHistory = await loadWorkspaceEditHistory(project.id, 5);
  const aiHistory: AiPromptHistoryRow[] = editHistory.map((e) => ({
    prompt: e.prompt,
    status:
      e.status === "completed"
        ? "deployed"
        : e.status === "failed" || e.status === "discarded"
          ? "failed"
          : "pending",
    when: formatRelative(new Date(e.createdAt)),
    deployId: e.resultBuildId ? `#${e.resultBuildId.slice(0, 6)}` : "—",
  }));
```

**(c) Deploy-history message from config.** Replace the `deploys` map (L89–99) which currently uses `d.providerDeploymentId` as the message:

```ts
  const deploys = buildState.deployHistory.map<DeployRow>((d) => ({
    id: d.id.slice(0, 6),
    env: d.environment === "production" ? "prod" : "preview",
    message: d.providerDeploymentId ?? "(no provider id)",
    status: d.status === "ready"
      ? d.environment === "production"
        ? "live"
        : "ready"
      : "failed",
    when: d.readyAt ? formatRelative(new Date(d.readyAt)) : formatRelative(new Date(d.createdAt)),
  }));
```

with a config-derived label. First load a `buildId → config` map for the builds referenced by the deploy history (admin client, no extra RLS round-trip — the RLS check already happened on the `projects` SELECT):

```ts
  // Deploy-history labels come from each deployment's source build config:
  // "Full build" vs "AI edit: <prompt excerpt>". The config lives on
  // site_builds, not on the deployment row, so resolve a small id->config
  // map for just the builds in the history (spec §3.1: no second
  // workspace_edits join — read config.mode/config.prompt off the build).
  const deployBuildIds = Array.from(
    new Set(buildState.deployHistory.map((d) => d.siteBuildId)),
  );
  const configByBuildId = new Map<string, BuildConfig | null>();
  if (deployBuildIds.length > 0) {
    const admin = createAdminClient();
    const { data: cfgRows } = await admin
      .from("site_builds")
      .select("id, config")
      .in("id", deployBuildIds);
    for (const row of (cfgRows ?? []) as Array<{ id: string; config: BuildConfig | null }>) {
      configByBuildId.set(String(row.id), row.config ?? null);
    }
  }
  const deployMessage = (config: BuildConfig | null): string => {
    if (config && config.mode === "edit") {
      const excerpt = config.prompt.trim().slice(0, 48);
      return `AI edit: ${excerpt}${config.prompt.trim().length > 48 ? "…" : ""}`;
    }
    return "Full build";
  };
  const deploys = buildState.deployHistory.map<DeployRow>((d) => ({
    id: d.id.slice(0, 6),
    env: d.environment === "production" ? "prod" : "preview",
    message: deployMessage(configByBuildId.get(d.siteBuildId) ?? null),
    status: d.status === "ready"
      ? d.environment === "production"
        ? "live"
        : "ready"
      : "failed",
    when: d.readyAt ? formatRelative(new Date(d.readyAt)) : formatRelative(new Date(d.createdAt)),
  }));
```

**(d) Header status word — owned by Phase 1, NOT this task.** The project-header chip rewrite (replacing `<StatusChip status={status} />` with the shared `deriveProjectStatusLabel` → `projectStatusLabelText` rendering, via Phase 1's `SharedStatusChip`) is **Phase 1 Task 8's** edit of this same file. To avoid two plans rewriting the same lines (and two competing label-text tables), this task does **not** touch the header status word, does **not** import `deriveProjectStatusLabel`, and introduces **no** `STATUS_LABEL_TEXT` const. Leave `const status = headerStatusFor({ live, setupComplete, raw: project.status });` and `<StatusChip status={status} />` exactly as they are — Phase 1 owns and reconciles the shared status word here.

> **Single-renderer rule (cross-plan):** the shared status word is rendered by Phase 1 only — on the dashboard badge (Phase 1 Task 8's `ProjectStatusBadge` rewrite) and on the project-header chip (Phase 1 Task 8's `SharedStatusChip`). Phase 1's `projectStatusLabelText` / `LABEL_TEXT` is the single label-text table; this phase does not duplicate it. If Phase 1 has not merged when you reach this task, do edits (a)–(c) and (e)–(g) and leave the header chip untouched (it already renders via `headerStatusFor`/`StatusChip`); Phase 1 swaps it to the shared word when it lands. There is nothing for this phase to follow up.

**(e) Remove the credits chip.** The `AiUpdateCard` is called with `creditsRemaining={aiCreditsRemaining}` (L284). Change the call site (L282–287):

```tsx
            <AiUpdateCard
              history={aiHistory}
              creditsRemaining={aiCreditsRemaining}
              live={live}
              setupComplete={setupComplete}
            />
```

to:

```tsx
            <AiUpdateCard
              history={aiHistory}
              live={live}
              setupComplete={setupComplete}
            />
```

Update the `AiUpdateCard` signature (L914–924): drop `creditsRemaining` from the props type and destructure, and delete the credits `<span>` block (L941–945). The header `<div>` of the card keeps just the title:

```tsx
function AiUpdateCard({
  history,
  live,
  setupComplete,
}: {
  history: AiPromptHistoryRow[];
  live: boolean;
  setupComplete: boolean;
}) {
```

and replace the card header (L937–946):

```tsx
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          AI Update
        </div>
        {live && (
          <span className="font-mono text-[11px] text-gry-d">
            {creditsRemaining.toLocaleString()} credits left
          </span>
        )}
      </div>
```

with:

```tsx
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          AI Update
        </div>
      </div>
```

**(f) Quick-stats render guard.** The block at L228–234 reads `{live && (...)}`. Change the condition so it renders when there is at least one measured stat (still only while live, since `quickStats` is only built from `latestBuild` and we only show the stat row on a live project per the existing design):

```tsx
        {/* Quick stats — only meaningful once the project is live. */}
        {live && (
          <div className="flex flex-wrap items-center">
            {quickStats.map((stat, idx) => (
              <SiteStat key={stat.label} stat={stat} isFirst={idx === 0} />
            ))}
          </div>
        )}
```

to:

```tsx
        {/* Quick stats — measured numbers only; nothing renders when the
            latest build produced no measurable values (spec §3.1). */}
        {live && quickStats.length > 0 && (
          <div className="flex flex-wrap items-center">
            {quickStats.map((stat, idx) => (
              <SiteStat key={stat.label} stat={stat} isFirst={idx === 0} />
            ))}
          </div>
        )}
```

**(g) Remove the inline tab block** (L236–243) — the tab bar moves to `layout.tsx` (Task 7), which renders for every route under `projects/[id]`. Delete:

```tsx
        {/* Tabs */}
        <div className="mt-1 flex items-center">
          <ActiveTab>Overview</ActiveTab>
          <InactiveTab>Content</InactiveTab>
          <InactiveTab>AI</InactiveTab>
          <InactiveTab>Deploy</InactiveTab>
          <InactiveTab>Settings</InactiveTab>
        </div>
```

and delete the now-unused `ActiveTab` (L699–705) and `InactiveTab` (L707–716) helper components.

> Note: the layout's tab bar lives *outside* the page header (the layout wraps the whole page). The header's `border-b` already provides the visual seam; the tab bar in `layout.tsx` renders directly under it. Visual parity is acceptable — the tabs simply move up one DOM level.

- [ ] **Step 2: Verify (typecheck + build the route).**

```
pnpm --filter @jab/web typecheck
```

Expected: clean. If Phase 2's `BuildConfig` is absent, the barrier note in edit (a) tells you to type the config locally; typecheck must still be clean. This task does not import any Phase 1 module (the header status word is Phase 1 Task 8's edit).

- [ ] **Step 3: Manual smoke (optional but recommended).** With the dev server running, open a live project's `/projects/<id>` and confirm: no Lighthouse stat; TTFB/Load appear only when the build has perf columns; the AI Update card has no "credits left" chip; deploy history rows read "Full build" / "AI edit: …".

- [ ] **Step 4: Commit (shared with Task 5's mock purge).**

```
git add "apps/web/app/(app)/projects/[id]/page.tsx" "apps/web/app/(app)/projects/[id]/mocks-types.ts"
git commit -m "feat(saas): project page renders measured stats + real AI history

Purge fabricated Lighthouse/credits/quickStats; AI history from
workspace_edits; deploy-history labels from build config; quick-stats
from build-quick-stats (omit-null). (Header status word is rendered by
Phase 1 Task 8, not here.)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Shared tab bar `layout.tsx` + four tab routes

**Files:**
- Create: `apps/web/app/(app)/projects/[id]/layout.tsx`
- Create: `apps/web/app/(app)/projects/[id]/tabs/content/page.tsx`
- Create: `apps/web/app/(app)/projects/[id]/tabs/deploy/page.tsx`
- Create: `apps/web/app/(app)/projects/[id]/tabs/ai/page.tsx`
- Create: `apps/web/app/(app)/projects/[id]/tabs/settings/page.tsx`

The layout renders a tab bar above the Overview page and its four sibling tabs. It is a Client Component because the active tab is derived from `usePathname()`. The Overview tab points at the project root; the others point at `/projects/[id]/tabs/{content,deploy,ai,settings}`. **No `cursor-not-allowed` dead ends** — every tab is a real `Link`.

> **Scoping (spec §3.1 blesses the tab bar only for Overview + the four tabs).** Because a Next.js segment layout at `projects/[id]/layout.tsx` wraps *every* nested route — including `onboard/`, `workspace/` (the full-screen Replit-style shell), and `builds/[buildId]/{progress,review}/` (each renders its own full-page chrome) — a naïve tab bar would inject double-chrome over four existing immersive surfaces (workspace especially would look broken). The layout below therefore **hides the tab bar** when `usePathname()` matches `/onboard`, `/workspace`, or `/builds/`; on those paths it renders `children` bare, exactly as today. The drill-in routes are reached from Overview, not from the tab bar, so nothing regresses. Step 6's verification explicitly loads `/workspace` and `/builds/[buildId]/review` to confirm no double-chrome.

Each tab route is an RLS-scoped Server Component that resolves the project (`notFound()` on PGRST116), loads its data, and renders. The Content/Deploy/AI tabs re-present existing data; Settings shows `DesignTokensReview` + a connection summary (never secrets) + a Vercel link + a labeled billing placeholder.

> No isolated unit test — these are Server Components and a Client layout. Verification is typecheck + a manual route smoke. Where a tab has pure derivation (`deployMessage`), it reuses the helper added in Task 6; we keep that helper module-local to the page, so the deploy tab re-declares the same tiny pure function inline (it's 4 lines; extracting a shared module is out of scope for this phase).

- [ ] **Step 1: Create the layout (tab bar).**

```tsx
// apps/web/app/(app)/projects/[id]/layout.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { use } from "react";

/**
 * Project workspace layout — renders the shared tab bar above the Overview
 * page and its four sibling tabs (Content/AI/Deploy/Settings). Active tab is
 * derived from the pathname. Every tab is a real Link (spec §3.1: no
 * cursor-not-allowed dead ends).
 *
 * Scoping (spec §3.1 blesses the tab bar only for Overview + the four tabs):
 * this segment layout also wraps the immersive drill-in routes that live
 * under /projects/[id] — /onboard, /workspace (the full-screen Replit-style
 * shell), and /builds/[buildId]/{progress,review} (each renders its own
 * full-page chrome). Rendering the tab bar over those would be double-chrome
 * and is NOT authorized by the spec, so we hide the tab bar on those paths
 * and render children bare. Those surfaces are reached from Overview, not
 * from the tab bar.
 */
const TABS = [
  { key: "overview", label: "Overview", segment: "" },
  { key: "content", label: "Content", segment: "tabs/content" },
  { key: "ai", label: "AI", segment: "tabs/ai" },
  { key: "deploy", label: "Deploy", segment: "tabs/deploy" },
  { key: "settings", label: "Settings", segment: "tabs/settings" },
] as const;

/**
 * Drill-in route segments that own their own full-page chrome. When the
 * pathname is on (or under) one of these, the tab bar is suppressed.
 */
const IMMERSIVE_SEGMENTS = ["onboard", "workspace", "builds"] as const;

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const pathname = usePathname();
  const base = `/projects/${id}`;

  // Suppress the tab bar on the immersive drill-in routes (onboard /
  // workspace / builds/*) — they render their own full-page chrome and a
  // tab bar over them would be an unblessed double-chrome regression.
  const isImmersive = IMMERSIVE_SEGMENTS.some(
    (seg) => pathname === `${base}/${seg}` || pathname.startsWith(`${base}/${seg}/`),
  );
  if (isImmersive) {
    return <>{children}</>;
  }

  function isActive(segment: string): boolean {
    if (segment === "") {
      // Overview is active on the project root exactly, not on deeper paths.
      return pathname === base;
    }
    return pathname === `${base}/${segment}` || pathname.startsWith(`${base}/${segment}/`);
  }

  return (
    <div className="flex flex-col">
      <nav
        aria-label="Project sections"
        className="sticky top-14 z-30 flex items-center gap-0 border-b border-bord bg-bg px-8"
      >
        {TABS.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const active = isActive(tab.segment);
          return (
            <Link
              key={tab.key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "whitespace-nowrap border-b-2 border-teal px-5 py-3.5 text-sm font-medium text-wht"
                  : "whitespace-nowrap border-b-2 border-transparent px-5 py-3.5 text-sm font-medium text-gry transition-colors hover:text-wht"
              }
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create the Content tab.**

```tsx
// apps/web/app/(app)/projects/[id]/tabs/content/page.tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { loadProjectContent } from "@/lib/jab/load-project-content";

/**
 * Content tab — re-presents the latest build's discovered pages and unique
 * block-type catalog (page_inventory + block_inventory). RLS-scoped;
 * cross-tenant probes resolve as 404.
 */
export const dynamic = "force-dynamic";

export default async function ContentTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .single();
  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const buildState = await loadProjectBuildState(supabase, project.id);
  const buildId = buildState.latestBuild?.id ?? null;
  const content = buildId
    ? await loadProjectContent(supabase, buildId)
    : { pages: [], blockTypes: [] };

  return (
    <div className="flex-1 px-8 py-7">
      {!buildId ? (
        <p className="rounded-lg border border-bord bg-bg px-5 py-6 text-center text-sm text-gry">
          No build yet — trigger a build to discover this site&apos;s pages and blocks.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="overflow-hidden rounded-lg border border-bord bg-bg">
            <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
              Pages ({content.pages.length})
            </div>
            <ul className="divide-y divide-bord">
              {content.pages.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-wht">{p.title || p.slug}</span>
                  <span className="shrink-0 font-mono text-[11px] text-gry-d">{p.routePath}</span>
                  <span className="shrink-0 rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[10px] text-gry">
                    {p.blockCount} blocks
                  </span>
                </li>
              ))}
              {content.pages.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-gry">No pages discovered.</li>
              )}
            </ul>
          </section>
          <section className="overflow-hidden rounded-lg border border-bord bg-bg">
            <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
              Block types ({content.blockTypes.length})
            </div>
            <ul className="divide-y divide-bord">
              {content.blockTypes.map((b) => (
                <li key={b.blockName} className="flex items-center gap-3 px-5 py-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-wht">{b.blockName}</span>
                  <span className="shrink-0 font-mono text-[11px] text-gry-d">
                    {b.occurrenceCount}× · {b.pageCount} page{b.pageCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
              {content.blockTypes.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-gry">No blocks discovered.</li>
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the Deploy tab.**

```tsx
// apps/web/app/(app)/projects/[id]/tabs/deploy/page.tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { formatRelative } from "@/lib/format-relative";
import type { BuildConfig } from "@/lib/jab/build-config";

/**
 * Deploy tab — full deploy history (newest first) with config-derived
 * labels ("Full build" / "AI edit: <excerpt>"). RLS-scoped; 404 on
 * cross-tenant. The config lives on site_builds, resolved via a small
 * id->config map (same approach as the Overview deploy-history card).
 */
export const dynamic = "force-dynamic";

function deployMessage(config: BuildConfig | null): string {
  if (config && config.mode === "edit") {
    const trimmed = config.prompt.trim();
    return `AI edit: ${trimmed.slice(0, 48)}${trimmed.length > 48 ? "…" : ""}`;
  }
  return "Full build";
}

export default async function DeployTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .single();
  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const buildState = await loadProjectBuildState(supabase, project.id);
  const buildIds = Array.from(new Set(buildState.deployHistory.map((d) => d.siteBuildId)));
  const configByBuildId = new Map<string, BuildConfig | null>();
  if (buildIds.length > 0) {
    const admin = createAdminClient();
    const { data: cfgRows } = await admin
      .from("site_builds")
      .select("id, config")
      .in("id", buildIds);
    for (const row of (cfgRows ?? []) as Array<{ id: string; config: BuildConfig | null }>) {
      configByBuildId.set(String(row.id), row.config ?? null);
    }
  }

  return (
    <div className="flex-1 px-8 py-7">
      <section className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
          Deploy history
        </div>
        <ul className="divide-y divide-bord">
          {buildState.deployHistory.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
              <span className="w-[60px] shrink-0 font-mono text-[11px] text-gry-d">{d.id.slice(0, 6)}</span>
              <span
                className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
                  d.environment === "production"
                    ? "border-teal/20 bg-teal/10 text-teal"
                    : "border-bord bg-elev text-gry-d"
                }`}
              >
                {d.environment === "production" ? "prod" : "preview"}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-gry">
                {deployMessage(configByBuildId.get(d.siteBuildId) ?? null)}
              </span>
              <span
                className={`shrink-0 font-mono text-[11px] ${
                  d.status === "ready" ? "text-teal" : d.status === "failed" ? "text-red" : "text-gry-d"
                }`}
              >
                {d.status}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-gry-d">
                {d.readyAt ? formatRelative(new Date(d.readyAt)) : formatRelative(new Date(d.createdAt))}
              </span>
            </li>
          ))}
          {buildState.deployHistory.length === 0 && (
            <li className="px-5 py-6 text-center text-sm text-gry">No deploys yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
```

> **Phase-2 barrier:** `BuildConfig` is owned by Phase 2. If absent, replace the import with a local `type BuildConfig = { mode?: "full" | "edit"; prompt?: string } | null;` at the top of the deploy tab file (and the page in Task 6). The read sites only touch `mode`/`prompt`.

- [ ] **Step 4: Create the AI tab.**

```tsx
// apps/web/app/(app)/projects/[id]/tabs/ai/page.tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceEditHistory } from "@/lib/actions/workspace-edit";
import { formatRelative } from "@/lib/format-relative";

/**
 * AI tab — the full workspace_edits history for this project (chat-driven
 * + manual targeted edits). RLS-scoped; 404 on cross-tenant.
 */
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  completed: "border-teal/30 bg-teal/10 text-teal",
  queued: "border-amb/30 bg-amb/10 text-amb",
  running: "border-amb/30 bg-amb/10 text-amb",
  failed: "border-red/30 bg-red/10 text-red",
  discarded: "border-bord bg-elev text-gry-d",
};

export default async function AiTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .single();
  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const edits = await loadWorkspaceEditHistory(project.id, 50);

  return (
    <div className="flex-1 px-8 py-7">
      <section className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
          AI edits ({edits.length})
        </div>
        <ul className="divide-y divide-bord">
          {edits.map((e) => (
            <li key={e.id} className="flex flex-col gap-1.5 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="min-w-0 flex-1 truncate text-[13px] text-wht">{e.prompt}</span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                    STATUS_TONE[e.status] ?? STATUS_TONE.queued
                  }`}
                >
                  {e.status}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-gry-d">
                <span>{e.scope}</span>
                <span>·</span>
                <span>{e.target}</span>
                <span>·</span>
                <span>{formatRelative(new Date(e.createdAt))}</span>
                {e.resultBuildId && (
                  <>
                    <span>·</span>
                    <span>build {e.resultBuildId.slice(0, 6)}</span>
                  </>
                )}
              </div>
              {e.errorText && (
                <p className="text-[11px] text-red">{e.errorText}</p>
              )}
            </li>
          ))}
          {edits.length === 0 && (
            <li className="px-5 py-6 text-center text-sm text-gry">
              No AI edits yet — open the Workspace to make one.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Create the Settings tab.**

```tsx
// apps/web/app/(app)/projects/[id]/tabs/settings/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { DesignTokensReview } from "@/components/design-tokens-review";
import { displayDomainFrom } from "@/lib/derive";

/**
 * Settings tab — design context (DesignTokensReview) + a connection
 * summary (never secrets) + a Vercel link when a deployment exists + an
 * explicitly-labeled billing placeholder. No cursor-not-allowed dead ends
 * (spec §3.1).
 */
export const dynamic = "force-dynamic";

export default async function SettingsTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, wp_url, design_tokens, personality, content_ownership")
    .eq("id", id)
    .single();
  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const buildState = await loadProjectBuildState(supabase, project.id);
  const productionUrl = buildState.productionDeployment?.url ?? null;
  const ownership = project.content_ownership as Record<string, "wp-managed" | "jab-managed"> | null;
  const contentTypeCount = ownership ? Object.keys(ownership).length : 0;

  return (
    <div className="flex-1 space-y-4 px-8 py-7">
      <DesignTokensReview
        tokens={project.design_tokens as Parameters<typeof DesignTokensReview>[0]["tokens"]}
        personality={project.personality as Parameters<typeof DesignTokensReview>[0]["personality"]}
      />

      <section className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
          Connection
        </div>
        <div className="flex items-center gap-3 border-b border-bord px-5 py-3.5">
          <div className="w-28 shrink-0 font-mono text-[11px] text-gry-d">WordPress</div>
          <div className="min-w-0 flex-1 font-mono text-xs text-blue">
            {displayDomainFrom(project.wp_url) || "—"}
          </div>
        </div>
        <div className="flex items-center gap-3 border-b border-bord px-5 py-3.5">
          <div className="w-28 shrink-0 font-mono text-[11px] text-gry-d">Content types</div>
          <div className="min-w-0 flex-1 text-sm text-wht">{contentTypeCount}</div>
        </div>
        <div className="flex items-center gap-3 px-5 py-3.5">
          <div className="w-28 shrink-0 font-mono text-[11px] text-gry-d">Hosting</div>
          <div className="min-w-0 flex-1 text-sm text-wht">
            {productionUrl ? (
              <Link
                href={productionUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-xs text-teal hover:underline"
              >
                {productionUrl.replace(/^https?:\/\//, "")} →
              </Link>
            ) : (
              <span className="text-gry">Not deployed yet</span>
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="border-b border-bord px-5 py-3.5 text-sm font-bold text-wht">
          Billing &amp; credits
        </div>
        <p className="px-5 py-6 text-sm text-gry">
          Billing &amp; credits — not available yet. Per-site subscription billing ships in a future release.
        </p>
      </section>
    </div>
  );
}
```

> **Note on `project.design_tokens`/`personality`:** confirm both columns exist in `projects` (the onboarding flow persists them). If a column name differs, adjust the SELECT and the `Parameters<...>` casts. The `DesignTokensReview` component already renders a `DesignTokensPending` empty state when both are null, so passing `null` is safe.

- [ ] **Step 6: Verify (typecheck + route smoke).**

```
pnpm --filter @jab/web typecheck
```

Then, with the dev server running, visit `/projects/<id>`, `/projects/<id>/tabs/content`, `/tabs/deploy`, `/tabs/ai`, `/tabs/settings` and confirm: the tab bar shows on each with the correct tab active, no `cursor-not-allowed` anywhere, and the Settings billing card reads "not available yet". Cross-tenant: a project id you don't own resolves to 404 on every tab.

**Double-chrome check (required — the layout must NOT wrap the immersive routes).** Load `/projects/<id>/workspace` and `/projects/<id>/builds/<buildId>/review` (and, if reachable, `/onboard` and `/builds/<buildId>/progress`) and confirm the project tab bar does **not** render over them — each drill-in surface shows only its own full-page chrome, exactly as it did before this phase. If a tab bar appears above the workspace shell or the review screen, the `IMMERSIVE_SEGMENTS` suppression in `layout.tsx` is wrong — fix it (do not ship the regression).

- [ ] **Step 7: Commit**

```
git add "apps/web/app/(app)/projects/[id]/layout.tsx" "apps/web/app/(app)/projects/[id]/tabs"
git commit -m "feat(saas): real Content/Deploy/AI/Settings tabs + shared tab bar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Dashboard "Live · updating" regression test (rendering owned by Phase 1)

**Files:**
- Create: `apps/web/app/(app)/dashboard/dashboard-status.test.ts` (regression fixture only)

**Ownership (cross-plan):** the dashboard `ProjectStatusBadge` rewrite and the project-header chip rewrite are **Phase 1 Task 8's** edits — Phase 1 authors `lib/jab/project-status-label.ts` (`deriveProjectStatusLabel`, `projectStatusLabelText`, the single `LABEL_TEXT` table) and is the **sole renderer** of the shared status word on both surfaces. This phase does **not** rewrite `ProjectStatusBadge`, does **not** add a `dashboard-status.ts` helper, and does **not** introduce a second label-text table (`STATUS_LABEL_TEXT` / `SHARED_LABEL_TEXT`). Two plans rewriting the same `dashboard/page.tsx` lines with competing label tables (`in-setup → "In setup"` vs `"Setup"` vs `"Draft"`) would be a merge conflict; Phase 1 reconciles `in-setup` to a single string. The only thing this phase owns for the dashboard is the **regression guarantee**: a live project with an in-flight edit must read "Live · updating".

`deriveProjectStatusLabel`'s `editAwaitingReview` is an **optional top-level input field** (Phase 1 defines it as optional and *reads* it, not derives it). The dashboard simply **omits** `editAwaitingReview`, which defaults false — collapsing "needs-review" into "Live", as intended. There is no hedge here: the field is optional, so omitting it is correct.

- [ ] **Step 1: Write the regression test.** It asserts Phase 1's pure `deriveProjectStatusLabel` returns `"live-updating"` for the dashboard's inputs and that Phase 1's `projectStatusLabelText` renders that as "Live · updating" — exercised against the Phase-1-owned module directly (no Phase-3 helper). Create:

```ts
// apps/web/app/(app)/dashboard/dashboard-status.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveProjectStatusLabel,
  projectStatusLabelText,
} from "@/lib/jab/project-status-label";

/**
 * Phase-3 regression guarantee: the dashboard badge speaks the shared status
 * word, and a live project with an in-flight edit reads "Live · updating".
 * Rendering itself is owned by Phase 1 (ProjectStatusBadge); this fixture
 * pins the label that Phase-1-rendered badge must show for the dashboard's
 * inputs. editAwaitingReview is an optional input field and the dashboard
 * omits it (defaults false → collapses needs-review into Live).
 */
describe("dashboard shared status word", () => {
  it("a live project with an in-flight build reads 'Live · updating'", () => {
    const label = deriveProjectStatusLabel({
      productionDeployment: { id: "dep_1" },
      hasActiveBuild: true,
      latestBuild: { status: "discovering" },
      // editAwaitingReview omitted — dashboard collapses needs-review into Live.
    });
    expect(label).toBe("live-updating");
    expect(projectStatusLabelText(label).label).toBe("Live · updating");
  });

  it("a live project with nothing building reads 'Live'", () => {
    const label = deriveProjectStatusLabel({
      productionDeployment: { id: "dep_1" },
      hasActiveBuild: false,
      latestBuild: { status: "ready" },
    });
    expect(label).toBe("live");
    expect(projectStatusLabelText(label).label).toBe("Live");
  });

  it("an in-flight build on a not-yet-live project reads 'Building'", () => {
    const label = deriveProjectStatusLabel({
      productionDeployment: null,
      hasActiveBuild: true,
      latestBuild: { status: "discovering" },
    });
    expect(label).toBe("building");
    expect(projectStatusLabelText(label).label).toBe("Building");
  });
});
```

- [ ] **Step 2: Run it.**

```
pnpm --filter @jab/web exec vitest run "app/(app)/dashboard/dashboard-status.test.ts"
```

Expected: passes **once Phase 1 has merged** (the import resolves and the labels match Phase 1's `LABEL_TEXT`). If Phase 1 is not yet merged, the import fails to resolve — that is the same Phase-1 barrier the other tasks carry; land this test once `project-status-label.ts` exists.

> **Phase-1 barrier:** `deriveProjectStatusLabel` / `projectStatusLabelText` are Phase-1-owned. Do not stub them here. If Phase 1 has not merged, skip this task and pick it up after; the dashboard badge already renders (via Phase 1 Task 8) when Phase 1 lands.

- [ ] **Step 3: Commit**

```
git add "apps/web/app/(app)/dashboard/dashboard-status.test.ts"
git commit -m "test(saas): dashboard shows 'Live · updating' for live in-flight edit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — Full-suite regression + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite.**

```
pnpm --filter @jab/web test
```

Expected: green, including the four new spec files (`perf-capture`, `build-quick-stats`, `load-project-content`, and the `dashboard-status` regression test) and the extended `load-project-builds` test. The `dashboard-status` test imports Phase 1's `project-status-label` — if Phase 1 has not merged it will fail to resolve; land it after Phase 1. If `load-project-builds.test.ts` fails on the perf assertions, re-check Task 2's `toBuildSummary` map and SELECT string.

- [ ] **Step 2: Typecheck.**

```
pnpm --filter @jab/web typecheck
```

Expected: clean. Common failure: a dangling `./mocks` import — grep for it and ensure every consumer was migrated to `./mocks-types` / `build-quick-stats`:

```
pnpm --filter @jab/web exec rg "from \"\\./mocks\"" "app/(app)/projects/[id]"
```

(should return nothing).

- [ ] **Step 3: Manual smoke of the demoable outcome.** With the dev server running and a live project:
  - `/projects/<id>` shows measured stats only (no Lighthouse, no "credits left"); deploy rows read "Full build" / "AI edit: …"; AI Update card lists real `workspace_edits` prompts.
  - All four tabs load real data; Settings shows the labeled billing placeholder; no `cursor-not-allowed`.
  - Dashboard: a live project with an in-flight edit shows "Live · updating".

- [ ] **Step 4: Commit** (only if Step 1/2 surfaced a fix; otherwise nothing to commit). If a fixup was needed:

```
git add -A
git commit -m "fix(saas): phase-3 regression fixups from full-suite run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done

The phase is shippable (spec §4 Phase 3) when all of the following hold:

- [ ] `extractPerf` is a tested pure module; the `verify-fidelity.ts` worker hook that calls it is owned by Phase 2 (not touched here).
- [ ] `buildQuickStats` omits any stat whose value is null — a live project never shows a fabricated Lighthouse/TTFB/Build number; predating-0028 builds simply don't render TTFB/Load.
- [ ] `BuildSummary` carries `ttfbMs`/`loadMs`/`transferBytes`, mapped in `toBuildSummary`, with the columns in the SELECT.
- [ ] `mocks.ts` is deleted; only type interfaces survive in `mocks-types.ts`; no `SITE_DETAIL_MOCKS` / `lighthouse` / `quickStats` / `aiHistory` / `aiCreditsRemaining` literals remain anywhere.
- [ ] The project page's AI Update card lists real `workspace_edits` rows and has no credits chip; deploy-history rows are labeled from `config.mode`/`config.prompt`. (The header status word is rendered by Phase 1 Task 8, not this phase.)
- [ ] Four real tab routes (`Content`/`Deploy`/`AI`/`Settings`) under a shared `layout.tsx` tab bar; every tab is a real `Link`; no `cursor-not-allowed` dead ends; Settings shows `DesignTokensReview` + connection summary (no secrets) + Vercel link + a labeled "Billing & credits — not available yet" placeholder.
- [ ] The tab-bar `layout.tsx` is scoped: it renders only over Overview + the four tabs and is **suppressed** on the immersive `/onboard`, `/workspace`, and `/builds/…` routes — verified by loading `/workspace` and `/builds/[buildId]/review` and confirming no double-chrome.
- [ ] All tab routes use the RLS client and `notFound()` on PGRST116 (cross-tenant safety).
- [ ] The dashboard badge reads the shared status word (rendered by Phase 1): a live project with an in-flight edit shows "Live · updating" — pinned by this phase's regression test (green).
- [ ] `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck` are both green.
