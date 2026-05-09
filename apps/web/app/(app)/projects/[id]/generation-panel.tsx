"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Generation panel — the "Generate homepage" button + recent jobs list.
 *
 * Polling: when any job is in `queued` or `running` state, this calls
 * router.refresh() every 4s so the Server Component re-fetches and we
 * see status transitions live. Phase E will swap this for Supabase
 * realtime; v0 polling is fine for the once-per-minute-or-so cadence
 * a real generation runs at.
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
    <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Generate homepage</h2>
          <p className="mt-1 text-sm text-slate-600">
            One-shot AI rebuild of the source homepage as a Next.js Server
            Component, pushed to a fresh feature branch on{" "}
            <span className="font-mono text-slate-900">{githubRepoFullName}</span>.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={hasInFlightJob || isPending}
          className="shrink-0 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {hasInFlightJob ? "Generating…" : "Generate homepage"}
        </button>
      </div>

      {submitError && (
        <p
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {submitError}
        </p>
      )}

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
    </section>
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
        <StatusBadge status={job.status} />
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
        <p className="text-xs text-rose-700">{job.error}</p>
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

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    queued: "bg-slate-100 text-slate-700",
    running: "bg-amber-100 text-amber-800",
    succeeded: "bg-emerald-100 text-emerald-800",
    failed: "bg-rose-100 text-rose-800",
  };
  const cls = palette[status] ?? palette.queued!;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
      {status}
    </span>
  );
}
