import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ProjectCard,
  type ProjectListEntry,
} from "@/components/project-card";

export interface ProjectsListViewProps {
  projects: ProjectListEntry[];
  /** Where the empty-state CTA points. Default `/projects/new`. */
  newProjectHref?: string;
  /** Where each card links into. Default `/projects`. */
  projectHrefBase?: string;
}

/**
 * Projects-list home. Two states:
 *   - Populated: header with action + responsive grid of `ProjectCard`s.
 *   - Empty: "no projects yet" hero with one CTA pointing at the
 *     new-project flow.
 *
 * Stage 0 v2 dropped the pre-auth `/preview` flow — the empty-state copy
 * no longer dual-paths through a wow-preview teaser. New projects start
 * at `/projects/new` and walk the four-step onboarding wizard.
 */
export function ProjectsListView({
  projects,
  newProjectHref = "/projects/new",
  projectHrefBase = "/projects",
}: ProjectsListViewProps) {
  if (projects.length === 0) {
    return <EmptyProjectsList newProjectHref={newProjectHref} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-wht">Projects</h1>
          <p className="mt-0.5 text-sm text-gry">
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

function EmptyProjectsList({ newProjectHref }: { newProjectHref: string }) {
  const steps = [
    {
      title: "Connect a client's WordPress",
      body: "Drop in a URL, install the plugin, and authenticate with an application password. We'll verify the plugin is current.",
    },
    {
      title: "Assign content ownership",
      body: "Decide which content types live in WordPress (collections like blog posts) vs. Jab (bespoke marketing pages). You can change this later.",
    },
    {
      title: "Build + publish",
      body: "Trigger the build, review per-page fidelity, regenerate anything that drifts, then publish to a preview URL.",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-10 text-center">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight text-wht">
          Connect your first client site
        </h1>
        <p className="mx-auto max-w-xl text-base text-gry">
          Each project pairs Jab with one WordPress install. Onboarding takes
          about ten minutes — no developer required.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href={newProjectHref}>
          <Button size="lg">Start a project →</Button>
        </Link>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, idx) => (
          <li
            key={step.title}
            className="rounded-lg border border-bord bg-bg p-5 text-left shadow-sm"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal/10 text-xs font-semibold text-teal">
              {idx + 1}
            </span>
            <h3 className="mt-3 text-sm font-semibold text-wht">
              {step.title}
            </h3>
            <p className="mt-1 text-sm text-gry">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
