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
      latestReadyBuild: null,
      latestReadyPreview: null,
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
