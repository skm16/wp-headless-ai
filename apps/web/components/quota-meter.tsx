import Link from "next/link";
import { cn } from "@/lib/utils";

export interface QuotaMeterProps {
  /** Singular label for the metered resource — "Generations", "Sites". */
  label: string;
  used: number;
  limit: number;
  /** Active plan name shown alongside the label, e.g. "Free trial", "Studio". */
  planName?: string;
  /** When provided, an "Upgrade" link appears once the meter is in warning or danger. */
  upgradeHref?: string;
  className?: string;
}

/**
 * Plan-aware progress meter. Lives in the workspace header / project page
 * (mounted in Phase 5) and reflects the COST-1 quota guard from Phase 1.
 *
 * Thresholds drive the bar tint:
 *   < 80%   → neutral slate
 *   80-99%  → warning amber + "Upgrade" link appears (when upgradeHref given)
 *   ≥ 100%  → danger rose, generation surfaces disable elsewhere
 *
 * Renders a labelled bar with N/M readout. Pure presentational — quota math
 * happens server-side; this is just the meter that draws it.
 */
export function QuotaMeter({
  label,
  used,
  limit,
  planName,
  upgradeHref,
  className,
}: QuotaMeterProps) {
  const safeLimit = Math.max(limit, 1);
  const ratio = Math.min(used / safeLimit, 1);
  const percent = Math.round(ratio * 100);
  const state = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "neutral";

  const fillClass =
    state === "danger"
      ? "bg-danger"
      : state === "warning"
        ? "bg-warning"
        : "bg-slate-700";

  const readoutClass =
    state === "danger"
      ? "text-danger-strong"
      : state === "warning"
        ? "text-warning-strong"
        : "text-slate-700";

  return (
    <div className={cn("space-y-1.5", className)} aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <div className="flex items-baseline gap-2 text-slate-700">
          <span className="font-medium">{label}</span>
          {planName && (
            <span className="text-slate-400">· {planName}</span>
          )}
        </div>
        <span className={cn("font-semibold tabular-nums", readoutClass)}>
          {used} of {limit}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${used} of ${limit} used`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
      >
        <div
          className={cn("h-full transition-all", fillClass)}
          style={{ width: `${percent}%` }}
        />
      </div>
      {state !== "neutral" && upgradeHref && (
        <p className="text-xs">
          <Link
            href={upgradeHref}
            className={cn(
              "font-medium underline-offset-2 hover:underline",
              state === "danger"
                ? "text-danger-strong"
                : "text-warning-strong",
            )}
          >
            {state === "danger" ? "Out of quota — upgrade →" : "Upgrade for more →"}
          </Link>
        </p>
      )}
    </div>
  );
}
