import Link from "next/link";
import { cn } from "@/lib/utils";

export interface WorkspaceNavItem {
  label: string;
  href: string;
  active?: boolean;
  /** Optional uppercase-mono section label. Items with the same `section`
   * are grouped together; the section label renders once at the top of the
   * group. Items without a section render directly. */
  section?: string;
  /** Optional count badge displayed on the right (e.g. "6" beside My Sites). */
  count?: number | string;
  /** Optional inline SVG icon (matches the 16×16 stroke style used in the
   * JAB design). Caller passes a JSX element. */
  icon?: React.ReactNode;
  /** Subsidiary item — renders indented beneath its parent, e.g. the active
   * site row sitting under "My Sites". */
  sub?: boolean;
}

export interface WorkspaceShellProps {
  children: React.ReactNode;
  navItems: WorkspaceNavItem[];
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  /** Pinned to the bottom of the sidebar. Use for user identity / sign-out. */
  sidebarFooter?: React.ReactNode;
  /** Optional badge beside the JAB logo (e.g. "Agency"). */
  brandBadge?: string;
  className?: string;
}

/**
 * JAB workspace chrome — 260px dark sidebar with grouped sections plus a
 * 56px sticky topbar. Mobile nav is still a gap (see prior comment); a
 * hamburger drawer is the engineering follow-up before agencies who log in
 * from their phones encounter the sign-in flow.
 */
export function WorkspaceShell({
  children,
  navItems,
  headerLeft,
  headerRight,
  sidebarFooter,
  brandBadge,
  className,
}: WorkspaceShellProps) {
  // Group nav items by their `section`. Items without a section share a
  // synthetic empty-string bucket so the relative order in `navItems`
  // becomes the render order on screen.
  const grouped: { section: string; items: WorkspaceNavItem[] }[] = [];
  for (const item of navItems) {
    const section = item.section ?? "";
    const last = grouped[grouped.length - 1];
    if (last && last.section === section) {
      last.items.push(item);
    } else {
      grouped.push({ section, items: [item] });
    }
  }

  return (
    <div className={cn("flex min-h-screen bg-surf text-wht", className)}>
      <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 flex-col overflow-y-auto border-r border-bord bg-bg sm:flex">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-bord px-5 py-[18px]">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 text-wht no-underline"
          >
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="rgb(15 32 64)" stroke="rgb(26 49 88)" />
              <text x="4" y="23" fontFamily="var(--font-display), sans-serif" fontWeight="800" fontSize="18">
                <tspan fill="rgb(0 201 167)">J</tspan>
                <tspan fill="rgb(240 244 248)" opacity="0.22">›</tspan>
              </text>
            </svg>
            <strong className="font-display text-[17px] font-extrabold">JAB</strong>
          </Link>
          {brandBadge && (
            <span className="ml-auto rounded-md border border-bord bg-elev px-[7px] py-[2px] font-mono text-[10px] text-gry-d">
              {brandBadge}
            </span>
          )}
        </div>

        <nav className="flex flex-1 flex-col">
          {grouped.map((group, gi) => (
            <div key={`${group.section}-${gi}`}>
              {group.section && (
                <div className="px-5 pb-1.5 pt-[18px] font-mono text-[10px] uppercase tracking-[0.18em] text-gry-d">
                  {group.section}
                </div>
              )}
              {group.items.map((item) => (
                <NavLink key={`${item.href}-${item.label}`} item={item} />
              ))}
            </div>
          ))}
        </nav>

        {sidebarFooter && (
          <div className="mt-auto flex items-center gap-2.5 border-t border-bord px-5 py-4">
            {sidebarFooter}
          </div>
        )}
      </aside>

      <div className="ml-0 flex min-w-0 flex-1 flex-col sm:ml-0">
        {(headerLeft || headerRight) && (
          <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-bord bg-surf/95 px-8">
            <div className="flex min-w-0 items-center gap-3">{headerLeft}</div>
            <div className="flex shrink-0 items-center gap-2">{headerRight}</div>
          </header>
        )}

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}

function NavLink({ item }: { item: WorkspaceNavItem }) {
  const baseClasses =
    "flex items-center gap-2.5 border-r-2 border-transparent px-5 py-2 text-sm text-gry no-underline transition-colors hover:bg-white/[0.025] hover:text-wht";
  const activeClasses =
    "border-r-teal bg-teal/[0.09] text-teal hover:bg-teal/[0.09] hover:text-teal";

  return (
    <Link
      href={item.href}
      className={cn(
        baseClasses,
        item.sub && "py-1.5 pl-11 text-[13px]",
        item.active && activeClasses,
      )}
    >
      {item.icon && (
        <span
          className={cn(
            "shrink-0 opacity-70",
            item.active && "opacity-100",
          )}
          aria-hidden="true"
        >
          {item.icon}
        </span>
      )}
      <span className="min-w-0 truncate">{item.label}</span>
      {item.count !== undefined && (
        <span
          className={cn(
            "ml-auto rounded-md border border-bord bg-elev px-[7px] py-px font-mono text-[11px] text-gry-d",
            item.active &&
              "border-teal/20 bg-teal/[0.07] text-teal",
          )}
        >
          {item.count}
        </span>
      )}
    </Link>
  );
}
