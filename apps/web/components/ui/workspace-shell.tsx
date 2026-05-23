import Link from "next/link";
import { cn } from "@/lib/utils";

export interface WorkspaceNavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface WorkspaceShellProps {
  children: React.ReactNode;
  navItems: WorkspaceNavItem[];
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  /** Pinned to the bottom of the sidebar. Use for user identity / sign-out. */
  sidebarFooter?: React.ReactNode;
  className?: string;
}

/**
 * PRE-PRODUCTION GAP: the sidebar is `hidden sm:flex` — below the `sm`
 * breakpoint the entire nav (project switcher, settings link, user identity
 * footer) is inaccessible. Acceptable for the design-ahead demo because
 * mobile editing isn't an MVP target, but a real mobile nav (hamburger →
 * drawer, or a bottom bar) needs to land before the platform ships to
 * agencies who might log in from their phone to check a deploy. Engineering
 * handoff item, not blocked on design.
 */
export function WorkspaceShell({
  children,
  navItems,
  headerLeft,
  headerRight,
  sidebarFooter,
  className,
}: WorkspaceShellProps) {
  return (
    <div className={cn("flex min-h-screen", className)}>
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
        <div className="px-4 py-6">
          <Link
            href="/dashboard"
            className="block text-xl font-extrabold text-slate-900"
          >
            Jab
          </Link>
        </div>
        <nav className="flex-1 space-y-1 px-4 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "block rounded-md px-3 py-2 transition-colors",
                item.active
                  ? "bg-brand-muted font-medium text-brand-strong"
                  : "text-slate-700 hover:bg-slate-100",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {sidebarFooter && (
          <div className="border-t border-slate-200 px-4 py-3">
            {sidebarFooter}
          </div>
        )}
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">{headerLeft}</div>
          <div className="flex shrink-0 items-center gap-3">{headerRight}</div>
        </header>

        <main className="flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
