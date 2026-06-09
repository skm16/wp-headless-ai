/**
 * build-status — pure status helpers for the site_builds state machine.
 *
 * The values mirror the CHECK constraint in
 * `drizzle/migrations/0014_saas_v2_schema.sql` and the docstring at the
 * top of that migration. Keep them in sync.
 *
 * Phase 2 of the 2026-06-02 SaaS-app completion plan: one vocabulary
 * shared by the trigger action, the workers, the progress route, and the
 * project UI — no inline string literals.
 */

export const BUILD_PHASES = [
  "queued",
  "discovering",
  "components",
  "composing",
  "building",
  "verifying",
  "ready",
  "failed",
  "cancelled",
] as const;

export type BuildPhase = (typeof BUILD_PHASES)[number];

export const FAILED_PHASES = [
  "discovering",
  "components",
  "composing",
  "building",
  "verifying",
] as const;

export type FailedPhase = (typeof FAILED_PHASES)[number];

/**
 * Active phases — the project has work in flight and we MUST NOT start
 * another build for the same project (Phase 2 plan: prevent concurrent
 * builds per project).
 *
 * `cancelled` is terminal; `ready` and `failed` are terminal.
 */
const ACTIVE_PHASES = new Set<BuildPhase>([
  "queued",
  "discovering",
  "components",
  "composing",
  "building",
  "verifying",
]);

export function isActiveBuildStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ACTIVE_PHASES.has(status as BuildPhase);
}

export function isTerminalBuildStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return status === "ready" || status === "failed" || status === "cancelled";
}

const PHASE_LABELS: Record<BuildPhase, string> = {
  queued: "Queued",
  discovering: "Discovering content",
  components: "Generating components",
  composing: "Composing the site",
  building: "Building & deploying preview",
  verifying: "Verifying fidelity",
  ready: "Ready for review",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function phaseLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return PHASE_LABELS[status as BuildPhase] ?? status;
}

/**
 * Linear timeline order used by the progress UI — drops the terminal
 * states so the timeline always renders the same N rungs regardless of
 * outcome. `failed` and `cancelled` are rendered as adornments on the
 * current rung, not new rungs.
 */
export const TIMELINE_PHASES: ReadonlyArray<BuildPhase> = [
  "queued",
  "discovering",
  "components",
  "composing",
  "building",
  "verifying",
  "ready",
] as const;

/**
 * Active builds older than this are presumed wedged (crashed worker under
 * retries:0, or a lost dispatch). The longest healthy Two Roads full build is
 * well under 30 minutes; 45 gives slow installs headroom. Includes 'queued'
 * (active for the guards but outside the 0031 index) — the dispatch-failure
 * cleanup (T5) prevents most queued strandings; this sweeps the rest.
 */
export const STALE_ACTIVE_BUILD_MS = 45 * 60 * 1000;

export function isStaleActiveBuild(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!isActiveBuildStatus(status) || !createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > STALE_ACTIVE_BUILD_MS;
}
