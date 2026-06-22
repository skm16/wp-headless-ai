/**
 * build-review-errors — non-async exports for the build-review server
 * action. Lives outside the "use server" file because Next.js forbids
 * non-async exports from server-action modules.
 */

export class BuildReviewError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "publish_gate_failed"
      | "no_preview_deployment"
      | "project_not_linked"
      | "promote_failed"
      | "publish_superseded",
    message: string,
  ) {
    super(message);
    this.name = "BuildReviewError";
  }
}
