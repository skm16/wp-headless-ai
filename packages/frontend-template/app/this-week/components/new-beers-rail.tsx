import type { GetBeersOutput } from "@/lib/sdk";

type Beer = GetBeersOutput["beers"][number];
type BeerImage = NonNullable<NonNullable<Beer["acf"]>["feature_image"]>;

export function NewBeersRail({ beers }: { beers: Beer[] }) {
  if (beers.length === 0) return null;

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Fresh from the brewery</h2>
        <a href="/beers" className="text-sm text-blue-600 hover:underline">
          See all beers →
        </a>
      </header>
      <ul className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
        {beers.map((beer) => {
          const imageSrc = pickImage(beer.acf?.feature_image);
          const imageAlt = pickAlt(beer.acf?.feature_image, beer.title);
          return (
            <li
              key={beer.id}
              className="flex w-64 shrink-0 snap-start flex-col gap-2 rounded border border-neutral-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold leading-snug">{beer.title}</h3>
                {beer.acf?.is_seaonal && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                    Seasonal
                  </span>
                )}
              </div>
              {imageSrc && (
                <div className="flex h-40 items-center justify-center rounded bg-neutral-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageSrc} alt={imageAlt} className="h-40 max-w-full object-contain" />
                </div>
              )}
              <Stats acf={beer.acf} />
              {beer.acf?.flavor_notes && (
                <p className="line-clamp-2 text-xs text-neutral-600">
                  {stripHtml(beer.acf.flavor_notes)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Picks the smallest size that's still big enough for the rail (160px tall).
 * Falls back to the full-resolution `url` when no size matches. The custom
 * `beer-thumb` size is a Two Roads convention; standard `medium` is the
 * portable fallback.
 */
function pickImage(img: BeerImage | undefined): string | null {
  if (!img) return null;
  const sizes = img.sizes as Record<string, unknown> | undefined;
  const candidates = ["beer-thumb", "medium", "medium_large", "large"];
  for (const key of candidates) {
    const url = sizes?.[key];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return typeof img.url === "string" ? img.url : null;
}

function pickAlt(img: BeerImage | undefined, fallback: string): string {
  if (img?.alt && img.alt.length > 0) return img.alt;
  return fallback;
}

function Stats({ acf }: { acf: Beer["acf"] | undefined }) {
  const cells: Array<[label: string, value: string | undefined]> = [
    ["ABV", acf?.abv],
    ["IBU", acf?.ibu],
  ];
  const visible = cells.filter(([, v]) => typeof v === "string" && v.length > 0);
  if (visible.length === 0) return null;

  return (
    <dl className="flex gap-3 text-xs">
      {visible.map(([label, value]) => (
        <div key={label}>
          <dt className="uppercase tracking-wide text-neutral-400">{label}</dt>
          <dd className="font-medium text-neutral-700">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
