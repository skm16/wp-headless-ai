import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { GenerationPanel } from "./generation-panel";
import { LocalDevGuide } from "./local-dev-guide";

/**
 * Project detail — metadata + Phase-C placeholder for the onboarding wizard.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist":
 * if the project belongs to another tenant, supabase returns 0 rows with
 * `code: "PGRST116"`. We surface as 404 in both cases so an attacker can't
 * enumerate IDs to discover other tenants' project IDs.
 *
 * Post-§12 note: this route still uses the GitHub-tied pipeline
 * (GenerationPanel, LocalDevGuide). The canonical post-pivot workspace IA
 * lives in the `/ui-kit/workspace` demo (DeploymentsPanel + PreviewFrame +
 * IterationPanel). This file gets the new workspace assembly when
 * engineering ships the deployments schema.
 */
export default async function ProjectDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, client_name, wp_url, status, created_at, github_repo_full_name, manifest, onboarded_at",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  const abilityCount = project.manifest
    ? (project.manifest as { abilities?: unknown[] }).abilities?.length ?? 0
    : 0;

  const { data: jobs } = await supabase
    .from("generation_jobs")
    .select(
      "id, page_path, status, error, started_at, finished_at, created_at, model, input_tokens, output_tokens, cache_read_tokens, output_branch, output_commit_sha",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <article className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="text-sm text-slate-500">
          <Link href="/dashboard" className="hover:underline">
            Projects
          </Link>{" "}
          /
        </p>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold text-slate-900">{project.name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {project.client_name ?? "No client name"}
              {project.wp_url ? (
                <>
                  {" · "}
                  <a
                    href={project.wp_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:underline"
                  >
                    {project.wp_url}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <ProjectStatusBadge status={project.status} />
        </div>
      </header>

      {project.status === "ready" ? (
        <>
          <Card>
            <CardBody>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-success-strong">
                    Onboarding complete
                  </h2>
                  <p className="mt-1 text-sm text-slate-700">
                    {abilityCount}{" "}
                    {abilityCount === 1 ? "ability" : "abilities"} discovered.
                    Ready to generate a page.
                  </p>
                </div>
                <Link href={`/projects/${project.id}/onboard`}>
                  <Button variant="ghost" size="sm">
                    Re-run wizard
                  </Button>
                </Link>
              </div>
              <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                    GitHub repo
                  </dt>
                  <dd className="mt-0.5 font-mono text-slate-700">
                    {project.github_repo_full_name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                    Onboarded
                  </dt>
                  <dd className="mt-0.5 text-slate-700">
                    {project.onboarded_at
                      ? new Date(project.onboarded_at).toLocaleString()
                      : "—"}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>
          <GenerationPanel
            projectId={project.id}
            githubRepoFullName={project.github_repo_full_name}
            jobs={(jobs ?? []).map((j) => ({
              id: j.id as string,
              pagePath: j.page_path as string,
              status: j.status as string,
              error: (j.error as string | null) ?? null,
              createdAt: j.created_at as string,
              startedAt: (j.started_at as string | null) ?? null,
              finishedAt: (j.finished_at as string | null) ?? null,
              model: (j.model as string | null) ?? null,
              inputTokens: (j.input_tokens as number | null) ?? null,
              outputTokens: (j.output_tokens as number | null) ?? null,
              cacheReadTokens: (j.cache_read_tokens as number | null) ?? null,
              outputBranch: (j.output_branch as string | null) ?? null,
              outputCommitSha: (j.output_commit_sha as string | null) ?? null,
            }))}
          />
          {project.github_repo_full_name && hasSucceededJob(jobs) ? (
            <LocalDevGuide
              githubRepoFullName={project.github_repo_full_name}
              latestSucceededBranch={latestSucceededBranch(jobs)}
            />
          ) : null}
        </>
      ) : (
        <EmptyState
          title="Finish setting up this project"
          description="Connect the Jab plugin on your client's WordPress install. Existing GitHub-export projects also finish their setup here."
          action={
            <Link href={`/projects/${project.id}/onboard`}>
              <Button>
                {project.status === "onboarding"
                  ? "Resume onboarding"
                  : "Start onboarding"}
              </Button>
            </Link>
          }
        />
      )}
    </article>
  );
}

type JobsRow = {
  id?: unknown;
  status?: unknown;
  output_branch?: unknown;
  created_at?: unknown;
}[];

function hasSucceededJob(jobs: JobsRow | null | undefined): boolean {
  if (!jobs) return false;
  return jobs.some((j) => j.status === "succeeded" && Boolean(j.output_branch));
}

function latestSucceededBranch(
  jobs: JobsRow | null | undefined,
): string | null {
  if (!jobs) return null;
  // Jobs come back ordered by created_at desc, so the first succeeded
  // entry is the latest.
  for (const j of jobs) {
    if (j.status === "succeeded" && typeof j.output_branch === "string") {
      return j.output_branch;
    }
  }
  return null;
}

function ProjectStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft!;
  return (
    <Badge tone={meta.tone} className="shrink-0">
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
    </Badge>
  );
}

/**
 * Mirrors the dashboard's status meta. When the deployments-schema
 * decision lands, both files swap to the richer derived-status table
 * (live / building / failed / draft) in lockstep.
 */
const STATUS_META: Record<
  string,
  {
    tone: "neutral" | "warning" | "success" | "danger" | "info";
    label: string;
    pulse: boolean;
  }
> = {
  draft: { tone: "neutral", label: "Draft", pulse: false },
  onboarding: { tone: "warning", label: "Onboarding", pulse: true },
  ready: { tone: "success", label: "Ready", pulse: false },
  archived: { tone: "neutral", label: "Archived", pulse: false },
};
