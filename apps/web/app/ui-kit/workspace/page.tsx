import { notFound } from "next/navigation";
import { WorkspaceDemo } from "./workspace-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of the redesigned project workspace IA — Phase 2
 * deliverable 2B. Project context lives in the top nav and sidebar footer;
 * the preview is front-and-center in the main content area; Pages and
 * Activity toggle as secondary views below the iteration panel.
 *
 * The real `(app)/projects/[id]/page.tsx` rewrite waits for engineering's
 * deployments-schema decision. When that lands, this demo's data shape and
 * IA become the contract the real route renders from.
 */
export default function WorkspaceDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <WorkspaceDemo />;
}
