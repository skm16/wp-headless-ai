/**
 * Below-the-hero strip of four high-traffic links — find beer, shop, events,
 * visit. Static UI; the underlying destinations are stable enough that they
 * don't need to come from WP.
 */
export function QuickActions() {
  const actions = [
    { label: "Find Beer Near You", href: "/product-finder", icon: PinIcon },
    { label: "Shop Beer & Merch", href: "https://tworoadsbrewing.square.site/", icon: ShopIcon },
    { label: "View Events", href: "/events", icon: CalendarIcon },
    { label: "Plan Your Visit", href: "/visit-us", icon: MapIcon },
  ] as const;

  return (
    <section className="bg-[#0a1f37] text-white">
      <ul className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-white/10 md:grid-cols-4">
        {actions.map(({ label, href, icon: Icon }) => (
          <li key={label}>
            <a
              href={href}
              className="flex items-center justify-center gap-3 px-4 py-5 text-xs font-semibold uppercase tracking-[0.18em] transition hover:bg-white/5"
            >
              <Icon className="h-4 w-4 text-[#fcc500]" />
              <span>{label}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M10 2C6.7 2 4 4.7 4 8c0 4.5 6 10 6 10s6-5.5 6-10c0-3.3-2.7-6-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z" />
    </svg>
  );
}
function ShopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M3 4h2l1 10h9l1-7H6.5M9 17a1 1 0 11-2 0 1 1 0 012 0zm6 0a1 1 0 11-2 0 1 1 0 012 0z" />
    </svg>
  );
}
function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M5 3v2H3v12h14V5h-2V3h-2v2H7V3H5zm0 5h10v8H5V8z" />
    </svg>
  );
}
function MapIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M10 2C7 2 4 4.5 4 8c0 4 6 10 6 10s6-6 6-10c0-3.5-3-6-6-6zm0 8.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
    </svg>
  );
}
