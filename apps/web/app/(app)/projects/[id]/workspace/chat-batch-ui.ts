import { batchProgressLabel } from "@/lib/jab/batch-edit";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

export interface BatchChipModel {
  /** Show the "apply to all" primary chip (a propose turn awaiting confirmation). */
  showApplyAll: boolean;
  /** Count in the set, for the chip label ("Apply to all 3"). */
  count: number;
  /** Progress hint text for an in-progress apply turn, or null. */
  progressLabel: string | null;
  /** The canned message the "apply to all" chip sends. */
  applyAllMessage: string;
}

/**
 * A batch clarify (needsClarification + batchRemaining) → show the confirm chips.
 * A batch edit (edit linked + batchRemaining) → show a progress hint, no chips.
 */
export function batchChipModel(
  m: ChatMessageView,
  opts?: { superseded?: boolean },
): BatchChipModel | null {
  const count = m.batchRemaining.length;
  if (count === 0) return null;
  // A propose is the ONLY bubble that offers "Apply to all": it dispatched no
  // edit (editId == null), hasn't failed, and hasn't been superseded by a later
  // batch turn in the same conversation (findings A + D). An apply/error turn
  // has a linked edit and only ever shows the progress hint.
  const isLiveProposeAwaitingConfirm =
    m.needsClarification && m.editId == null && m.editStatus !== "failed" && !opts?.superseded;
  if (isLiveProposeAwaitingConfirm) {
    return {
      showApplyAll: true,
      count,
      progressLabel: null,
      applyAllMessage: "Yes, apply the same change to all of them.",
    };
  }
  // apply turn (edit linked): just a progress hint
  return { showApplyAll: false, count, progressLabel: batchProgressLabel(count), applyAllMessage: "" };
}

/**
 * A batch propose is superseded once a LATER assistant turn in the same
 * conversation also carries a batch (finding D): re-clicking a stale propose's
 * "Apply to all" chip would re-run the whole set. Returns true when any
 * assistant message after `index` still has an in-progress batch.
 */
export function isProposeSuperseded(messages: ChatMessageView[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant" && messages[i].batchRemaining.length > 0) return true;
  }
  return false;
}
