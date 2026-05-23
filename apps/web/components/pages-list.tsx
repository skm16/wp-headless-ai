import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { ContentDocStatus } from "@/components/content-doc-status";
import type { OwnershipMode } from "@/components/ownership-picker";

export type PageStatus =
  | "not-generated"
  | "building"
  | "preview"
  | "live"
  | "failed";

export interface PageEntry {
  /** Display label — "Home", "Blog index", "Blog post", "Generic page". */
  template: string;
  /** Route shape — "/", "/blog", "/blog/[slug]", "/[slug]". */
  slug: string;
  status: PageStatus;
  ownership: OwnershipMode;
  lastDeployedAt?: Date;
  /** Number of WP entries this template covers (e.g. 42 blog posts). */
  entriesCount?: number;
  /** Live URL for `live`/`preview` statuses. */
  url?: string;
  /** Direct link to wp-admin edit screen for WP-managed pages. */
  wpAdminUrl?: string;
  error?: string;
}

export interface PagesListProps {
  pages: PageEntry[];
  /** Brief copy at the top — coverage indicator. Defaults to count summary. */
  coverageNote?: string;
  /** Optional disclosure shown below the list — strangler-fig copy about forms etc. */
  fallbackNote?: string;
  onGenerate?: (entry: PageEntry) => void;
  onIterate?: (entry: PageEntry) => void;
  onRegenerate?: (entry: PageEntry) => void;
  className?: string;
}

/**
 * §4 Phase 3 + §13 — Pages list. Per-template rows surface what's generated,
 * what's pending, and which side owns the content (WP-managed vs
 * Jab-managed). Action affordances route to wp-admin (WP-managed) or to the
 * iteration loop (Jab-managed) based on the per-row ownership.
 *
 * The list IS the site's coverage indicator — agencies read this to know
 * what's headless and what still falls through to the strangler-fig proxy.
 */
export function PagesList({
  pages,
  coverageNote,
  fallbackNote,
  onGenerate,
  onIterate,
  onRegenerate,
  className,
}: PagesListProps) {
  if (pages.length === 0) {
    return (
      <EmptyState
        title="No templates yet"
        description="Generate your first page above to start covering the site."
        className={className}
      />
    );
  }

  const active = pages.filter(
    (p) => p.status === "live" || p.status === "preview",
  ).length;
  const note =
    coverageNote ??
    `${active} of ${pages.length} templates active.`;

  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-xs text-slate-500">{note}</p>

      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {pages.map((page) => (
          <li
            key={page.slug}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  {page.template}
                </p>
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                  {page.slug}
                </code>
                {page.entriesCount !== undefined && (
                  <span className="text-xs text-slate-500">
                    · {page.entriesCount}{" "}
                    {page.entriesCount === 1 ? "entry" : "entries"}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <ContentDocStatus value={page.ownership} />
                <StatusBadge
                  status={page.status}
                  lastDeployedAt={page.lastDeployedAt}
                />
              </div>
              {page.status === "failed" && page.error && (
                <p className="mt-1 text-xs text-danger-strong">{page.error}</p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {(page.status === "live" || page.status === "preview") &&
                page.url && (
                  <Link
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="ghost" size="sm">
                      Open ↗
                    </Button>
                  </Link>
                )}
              {page.status === "failed" && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onRegenerate?.(page)}
                  disabled={!onRegenerate}
                >
                  Regenerate
                </Button>
              )}
              {page.status === "not-generated" && (
                <Button
                  size="sm"
                  onClick={() => onGenerate?.(page)}
                  disabled={!onGenerate}
                >
                  Generate
                </Button>
              )}
              {page.ownership === "wp-managed" && page.wpAdminUrl ? (
                <Link
                  href={page.wpAdminUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="secondary" size="sm">
                    Edit in WordPress ↗
                  </Button>
                </Link>
              ) : page.ownership === "jab-managed" &&
                (page.status === "live" || page.status === "preview") ? (
                <Button
                  size="sm"
                  onClick={() => onIterate?.(page)}
                  disabled={!onIterate}
                >
                  Iterate
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {fallbackNote && (
        <p className="text-xs text-slate-500">{fallbackNote}</p>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  lastDeployedAt,
}: {
  status: PageStatus;
  lastDeployedAt?: Date;
}) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Badge tone={meta.tone}>
        <StatusDot tone={meta.tone} pulse={meta.pulse} />
        {meta.label}
      </Badge>
      {lastDeployedAt && (status === "live" || status === "preview") && (
        <span className="text-slate-500">
          · {formatRelative(lastDeployedAt)}
        </span>
      )}
    </span>
  );
}

const STATUS_META: Record<
  PageStatus,
  {
    tone: "neutral" | "warning" | "success" | "danger" | "info";
    label: string;
    pulse: boolean;
  }
> = {
  "not-generated": { tone: "neutral", label: "Not generated yet", pulse: false },
  building: { tone: "warning", label: "Building", pulse: true },
  preview: { tone: "info", label: "Preview", pulse: false },
  live: { tone: "success", label: "Live", pulse: false },
  failed: { tone: "danger", label: "Failed", pulse: false },
};

