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
