"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { IntentChip } from "@/components/intent-picker";
import type { ProjectIntent } from "@/components/intent-picker";

export type ProjectListStatus =
  | "draft"
  | "onboarding"
  | "building"
  | "live"
  | "failed";

export interface ProjectListEntry {
  id: string;
  name: string;
  /** Client name — the agency's account-of-record for this site, distinct from `name`. */
  clientName?: string;
  status: ProjectListStatus;
  /** The WordPress URL the project is connected to. */
  wpUrl: string;
  /** Public URL the live site is served at. Only meaningful for `live`. */
  productionUrl?: string;
  /** Project intent — see §12 step 4. */
  intent?: ProjectIntent;
  /** Timestamp of the most recent deployment (preview or production). */
  lastDeployedAt?: Date;
  /** Short copy describing the failure when status === "failed". */
  errorMessage?: string;
}

export interface ProjectCardProps {
  project: ProjectListEntry;
  /** Route to the project workspace. Defaults to `/projects/{id}`. */
  hrefBase?: string;
  className?: string;
}

/**
 * Project card surfaced in the projects-list (`/dashboard` and `/projects`).
 * The whole card is the click target — agencies scan this list looking for
 * "which client sites need attention?", so the deployment-derived status and
 * the last-deployment recency are the most load-bearing details.
 *
 * Thumbnails are placeholder gradients today. When the Phase 3 visual-diff
 * pipeline lands (screenshot capture per deployment), the latest desktop
 * screenshot replaces the gradient.
 */
export function ProjectCard({
  project,
  hrefBase = "/projects",
  className,
}: ProjectCardProps) {
  const href = `${hrefBase}/${project.id}`;
  const meta = STATUS_META[project.status];

  return (
    <Link
      href={href}
      className={cn(
        "group block overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:border-brand/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
        className,
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-brand-muted via-white to-slate-50">
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-slate-900/40 to-transparent px-3 py-2">
          <Badge tone={meta.tone}>
            <StatusDot tone={meta.tone} pulse={meta.pulse} />
            {meta.label}
          </Badge>
        </div>
        <div className="flex h-full items-center justify-center">
          <p className="text-xs uppercase tracking-wider text-slate-400">
            {project.status === "live" ? "Latest deploy" : "Preview pending"}
          </p>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900 group-hover:text-brand-strong">
              {project.name}
            </h3>
            {project.clientName && (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {project.clientName}
              </p>
            )}
          </div>
          {project.intent && (
            // Omit onEdit — list view links into the workspace for that.
            // Wrapping a click handler inside this card's Link would be a
            // nested-interactive trap.
            <IntentChip value={project.intent} />
          )}
        </div>

        <dl className="space-y-1.5 text-xs">
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0 text-slate-500">WordPress</dt>
            <dd className="min-w-0 truncate font-mono text-slate-700">
              {project.wpUrl}
            </dd>
          </div>
          {project.productionUrl && (
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-slate-500">Live at</dt>
              <dd className="min-w-0 truncate font-mono text-slate-700">
                {project.productionUrl}
              </dd>
            </div>
          )}
        </dl>

        {project.status === "failed" && project.errorMessage && (
          <p className="rounded border border-danger/30 bg-danger-muted px-2 py-1.5 text-xs text-danger-strong">
            {project.errorMessage}
          </p>
        )}

        {project.lastDeployedAt && (
          <p className="text-xs text-slate-500">
            {project.status === "live" ? "Deployed" : "Updated"}{" "}
            {formatRelative(project.lastDeployedAt)}
          </p>
        )}
      </div>
    </Link>
  );
}

const STATUS_META: Record<
  ProjectListStatus,
  {
    tone: "neutral" | "warning" | "success" | "danger" | "info";
    label: string;
    pulse: boolean;
  }
> = {
  draft: { tone: "neutral", label: "Draft", pulse: false },
  onboarding: { tone: "info", label: "Onboarding", pulse: true },
  building: { tone: "warning", label: "Building", pulse: true },
  live: { tone: "success", label: "Live", pulse: false },
  failed: { tone: "danger", label: "Failed", pulse: false },
};
