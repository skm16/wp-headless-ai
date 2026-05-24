import { notFound } from "next/navigation";
import { WorkspaceJabDemo } from "./workspace-jab-demo";

export const dynamic = "force-dynamic";

export default function WorkspaceJabDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <WorkspaceJabDemo />;
}
