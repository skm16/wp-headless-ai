import { getMenus, type GetMenusOutput } from "@/lib/sdk";
import { skmClient } from "@/lib/skm/client";

type Menu = GetMenusOutput["menus"][number];
type MenuItem = Menu["items"][number];

const COLUMN_DEFS: Array<{ heading: string; slugs: string[] }> = [
  { heading: "Explore", slugs: ["footer-beers", "footer-breweries", "footer-news"] },
  { heading: "Events & Experiences", slugs: ["footer-about"] },
  { heading: "Partners & Support", slugs: ["footer-contact"] },
  { heading: "Shop", slugs: ["footer-shop"] },
];

/**
 * Multi-column dark footer. Pulls every footer-* menu from the WP backend
 * and arranges them under topical headings. Each column gracefully shrinks
 * when its source menus are missing.
 */
export async function SiteFooter() {
  const menus = await loadFooterMenus();
  const columns = COLUMN_DEFS.map((def) => ({
    heading: def.heading,
    items: collectItems(menus, def.slugs),
  })).filter((col) => col.items.length > 0);

  const year = new Date().getFullYear();

  return (
    <footer className="bg-[#0c2542] text-neutral-200">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-2">
            <p className="font-serif text-2xl italic text-white">
              Take the Road <span className="font-bold not-italic">Less</span>{" "}
              <span className="font-bold not-italic">Traveled</span>
              <span className="align-top text-xs">®</span>
            </p>
            <Addresses />
          </div>
          {columns.map((col) => (
            <FooterColumn key={col.heading} heading={col.heading} items={col.items} />
          ))}
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-2 px-6 py-5 text-xs text-neutral-400 sm:flex-row sm:items-center">
          <p>© {year} Two Roads Brewing Company. All Rights Reserved.</p>
          <p className="flex gap-4">
            <a href="/return-refund-policy" className="hover:text-white">
              Return & Refund Policy
            </a>
            <a href="/terms-conditions" className="hover:text-white">
              Terms & Conditions
            </a>
            <a href="/privacy-policy" className="hover:text-white">
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ heading, items }: { heading: string; items: MenuItem[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-[#fcc500]">{heading}</h3>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a href={rewriteWpUrl(item.url)} className="text-neutral-300 hover:text-white">
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Addresses() {
  return (
    <div className="space-y-3 text-xs text-neutral-300">
      <div>
        <p className="font-semibold text-white">Two Roads Brewery</p>
        <p>1700 Stratford Ave</p>
        <p>Stratford, CT 06615</p>
      </div>
      <div>
        <p className="font-semibold text-white">Area Two Brewery</p>
        <p>1526 Stratford Ave</p>
        <p>Stratford, CT 06615</p>
      </div>
      <div>
        <p className="font-semibold text-white">Food Hall + Bar</p>
        <p>1625 Stratford Ave</p>
        <p>Stratford, CT 06615</p>
      </div>
    </div>
  );
}

async function loadFooterMenus(): Promise<Menu[]> {
  try {
    const { menus } = await getMenus(skmClient);
    return menus.filter((m) => m.slug.startsWith("footer"));
  } catch (err) {
    console.error("[SiteFooter] failed to load footer menus:", err);
    return [];
  }
}

function collectItems(menus: Menu[], slugs: string[]): MenuItem[] {
  const out: MenuItem[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    const menu = menus.find((m) => m.slug === slug);
    if (!menu) continue;
    for (const item of menu.items.slice().sort((a, b) => a.order - b.order)) {
      const key = item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function rewriteWpUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const wp = process.env.WP_URL ? new URL(process.env.WP_URL) : null;
    if (wp && u.hostname === wp.hostname) return u.pathname + u.search + u.hash;
    return rawUrl;
  } catch {
    return rawUrl;
  }
}
