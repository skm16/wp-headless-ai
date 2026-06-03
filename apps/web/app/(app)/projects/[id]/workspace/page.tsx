import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { displayDomainFrom } from "@/lib/derive";
import { loadLatestBuildForWorkspace } from "@/lib/jab/load-build-for-workspace";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import {
  loadWorkspaceEditHistory,
  requestWorkspaceEditAction,
} from "@/lib/actions/workspace-edit";
import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import {
  WorkspaceJabDemo,
  type WorkspaceProject,
} from "@/app/ui-kit/workspace-jab/workspace-jab-demo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace — JAB",
  robots: { index: false, follow: false },
};

/**
 * Per-project workspace. Reuses the same UI shell as the stakeholder demo
 * at `/ui-kit/workspace-jab`, but injects real data via the `project` prop:
 *
 *   • topbar back-link → project name (links back to /projects/[id])
 *   • URL chips        → project's WordPress display domain
 *   • preview iframe   → honest empty state (NoPreviewFallback) until the
 *                        Stage 1 preview pipeline lands. The Stage 0 schema
 *                        cleanup dropped the legacy `preview_html` column
 *                        on `projects`; the rebuilt preview will be sourced
 *                        from a dedicated worker output, not the projects
 *                        row.
 *
 * Everything else (AI panel conversation, code panel templates, WP panel
 * mocks) stays mocked for now — matches the brand doc's "real data +
 * mocked extras" pattern from the Site Detail page. Those slots will go
 * real as the relevant tables land.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist":
 * if the project belongs to another tenant, supabase returns 0 rows with
 * `code: "PGRST116"`. We surface as 404 in both cases so an attacker
 * can't enumerate IDs to discover other tenants' project IDs — same
 * posture as the project page itself.
 */
export default async function ProjectWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, wp_url")
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  // Best-effort load of the latest completed Phase B build. Null when the
  // project hasn't been generated yet — workspace falls back to the demo's
  // mocked Code panel templates in that case. Tenant access was validated
  // by the RLS-enforced projects query above; the loader uses admin client
  // (service role) because the site-screenshots bucket lacks an authenticated
  // read policy. The projectId filter is the security boundary here.
  const build = await loadLatestBuildForWorkspace(project.id);
  const buildState = await loadProjectBuildState(supabase, project.id);
  const editHistory = await loadWorkspaceEditHistory(project.id, 10);

  const workspaceProject: WorkspaceProject = {
    id: project.id,
    name: project.name,
    displayDomain: displayDomainFrom(project.wp_url),
    previewHtml: null,
    build,
  };

  const sourceBuildId =
    buildState.latestBuild?.status === "ready" ? buildState.latestBuild.id : null;

  const submitEdit = async (formData: FormData) => {
    "use server";
    const scope = formData.get("scope");
    const target = formData.get("target");
    const prompt = formData.get("prompt");
    if (
      typeof scope !== "string" ||
      typeof target !== "string" ||
      typeof prompt !== "string"
    ) {
      throw new Error("submitEdit: scope/target/prompt missing");
    }
    if (!sourceBuildId) {
      throw new Error(
        "Targeted edits require a ready build. Trigger Build site first.",
      );
    }
    await requestWorkspaceEditAction({
      projectId: project.id,
      sourceBuildId,
      scope: scope as WorkspaceEditScope,
      target,
      prompt,
    });
  };

  return (
    <div className="flex flex-col">
      <WorkspaceEditsPanel
        projectId={project.id}
        sourceBuildId={sourceBuildId}
        history={editHistory}
        submitAction={submitEdit}
      />
      <WorkspaceJabDemo project={workspaceProject} />
    </div>
  );
}

interface WorkspaceEditsPanelProps {
  projectId: string;
  sourceBuildId: string | null;
  history: Awaited<ReturnType<typeof loadWorkspaceEditHistory>>;
  submitAction: (formData: FormData) => Promise<void>;
}

function WorkspaceEditsPanel({
  projectId,
  sourceBuildId,
  history,
  submitAction,
}: WorkspaceEditsPanelProps) {
  return (
    <section className="border-b border-bord bg-bg px-8 py-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold leading-snug text-wht">
          Targeted edits
        </h2>
        {!sourceBuildId && (
          <span className="font-mono text-[11px] text-amb">
            Requires a ready build
          </span>
        )}
      </div>
      <form
        action={submitAction}
        className="grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr_2fr_auto]"
      >
        <select
          name="scope"
          defaultValue="shell"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-surf px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        >
          <option value="shell">shell</option>
          <option value="component">component</option>
        </select>
        <input
          type="text"
          name="target"
          placeholder="header / footer / core/heading"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-surf px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <input
          type="text"
          name="prompt"
          placeholder="Describe the change you want"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-surf px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!sourceBuildId}
          className="inline-flex h-9 items-center rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Run edit →
        </button>
      </form>
      {history.length > 0 && (
        <ul className="mt-4 divide-y divide-bord overflow-hidden rounded-lg border border-bord bg-bg">
          {history.map((edit) => (
            <li
              key={edit.id}
              className="flex items-center gap-3 px-4 py-2.5 text-[13px]"
            >
              <span className="shrink-0 rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[10px] text-gry">
                {edit.scope}/{edit.target}
              </span>
              <span className="min-w-0 flex-1 truncate text-gry">
                {edit.prompt}
              </span>
              <EditStatusChip status={edit.status} />
              {edit.resultBuildId && (
                <Link
                  href={`/projects/${projectId}/builds/${edit.resultBuildId}/progress`}
                  className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                >
                  view build →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EditStatusChip({ status }: { status: string }) {
  const TONE: Record<string, string> = {
    queued: "border-bord bg-elev text-gry",
    running: "border-amb/30 bg-amb/10 text-amb",
    completed: "border-teal/30 bg-teal/10 text-teal",
    failed: "border-red/30 bg-red/10 text-red",
  };
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
        TONE[status] ?? TONE.queued
      }`}
    >
      {status}
    </span>
  );
}
