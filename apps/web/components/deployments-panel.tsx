import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

export type DeploymentStatus =
  | "queued"
  | "building"
  | "preview"
  | "published"
  | "failed";

export interface Deployment {
  id: string;
  /** Path within the site — "/" for homepage, "/blog" for blog index, etc. */
  pagePath: string;
  status: DeploymentStatus;
  previewUrl?: string;
  productionUrl?: string;
  createdAt: Date;
  /** Engineering hint for the iteration tree (Phase 2G); not visualized at this slice. */
  parentId?: string;
  /** User's natural-language feedback that produced this deployment (Phase 2G). */
  feedback?: string;
  /** Error message when status === "failed" — uses the catalog from docs/saas-failure-states.md. */
  error?: string;
}

export interface DeploymentsPanelProps {
  deployments: Deployment[];
  /** Fires when a user clicks `Regenerate` on a failed deployment. */
  onRegenerate?: (deployment: Deployment) => void;
  /** Fires when a user clicks `Promote to production` on a preview. */
  onPromote?: (deployment: Deployment) => void;
  className?: string;
}

/**
 * §4 Phase 2 deliverable 2B — Activity panel. Replaces the GitHub-tied job
 * log (`generation-panel.tsx` + its JobRow) with a hosting-tied deployment
 * list. Each row is a discrete deploy; rows reveal the path, status,
 * timestamp, and the actions appropriate to the state.
 *
 * Today this renders mock data passed via props. Engineering ships the schema
 * (extend `generation_jobs` vs. new `deployments` table — open decision); the
 * UI surface stays identical when the real data lands.
 */
export function DeploymentsPanel({
  deployments,
  onRegenerate,
  onPromote,
  className,
}: DeploymentsPanelProps) {
  if (deployments.length === 0) {
    return (
      <EmptyState
        title="No deployments yet"
        description="Once you generate a page, each version appears here. The most recent goes live when you publish."
        className={className}
      />
    );
  }

  return (
    <ul
      className={cn(
        "divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white",
        className,
      )}
    >
      {deployments.map((deployment) => (
        <DeploymentRow
          key={deployment.id}
          deployment={deployment}
          onRegenerate={onRegenerate}
          onPromote={onPromote}
        />
      ))}
    </ul>
  );
}

interface DeploymentRowProps {
  deployment: Deployment;
  onRegenerate?: (deployment: Deployment) => void;
  onPromote?: (deployment: Deployment) => void;
}

function DeploymentRow({
  deployment,
  onRegenerate,
  onPromote,
}: DeploymentRowProps) {
  const meta = STATUS_META[deployment.status];
  return (
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
            {deployment.pagePath}
          </code>
          <Badge tone={meta.tone}>
            <StatusDot tone={meta.tone} pulse={meta.pulse} />
            {meta.label}
          </Badge>
          <span className="text-xs text-slate-500">
            {formatRelative(deployment.createdAt)}
          </span>
        </div>
        {deployment.feedback && (
          <p className="mt-1 truncate text-xs italic text-slate-600">
            “{deployment.feedback}”
          </p>
        )}
        {deployment.status === "failed" && deployment.error && (
          <p className="mt-1 text-xs text-danger-strong">{deployment.error}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {deployment.status === "published" && deployment.productionUrl && (
          <Link
            href={deployment.productionUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="ghost" size="sm">
              Open site ↗
            </Button>
          </Link>
        )}
        {deployment.status === "preview" && deployment.previewUrl && (
          <>
            <Link
              href={deployment.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="ghost" size="sm">
                Open preview ↗
              </Button>
            </Link>
            <Button
              size="sm"
              onClick={() => onPromote?.(deployment)}
              disabled={!onPromote}
            >
              Publish
            </Button>
          </>
        )}
        {deployment.status === "failed" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRegenerate?.(deployment)}
            disabled={!onRegenerate}
          >
            Regenerate
          </Button>
        )}
      </div>
    </li>
  );
}

const STATUS_META: Record<
  DeploymentStatus,
  {
    tone: "neutral" | "warning" | "success" | "danger" | "info";
    label: string;
    pulse: boolean;
  }
> = {
  queued: { tone: "neutral", label: "Queued", pulse: false },
  building: { tone: "warning", label: "Building", pulse: true },
  preview: { tone: "info", label: "Preview", pulse: false },
  published: { tone: "success", label: "Live", pulse: false },
  failed: { tone: "danger", label: "Failed", pulse: false },
};

