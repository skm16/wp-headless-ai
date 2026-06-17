/**
 * state — pure fold over draft snapshots + steps. The draft is a pure
 * function of (base build, active steps): spec §4. No IO here.
 */
export interface DraftVersionRow {
  id: string;
  unit_key: string;
  version_no: number;
  created_by_edit_id: string | null;
}

export interface DraftStepRow {
  id: string;
  status: string;
  undone_at: string | null;
  changed_slugs: string[] | null;
  created_at: string;
}

/**
 * A version is ACTIVE only when its creating step is completed and not undone.
 * A 'running' step (e.g. an in-progress edit that inserted a version row before
 * bumpDraftVersion committed it) does NOT activate its version row — prevents
 * in-flight patches from bleeding into concurrent edits' effective base.
 * Missing step → active (defensive: a truly orphaned completed row must not
 * silently vanish from the effective set).
 */
function isActiveVersion(version: DraftVersionRow, stepsById: Map<string, DraftStepRow>): boolean {
  if (!version.created_by_edit_id) return true;
  const step = stepsById.get(version.created_by_edit_id);
  if (!step) return true; // defensive: never lose committed work with a missing step row
  return step.status === "completed" && step.undone_at === null;
}

/** Latest active version per unit_key. Empty map entry = unit falls back to base build. */
export function effectiveUnitVersions<T extends DraftVersionRow>(
  versions: T[],
  steps: DraftStepRow[],
): Map<string, T> {
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const out = new Map<string, T>();
  for (const version of versions) {
    if (!isActiveVersion(version, stepsById)) continue;
    const cur = out.get(version.unit_key);
    if (!cur || version.version_no > cur.version_no) out.set(version.unit_key, version);
  }
  return out;
}

/** Per-unit version numbers are never reused — undone versions still count. */
export function nextUnitVersionNo(versions: DraftVersionRow[], unitKey: string): number {
  let max = 0;
  for (const v of versions) {
    if (v.unit_key === unitKey && v.version_no > max) max = v.version_no;
  }
  return max + 1;
}

/** Union of changed_slugs over ACTIVE (completed, not undone) steps — the publish blast radius. */
export function unionChangedSlugs(steps: DraftStepRow[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    if (step.status !== "completed" || step.undone_at !== null) continue;
    for (const slug of step.changed_slugs ?? []) out.add(slug);
  }
  return [...out];
}

/** Steps that currently contribute to the draft (history UI + publish gate). */
export function activeSteps<T extends DraftStepRow>(steps: T[]): T[] {
  return steps.filter((s) => s.status === "completed" && s.undone_at === null);
}
