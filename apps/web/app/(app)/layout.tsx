import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/app/(app)/sign-out-button";

/**
 * (app) route-group layout — wraps every signed-in route with the
 * sidebar nav + top header. Middleware already gates the group; this
 * layout assumes a session exists, but we double-check via getUser()
 * to surface explicit redirect rather than crash on null.
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

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white px-4 py-6 sm:block">
        <Link href="/dashboard" className="block text-xl font-extrabold text-slate-900">
          Jab
        </Link>
        <nav className="mt-8 space-y-1 text-sm">
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 text-slate-700 hover:bg-slate-100"
          >
            Projects
          </Link>
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <span className="text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{user.email}</span>
          </span>
          <SignOutButton />
        </header>

        <main className="flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
