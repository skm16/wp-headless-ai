import { deriveEditUiState } from "@/lib/jab/workspace-edit-state";
import { phaseLabel } from "@/lib/jab/build-status";

/** Pure presentational model for the chat "what changed" card. */
export interface WhatChangedCardInput {
  projectId: string;
  buildId: string | null;
  editStatus: string;
  buildStatus: string | null;
  promoted: boolean;
  action: string;
  changedPageCount: number | null;
  startedAtMs: number;
  nowMs: number;
}

export interface WhatChangedCard {
  statusLabel: string;
  phaseLabel: string | null;
  elapsed: string;
  blastRadius: string | null;
  progressHref: string | null;
  reviewHref: string | null;
  action: string;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export function buildWhatChangedCard(input: WhatChangedCardInput): WhatChangedCard {
  const ui = deriveEditUiState({
    editStatus: input.editStatus,
    buildStatus: input.buildStatus,
    promoted: input.promoted,
  });
  const active = ui.label === "Building…";
  const progressHref = input.buildId
    ? `/projects/${input.projectId}/builds/${input.buildId}/progress`
    : null;
  const reviewHref =
    ui.awaitingReview && input.buildId
      ? `/projects/${input.projectId}/builds/${input.buildId}/review`
      : null;
  return {
    statusLabel: ui.label,
    phaseLabel: active && input.buildStatus ? phaseLabel(input.buildStatus) : null,
    elapsed: formatElapsed(input.nowMs - input.startedAtMs),
    blastRadius:
      input.changedPageCount !== null ? `Changes ${input.changedPageCount} page(s)` : null,
    progressHref,
    reviewHref,
    action: input.action,
  };
}
