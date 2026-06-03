---
# Phase 1 — Workspace Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded-empty workspace preview (`previewHtml: null`) with a real sandboxed iframe loading the project's latest Vercel **preview** URL, with honest none/building/ready/failed states, a phase-aware building view, a device toggle, live refresh on building→ready (poll, not full reload), a protected-preview guard, and one shared status word across dashboard/header/workspace.

**Architecture:** Two pure modules (`project-status-label.ts`, `workspace-preview-state.ts`) derive UI state from the already-loaded `ProjectBuildState` (no new queries). A small fetch-guard (`preview-protection.ts`) detects Vercel Deployment Protection. A thin server action (`loadWorkspacePreviewStateAction`) re-derives preview state per poll. A `"use client"` `WorkspacePreviewPane` wraps the existing `PreviewFrame` (external-`src` sandbox + device toggle already built) and owns the poll-while-building effect. The workspace page and the demo's `PreviewPane` are rewired to consume `previewState` instead of `previewHtml`/`srcDoc`; the `/ui-kit` `!project → SiteMock` demo branch is untouched.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM + Supabase (postgres), Inngest workers, Vitest, Tailwind, Anthropic SDK, Vercel REST.

**Spec:** docs/superpowers/specs/2026-06-03-saas-e2e-loop-design.md (this plan implements §3.2 in full, and §2.2 `deriveProjectStatusLabel`).
---

## File Structure

| File | New/Modified | Responsibility |
|------|--------------|----------------|
| `apps/web/lib/jab/project-status-label.ts` | **New (pure)** | `ProjectStatusLabel` type + `deriveProjectStatusLabel(s)` — one shared status word (§2.2). Input `ProjectStatusLabelInput` is the canonical read-subset of `ProjectBuildState` (so a `ProjectBuildState` value is assignable and Phase 3 calls it as `deriveProjectStatusLabel(buildState)`). **Sole renderer** of the shared label module; Phase 3 imports it, never re-implements the label text. |
| `apps/web/lib/jab/project-status-label.test.ts` | **New (test)** | Every branch of `deriveProjectStatusLabel`. |
| `apps/web/lib/jab/workspace-preview-state.ts` | **New (pure)** | `WorkspacePreviewState` union + `deriveWorkspacePreviewState(s)` (§3.2) — none/building/ready/failed with the ready-but-no-preview-row race resolved to building. |
| `apps/web/lib/jab/workspace-preview-state.test.ts` | **New (test)** | Every kind + the two subtle races in §3.2 Guardrails. |
| `apps/web/lib/vercel/preview-protection.ts` | **New (impure)** | `assertPreviewReachable(url)` + `PreviewProtectedError` — HEAD/GET; 401/403 → throw. |
| `apps/web/lib/vercel/preview-protection.test.ts` | **New (test)** | 401/403 throw; 200/3xx pass; network error swallowed. |
| `apps/web/lib/actions/workspace-preview.ts` | **New (impure, "use server")** | `loadWorkspacePreviewStateAction(projectId)`: RLS project SELECT → `loadProjectBuildState` → `deriveWorkspacePreviewState`. |
| `apps/web/components/workspace-preview-pane.tsx` | **New (UI, "use client")** | Wraps `PreviewFrame`; maps `kind → PreviewFrame status`; owns the poll-while-building effect; building state shows the phase + "View full progress" link. |
| `apps/web/app/(app)/projects/[id]/workspace/page.tsx` | **Modify** | Compute `previewState` from the already-loaded `buildState`; drop `previewHtml: null`; pass `previewState`. |
| `apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx` | **Modify** | `WorkspaceProject.previewHtml` → `previewState`; `PreviewPane` renders `<WorkspacePreviewPane>` for real projects; **leave `!project → SiteMock` untouched**; strip the redundant inline device toggle. |
| `apps/web/app/(app)/dashboard/page.tsx` | **Modify** | Render `deriveProjectStatusLabel` in the project card badge. |
| `apps/web/app/(app)/projects/[id]/page.tsx` | **Modify** | Render `deriveProjectStatusLabel` in the project header chip. |

**Reused verbatim (do not edit):** `components/preview-frame.tsx` (external-`src` sandbox + device toggle + idle/deploying/failed placeholders), `components/scaled-iframe.tsx`, `lib/jab/load-project-builds.ts` (`loadProjectBuildState`, `ProjectBuildState`), `lib/jab/build-status.ts` (`phaseLabel`), `lib/inngest/functions/deploy-site.ts` (already writes `preview_url` + the preview `deployments` row — read-only confirmed at lines 197–225).

**Phase boundary notes (cross-plan ownership, do not violate):**
- This phase is the **sole owner of the workspace preview slot** (`WorkspacePreviewPane` / `WorkspacePreviewState`, replacing `previewHtml`). Phases 2/3 consume it; they never touch `previewHtml`/`srcDoc`.
- `deriveProjectStatusLabel` (§2.2) is **authored here**; Phase 3 imports it.
- This phase does **not** author any migration (the 0028–0031 batch is Phase 0) and does **not** touch `edit-site.ts`, `verify-fidelity.ts`, `compose-site.ts`, or `deploy-site.ts`.
- `deriveProjectStatusLabel`'s `editAwaitingReview` branch reads an **optional** field on its input. Phase 1 never populates it (it falls through to `live`); Phase 3/S4 wires the real value via `loadWorkspaceEditState`. Authoring the branch now keeps the function total and stable for downstream imports.

---

## Task 1 — `project-status-label.ts` (pure, §2.2)

The single shared status word. Pure function over the three fields of `ProjectBuildState` plus an optional `editAwaitingReview`. TDD every branch.

**Files:**
- Create: `apps/web/lib/jab/project-status-label.ts`
- Test: `apps/web/lib/jab/project-status-label.test.ts`

### Steps

- [ ] **Step 1: Write the failing test.**

```ts
// apps/web/lib/jab/project-status-label.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveProjectStatusLabel,
  projectStatusLabelText,
  type ProjectStatusLabelInput,
} from "./project-status-label";
import type { ProjectBuildState } from "./load-project-builds";

function base(): ProjectStatusLabelInput {
  return {
    productionDeployment: null,
    hasActiveBuild: false,
    latestBuild: null,
    editAwaitingReview: false,
  };
}

// Compile-time contract: a full ProjectBuildState is accepted by
// deriveProjectStatusLabel (this is what lets Phase 3 call it with the raw
// loadProjectBuildState result — `deriveProjectStatusLabel(buildState)`).
// If this stops compiling, the shared-label contract has drifted.
describe("deriveProjectStatusLabel accepts a full ProjectBuildState", () => {
  it("derives from a real ProjectBuildState value passed directly", () => {
    const buildState: ProjectBuildState = {
      latestBuild: null,
      latestPreview: null,
      productionDeployment: null,
      deployHistory: [],
      hasActiveBuild: false,
    };
    // Passing the *variable* (not a literal-with-extras) is the supported
    // call shape for callers that already hold a ProjectBuildState.
    expect(deriveProjectStatusLabel(buildState)).toBe("in-setup");
  });
});

describe("deriveProjectStatusLabel", () => {
  it("returns 'live-updating' when production exists AND a build is active", () => {
    expect(
      deriveProjectStatusLabel({
        ...base(),
        productionDeployment: { id: "d1" },
        hasActiveBuild: true,
      }),
    ).toBe("live-updating");
  });

  it("returns 'needs-review' when production exists AND an edit awaits review (and no active build)", () => {
    expect(
      deriveProjectStatusLabel({
        ...base(),
        productionDeployment: { id: "d1" },
        editAwaitingReview: true,
      }),
    ).toBe("needs-review");
  });

  it("prioritizes 'live-updating' over 'needs-review' when both an active build and a pending review exist", () => {
    expect(
      deriveProjectStatusLabel({
        ...base(),
        productionDeployment: { id: "d1" },
        hasActiveBuild: true,
        editAwaitingReview: true,
      }),
    ).toBe("live-updating");
  });

  it("returns 'live' when production exists and nothing is in flight", () => {
    expect(
      deriveProjectStatusLabel({
        ...base(),
        productionDeployment: { id: "d1" },
      }),
    ).toBe("live");
  });

  it("returns 'building' when no production but a build is active", () => {
    expect(
      deriveProjectStatusLabel({ ...base(), hasActiveBuild: true }),
    ).toBe("building");
  });

  it("returns 'failed' when no production, no active build, latest build failed", () => {
    expect(
      deriveProjectStatusLabel({
        ...base(),
        latestBuild: { status: "failed" },
      }),
    ).toBe("failed");
  });

  it("returns 'in-setup' otherwise (no production, no active build, no failed build)", () => {
    expect(deriveProjectStatusLabel(base())).toBe("in-setup");
    expect(
      deriveProjectStatusLabel({
        ...base(),
        latestBuild: { status: "cancelled" },
      }),
    ).toBe("in-setup");
  });

  it("treats editAwaitingReview as ignorable when there is no production deployment", () => {
    // An edit awaiting review on a project that was never promoted is still
    // "building"/"in-setup" — needs-review is a *live*-project state only.
    expect(
      deriveProjectStatusLabel({ ...base(), editAwaitingReview: true }),
    ).toBe("in-setup");
  });
});

describe("projectStatusLabelText", () => {
  it("maps every label to a non-empty human string", () => {
    const labels = [
      "in-setup",
      "building",
      "live",
      "live-updating",
      "needs-review",
      "failed",
    ] as const;
    for (const l of labels) {
      const text = projectStatusLabelText(l);
      expect(text.label).toBeTruthy();
      expect(typeof text.label).toBe("string");
      expect(["neutral", "warning", "success", "danger"]).toContain(text.tone);
    }
  });

  it("renders the two live variants as 'Live · …'", () => {
    expect(projectStatusLabelText("live-updating").label).toBe("Live · updating");
    expect(projectStatusLabelText("needs-review").label).toBe("Live · review ready");
    expect(projectStatusLabelText("live").label).toBe("Live");
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/jab/project-status-label.test.ts`
  - Expected: failure — `Cannot find module './project-status-label'` (file does not exist yet).

