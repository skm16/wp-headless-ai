/**
 * ScopedReviewBanner — shown above the page list when reviewing an edit build
 * (spec §3.4). Explains that untouched pages carried forward their prior
 * approval and only the changed pages need review.
 */
export function ScopedReviewBanner({
  action,
  changedCount,
  carriedCount,
}: {
  action: string;
  changedCount: number;
  carriedCount: number;
}) {
  return (
    <div className="mb-4 rounded-lg border border-teal/30 bg-teal/[0.04] px-5 py-4">
      <div className="text-sm font-bold text-teal">Scoped review — AI edit</div>
      <p className="mt-1 text-sm text-gry">{action}</p>
      <p className="mt-1 text-[13px] text-gry-d">
        {changedCount} changed page(s) need review. {carriedCount} unchanged page(s) kept their prior
        approval and are hidden by default.
      </p>
    </div>
  );
}
