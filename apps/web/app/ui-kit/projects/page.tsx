import { notFound } from "next/navigation";
import { ProjectsDemo } from "./projects-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of the redesigned projects-list home — the surface
 * the user lands on after sign-in (the `/dashboard` route in production).
 *
 * Three scenarios toggleable via the header: empty (no projects yet — the
 * first-time-user moment), one (single-project agency on the Solo tier),
 * and many (a fuller agency book with mixed deployment states).
 *
 * Cards link to `/ui-kit/workspace` to make the demo round-trippable. The
 * real `/dashboard` route refactor is gated on the deployments-schema
 * decision — see plan §11.
 */
export default function ProjectsDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ProjectsDemo />;
}
