/**
 * publish-draft-event — the canonical `draft/publish.requested` Inngest payload
 * for the Live-Draft publish bridge (2026-06-18 plan, Task 4).
 *
 * Mirrors edit-request-event.ts: the repo's Inngest events are otherwise
 * untyped (`inngest.send({ name, data })`); this module is the single source of
 * truth for the publish-request shape so the producer (publishDraftAction,
 * Task 6) and the consumer (the publish-draft worker) agree without re-casting
 * inline.
 *
 * The worker resolves the draft state (effective unit versions + token deltas)
 * itself from `draftId`; the buildId points at the queued site_builds row the
 * action already inserted (the worker fills its real config in stamp-config).
 */

/** The Inngest event name, as a typed constant to avoid string drift. */
export const DRAFT_PUBLISH_REQUESTED_EVENT = "draft/publish.requested" as const;

/** The `data` payload for `draft/publish.requested`. */
export interface DraftPublishRequestedData {
  projectId: string;
  tenantId: string;
  /** drafts.id being published — locked to 'publishing' by the action. */
  draftId: string;
  /** The queued publish_draft site_builds row the action inserted. */
  buildId: string;
}
