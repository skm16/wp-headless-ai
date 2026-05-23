import { notFound } from "next/navigation";
import { ConnectionsDemo } from "./connections-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of the Connections page (Phase 2 deliverable 2E).
 * Three cards — WordPress, Hosting (with custom-domain wiring), Content
 * ownership — plus a Billing link out to Phase 5.
 *
 * The real route lands at `(app)/projects/[id]/connections/page.tsx` once
 * engineering provides the custom-domain provisioning shape (Vercel domain
 * alias API specifics — §11). The mock here exercises every custom-domain
 * state by cycling on each Check status click.
 */
export default function ConnectionsDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ConnectionsDemo />;
}
