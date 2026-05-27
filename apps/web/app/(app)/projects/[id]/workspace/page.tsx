import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { displayDomainFrom } from "@/lib/derive";
import { loadLatestBuildForWorkspace } from "@/lib/jab/load-build-for-workspace";
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

  const workspaceProject: WorkspaceProject = {
    id: project.id,
    name: project.name,
    displayDomain: displayDomainFrom(project.wp_url),
    previewHtml: null,
    build,
  };

  return <WorkspaceJabDemo project={workspaceProject} />;
}
