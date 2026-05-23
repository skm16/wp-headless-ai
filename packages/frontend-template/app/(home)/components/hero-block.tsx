import type { GetBeersOutput } from "@/lib/sdk";

type Beer = GetBeersOutput["beers"][number];
type BeerImage = NonNullable<NonNullable<Beer["acf"]>["feature_image"]>;

/**
 * Two Roads-style hero. Dark navy background with a sun-burst gradient,
 * featured beer image floated left, brewery tagline + body + yellow CTA
 * stacked center. The headline mixes a sans-serif voice with a script
 * inflection on "Less" to mimic the brand's actual signage.
 */
export function HeroBlock({ heroBeer }: { heroBeer: Beer | null }) {
  const img = heroBeer ? imageUrl(heroBeer.acf?.feature_image) : null;
  const alt = heroBeer ? altText(heroBeer.acf?.feature_image, heroBeer.title) : "Two Roads beer";

  return (
    <section className="relative isolate overflow-hidden bg-[#0c2542] text-white">
      {/* Sun burst on the right side, mimicking the photo lighting */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-1/2 h-[140%] w-[80%] -translate-y-1/2 rounded-full bg-gradient-to-l from-[#fcc500]/40 via-[#fcc500]/10 to-transparent blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,rgba(252,197,0,0.18),transparent_60%)]"
      />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-8 px-6 py-16 md:grid-cols-[1fr_1.4fr] md:py-24">
        <div className="flex justify-center md:justify-end">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={img}
              alt={alt}
              className="h-72 w-auto object-contain drop-shadow-[0_25px_60px_rgba(252,197,0,0.35)] sm:h-80 md:h-96"
            />
          ) : (
            <div className="h-80 w-44 rounded-md bg-white/5" />
          )}
        </div>
        <div className="space-y-6">
          <h1 className="text-4xl font-bold uppercase leading-[1.05] tracking-tight sm:text-5xl">
            <span className="block font-serif text-2xl font-normal italic capitalize tracking-normal text-white/90 sm:text-3xl">
              Here&apos;s
            </span>
            <span className="block">To Taking The</span>
            <span className="block">
              Road{" "}
              <span className="font-serif font-normal italic capitalize tracking-normal text-[#fcc500]">
                Less
              </span>{" "}
              Traveled
              <span className="align-top text-base font-normal text-[#fcc500]">®</span>
            </span>
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">
            Two Roads isn&apos;t just the logo on our brewery building, it&apos;s our philosophy. Life
            always seems to offer up two ways to go. It just so happens, we prefer the one less
            traveled and having some fun along the way — in our lives, our careers and especially
            our beers. Now our &ldquo;road less traveled&rdquo; philosophy is being brought to life
            in the beers that we create and how we create them.
          </p>
          <a
            href="/beers"
            className="inline-block rounded-sm bg-[#fcc500] px-7 py-3 text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] shadow-md transition hover:bg-[#ffd83a]"
          >
            Explore Our Beverages
          </a>
        </div>
      </div>
    </section>
  );
}

function imageUrl(img: BeerImage | undefined): string | null {
  if (!img) return null;
  const sizes = img.sizes as Record<string, unknown> | undefined;
  for (const key of ["large", "medium_large", "medium"]) {
    const url = sizes?.[key];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return typeof img.url === "string" ? img.url : null;
}

function altText(img: BeerImage | undefined, fallback: string): string {
  if (img?.alt && img.alt.length > 0) return img.alt;
  return fallback;
}

/**
 * Picks a flagship-feeling beer for the hero — non-seasonal, with a feature
 * image. Used by the page so the picker stays alongside the component.
 */
export function pickHeroBeer(beers: Beer[]): Beer | null {
  const withImage = beers.filter((b) => imageUrl(b.acf?.feature_image) !== null);
  return (
    withImage.find((b) => !b.acf?.is_seaonal && typeof b.acf?.flavor_notes === "string") ??
    withImage[0] ??
    beers[0] ??
    null
  );
}
