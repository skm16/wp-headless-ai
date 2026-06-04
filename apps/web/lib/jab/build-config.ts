/**
 * build-config — the canonical `site_builds.config` shape (e2e-loop §2.4).
 *
 * This is the ONLY shape written to site_builds.config. Defined once here and
 * imported by:
 *   - edit-site.ts (Phase 2) — writes the full edit shape on create-result-build.
 *   - the deploy-history label (Phase 3) — reads config.mode / config.prompt.
 *   - approval carry-forward (Phase 2/S4) — reads config.source_build_id /
 *     config.changed_slugs.
 *
 * Non-async pure module — safe to import from server actions, workers, and the
 * client-bundled label helpers alike.
 */

import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

export type BuildConfig =
  | { mode: "full" }
  | {
      mode: "edit";
      source_build_id: string;
      scope: WorkspaceEditScope; // §2.6 — "component" | "shell"
      target: string; // block_name | shell kind ('header'|'footer')
      prompt: string; // raw user/plan text (human-readable)
      regeneration_prompt: string; // guidance threaded into the generator
      action: string; // planner's human summary, e.g. "Regenerated the Hero block"
      edit_id: string; // workspace_edits.id
      message_id: string | null; // chat_messages.id that triggered it (null for the manual form path)
      changed_slugs: string[]; // computed by edit-site's compute-changed-pages step
      change_reason: "component_pages" | "shell_all" | null;
    };

/**
 * Narrowing type guard. Returns true only for a well-formed edit config
 * (mode === "edit"). Defensive against arbitrary jsonb read back from the DB:
 * null / undefined / non-object / wrong-mode all return false.
 */
export function isEditConfig(
  config: unknown,
): config is Extract<BuildConfig, { mode: "edit" }> {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as { mode?: unknown }).mode === "edit"
  );
}