- [ ] **Step 3: Minimal implementation.**

```ts
// apps/web/lib/jab/project-status-label.ts
import type { ProjectBuildState } from "./load-project-builds";

/**
 * project-status-label — the SINGLE shared status word rendered on the
 * dashboard card, the project header, and the workspace. Resolves the
 * "three different words for the same state" problem (spec §2.2) by
 * deriving one label from the canonical ProjectBuildState fields.
 *
 * Pure. The input is the canonical-subset shape `ProjectStatusLabelInput`,
 * which is exactly the three `ProjectBuildState` fields this function reads
 * (`productionDeployment`/`hasActiveBuild`/`latestBuild`) plus an optional
 * `editAwaitingReview` flag. It is a *structural subset* of ProjectBuildState
 * (see the `_assignableFromProjectBuildState` assertion below), so any caller
 * that already holds a `ProjectBuildState` value passes it directly — e.g.
 * Phase 3's `deriveProjectStatusLabel(buildState)`. This matches the spec
 * §2.2 signature `deriveProjectStatusLabel(s: ProjectBuildState)`: we read the
 * same three fields, only stated as the minimal subset so the dashboard (which
 * holds the lighter `DashboardProjectBuildState`, not a full ProjectBuildState)
 * can synthesize the same input.
 *
 * `editAwaitingReview` is populated by S4's loadWorkspaceEditState in a later
 * phase; absent/false here, so Phase 1 callers get "live" instead of
 * "needs-review" until that wiring lands.
 *
 * IMPORTANT — pass a variable, not a fresh literal-with-extras. Because this
 * is a closed object type, an inline literal carrying excess ProjectBuildState
 * fields (`latestPreview`/`deployHistory`) triggers TS excess-property errors.
 * Callers holding a `ProjectBuildState` MUST pass the variable
 * (`deriveProjectStatusLabel(buildState)`), which is assignable without
 * excess-property checking; callers without one (the dashboard) construct the
 * minimal `ProjectStatusLabelInput` shape directly.
 */

export type ProjectStatusLabel =
  | "in-setup"
  | "building"
  | "live"
  | "live-updating"
  | "needs-review"
  | "failed";

export interface ProjectStatusLabelInput {
  /**
   * The current production deployment row, or null when not live. Only `.id`
   * is read; a full `ProjectBuildState.productionDeployment`
   * (`DeploymentSummary | null`) satisfies this, and the dashboard can supply
   * a synthetic `{ id: "live" }` when it only knows `productionUrl`.
   */
  productionDeployment: { id: string } | null;
  /** True when the latest build is in any active phase (queued..verifying). */
  hasActiveBuild: boolean;
  /** Latest site_builds row (only `.status` is read), or null. */
  latestBuild: { status: string } | null;
  /**
   * True when a *ready, unpromoted* edit build is awaiting review for this
   * live project. Populated by S4 in a later phase; absent/false here.
   */
  editAwaitingReview?: boolean;
}

/**
 * Compile-time proof that a full `ProjectBuildState` is assignable to
 * `ProjectStatusLabelInput` — this is what lets Phase 3 call
 * `deriveProjectStatusLabel(buildState)` with the real loader result. If
 * `ProjectBuildState`'s `productionDeployment`/`latestBuild` shapes ever drift
 * away from the fields read here, this line fails to compile (loud, early).
 */
declare const _assignableFromProjectBuildState: ProjectBuildState &
  Partial<Pick<ProjectStatusLabelInput, "editAwaitingReview">>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _proof: ProjectStatusLabelInput = _assignableFromProjectBuildState;

/**
 * Priority order matches spec §2.2:
 *   productionDeployment && hasActiveBuild     -> "live-updating"
 *   productionDeployment && editAwaitingReview -> "needs-review"
 *   productionDeployment                       -> "live"
 *   hasActiveBuild                             -> "building"
 *   latestBuild?.status === "failed"           -> "failed"
 *   else                                       -> "in-setup"
 */
export function deriveProjectStatusLabel(
  s: ProjectStatusLabelInput,
): ProjectStatusLabel {
  if (s.productionDeployment) {
    if (s.hasActiveBuild) return "live-updating";
    if (s.editAwaitingReview) return "needs-review";
    return "live";
  }
  if (s.hasActiveBuild) return "building";
  if (s.latestBuild?.status === "failed") return "failed";
  return "in-setup";
}

export interface ProjectStatusLabelText {
  label: string;
  tone: "neutral" | "warning" | "success" | "danger";
  /** Whether the status dot should pulse (in-flight states). */
  pulse: boolean;
}

const LABEL_TEXT: Record<ProjectStatusLabel, ProjectStatusLabelText> = {
  "in-setup": { label: "In setup", tone: "neutral", pulse: false },
  building: { label: "Building", tone: "warning", pulse: true },
  live: { label: "Live", tone: "success", pulse: false },
  "live-updating": { label: "Live · updating", tone: "warning", pulse: true },
  "needs-review": { label: "Live · review ready", tone: "success", pulse: true },
  failed: { label: "Failed", tone: "danger", pulse: false },
};

export function projectStatusLabelText(
  label: ProjectStatusLabel,
): ProjectStatusLabelText {
  return LABEL_TEXT[label];
}
```

- [ ] **Step 4: Run, verify PASS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/jab/project-status-label.test.ts`
  - Expected: all tests pass.

- [ ] **Step 5: Commit.**
  - `git add apps/web/lib/jab/project-status-label.ts apps/web/lib/jab/project-status-label.test.ts`
  - `git commit -m "feat(saas): add deriveProjectStatusLabel shared status word (spec §2.2)"`

---

## Task 2 — `workspace-preview-state.ts` (pure, §3.2)

The correctness core of the phase. Derives the preview pane's state from `ProjectBuildState`, resolving every race in §3.2 "Guardrails". TDD every kind + every race.

**Files:**
- Create: `apps/web/lib/jab/workspace-preview-state.ts`
- Test: `apps/web/lib/jab/workspace-preview-state.test.ts`
- Reads (imports): `phaseLabel` from `./build-status`; types from `./load-project-builds`.

### Steps

- [ ] **Step 1: Write the failing test.**

```ts
// apps/web/lib/jab/workspace-preview-state.test.ts
import { describe, it, expect } from "vitest";
import { deriveWorkspacePreviewState } from "./workspace-preview-state";
import type {
  ProjectBuildState,
  BuildSummary,
  DeploymentSummary,
} from "./load-project-builds";

function build(partial: Partial<BuildSummary>): BuildSummary {
  return {
    id: "build_1",
    status: "ready",
    failedPhase: null,
    previewUrl: null,
    pageCount: null,
    blockTypeCount: null,
    componentCount: null,
    fidelityAvg: null,
    createdAt: "2026-06-03T00:00:00Z",
    finishedAt: null,
    ...partial,
  };
}

