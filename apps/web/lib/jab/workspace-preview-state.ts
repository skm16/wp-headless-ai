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
