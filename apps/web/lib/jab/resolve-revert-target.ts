/**
 * resolve-revert-target — pure mapping from a user-named "version N" to a
 * workspace_edits id. v1 semantics: version N (1-based) = the Nth completed,
 * non-undone edit in chronological (ascending) order. Out of range → typed
 * failure the caller surfaces as a clarifying chat reply, never a guess.
 */
export interface RevertEditRow {
  id: string;
  createdAt: string;
}

export type ResolveRevertTargetResult =
  | { ok: true; editId: string }
  | { ok: false; reason: "out_of_range" };

export function resolveRevertTarget(
  completedEditsAscending: RevertEditRow[],
  version: number,
): ResolveRevertTargetResult {
  if (!Number.isInteger(version) || version < 1 || version > completedEditsAscending.length) {
    return { ok: false, reason: "out_of_range" };
  }
  return { ok: true, editId: completedEditsAscending[version - 1].id };
}
