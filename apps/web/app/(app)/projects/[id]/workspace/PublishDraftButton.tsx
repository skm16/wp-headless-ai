"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  publishDraftAction,
  cancelPublishAction,
} from "@/lib/actions/publish-draft-action";

/**
 * PublishDraftButton — client control in the workspace edit-history panel header
 * (next to "Discard draft"), the Live-Draft publish bridge's user entry point
 * (2026-06-18 plan, Task 9).
 *
 * Two states, driven by the draft's status (surfaced by the workspace page):
 *   • draftStatus="active"     — shown when ≥1 active draft step exists. On click,
 *     publishDraftAction(projectId) snapshots the draft into a queued
 *     publish_draft build and dispatches the worker; on success we push the user
 *     to that build's progress page (which advances to the per-page review screen
 *     when the pipeline reaches ready).
 *   • draftStatus="publishing" — the draft is locked mid-publish. We show
 *     "Publishing…" (disabled) plus a Cancel affordance: cancelPublishAction
 *     reverts the draft active→… so the user can abandon a publish stuck at
 *     review and resume editing (edits stay intact).
 *
 * Both calls go through useTransition so the buttons disable while in flight,
 * then router.refresh() (cancel) / router.push() (publish) so the surrounding
 * server component re-renders the updated state.
 */

export interface PublishDraftButtonProps {
  projectId: string;
  /** The live draft's status — "active" (publishable) or "publishing" (locked). */
  draftStatus: "active" | "publishing";
}

export function PublishDraftButton({
  projectId,
  draftStatus,
}: PublishDraftButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handlePublish() {
    startTransition(async () => {
      const { buildId } = await publishDraftAction(projectId);
      router.push(`/projects/${projectId}/builds/${buildId}/progress`);
    });
  }

  function handleCancel() {
    if (
      !window.confirm(
        "Cancel the publish? Your draft edits stay intact and you can keep editing.",
      )
    )
      return;
    startTransition(async () => {
      await cancelPublishAction(projectId);
      router.refresh();
    });
  }

  if (draftStatus === "publishing") {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="rounded-full border border-bord bg-elev px-2 py-0.5 font-mono text-[10px] text-gry">
          Publishing…
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={handleCancel}
          className="shrink-0 font-mono text-[11px] text-red/70 transition-colors hover:text-red disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Cancelling…" : "Cancel publish"}
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={handlePublish}
      className="inline-flex h-6 shrink-0 items-center rounded-md bg-teal px-2.5 font-mono text-[11px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Publishing…" : "Publish draft →"}
    </button>
  );
}