function preview(partial: Partial<DeploymentSummary>): DeploymentSummary {
  return {
    id: "dpl_1",
    siteBuildId: "build_1",
    environment: "preview",
    status: "ready",
    url: "https://preview-build-1.vercel.app",
    providerDeploymentId: "vercel_1",
    readyAt: "2026-06-03T00:05:00Z",
    createdAt: "2026-06-03T00:04:00Z",
    ...partial,
  };
}

function state(partial: Partial<ProjectBuildState>): ProjectBuildState {
  return {
    latestBuild: null,
    latestPreview: null,
    productionDeployment: null,
    deployHistory: [],
    hasActiveBuild: false,
    ...partial,
  };
}

describe("deriveWorkspacePreviewState", () => {
  it("returns { kind: 'none' } when there is no build at all", () => {
    expect(deriveWorkspacePreviewState(state({}))).toEqual({ kind: "none" });
  });

  it("returns 'ready' with url/buildId/deploymentId when latestPreview is present", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "ready" }),
        latestPreview: preview({}),
      }),
    );
    expect(result).toEqual({
      kind: "ready",
      url: "https://preview-build-1.vercel.app",
      buildId: "build_1",
      deploymentId: "dpl_1",
    });
  });

  it("returns 'building' with the phase label when an active build is in flight (no preview yet)", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "components" }),
        hasActiveBuild: true,
      }),
    );
    expect(result).toEqual({
      kind: "building",
      buildId: "build_1",
      phase: "Generating components",
    });
  });

  it("RACE: status='ready' but preview row not written yet -> 'building', NOT 'none'", () => {
    // record-preview-deployment step hasn't landed; latestPreview is still
    // null. We must keep polling, not flash the empty state. (§3.2 guardrail)
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "ready" }),
        latestPreview: null,
        hasActiveBuild: false,
      }),
    );
    expect(result.kind).toBe("building");
    if (result.kind === "building") {
      expect(result.buildId).toBe("build_1");
      expect(result.phase).toBe("Ready for review");
    }
  });

  it("RACE: status='verifying' but preview row not written yet -> 'building'", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "verifying" }),
        latestPreview: null,
        hasActiveBuild: true,
      }),
    );
    expect(result.kind).toBe("building");
    if (result.kind === "building") {
      expect(result.phase).toBe("Verifying fidelity");
    }
  });

  it("STALE: latestPreview is scoped to latestBuild.id, so a prior build's preview never leaks", () => {
    // load-project-builds already scopes latestPreview to latestBuild.id, so
    // a new in-flight build with a stale-but-unmatched preview yields building.
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ id: "build_2", status: "composing" }),
        latestPreview: null, // loader returned null because dpl_1 was scoped to build_1
        hasActiveBuild: true,
      }),
    );
    expect(result.kind).toBe("building");
    if (result.kind === "building") {
      expect(result.buildId).toBe("build_2");
    }
  });

  it("returns 'failed' with the failed phase when the latest build failed and no preview", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "failed", failedPhase: "building" }),
        latestPreview: null,
      }),
    );
    expect(result).toEqual({
      kind: "failed",
      buildId: "build_1",
      failedPhase: "building",
    });
  });

  it("falls back to the raw status when a failed build has no failedPhase", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "failed", failedPhase: null }),
      }),
    );
    expect(result).toEqual({
      kind: "failed",
      buildId: "build_1",
      failedPhase: "failed",
    });
  });

  it("returns 'none' for a cancelled build with no preview (treated as nothing to show)", () => {
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "cancelled" }),
        latestPreview: null,
      }),
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("prefers 'ready' over 'failed' if a ready preview somehow coexists with a failed build", () => {
    // Defensive: a ready preview row is the strongest signal we have something
    // viewable; never hide a working preview behind a failed flag.
    const result = deriveWorkspacePreviewState(
      state({
        latestBuild: build({ status: "failed", failedPhase: "verifying" }),
        latestPreview: preview({}),
      }),
    );
    expect(result.kind).toBe("ready");
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/jab/workspace-preview-state.test.ts`
  - Expected: failure — `Cannot find module './workspace-preview-state'`.

- [ ] **Step 3: Minimal implementation.**

```ts
// apps/web/lib/jab/workspace-preview-state.ts
import { phaseLabel } from "./build-status";
import { isActiveBuildStatus } from "./build-status";
import type { ProjectBuildState } from "./load-project-builds";

/**
 * workspace-preview-state — pure derivation of the workspace preview pane's
 * state from the canonical ProjectBuildState (spec §3.2). Sole owner of the
 * preview slot's state shape; the UI (WorkspacePreviewPane) renders from it
 * and never re-reads the build state itself.
 *
 * The interesting logic is the ready-but-preview-row-not-written race: a
 * build can be `ready`/`verifying` before deploy-site's
 * record-preview-deployment step has written the preview `deployments` row,
 * so latestPreview is briefly null. We MUST return `building` there (keep
 * polling) rather than `none` (flash empty). See the §3.2 guardrails.
 */

export type WorkspacePreviewState =
  | { kind: "none" }
  | { kind: "building"; buildId: string; phase: string }
  | { kind: "ready"; url: string; buildId: string; deploymentId: string }
  | { kind: "failed"; buildId: string; failedPhase: string };

/** Statuses where a preview row is expected to exist (or arrive imminently). */
const PREVIEW_EXPECTED_STATUSES = new Set(["verifying", "ready"]);

export function deriveWorkspacePreviewState(
  s: ProjectBuildState,
): WorkspacePreviewState {
  const build = s.latestBuild;
  if (!build) return { kind: "none" };

  // Strongest signal: a ready preview row scoped to the latest build. Show it
  // even if the build row says failed (defensive — never hide a working URL).
  const preview = s.latestPreview;
  if (preview && preview.status === "ready" && preview.url) {
    return {
      kind: "ready",
      url: preview.url,
      buildId: build.id,
      deploymentId: preview.id,
    };
  }

  // Active build, no ready preview yet -> building with the live phase label.
  if (s.hasActiveBuild || isActiveBuildStatus(build.status)) {
    return { kind: "building", buildId: build.id, phase: phaseLabel(build.status) };
  }

  // Terminal-but-no-preview races: status is ready/verifying yet the preview
  // row hasn't been written. Keep polling — building, not none.
  if (PREVIEW_EXPECTED_STATUSES.has(build.status)) {
    return { kind: "building", buildId: build.id, phase: phaseLabel(build.status) };
  }

  if (build.status === "failed") {
    return {
      kind: "failed",
      buildId: build.id,
      failedPhase: build.failedPhase ?? "failed",
    };
  }

  // cancelled / anything else with nothing viewable.
  return { kind: "none" };
}
```

- [ ] **Step 4: Run, verify PASS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/jab/workspace-preview-state.test.ts`
  - Expected: all tests pass.

- [ ] **Step 5: Commit.**
  - `git add apps/web/lib/jab/workspace-preview-state.ts apps/web/lib/jab/workspace-preview-state.test.ts`
  - `git commit -m "feat(saas): add deriveWorkspacePreviewState with race handling (spec §3.2)"`

---

## Task 3 — `preview-protection.ts` (impure, fetch-guarded)

Detect Vercel team-level Deployment Protection (SSO wall) so a protected preview surfaces a loud error instead of a blank iframe. TDD with a mocked `fetch`.

**Files:**
- Create: `apps/web/lib/vercel/preview-protection.ts`
- Test: `apps/web/lib/vercel/preview-protection.test.ts`

### Steps

- [ ] **Step 1: Write the failing test.**

```ts
// apps/web/lib/vercel/preview-protection.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "./preview-protection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("assertPreviewReachable", () => {
  it("resolves (no throw) on a 200 response", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("resolves on a 3xx redirect (preview reachable, just redirecting)", async () => {
    stubFetch(async () => new Response(null, { status: 302 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("throws PreviewProtectedError on 401", async () => {
    stubFetch(async () => new Response(null, { status: 401 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).rejects.toBeInstanceOf(
      PreviewProtectedError,
    );
  });

  it("throws PreviewProtectedError on 403", async () => {
    stubFetch(async () => new Response(null, { status: 403 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).rejects.toBeInstanceOf(
      PreviewProtectedError,
    );
  });

  it("the PreviewProtectedError carries the url and a helpful message", async () => {
    stubFetch(async () => new Response(null, { status: 401 }));
    try {
      await assertPreviewReachable("https://x.vercel.app");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PreviewProtectedError);
      const err = e as PreviewProtectedError;
      expect(err.url).toBe("https://x.vercel.app");
      expect(err.message).toMatch(/Deployment Protection/i);
    }
  });

  it("swallows a network error (returns reachable=unknown -> no throw)", async () => {
    // A transient network failure must NOT be reported as protection — only
    // an explicit 401/403 counts. We resolve quietly.
    stubFetch(async () => {
      throw new TypeError("network down");
    });
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("does not throw on other 4xx (e.g. 404) — only 401/403 are protection", async () => {
    stubFetch(async () => new Response(null, { status: 404 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/vercel/preview-protection.test.ts`
  - Expected: failure — `Cannot find module './preview-protection'`.

- [ ] **Step 3: Minimal implementation.**

```ts
// apps/web/lib/vercel/preview-protection.ts
/**
 * preview-protection — detect Vercel team-level Deployment Protection.
 *
 * When an org enables SSO/Deployment Protection, every preview URL returns
 * 401/403 behind a Vercel auth wall. The iframe then shows a blank/login
 * page and the whole live-preview feature looks broken. This guard fires a
 * cheap HEAD (falling back to GET) and throws a tagged PreviewProtectedError
 * on 401/403 so callers can surface a loud, actionable banner instead of a
 * silent blank frame (spec §3.2, R5).
 *
 * Deliberately fail-soft on everything else: a network blip or a 404 is NOT
 * protection, so we resolve quietly and let the iframe attempt the load.
 */

export class PreviewProtectedError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(
      `Preview is protected (HTTP ${status}). Disable Vercel Deployment Protection for previews, or grant access, then reload. URL: ${url}`,
    );
    this.name = "PreviewProtectedError";
    this.url = url;
    this.status = status;
  }
}

async function probe(url: string, method: "HEAD" | "GET"): Promise<number | null> {
  try {
    const res = await fetch(url, { method, redirect: "manual" });
    return res.status;
  } catch {
    // Network error — unknown, not protection.
    return null;
  }
}

/**
 * Throws PreviewProtectedError if the preview URL is gated behind Vercel
 * Deployment Protection (401/403). Resolves for any other outcome.
 */
export async function assertPreviewReachable(url: string): Promise<void> {
  // HEAD first (cheap); some Vercel routes 405 HEAD, so fall back to GET.
  let status = await probe(url, "HEAD");
  if (status === null || status === 405) {
    status = await probe(url, "GET");
  }
  if (status === 401 || status === 403) {
    throw new PreviewProtectedError(url, status);
  }
}
```

- [ ] **Step 4: Run, verify PASS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/vercel/preview-protection.test.ts`
  - Expected: all tests pass.

- [ ] **Step 5: Commit.**
  - `git add apps/web/lib/vercel/preview-protection.ts apps/web/lib/vercel/preview-protection.test.ts`
  - `git commit -m "feat(saas): add assertPreviewReachable Deployment Protection guard (spec §3.2)"`

---

## Task 4 — `loadWorkspacePreviewStateAction` server action (impure)

The poll target. RLS project SELECT → `loadProjectBuildState` → `deriveWorkspacePreviewState`. Re-validates membership per call; the client sends only `projectId`. Also runs `assertPreviewReachable` (fail-soft → attaches a `protected` flag, never throws to the client).

**Files:**
- Create: `apps/web/lib/actions/workspace-preview.ts`
- Test: `apps/web/lib/actions/workspace-preview.test.ts`
- Reuses: `createClient` from `@/lib/supabase/server`, `loadProjectBuildState` from `@/lib/jab/load-project-builds`, `deriveWorkspacePreviewState` from `@/lib/jab/workspace-preview-state`, `assertPreviewReachable`/`PreviewProtectedError` from `@/lib/vercel/preview-protection`.

> **Note on testing a `"use server"` file:** the action depends on `next/headers` (via `createClient`) and Supabase. We test it by mocking `@/lib/supabase/server`, `@/lib/jab/load-project-builds`, and `@/lib/vercel/preview-protection`. This keeps the test a focused unit over the action's branching (not-found vs. ok vs. protected), not the I/O.

### Steps

- [ ] **Step 1: Write the failing test.**

```ts
// apps/web/lib/actions/workspace-preview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks (declared before importing the SUT) ---
const mockSingle = vi.fn();
const mockCreateClient = vi.fn(async () => ({
  from: () => ({
    select: () => ({ eq: () => ({ single: mockSingle }) }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

const mockLoadProjectBuildState = vi.fn();
vi.mock("@/lib/jab/load-project-builds", () => ({
  loadProjectBuildState: mockLoadProjectBuildState,
}));

const mockAssertReachable = vi.fn();
vi.mock("@/lib/vercel/preview-protection", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/vercel/preview-protection")
  >("@/lib/vercel/preview-protection");
  return { ...actual, assertPreviewReachable: mockAssertReachable };
});

import { loadWorkspacePreviewStateAction } from "./workspace-preview";
import { PreviewProtectedError } from "@/lib/vercel/preview-protection";

function readyBuildState() {
  return {
    latestBuild: {
      id: "build_1",
      status: "ready",
      failedPhase: null,
      previewUrl: "https://x.vercel.app",
      pageCount: null,
      blockTypeCount: null,
      componentCount: null,
      fidelityAvg: null,
      createdAt: "2026-06-03T00:00:00Z",
      finishedAt: null,
    },
    latestPreview: {
      id: "dpl_1",
      siteBuildId: "build_1",
      environment: "preview" as const,
      status: "ready" as const,
      url: "https://x.vercel.app",
      providerDeploymentId: "v1",
      readyAt: null,
      createdAt: "2026-06-03T00:00:00Z",
    },
    productionDeployment: null,
    deployHistory: [],
    hasActiveBuild: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertReachable.mockResolvedValue(undefined);
});

describe("loadWorkspacePreviewStateAction", () => {
  it("returns { ok: false, reason: 'not_found' } on PGRST116", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const result = await loadWorkspacePreviewStateAction("proj_x");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mockLoadProjectBuildState).not.toHaveBeenCalled();
  });

  it("returns the derived preview state with protected=false when reachable", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.kind).toBe("ready");
      expect(result.protected).toBe(false);
    }
  });

  it("sets protected=true (does NOT throw) when assertPreviewReachable throws PreviewProtectedError", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    mockAssertReachable.mockRejectedValue(
      new PreviewProtectedError("https://x.vercel.app", 401),
    );
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.protected).toBe(true);
      expect(result.state.kind).toBe("ready");
    }
  });

  it("does not call assertPreviewReachable when the state is not 'ready'", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    const buildingState = {
      ...readyBuildState(),
      latestBuild: { ...readyBuildState().latestBuild, status: "components" },
      latestPreview: null,
      hasActiveBuild: true,
    };
    mockLoadProjectBuildState.mockResolvedValue(buildingState);
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.kind).toBe("building");
      expect(result.protected).toBe(false);
    }
    expect(mockAssertReachable).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-preview.test.ts`
  - Expected: failure — `Cannot find module './workspace-preview'`.

- [ ] **Step 3: Minimal implementation.**

```ts
// apps/web/lib/actions/workspace-preview.ts
"use server";
import { createClient } from "@/lib/supabase/server";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import {
  deriveWorkspacePreviewState,
  type WorkspacePreviewState,
} from "@/lib/jab/workspace-preview-state";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "@/lib/vercel/preview-protection";

