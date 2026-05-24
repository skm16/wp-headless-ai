import type { Metadata } from "next";
import { WorkspaceJabDemo } from "./workspace-jab-demo";

export const dynamic = "force-dynamic";

/**
 * Exception to the broader `/ui-kit/*` dev-only convention: this design
 * preview is intentionally reachable on prod so stakeholders can be sent a
 * direct link. The content is entirely mocked (Two Roads Brewing) and reads
 * no real data, so there's nothing sensitive to expose. `robots: noindex`
 * keeps it out of search results — direct-URL-only access.
 */
export const metadata: Metadata = {
  title: "Workspace preview — JAB",
  robots: { index: false, follow: false },
};

export default function WorkspaceJabDemoPage() {
  return <WorkspaceJabDemo />;
}
