/**
 * trigger-build-validation — non-async exports for the trigger-build
 * server action. Lives outside the "use server" file because Next.js
 * forbids non-async exports from server-action modules.
 */

export class TriggerBuildError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "not_ready"
      | "active_build"
      | "dispatch_failed",
    message: string,
  ) {
    super(message);
    this.name = "TriggerBuildError";
  }
}

interface ProjectGateRow {
  status: string;
  wp_url: string | null;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
  manifest: unknown;
}

/**
 * Pure validation — exercised by tests without a Supabase client. The
 * trigger-build server action calls this immediately after the
 * RLS-scoped project SELECT.
 */
export function validateProjectReadyForBuild(row: ProjectGateRow): void {
  if (row.status !== "ready") {
    throw new TriggerBuildError(
      "not_ready",
      `Project is in status='${row.status}'. Finish onboarding before triggering a build.`,
    );
  }
  if (!row.wp_url) {
    throw new TriggerBuildError(
      "not_ready",
      "Project has no WordPress URL. Reconnect via the onboarding wizard.",
    );
  }
  if (!row.wp_username || !row.wp_app_password_encrypted) {
    throw new TriggerBuildError(
      "not_ready",
      "Project has no WordPress credentials on file. Reconnect via the onboarding wizard.",
    );
  }
  if (!row.manifest) {
    throw new TriggerBuildError(
      "not_ready",
      "Project manifest hasn't been captured yet. Reconnect the Jab plugin and retry.",
    );
  }
}