/**
 * workspace-preview — the poll target for the workspace preview pane.
 *
 * The client sends ONLY a projectId. We re-validate tenant membership per
 * call via an RLS-scoped SELECT (PGRST116 = not yours = not_found), then
 * re-derive the preview state from the canonical loadProjectBuildState. No
 * new deploy, no Vercel write — a cheap read invoked on a 5s poll while the
 * pane is in the `building` state (spec §3.2: "poll, not meta-refresh").
 *
 * Vercel Deployment Protection is checked fail-soft: a protected preview
 * sets `protected: true` so the pane can show a banner, but never throws to
 * the client (operator-recoverable, must not blank the UI). Only run the
 * reachability probe when there's actually a ready URL to probe.
 */

export type LoadWorkspacePreviewStateResult =
  | { ok: false; reason: "not_found" }
  | { ok: true; state: WorkspacePreviewState; protected: boolean };

export async function loadWorkspacePreviewStateAction(
  projectId: string,
): Promise<LoadWorkspacePreviewStateResult> {
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();

  if (error?.code === "PGRST116" || !project) {
    return { ok: false, reason: "not_found" };
  }
  if (error) throw error;

  const buildState = await loadProjectBuildState(supabase, projectId);
  const state = deriveWorkspacePreviewState(buildState);

  let isProtected = false;
  if (state.kind === "ready") {
    try {
      await assertPreviewReachable(state.url);
    } catch (err) {
      if (err instanceof PreviewProtectedError) {
        isProtected = true;
        console.warn(`[workspace-preview] ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  return { ok: true, state, protected: isProtected };
}
```

- [ ] **Step 4: Run, verify PASS.**
  - Command: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-preview.test.ts`
  - Expected: all tests pass.

- [ ] **Step 5: Commit.**
  - `git add apps/web/lib/actions/workspace-preview.ts apps/web/lib/actions/workspace-preview.test.ts`
  - `git commit -m "feat(saas): add loadWorkspacePreviewStateAction poll target (spec §3.2)"`

---

## Task 5 — `WorkspacePreviewPane` component (UI, "use client")

Wraps the existing `PreviewFrame`, maps `WorkspacePreviewState.kind → PreviewFrame status`, owns the poll-while-building effect (poll only while `kind==="building"`, ≥5s, guard overlapping in-flight calls, clear on unmount), and renders the building view with the actual phase + a "View full progress" link. The pane is the sole consumer of `loadWorkspacePreviewStateAction`.

The pure state→props mapping is extracted into `previewPaneStatusFor` and unit-tested; the poll wiring is verified by typecheck + the manual smoke in Task 9.

**Files:**
- Create: `apps/web/components/workspace-preview-pane.tsx`
- Test: `apps/web/components/workspace-preview-pane.test.tsx`
- Reuses: `PreviewFrame` from `@/components/preview-frame`; `WorkspacePreviewState` from `@/lib/jab/workspace-preview-state`; `LoadWorkspacePreviewStateResult`/`loadWorkspacePreviewStateAction` from `@/lib/actions/workspace-preview`.

### Steps

- [ ] **Step 1: Write the failing test (the pure mapping helper).**

```tsx
// apps/web/components/workspace-preview-pane.test.tsx
import { describe, it, expect } from "vitest";
import { previewPaneStatusFor } from "./workspace-preview-pane";
import type { WorkspacePreviewState } from "@/lib/jab/workspace-preview-state";

describe("previewPaneStatusFor", () => {
  it("maps 'ready' -> PreviewFrame status 'live' with the url", () => {
    const s: WorkspacePreviewState = {
      kind: "ready",
      url: "https://x.vercel.app",
      buildId: "b1",
      deploymentId: "d1",
    };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("live");
    expect(r.src).toBe("https://x.vercel.app");
  });

  it("maps 'building' -> 'deploying' with no src", () => {
    const s: WorkspacePreviewState = { kind: "building", buildId: "b1", phase: "Composing the site" };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("deploying");
    expect(r.src).toBeUndefined();
  });

  it("maps 'failed' -> 'failed' with no src", () => {
    const s: WorkspacePreviewState = { kind: "failed", buildId: "b1", failedPhase: "building" };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("failed");
    expect(r.src).toBeUndefined();
  });

  it("maps 'none' -> 'idle' with no src", () => {
    const r = previewPaneStatusFor({ kind: "none" });
    expect(r.status).toBe("idle");
    expect(r.src).toBeUndefined();
  });

  it("only the 'building' kind should drive polling", () => {
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }).shouldPoll).toBe(true);
    expect(previewPaneStatusFor({ kind: "none" }).shouldPoll).toBe(false);
    expect(
      previewPaneStatusFor({ kind: "ready", url: "u", buildId: "b", deploymentId: "d" }).shouldPoll,
    ).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }).shouldPoll).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it FAILS.**
  - Command: `pnpm --filter @jab/web exec vitest run components/workspace-preview-pane.test.tsx`
  - Expected: failure — `Cannot find module './workspace-preview-pane'` or `previewPaneStatusFor is not a function`.

- [ ] **Step 3: Minimal implementation.**

```tsx
// apps/web/components/workspace-preview-pane.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PreviewFrame } from "@/components/preview-frame";
import type { WorkspacePreviewState } from "@/lib/jab/workspace-preview-state";
import {
  loadWorkspacePreviewStateAction,
  type LoadWorkspacePreviewStateResult,
} from "@/lib/actions/workspace-preview";

/**
 * WorkspacePreviewPane — sole owner of the workspace preview slot (spec §3.2).
 * Wraps the hardened PreviewFrame (external-`src` sandbox + device toggle +
 * scaled-iframe already built) and owns the poll-while-building effect:
 *
 *   - poll ONLY while kind === "building"
 *   - ≥5s interval
 *   - guard against overlapping in-flight calls (a slow poll never stacks)
 *   - clear on unmount / when leaving the building state
 *   - poll, NOT meta-refresh — a full reload would reset chat scroll/focus
 *     (a11y regression, §3.2)
 *
 * The building state surfaces the real phase (not a bare spinner) + a "View
 * full progress" link so a 2–3 min edit never looks hung.
 */

const POLL_INTERVAL_MS = 5_000;

export interface WorkspacePreviewPaneProps {
  projectId: string;
  /** Server-rendered initial state (from the page's already-loaded buildState). */
  initialState: WorkspacePreviewState;
  /** Whether the initial server render found the preview protected. */
  initialProtected?: boolean;
  /** Domain shown in the chrome bar for non-ready states. */
  displayDomain?: string;
}

interface PaneStatus {
  status: "idle" | "deploying" | "live" | "failed";
  src?: string;
  shouldPoll: boolean;
}

/** Pure mapping from preview state -> PreviewFrame props. Unit-tested. */
export function previewPaneStatusFor(state: WorkspacePreviewState): PaneStatus {
  switch (state.kind) {
    case "ready":
      return { status: "live", src: state.url, shouldPoll: false };
    case "building":
      return { status: "deploying", shouldPoll: true };
    case "failed":
      return { status: "failed", shouldPoll: false };
    case "none":
    default:
      return { status: "idle", shouldPoll: false };
  }
}

export function WorkspacePreviewPane({
  projectId,
  initialState,
  initialProtected = false,
  displayDomain,
}: WorkspacePreviewPaneProps) {
  const [state, setState] = useState<WorkspacePreviewState>(initialState);
  const [isProtected, setIsProtected] = useState(initialProtected);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // guard overlapping calls
    inFlight.current = true;
    try {
      const result: LoadWorkspacePreviewStateResult =
        await loadWorkspacePreviewStateAction(projectId);
      if (result.ok) {
        setState(result.state);
        setIsProtected(result.protected);
      }
    } catch {
      // Swallow transient poll errors — the next tick retries. Never blank
      // the pane on a single failed poll.
    } finally {
      inFlight.current = false;
    }
  }, [projectId]);

  const mapped = previewPaneStatusFor(state);

  useEffect(() => {
    if (!mapped.shouldPoll) return;
    const id = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mapped.shouldPoll, poll]);

  const caption =
    state.kind === "building"
      ? state.phase
      : state.kind === "failed"
        ? `Build failed at: ${state.failedPhase}`
        : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      {isProtected && (
        <div
          role="alert"
          className="border-b border-amb/40 bg-amb/[0.08] px-4 py-2 text-[12px] text-amb"
        >
          Preview is protected — disable Deployment Protection for previews in
          Vercel, then reload.
        </div>
      )}
      <PreviewFrame
        src={mapped.src}
        url={mapped.src ?? displayDomain}
        status={mapped.status}
        caption={caption}
        title="Live preview"
        className="m-3 flex-1"
      />
      {state.kind === "building" && (
        <div className="px-4 pb-3 text-center text-[12px] text-gry-d">
          <Link
            href={`/projects/${projectId}/builds/${state.buildId}/progress`}
            className="font-mono text-teal hover:underline"
          >
            View full progress →
          </Link>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify PASS + typecheck.**
  - Command: `pnpm --filter @jab/web exec vitest run components/workspace-preview-pane.test.tsx`
  - Then: `pnpm --filter @jab/web typecheck`
  - Expected: tests pass; typecheck clean. (Typecheck is the verification for the poll-effect wiring, which has no unit test.)

- [ ] **Step 5: Commit.**
  - `git add apps/web/components/workspace-preview-pane.tsx apps/web/components/workspace-preview-pane.test.tsx`
  - `git commit -m "feat(saas): add WorkspacePreviewPane with poll-while-building (spec §3.2)"`

---

## Task 6 — Rewire `workspace-jab-demo.tsx`: `previewHtml` → `previewState`

Replace the `WorkspaceProject.previewHtml` field with `previewState`; in `PreviewPane`, replace the `project.previewHtml ? <iframe srcDoc> : <NoPreviewFallback>` branch with `<WorkspacePreviewPane>`; **leave the `!project → <SiteMock/>` branch untouched** (the `/ui-kit` demo); strip the redundant inline device toggle (PreviewFrame owns it and adds tablet for free).

Because the demo file is a large UI component with no unit test, verification is `typecheck` + the manual smoke (Task 9). The change is mechanical and the surrounding context is quoted in each edit.

**Files:**
- Modify: `apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx`
  - `WorkspaceProject` interface (line ~1555)
  - `PreviewPane` (line ~1374) — remove inline device toggle + `mobile` state + the device/mobile-frame wrappers; replace the three-mode iframe block (lines ~1521–1532) with the pane for real projects.
  - `NoPreviewFallback` (line ~1349) — now unused for real projects; keep only if still referenced, else delete.

### Steps

- [ ] **Step 1: Add the import + change the `WorkspaceProject` interface.**

  Add the import near the other top-of-file imports (the file already imports React hooks; add this alongside the component imports):

```tsx
import { WorkspacePreviewPane } from "@/components/workspace-preview-pane";
import type { WorkspacePreviewState } from "@/lib/jab/workspace-preview-state";
```

  Then change the `WorkspaceProject` interface. Find (line ~1555):

```tsx
export interface WorkspaceProject {
  id: string;
  name: string;
  displayDomain: string;
  previewHtml: string | null;
  build?: WorkspaceBuildForProject | null;
}
```

  Replace with:

```tsx
export interface WorkspaceProject {
  id: string;
  name: string;
  displayDomain: string;
  /**
   * Workspace preview state (spec §3.2). Replaces the retired `previewHtml`
   * string slot — that rendered literal HTML via `srcDoc` and could not load
   * an external URL. The live Vercel preview is loaded by WorkspacePreviewPane
   * via `src=`. Null/undefined on the /ui-kit demo path (no real project).
   */
  previewState?: WorkspacePreviewState | null;
  /** Server-rendered protection flag for the initial preview state. */
  previewProtected?: boolean;
  build?: WorkspaceBuildForProject | null;
}
```

- [ ] **Step 2: Replace the `PreviewPane` body's real-project branch.**

  The current `PreviewPane` (lines ~1374–1539) owns a `const [mobile, setMobile] = useState(false)` plus an inline device toggle and a mobile-frame wrapper, then a three-mode block. We keep the `!project → <SiteMock/>` demo path and the chrome bar, and route real projects through `WorkspacePreviewPane`.

  Find the three-mode block (lines ~1510–1533):

```tsx
            {/* Three modes:
                  • no `project` prop → stakeholder demo route, render the
                    built-in Two Roads SiteMock as before.
                  • project + previewHtml → render the project's generated
                    homepage in a sandboxed iframe. Same posture as
                    HeroPreview (allow-scripts, no allow-same-origin) so
                    the embedded HTML can run its own JS but can't reach
                    the parent's cookies/DOM.
                  • project + no preview yet → honest empty state pointing
                    back to the project page where the regenerate button
                    lives. Better than a misleading fake site. */}
            {!project ? (
              <SiteMock />
            ) : project.previewHtml ? (
              <iframe
                srcDoc={project.previewHtml}
                title={`Homepage preview for ${project.displayDomain || project.name}`}
                sandbox="allow-scripts"
                className="block h-full w-full border-0 bg-bg"
              />
            ) : (
              <NoPreviewFallback projectId={project.id} />
            )}
```

  Replace with:

```tsx
            {/* Two modes:
                  • no `project` prop → stakeholder demo route, render the
                    built-in Two Roads SiteMock as before (/ui-kit). UNCHANGED.
                  • real project → WorkspacePreviewPane (spec §3.2). It owns
                    the live Vercel preview iframe, device toggle, status
                    states, and poll-while-building — so this slot just hands
                    off the derived previewState. */}
            {!project ? (
              <SiteMock />
            ) : (
              <WorkspacePreviewPane
                projectId={project.id}
                initialState={project.previewState ?? { kind: "none" }}
                initialProtected={project.previewProtected ?? false}
                displayDomain={project.displayDomain}
              />
            )}
```

- [ ] **Step 3: Strip the redundant inline device toggle + mobile-frame chrome (real-project path only).**

  `WorkspacePreviewPane` (via `PreviewFrame`) now owns the device toggle, the chrome bar, and the mobile frame. The demo's `SiteMock` path still needs the existing chrome/toggle. The cleanest scoping that preserves the demo: keep the existing `PreviewPane` chrome + `mobile` state for the `!project` (SiteMock) demo path, and short-circuit at the top of `PreviewPane` for real projects so `WorkspacePreviewPane` renders standalone (it brings its own chrome).

  Find the start of `PreviewPane` (line ~1374):

```tsx
function PreviewPane({ isStreaming, codeOpen, project }: PreviewPaneProps) {
  const [mobile, setMobile] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
```

  Insert the real-project short-circuit immediately after the `useState` line, before the `return`:

```tsx
function PreviewPane({ isStreaming, codeOpen, project }: PreviewPaneProps) {
  const [mobile, setMobile] = useState(false);

  // Real project → the new preview pane owns its own chrome/toggle/states.
  // The CodePanel still mounts beneath when the Code panel is open.
  if (project) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <WorkspacePreviewPane
            projectId={project.id}
            initialState={project.previewState ?? { kind: "none" }}
            initialProtected={project.previewProtected ?? false}
            displayDomain={project.displayDomain}
          />
          {codeOpen && <CodePanel components={project.build?.components ?? null} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
```

  > With this short-circuit, the original three-mode block edited in Step 2 is only reached on the `!project` demo path, so its content collapses to just `<SiteMock />`. Apply Step 2's replacement so the only remaining branch there is `<SiteMock />` (the `project` ternary is dead on this path but harmless; prefer simplifying it to a bare `<SiteMock />` if the surrounding JSX allows). Keep the `mobile`/`setMobile` toggle and the streaming overlay for the demo path. The `isStreaming` overlay stays on the demo path only — real projects show building state via the pane.

- [ ] **Step 4: Remove the now-unused `NoPreviewFallback` (real projects no longer use it).**

  Search the file for remaining `NoPreviewFallback` references. If the only definition+reference were the ones removed in Step 2, delete the `NoPreviewFallback` function (lines ~1349–1366) to avoid an unused-symbol lint error. If `SiteMock` or any other path still references it, leave it.
  - Command to confirm: `pnpm --filter @jab/web exec eslint app/ui-kit/workspace-jab/workspace-jab-demo.tsx` (or rely on typecheck + the build in Task 9). Remove the dead function only if unreferenced.

- [ ] **Step 5: Verify typecheck PASS, then commit.**
  - Command: `pnpm --filter @jab/web typecheck`
  - Expected: no type errors. (No unit test for this UI file — typecheck + manual smoke in Task 9 are the verification.)
  - `git add apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx`
  - `git commit -m "refactor(saas): route real-project preview through WorkspacePreviewPane (spec §3.2)"`

---

## Task 7 — Wire `workspace/page.tsx`: compute `previewState` from the loaded `buildState`

The page already loads `buildState` at line 72. Compute `previewState` from it (and the protection check), drop `previewHtml: null`, and pass `previewState`/`previewProtected` into the `WorkspaceProject`.

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/page.tsx`
  - imports (lines 1–16)
  - `workspaceProject` construction (lines 75–81)
- Reuses: `deriveWorkspacePreviewState` from `@/lib/jab/workspace-preview-state`; `assertPreviewReachable`/`PreviewProtectedError` from `@/lib/vercel/preview-protection`.

> No unit test for the page component itself; verification is typecheck + manual smoke (Task 9). The derivation it calls is already fully unit-tested in Task 2.

### Steps

- [ ] **Step 1: Add imports.**

  After the existing import block (the last import is `WorkspaceJabDemo`/`WorkspaceProject` at line 13–16), add:

```tsx
import { deriveWorkspacePreviewState } from "@/lib/jab/workspace-preview-state";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "@/lib/vercel/preview-protection";
```

- [ ] **Step 2: Compute `previewState` after `buildState` is loaded.**

  Find (lines 71–73):

```tsx
  const build = await loadLatestBuildForWorkspace(project.id);
  const buildState = await loadProjectBuildState(supabase, project.id);
  const editHistory = await loadWorkspaceEditHistory(project.id, 10);
```

  Add immediately after:

```tsx
  // Spec §3.2: derive the preview pane's state from the already-loaded
  // buildState (no extra query). The protection probe is fail-soft — a
  // protected preview shows a banner, never blanks the workspace.
  const previewState = deriveWorkspacePreviewState(buildState);
  let previewProtected = false;
  if (previewState.kind === "ready") {
    try {
      await assertPreviewReachable(previewState.url);
    } catch (err) {
      if (err instanceof PreviewProtectedError) {
        previewProtected = true;
        console.warn(`[workspace] ${err.message}`);
      } else {
        throw err;
      }
    }
  }
```

- [ ] **Step 3: Replace the `workspaceProject` construction.**

  Find (lines 75–81):

```tsx
  const workspaceProject: WorkspaceProject = {
    id: project.id,
    name: project.name,
    displayDomain: displayDomainFrom(project.wp_url),
    previewHtml: null,
    build,
  };
```

  Replace with:

```tsx
  const workspaceProject: WorkspaceProject = {
    id: project.id,
    name: project.name,
    displayDomain: displayDomainFrom(project.wp_url),
    previewState,
    previewProtected,
    build,
  };
```

- [ ] **Step 4: Update the stale docstring (lines 30–37) that promised `NoPreviewFallback`.**

  Find the bullet in the file-level docstring:

```tsx
 *   • preview iframe   → honest empty state (NoPreviewFallback) until the
 *                        Stage 1 preview pipeline lands. The Stage 0 schema
 *                        cleanup dropped the legacy `preview_html` column
 *                        on `projects`; the rebuilt preview will be sourced
 *                        from a dedicated worker output, not the projects
 *                        row.
```

  Replace with:

```tsx
 *   • preview iframe   → live Vercel preview via WorkspacePreviewPane
 *                        (spec §3.2). previewState is derived from
 *                        loadProjectBuildState; the pane loads the preview
 *                        deployment URL with a device toggle and refreshes
 *                        building→ready via a 5s poll (no full reload).
```

- [ ] **Step 5: Verify typecheck PASS, then commit.**
  - Command: `pnpm --filter @jab/web typecheck`
  - Expected: clean. (`previewHtml` is gone from `WorkspaceProject`; if any other reference remained it would fail here — confirmed in research that only the demo + this page reference it.)
  - `git add apps/web/app/(app)/projects/[id]/workspace/page.tsx`
  - `git commit -m "feat(saas): wire workspace page to live preview state (spec §3.2)"`

---

## Task 8 — Render `deriveProjectStatusLabel` in dashboard card + project header

One shared status word, everywhere. Replace the dashboard card's ad-hoc `ProjectStatusBadge` build/live logic and the project header's `headerStatusFor`/`StatusChip` so both render `projectStatusLabelText(deriveProjectStatusLabel(...))`. The onboarding "Setup · Step N of 4" badge stays (it predates a first build and is finer-grained than `in-setup`).

**Sole-renderer ownership (cross-plan, do not violate):** This task is the **single owner** of the dashboard `ProjectStatusBadge` rewrite and the project-header chip rewrite. Phase 3 (S1) consumes the result and **must not** re-implement either: no `dashboard-status.ts` `dashboardBadgeFor` helper, no `STATUS_LABEL_TEXT`/`SHARED_LABEL_TEXT` table, no `statusWithSharedLabel` chip rebuild. The **only** label-text table in the codebase is `LABEL_TEXT` / `projectStatusLabelText` authored in Task 1 — there is exactly one string per state (e.g. `in-setup → "In setup"`), and every surface reuses it. Phase 3's contribution here is at most a regression test asserting the Phase-1-rendered badge reads "Live · updating" for a live-with-active-build project. If Phase 3's plan still rewrites these, that is a duplicate to strike there, not a second implementation.

**Files:**
- Modify: `apps/web/app/(app)/dashboard/page.tsx` — the `ProjectStatusBadge` (lines 139–182).
- Modify: `apps/web/app/(app)/projects/[id]/page.tsx` — the header chip (line 216) + `headerStatusFor` (lines 589–602).

> No new unit test (the label logic is fully tested in Task 1). Verification is typecheck + manual smoke (Task 9). Each edit quotes surrounding context.

### Steps

- [ ] **Step 1: Dashboard — import and use the shared label.**

  Add to the dashboard imports (after line 9 `phaseLabel` import):

```tsx
import {
  deriveProjectStatusLabel,
  projectStatusLabelText,
} from "@/lib/jab/project-status-label";
import { StatusDot } from "@/components/ui/status-dot";
```

  (Note: `StatusDot` and `Badge` are already imported at lines 4 & 7 — do not double-import; only add the `project-status-label` import if `StatusDot` is already present.)

  Now change `ProjectStatusBadge` to derive the post-setup label from the build state. The dashboard's `DashboardProjectBuildState` carries `hasActiveBuild`, `latestBuildStatus`, `productionUrl`. Build the label input from those. Find (lines 139–182):

```tsx
function ProjectStatusBadge({
  status,
  stepCompletedCount,
  isLive,
  hasActiveBuild,
}: {
  status: string;
  stepCompletedCount: number;
  isLive: boolean;
  hasActiveBuild: boolean;
}) {
  const isInSetup = status === "draft" || status === "onboarding";
  if (isInSetup) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Setup · Step {Math.min(stepCompletedCount + 1, 4)} of 4
      </Badge>
    );
  }
  if (hasActiveBuild) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Building
      </Badge>
    );
  }
  if (isLive) {
    return (
      <Badge tone="success" className="shrink-0">
        <StatusDot tone="success" />
        Live
      </Badge>
    );
  }
  const meta = STATUS_META[status] ?? STATUS_META.draft!;
  return (
    <Badge tone={meta.tone} className="shrink-0">
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
    </Badge>
  );
}
```

  Replace with:

```tsx
function ProjectStatusBadge({
  status,
  stepCompletedCount,
  isLive,
  hasActiveBuild,
  latestBuildStatus,
}: {
  status: string;
  stepCompletedCount: number;
  isLive: boolean;
  hasActiveBuild: boolean;
  latestBuildStatus: string | null;
}) {
  // Onboarding keeps the finer-grained step badge (predates any build).
  const isInSetup = status === "draft" || status === "onboarding";
  if (isInSetup) {
    return (
      <Badge tone="warning" className="shrink-0">
        <StatusDot tone="warning" pulse />
        Setup · Step {Math.min(stepCompletedCount + 1, 4)} of 4
      </Badge>
    );
  }
  // Everything past onboarding uses the one shared status word (spec §2.2).
  const label = deriveProjectStatusLabel({
    productionDeployment: isLive ? { id: "live" } : null,
    hasActiveBuild,
    latestBuild: latestBuildStatus ? { status: latestBuildStatus } : null,
    // editAwaitingReview wired by S4 later; absent here -> "live".
  });
  const text = projectStatusLabelText(label);
  return (
    <Badge tone={text.tone} className="shrink-0">
      <StatusDot tone={text.tone} pulse={text.pulse} />
      {text.label}
    </Badge>
  );
}
```

  Then pass `latestBuildStatus` at the call site (lines 114–119):

```tsx
                  <ProjectStatusBadge
                    status={p.status}
                    stepCompletedCount={stepCompletedCount}
                    isLive={!!buildState.productionUrl}
                    hasActiveBuild={buildState.hasActiveBuild}
                  />
```

  Replace with:

```tsx
                  <ProjectStatusBadge
                    status={p.status}
                    stepCompletedCount={stepCompletedCount}
                    isLive={!!buildState.productionUrl}
                    hasActiveBuild={buildState.hasActiveBuild}
                    latestBuildStatus={buildState.latestBuildStatus}
                  />
```

  > `STATUS_META`, `Badge`, `StatusDot`, and `projectStatusLabelText`'s tone vocabulary (`neutral`/`warning`/`success`/`danger`) all align with the `Badge` `tone` prop. `STATUS_META` is now unused by `ProjectStatusBadge` but may still be referenced elsewhere in the file — if `pnpm --filter @jab/web typecheck` reports it unused, delete it.

- [ ] **Step 2: Project header — import and use the shared label.**

  The header already loads `buildState` (line 57) and computes `live` (line 81). Import the label helpers (add to the existing import block near line 18):

```tsx
import {
  deriveProjectStatusLabel,
  projectStatusLabelText,
} from "@/lib/jab/project-status-label";
```

  Compute the shared label next to `status` (line 105). Find:

```tsx
  const status = headerStatusFor({ live, setupComplete, raw: project.status });
```

  Add immediately after:

```tsx
  // Spec §2.2: the one shared status word for the header chip. We keep
  // headerStatusFor for the setup-complete-but-not-live in-between copy,
  // but past that, render the shared label so header/dashboard/workspace
  // never disagree. `buildState` is a full ProjectBuildState, which is
  // assignable to ProjectStatusLabelInput — pass the variable directly (no
  // re-wrapping, no casts; passing a literal-with-extras would trip TS
  // excess-property checks).
  const sharedStatusLabel = deriveProjectStatusLabel(buildState);
```

  Then render it in the header chip. Find (line 216):

```tsx
                <StatusChip status={status} />
```

  Replace with:

```tsx
                <SharedStatusChip label={sharedStatusLabel} fallback={status} live={live} setupComplete={setupComplete} />
```

  And add a small wrapper component near `StatusChip` (around line 666). It uses the shared label for every state except the `setupComplete && !live` in-between, which keeps the existing "Setup complete" copy from `headerStatusFor`:

```tsx
/**
 * Renders the shared status word (spec §2.2) for the header chip. The one
 * exception is the setup-complete-but-not-live in-between state, where the
 * existing "Setup complete" copy (from headerStatusFor) reads truer than
 * the generic "In setup" — so we fall through to the legacy chip there.
 */
function SharedStatusChip({
  label,
  fallback,
  live,
  setupComplete,
}: {
  label: ReturnType<typeof deriveProjectStatusLabel>;
  fallback: DeploymentStatus;
  live: boolean;
  setupComplete: boolean;
}) {
  if (!live && setupComplete) {
    return <StatusChip status={fallback} />;
  }
  const text = projectStatusLabelText(label);
  const toneClass: Record<typeof text.tone, string> = {
    success: "bg-teal/10 text-teal border-teal/20",
    warning: "bg-amb/10 text-amb border-amb/20",
    danger: "bg-red/10 text-red border-red/20",
    neutral: "bg-elev text-gry-d border-bord",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${toneClass[text.tone]}`}
    >
      {text.label}
    </span>
  );
}
```

  > Confirm the Tailwind color tokens (`teal`, `amb`, `red`, `elev`, `bord`, `gry-d`) match those already used by `StatusChip` (lines 666–672 use `bg-teal/10 text-teal border-teal/20` for `live` and `bg-amb/10 text-amb border-amb/20` for `building`). They do — reuse the same palette. If `DeploymentStatus` is not in scope at the wrapper's location, keep `SharedStatusChip` directly below the existing `StatusChip` definition where `DeploymentStatus` is already imported/declared.

- [ ] **Step 3: Verify typecheck PASS.**
  - Command: `pnpm --filter @jab/web typecheck`
  - Expected: clean. Resolve any "unused `STATUS_META`/`headerStatusFor`" by deletion only if genuinely unreferenced (the header still calls `headerStatusFor` for the fallback, so it stays).

- [ ] **Step 4: Run the full app test suite to confirm no regressions.**
  - Command: `pnpm --filter @jab/web test`
  - Expected: all tests green (including the four new test files from Tasks 1–5).

- [ ] **Step 5: Commit.**
  - `git add apps/web/app/(app)/dashboard/page.tsx apps/web/app/(app)/projects/[id]/page.tsx`
  - `git commit -m "feat(saas): render one shared deriveProjectStatusLabel word across dashboard + header (spec §2.2)"`

---

## Task 9 — Manual verification: trigger a build, watch the preview appear + refresh

End-to-end smoke against a real connected project (the Two Roads pilot). This is the shippable/demoable outcome of the phase. No code change — observation only. Record the result inline in the task checkboxes.

**Files:** none (manual).

**Prereqs:** a connected, onboarding-complete project exists in the local environment; `.env.local` targets the local Supabase project (`ajfurojjxthhzkjqttri`); Vercel + Inngest dev credentials present; the Inngest dev server running so workers fire.

### Steps

- [ ] **Step 1: Start the app + Inngest dev server.**
  - `pnpm --filter @jab/web dev` (Next.js) and the Inngest dev server per the repo's standard dev runbook.

- [ ] **Step 2: Trigger a full build from an existing project.**
  - Open `/projects/[id]`, click **Build site** (or **Rebuild** if already live).
  - Open `/projects/[id]/workspace` in a second tab.
  - **Expected:** the preview pane shows the **building** state with the live phase label ("Discovering content" → "Generating components" → … → "Building & deploying preview") and a **"View full progress →"** link. The pane does **not** flash an empty state during the verifying→ready window.

- [ ] **Step 3: Watch building→ready refresh without a full reload.**
  - Keep the workspace tab focused. Do NOT reload it.
  - **Expected:** within ~5s of the preview deployment going ready, the pane swaps to the **live** Vercel preview iframe (`status="live"`, real `src`), the chrome bar shows the preview URL with copy/open-in-tab, and the page did **not** do a full reload (chat scroll/focus, if present, is preserved). Toggling **mobile / tablet / desktop** re-renders the iframe at the true viewport via `ScaledIframe`.

- [ ] **Step 4: Confirm the shared status word is consistent.**
  - Compare the word on the dashboard card, the project header chip, and (implicitly) the workspace building state.
  - **Expected:** for a live project with a build in flight, all surfaces read **"Live · updating"**; for a building, never-live project, all read **"Building"**; for a live, idle project, all read **"Live"**.

- [ ] **Step 5: Confirm the protected-preview path surfaces (optional, if Deployment Protection can be toggled).**
  - If a preview can be put behind Vercel Deployment Protection, reload the workspace.
  - **Expected:** the amber **"Preview is protected — disable Deployment Protection…"** banner renders above the frame; the build is **not** auto-failed; the rest of the workspace is interactive. If Deployment Protection cannot be toggled in this environment, mark this step N/A and note it.

- [ ] **Step 6: Final guard — run the full suite + typecheck one last time.**
  - `pnpm --filter @jab/web test`
  - `pnpm --filter @jab/web typecheck`
  - **Expected:** both green. Commit nothing (no code change); record observations in this task's checkboxes.

---

## Definition of done

The phase is shippable and demoable when all of the following hold (spec §4 Phase 1 outcome):

- [ ] `deriveWorkspacePreviewState` exists and is unit-tested for every kind (`none`/`building`/`ready`/`failed`) **and** every §3.2 race: ready-but-preview-row-not-written → `building` (not `none`); verifying-but-no-preview → `building`; stale prior-build preview never leaks (scoped to `latestBuild.id`); failed with/without `failedPhase`.
- [ ] `deriveProjectStatusLabel` exists and is unit-tested for all six labels with the correct priority order; rendered identically on the dashboard card, the project header chip, and (via the building state) the workspace — one word per state, everywhere.
- [ ] `assertPreviewReachable`/`PreviewProtectedError` throw on 401/403 and resolve quietly otherwise; unit-tested with a mocked `fetch`.
- [ ] `loadWorkspacePreviewStateAction` re-validates membership (PGRST116 → `not_found`), returns the derived state + a `protected` flag, and never throws on Deployment Protection; unit-tested.
- [ ] `WorkspacePreviewPane` wraps `PreviewFrame`, maps state→status via the unit-tested `previewPaneStatusFor`, polls only while `kind==="building"` (≥5s, overlap-guarded, cleared on unmount), and surfaces the phase + a "View full progress" link in the building state.
- [ ] `workspace/page.tsx` computes `previewState` from the already-loaded `buildState`; `previewHtml: null` is gone; the `WorkspaceProject` interface carries `previewState`/`previewProtected` and no longer carries `previewHtml`.
- [ ] `workspace-jab-demo.tsx`'s `PreviewPane` renders `<WorkspacePreviewPane>` for real projects; the `!project → <SiteMock/>` `/ui-kit` demo branch is untouched; the redundant inline device toggle is removed for the real-project path.
- [ ] Manual smoke passed: triggering a full build from an existing project shows the live Vercel preview in the workspace with a device toggle, refreshes building→ready without a full reload, and surfaces a protected-preview error if Deployment Protection is on.
- [ ] `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck` are both green.
- [ ] No migration authored, and no edit to `edit-site.ts` / `verify-fidelity.ts` / `compose-site.ts` / `deploy-site.ts` (those belong to Phase 0/2).
