import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ProjectCard,
  type ProjectListEntry,
} from "@/components/project-card";

export interface ProjectsListViewProps {
  projects: ProjectListEntry[];
  /** Where the empty-state "wow" CTA points. Default `/preview`. */
  previewHref?: string;
  /** Where the empty-state secondary CTA points. Default `/projects/new`. */
  newProjectHref?: string;
  /** Where each card links into. Default `/projects`. */
  projectHrefBase?: string;
}

/**
 * Projects-list home. Two states:
 *   - Populated: header with action + responsive grid of `ProjectCard`s.
 *   - Empty: "no projects yet" hero with two CTAs — the `/preview` wow path
 *     (recommended; lowest friction) and the explicit `/projects/new` path.
 *
 * §5 calls out the empty state as the natural first-time-user moment, so the
 * copy promotes the wow path: someone who's just signed up without doing the
 * anonymous-draft flow should land here and get pulled into `/preview`
 * rather than into a credentials form.
 */
export function ProjectsListView({
  projects,
  previewHref = "/preview",
  newProjectHref = "/projects/new",
  projectHrefBase = "/projects",
}: ProjectsListViewProps) {
  if (projects.length === 0) {
    return (
      <EmptyProjectsList
        previewHref={previewHref}
        newProjectHref={newProjectHref}
      />
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Projects</h1>
          <p className="mt-0.5 text-sm text-slate-600">
            One per client WordPress site you&apos;ve connected.
          </p>
        </div>
        <Link href={newProjectHref}>
          <Button>New project</Button>
        </Link>
      </header>

      <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectCard project={project} hrefBase={projectHrefBase} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyProjectsList({
  previewHref,
  newProjectHref,
}: {
  previewHref: string;
  newProjectHref: string;
}) {
  const steps = [
    {
      title: "Paste a client's URL",
      body: "We generate a homepage preview straight from their public WordPress site. No setup, no credentials yet.",
    },
    {
      title: "Save the ones you like",
      body: "Each saved preview becomes a project here. Connect the WordPress app password when you're ready to go live.",
    },
    {
      title: "Refine and publish",
      body: "Edit copy and design in plain English. Publish to a real URL with a custom domain when you're done.",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-10 text-center">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Start with a client&apos;s site
        </h1>
        <p className="mx-auto max-w-xl text-base text-slate-600">
          Generate a homepage preview from any WordPress URL — no account or
          credentials needed for the first look. Save the ones you want to
          turn into client projects.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href={previewHref}>
          <Button size="lg">Try it with a client&apos;s site →</Button>
        </Link>
        <Link href={newProjectHref}>
          <Button size="lg" variant="ghost">
            Or set up from scratch
          </Button>
        </Link>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, idx) => (
          <li
            key={step.title}
            className="rounded-lg border border-slate-200 bg-white p-5 text-left shadow-sm"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-muted text-xs font-semibold text-brand-strong">
              {idx + 1}
            </span>
            <h3 className="mt-3 text-sm font-semibold text-slate-900">
              {step.title}
            </h3>
            <p className="mt-1 text-sm text-slate-600">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
