import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * Dashboard — list of projects in the user's tenant(s).
 *
 * RLS auto-scopes the query to projects whose tenant_id is in
 * current_user_tenant_ids(). No explicit `.eq("tenant_id", ...)` here
 * because we trust the database to enforce the boundary. (If a future
 * code change accidentally drops the eq, RLS still saves us.)
 */
export default async function Dashboard() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name, client_name, wp_url, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="rounded-md bg-rose-50 p-4 text-sm text-rose-800">
        Failed to load projects: {error.message}
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h1 className="text-2xl font-semibold text-slate-900">No projects yet</h1>
        <p className="mt-2 max-w-md text-slate-600">
          Each project represents one WordPress site you&apos;re migrating to a
          headless Next.js app. Create one to get started.
        </p>
        <Link
          href="/projects/new"
          className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Create your first project
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Projects</h1>
        <Link
          href="/projects/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          New project
        </Link>
      </header>

      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="block px-4 py-3 hover:bg-slate-50"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{p.name}</h2>
                  <p className="text-sm text-slate-600">
                    {p.client_name ?? "No client name"}
                    {p.wp_url ? ` · ${p.wp_url}` : ""}
                  </p>
                </div>
                <StatusPill status={p.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
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
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
