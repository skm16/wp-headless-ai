import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
    .select("id, name, client_name, wp_url, status, created_at")
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

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

      <section className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          Onboarding wizard — Phase C
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600">
          Coming next: install the Jab plugin on the client&apos;s WordPress
          site, paste the WP credentials, connect a GitHub repo, and we&apos;ll
          fetch the abilities manifest and scaffold the first commit.
        </p>
      </section>
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
