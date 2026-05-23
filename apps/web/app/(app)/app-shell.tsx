"use client";

import { usePathname } from "next/navigation";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { SignOutButton } from "./sign-out-button";

export interface AppShellProps {
  userEmail: string;
  children: React.ReactNode;
}

/**
 * Client wrapper around `WorkspaceShell` so the (app) layout can stay a
 * Server Component (it does the auth check + user fetch). Owns the
 * pathname-aware active-route highlighting and the sidebar-footer identity
 * block.
 *
 * Nav surface deliberately narrow at MVP — only routes that exist today.
 * Billing and Settings are real demo surfaces (`/ui-kit/billing`,
 * `/ui-kit/settings`) but the real routes wait on engineering; adding the
 * nav links now would point at 404s.
 */
export function AppShell({ userEmail, children }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const isProjects =
    pathname === "/dashboard" || pathname.startsWith("/projects");

  return (
    <WorkspaceShell
      navItems={[
        { label: "Projects", href: "/dashboard", active: isProjects },
      ]}
      sidebarFooter={
        <div className="space-y-2">
          <p className="truncate text-xs text-slate-500">Signed in as</p>
          <p className="truncate text-sm font-medium text-slate-900">
            {userEmail}
          </p>
          <SignOutButton />
        </div>
      }
    >
      {children}
    </WorkspaceShell>
  );
}
