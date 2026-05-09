import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { GenerationPanel } from "./generation-panel";

/**
 * Project detail — metadata + Phase-C placeholder for the onboarding wizard.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist":
 * if the project belongs to another tenant, supabase returns 0 rows with
 * `code: "PGRST116"`. We surface as 404 in both cases so an attacker can't
 * enumerate IDs to discover other tenants' project IDs.
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
          <div>
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
          <StatusPill status={project.status} />
        </div>
      </header>

      {project.status === "ready" ? (
        <>
        <section className="space-y-4 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-emerald-900">
                Onboarding complete
              </h2>
              <p className="mt-1 text-sm text-emerald-800">
                {abilityCount} {abilityCount === 1 ? "ability" : "abilities"} discovered. Ready to generate a page.
              </p>
            </div>
            <Link
              href={`/projects/${project.id}/onboard`}
              className="text-sm font-medium text-emerald-900 underline-offset-2 hover:underline"
            >
              Re-run wizard
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-emerald-700">GitHub repo</dt>
              <dd className="mt-0.5 font-mono text-emerald-900">
                {project.github_repo_full_name}
              </dd>
            </div>
            <div>
              <dt className="text-emerald-700">Onboarded</dt>
              <dd className="mt-0.5 text-emerald-900">
                {project.onboarded_at
                  ? new Date(project.onboarded_at).toLocaleString()
                  : "—"}
              </dd>
            </div>
          </dl>
        </section>
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
        </>
      ) : (
        <section className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <h2 className="text-lg font-semibold text-slate-900">
            Connect this project to WordPress + GitHub
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600">
            Verify the Jab plugin on the client&apos;s WordPress install, then
            link the GitHub repo where Jab will push generated code.
          </p>
          <Link
            href={`/projects/${project.id}/onboard`}
            className="mt-5 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            {project.status === "onboarding" ? "Resume onboarding" : "Start onboarding"}
          </Link>
        </section>
      )}
    </article>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    draft: "bg-slate-100 text-slate-700",
    onboarding: "bg-amber-100 text-amber-800",
    ready: "bg-emerald-100 text-emerald-800",
    archived: "bg-slate-100 text-slate-500",
  };
  const cls = palette[status] ?? palette.draft!;
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
