import type { GetLocationsOutput } from "@/lib/sdk";

type Location = GetLocationsOutput["locations"][number];

/**
 * Visit Us section. Two-column: stylized SVG "map" stand-in on the left
 * (no map dependency in the template; agencies can swap in Mapbox/Leaflet),
 * and a list of locations on the right with brand-color headings, address,
 * and click-to-call phone numbers.
 */
export function VisitUs({ locations }: { locations: Location[] }) {
  if (locations.length === 0) return null;
  const visible = locations.slice(0, 4);

  return (
    <section className="bg-white py-16">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-center text-2xl font-bold uppercase tracking-[0.18em] text-[#0c2542] sm:text-3xl">
          Visit Us
        </h2>
        <div className="mt-12 grid grid-cols-1 items-center gap-12 md:grid-cols-2">
          <MapPlaceholder count={visible.length} />
          <ul className="space-y-7">
            {visible.map((loc) => (
              <LocationRow key={loc.id} location={loc} />
            ))}
          </ul>
        </div>
        <div className="mt-12 text-center">
          <a
            href="/visit-us"
            className="inline-block text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] transition hover:text-[#0c2542]/70"
          >
            Come Visit Us <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function LocationRow({ location }: { location: Location }) {
  const acf = location.acf;
  const title = acf?.custom_title || location.title;
  const brand = sanitizeHex(acf?.location_brand_color) ?? "#fcc500";

  return (
    <li className="space-y-2">
      <h3 className="text-base font-bold uppercase tracking-[0.18em]" style={{ color: brand }}>
        {title}
      </h3>
      <p className="text-sm text-neutral-700">
        {acf?.address_line_one}
        {acf?.address_line_two ? `, ${acf.address_line_two}` : ""}
        {acf?.city_state_zip ? `, ${acf.city_state_zip}` : ""}
      </p>
      {acf?.phone_number && (
        <a
          href={`tel:${acf.phone_number.replace(/[^\d+]/g, "")}`}
          className="inline-flex items-center gap-2 text-sm text-neutral-700 hover:text-[#0c2542]"
        >
          <PhoneIcon className="h-4 w-4" /> {acf.phone_number}
        </a>
      )}
    </li>
  );
}

function MapPlaceholder({ count }: { count: number }) {
  return (
    <div
      className="relative h-72 w-full overflow-hidden rounded-md border border-neutral-200 bg-[#e6efe5]"
      aria-label={`Map showing ${count} Two Roads locations`}
    >
      {/* Stylized stripes evoking a satellite map */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(120deg, transparent 0 40%, rgba(252,197,0,0.4) 40% 42%, transparent 42% 100%)," +
            "linear-gradient(60deg, transparent 0 60%, rgba(12,37,66,0.25) 60% 62%, transparent 62% 100%)," +
            "linear-gradient(180deg, transparent 0 50%, rgba(12,37,66,0.1) 50% 51%, transparent 51% 100%)",
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border-4 border-[#0c2542] bg-[#fcc500]">
          <span className="text-[8px] font-black uppercase leading-none text-[#0c2542]">
            TR
          </span>
        </div>
      </div>
    </div>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="#fcc500" aria-hidden>
      <path d="M3 5c0-1.1.9-2 2-2h2c.6 0 1 .4 1 1v3c0 .6-.4 1-1 1H6c.5 3 3 5.5 6 6V13c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v2c0 1.1-.9 2-2 2C8.6 17 3 11.4 3 5z" />
    </svg>
  );
}

function sanitizeHex(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/#?([0-9a-fA-F]{6})/);
  return m ? `#${m[1].toLowerCase()}` : null;
}
