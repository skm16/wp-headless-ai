"use client";

import { usePathname } from "next/navigation";
import {
  WorkspaceShell,
  type WorkspaceNavItem,
} from "@/components/ui/workspace-shell";
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
 * Nav surface is grouped to match the JAB IA (Overview / Sites / Tools).
 * Tools links currently point at routes that don't exist yet — they're
 * placeholders so the chrome stays coherent with the design and so the
 * grouped-section layout actually shows up. Engineering swaps the `#`
 * targets for real routes as each lands.
 */
export function AppShell({ userEmail, children }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const isProjects =
    pathname === "/dashboard" || pathname.startsWith("/projects");

  const navItems: WorkspaceNavItem[] = [
    {
      section: "Overview",
      label: "Dashboard",
      href: "/dashboard",
      active: pathname === "/dashboard",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      ),
    },
    {
      section: "Sites",
      label: "My Sites",
      href: "/dashboard",
      active: isProjects,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2C8.5 7 8.5 17 12 22M12 2C15.5 7 15.5 17 12 22" />
          <path d="M2 12h20" />
        </svg>
      ),
    },
    {
      section: "Sites",
      label: "Deployments",
      href: "#",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
        </svg>
      ),
    },
    {
      section: "Tools",
      label: "AI Prompts",
      href: "#",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z" />
        </svg>
      ),
    },
    {
      section: "Tools",
      label: "Settings",
      href: "#",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
  ];

  const initials = (userEmail.split("@")[0] ?? "?")
    .slice(0, 2)
    .toUpperCase();

  return (
    <WorkspaceShell
      navItems={navItems}
      brandBadge="Agency"
      sidebarFooter={
        <>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bord bg-gradient-to-br from-[#1a4080] to-[#0f2040] font-display text-[13px] font-bold text-teal">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-wht">
              {userEmail}
            </div>
            <SignOutButton />
          </div>
        </>
      }
    >
      {children}
    </WorkspaceShell>
  );
}
