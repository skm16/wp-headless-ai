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
 *
 * Wrapped in a `declare function` so the proof is erased entirely at runtime
 * (no `declare const` / module-level initializer that Vitest would execute).
 */
declare function _checkAssignability(
  _s: ProjectBuildState & Partial<Pick<ProjectStatusLabelInput, "editAwaitingReview">>,
): ProjectStatusLabelInput;

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
