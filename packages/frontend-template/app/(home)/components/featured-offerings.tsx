import type { GetBeersOutput } from "@/lib/sdk";

type Beer = GetBeersOutput["beers"][number];
type BeerImage = NonNullable<NonNullable<Beer["acf"]>["feature_image"]>;

/**
 * "Featured Offerings" — three flagship beers presented as standalone product
 * shots on a clean white field with all-caps labels below. Mirrors Two Roads'
 * actual homepage treatment.
 *
 * Picks the first three beers that pass the flagship filter (product finder
 * visible, non-seasonal, has image). Falls back to any image-bearing beers.
 */
export function FeaturedOfferings({ beers }: { beers: Beer[] }) {
  const featured = pickFeatured(beers);
  if (featured.length === 0) return null;

  return (
    <section className="bg-white py-16">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-center text-2xl font-bold uppercase tracking-[0.18em] text-[#0c2542] sm:text-3xl">
          Featured Offerings
        </h2>
        <ul className="mt-12 grid grid-cols-1 gap-10 sm:grid-cols-3">
          {featured.map((beer) => (
            <FeaturedCan key={beer.id} beer={beer} />
          ))}
        </ul>
        <div className="mt-12 text-center">
          <a
            href="/beers"
            className="inline-block text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] transition hover:text-[#0c2542]/70"
          >
            View All Beers <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function FeaturedCan({ beer }: { beer: Beer }) {
  const img = imageUrl(beer.acf?.feature_image);
  const alt = altText(beer.acf?.feature_image, beer.title);
  return (
    <li className="flex flex-col items-center gap-5 text-center">
      <a href={beer.link} className="block">
        {img && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={alt}
            className="h-72 w-auto object-contain transition group-hover:scale-105"
          />
        )}
      </a>
      <a
        href={beer.link}
        className="text-xs font-bold uppercase tracking-[0.18em] text-[#0c2542] hover:text-[#0c2542]/70"
      >
        {beer.title}
      </a>
    </li>
  );
}

function pickFeatured(beers: Beer[]): Beer[] {
  const withImage = beers.filter((b) => imageUrl(b.acf?.feature_image) !== null);
  const flaggedFlagship = withImage.filter((b) => b.acf?.product_finder_visibility === true && !b.acf?.is_seaonal);
  if (flaggedFlagship.length >= 3) return flaggedFlagship.slice(0, 3);
  const anyFlagship = withImage.filter((b) => !b.acf?.is_seaonal);
  if (anyFlagship.length >= 3) return anyFlagship.slice(0, 3);
  return withImage.slice(0, 3);
}

function imageUrl(img: BeerImage | undefined): string | null {
  if (!img) return null;
  const sizes = img.sizes as Record<string, unknown> | undefined;
  for (const key of ["medium_large", "large", "medium"]) {
    const url = sizes?.[key];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return typeof img.url === "string" ? img.url : null;
}

function altText(img: BeerImage | undefined, fallback: string): string {
  if (img?.alt && img.alt.length > 0) return img.alt;
  return fallback;
}
