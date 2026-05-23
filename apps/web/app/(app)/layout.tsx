import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "./app-shell";

/**
 * (app) route-group layout — wraps every signed-in route with the workspace
 * shell (sidebar nav + top header). Middleware already gates the group; we
 * double-check via getUser() to surface explicit redirect rather than crash
 * on null.
 *
 * Layout is a Server Component (auth + user fetch). Active-route awareness
 * needs `usePathname` (client) so the actual shell lives in `AppShell`.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  return <AppShell userEmail={user.email ?? "—"}>{children}</AppShell>;
}
