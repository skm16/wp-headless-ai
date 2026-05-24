import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";

/**
 * Dashboard — list of projects in the user's tenant(s).
 *
 * RLS auto-scopes the query to projects whose tenant_id is in
 * current_user_tenant_ids(). No explicit `.eq("tenant_id", ...)` here
 * because we trust the database to enforce the boundary. (If a future
 * code change accidentally drops the eq, RLS still saves us.)
 *
 * UI uses the Foundation primitives (Button, Badge, StatusDot, EmptyState,
 * Alert) but keeps today's data shape — the richer per-project surface
 * (deployment-derived status, production URL, intent chip, thumbnails) is
 * a follow-up refactor pending the deployments-schema decision. See the
 * `ProjectsListView` / `ProjectCard` demo at `/ui-kit/projects` for the
 * target shape.
 */
export default async function Dashboard() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name, client_name, wp_url, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <Alert tone="danger" title="Couldn't load your projects">
        {error.message}
      </Alert>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Start with one of your client's WordPress URLs — generate a homepage preview in about a minute. No credentials needed for the first look."
        action={
          <div className="flex items-center gap-2">
            <Link href="/preview">
              <Button>Try with a client&apos;s site →</Button>
            </Link>
            <Link href="/projects/new">
              <Button variant="ghost">Or set up from scratch</Button>
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-7 px-8 py-8">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[28px] font-extrabold leading-[1.15] tracking-[-0.02em] text-wht">
            My Sites
          </h1>
          <p className="mt-1 text-sm text-gry">
            One per client WordPress site you&apos;ve connected.
          </p>
        </div>
        <Link href="/projects/new">
          <Button>New project</Button>
        </Link>
      </header>

      <ul className="divide-y divide-bord overflow-hidden rounded-lg border border-bord bg-bg">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="group block px-5 py-4 transition-colors hover:bg-white/[0.025] focus-visible:bg-white/[0.025] focus-visible:outline-none"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-display text-base font-bold leading-snug text-wht group-hover:text-teal">
                    {p.name}
                  </h2>
                  <p className="mt-1 truncate font-mono text-xs text-gry-d">
                    {p.client_name ?? "No client name"}
                    {p.wp_url ? ` · ${p.wp_url}` : ""}
                  </p>
                </div>
                <ProjectStatusBadge status={p.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
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
 * Today's `projects.status` is the project-lifecycle column
 * (draft / onboarding / ready / archived). The richer deployment-derived
 * status (Building / Live / Failed) lives one schema-decision away —
 * keep this mapping close to the DB values so swapping in the new shape
 * is a one-record edit.
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
