/**
 * edit-request-event — the canonical `site/edit.requested` Inngest payload
 * (e2e-loop §2.5). The repo's Inngest events are otherwise untyped (plain
 * `inngest.send({ name, data })`); this module is the single source of truth
 * for the edit-request shape so the producer (requestWorkspaceEditAction) and
 * the consumer (the edit-site worker) agree without re-casting inline.
 *
 * Phase 0 defines the type only. Phase 2 (sole owner of the edit-site seam +
 * the payload extension) wires it into workspace-edit.ts's send and
 * edit-site.ts's event.data parse.
 *
 * Back-compat: regenerationPrompt / action / messageId are optional so the
 * manual-form path (no planner) can omit them — the worker falls back to
 * `prompt` for regenerationPrompt.
 */

import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

/** The Inngest event name, as a typed constant to avoid string drift. */
export const EDIT_REQUESTED_EVENT = "site/edit.requested" as const;

/** The `data` payload for `site/edit.requested` (§2.5). */
export interface SiteEditRequestedData {
  editId: string;
  projectId: string;
  tenantId: string;
  sourceBuildId: string;
  scope: WorkspaceEditScope;
  target: string;
  prompt: string;
  /** NEW — planner guidance threaded into the generator; manual form omits (falls back to `prompt`). */
  regenerationPrompt?: string;
  /** NEW — planner's human summary, e.g. "Regenerated the Hero block". */
  action?: string;
  /** NEW — the chat_messages.id that triggered the edit; null for the manual-form path. */
  messageId?: string | null;
}
