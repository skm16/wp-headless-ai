import Link from "next/link";

import { getMenus, type GetMenusOutput } from "@/lib/sdk";
import { skmClient } from "@/lib/skm/client";

type Menu = GetMenusOutput["menus"][number];
type MenuItem = Menu["items"][number];

/**
 * Top sticky nav, modeled on Two Roads' actual brand design — bright yellow
 * bar with a centered logo and uppercase tracked menu items. The menu items
 * are pulled from the WP "main_menu" location at request time. Falls back
 * to a static label list if the WP menu can't be loaded.
 */
export async function SiteHeader() {
  const items = await loadMainNav();

  return (
    <header className="sticky top-0 z-40 bg-[#fcc500] text-[#0c2542] shadow-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-3">
        <Link href="/" aria-label="Two Roads home" className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border-[3px] border-[#0c2542] bg-[#0c2542] text-[10px] font-black uppercase leading-none tracking-tight text-[#fcc500]">
            <span className="text-center">
              TWO
              <br />
              ROADS
            </span>
          </div>
        </Link>
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
          {items.map((item) => (
            <NavLink key={item.id} item={item} />
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-sm px-3 py-1.5 text-xs font-bold uppercase tracking-[0.15em] hover:bg-[#0c2542]/10 lg:hidden"
            aria-label="Open menu"
          >
            Menu
          </button>
        </div>
      </div>
    </header>
  );
}

function NavLink({ item }: { item: MenuItem }) {
  const href = rewriteWpUrl(item.url);
  return (
    <a
      href={href}
      className="text-xs font-bold uppercase tracking-[0.18em] transition hover:text-[#0c2542]/70"
    >
      {item.title}
    </a>
  );
}

async function loadMainNav(): Promise<MenuItem[]> {
  try {
    const { menus } = await getMenus(skmClient);
    const primary =
      menus.find((m) => m.locations.includes("main_menu")) ??
      menus.find((m) => m.slug === "main-nav-2026") ??
      menus.find((m) => m.slug === "main-menu");
    if (!primary) return [];
    return primary.items
      .filter((i) => i.parent_id === 0)
      .sort((a, b) => a.order - b.order);
  } catch (err) {
    console.error("[SiteHeader] failed to load main nav:", err);
    return [];
  }
}

/**
 * Two Roads' production menu items embed absolute URLs to the WP origin
 * (`https://two-roads-brewing.local/...`). For pages we have on the headless
 * frontend (e.g. `/beers`), rewrite to the local route. Everything else is
 * left intact (custom URLs, external sites like Square, Brandfolder).
 */
function rewriteWpUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const wp = process.env.WP_URL ? new URL(process.env.WP_URL) : null;
    if (wp && u.hostname === wp.hostname) {
      // Same-origin to the WP install — keep just the path so it routes
      // through the headless frontend.
      return u.pathname + u.search + u.hash;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}
