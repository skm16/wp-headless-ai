import type { GetLocationsOutput } from "@/lib/sdk";

type Location = GetLocationsOutput["locations"][number];

export function LocationsTodayPanel({ locations }: { locations: Location[] }) {
  if (locations.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">Tap rooms</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {locations.map((loc) => {
          const acf = loc.acf;
          const brandColor = sanitizeHex(acf?.location_brand_color);
          return (
            <li
              key={loc.id}
              className="rounded border-l-4 border-neutral-200 bg-white p-4 shadow-sm"
              style={brandColor ? { borderLeftColor: brandColor } : undefined}
            >
              <h3 className="text-base font-semibold">{acf?.custom_title || loc.title}</h3>
              {(acf?.address_line_one || acf?.city_state_zip) && (
                <p className="mt-1 text-sm text-neutral-600">
                  {acf?.address_line_one}
                  {acf?.address_line_two ? `, ${acf.address_line_two}` : ""}
                  {acf?.city_state_zip ? <><br />{acf.city_state_zip}</> : null}
                </p>
              )}
              {acf?.phone_number && (
                <p className="mt-1 text-sm text-neutral-500">{acf.phone_number}</p>
              )}
              {acf?.on_tap_headline && (
                <p className="mt-3 text-xs uppercase tracking-wide text-neutral-400">
                  {acf.on_tap_headline}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function sanitizeHex(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/#?([0-9a-fA-F]{6})/);
  return m ? `#${m[1].toLowerCase()}` : null;
}
