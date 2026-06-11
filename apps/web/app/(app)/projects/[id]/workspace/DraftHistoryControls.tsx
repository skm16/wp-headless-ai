"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  undoLastEditAction,
  revertToVersionAction,
  discardDraftAction,
} from "@/lib/actions/draft-actions";

/**
 * DraftHistoryControls — client component that renders undo / revert / discard
 * buttons inside the workspace history panel (spec §6.3 / Phase-2 T9).
 *
 * Three variants driven by `kind`:
 *   "undo"    — shown on the LATEST active completed draft step; calls
 *               undoLastDraftStepAction (always undoes the last step, not
 *               the specific row — by design, linear history).
 *   "revert"  — shown on earlier active completed draft steps; calls
 *               revertDraftToStepAction(projectId, editId).
 *   "discard" — shown in the panel header when ≥1 active step exists; calls
 *               discardDraftAction with a window.confirm gate.
 *
 * All three go into a useTransition so buttons are disabled while in flight,
 * then call router.refresh() on completion so the server component re-renders
 * the updated state.
 */

export interface DraftHistoryControlsProps {
  projectId: string;
  editId: string;
  kind: "undo" | "revert" | "discard";
}

export function DraftHistoryControls({
  projectId,
  editId,
  kind,
}: DraftHistoryControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleUndo() {
    startTransition(async () => {
      await undoLastEditAction(projectId);
      router.refresh();
    });
  }

  function handleRevert() {
    startTransition(async () => {
      await revertToVersionAction(projectId, editId);
      router.refresh();
    });
  }

  function handleDiscard() {
    if (
      !window.confirm("Discard the draft? This cannot be undone.")
    )
      return;
    startTransition(async () => {
      await discardDraftAction(projectId);
      router.refresh();
    });
  }

  if (kind === "undo") {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={handleUndo}
        className="shrink-0 rounded border border-bord px-1.5 py-0.5 font-mono text-[10px] text-gry transition-colors hover:border-teal/50 hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "…" : "Undo"}
      </button>
    );
  }

  if (kind === "revert") {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={handleRevert}
        className="shrink-0 rounded border border-bord px-1.5 py-0.5 font-mono text-[10px] text-gry transition-colors hover:border-teal/50 hover:text-teal disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "…" : "↩ Revert to here"}
      </button>
    );
  }

  // kind === "discard"
  return (
    <button
      type="button"
      disabled={pending}
      onClick={handleDiscard}
      className="shrink-0 font-mono text-[11px] text-red/70 transition-colors hover:text-red disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Discarding…" : "Discard draft"}
    </button>
  );
}
