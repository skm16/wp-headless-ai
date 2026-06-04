/**
 * scoped-review — pure partition of a review page list into "changed by this
 * edit" (actionable, shown by default) vs "carried forward" (collapsed under
 * show-all). null changedSlugs → treat every page as changed (full re-review).
 */
export interface ScopedPageInput {
  slug: string;
  approvalStatus: string;
}
export interface ScopedPagePartition<T extends ScopedPageInput> {
  changed: T[];
  carried: T[];
  changedCount: number;
}
export function partitionScopedPages<T extends ScopedPageInput>(
  pages: T[],
  changedSlugs: string[] | null,
): ScopedPagePartition<T> {
  if (changedSlugs === null) {
    return { changed: pages, carried: [], changedCount: pages.length };
  }
  const changedSet = new Set(changedSlugs);
  const changed = pages.filter((p) => changedSet.has(p.slug));
  const carried = pages.filter((p) => !changedSet.has(p.slug));
  return { changed, carried, changedCount: changed.length };
}
