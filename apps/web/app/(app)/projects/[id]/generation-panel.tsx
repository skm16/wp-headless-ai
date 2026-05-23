"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";

/**
 * Generation panel — the "Generate homepage" button + recent jobs list.
 *
 * Polling: when any job is in `queued` or `running` state, this calls
 * router.refresh() every 4s so the Server Component re-fetches and we
 * see status transitions live. The Inngest-backed pipeline will swap this
 * for Supabase realtime; v0 polling is fine for the once-per-minute-or-so
 * cadence a real generation runs at.
 *
 * Legacy notice: the GitHub-tied push lives here. The managed-hosting
 * flow replaces the branch/commit affordances with a hosted preview URL
 * + Publish flow (see /ui-kit/workspace). This file stays in place until
 * engineering ships the deployments schema.
 */
export interface GenerationJobView {
  id: string;
  pagePath: string;
  status: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  outputBranch: string | null;
  outputCommitSha: string | null;
}

export function GenerationPanel({
  projectId,
  githubRepoFullName,
  jobs,
}: {
  projectId: string;
  githubRepoFullName: string | null;
  jobs: GenerationJobView[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const hasInFlightJob = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );

  useEffect(() => {
    if (!hasInFlightJob) return;
    const tick = setInterval(() => {
      startTransition(() => {
        router.refresh();
      });
    }, 4000);
    return () => clearInterval(tick);
  }, [hasInFlightJob, router]);

  async function handleGenerate() {
    setSubmitError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pagePath: "/" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Generate homepage</CardTitle>
          <p className="mt-1 text-sm text-slate-600">
            One-shot AI rebuild of the source homepage as a Next.js Server
            Component, pushed to a fresh feature branch on{" "}
            <span className="font-mono text-slate-900">
              {githubRepoFullName ?? "—"}
            </span>
            .
          </p>
        </div>
        <Button
          type="button"
          onClick={handleGenerate}
          disabled={hasInFlightJob || isPending}
          loading={hasInFlightJob}
          loadingText="Generating…"
        >
          Generate homepage
        </Button>
      </CardHeader>
      <CardBody className="space-y-4">
        {submitError && <Alert tone="danger">{submitError}</Alert>}

        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">
            No generations yet. Click the button to kick off the first one.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="py-3">
                <JobRow job={j} githubRepoFullName={githubRepoFullName} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function JobRow({
  job,
  githubRepoFullName,
}: {
  job: GenerationJobView;
  githubRepoFullName: string | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-slate-900">
          <span className="font-mono">{job.pagePath}</span>
          <span className="ml-2 text-xs font-normal text-slate-500">
            {new Date(job.createdAt).toLocaleString()}
          </span>
        </p>
        <JobStatusBadge status={job.status} />
      </div>

      {job.status === "succeeded" && job.outputBranch && githubRepoFullName ? (
        <p className="text-xs text-slate-600">
          Pushed to{" "}
          <a
            href={`https://github.com/${githubRepoFullName}/tree/${job.outputBranch}`}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-slate-900 underline-offset-2 hover:underline"
          >
            {job.outputBranch}
          </a>
          {job.outputCommitSha ? (
            <>
              {" · commit "}
              <a
                href={`https://github.com/${githubRepoFullName}/commit/${job.outputCommitSha}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-slate-900 underline-offset-2 hover:underline"
              >
                {job.outputCommitSha.slice(0, 7)}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {job.status === "failed" && job.error ? (
        <p className="text-xs text-danger-strong">{job.error}</p>
      ) : null}

      {(job.status === "succeeded" || job.status === "failed") &&
      (job.inputTokens != null || job.outputTokens != null) ? (
        <p className="text-xs text-slate-500">
          {job.model ? `${job.model} · ` : ""}
          tokens in {job.inputTokens ?? "—"} / out {job.outputTokens ?? "—"}
          {job.cacheReadTokens ? ` · cache_read ${job.cacheReadTokens}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  const meta = JOB_STATUS_META[status] ?? JOB_STATUS_META.queued!;
  return (
    <Badge tone={meta.tone}>
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
    </Badge>
  );
}

const JOB_STATUS_META: Record<
  string,
  {
    tone: "neutral" | "warning" | "success" | "danger";
    label: string;
    pulse: boolean;
  }
> = {
  queued: { tone: "neutral", label: "Queued", pulse: false },
  running: { tone: "warning", label: "Running", pulse: true },
  succeeded: { tone: "success", label: "Succeeded", pulse: false },
  failed: { tone: "danger", label: "Failed", pulse: false },
};
