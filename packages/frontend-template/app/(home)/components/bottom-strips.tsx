/**
 * Two below-the-fold conversion strips that close out the homepage:
 *   - NewsletterStrip — yellow band with email capture (visual-only;
 *     wire to a route handler when the agency adds it).
 *   - FindNearYouStrip — dark navy band with the product-finder zip input.
 *
 * Both are static UI; the agency hooks them up to whatever signup or
 * product-finder endpoint they prefer.
 */

export function NewsletterStrip() {
  return (
    <section className="bg-[#fcc500] py-10">
      <form
        className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 text-center"
        action="#"
        method="post"
      >
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] sm:text-base">
          Want to stay in the loop? Sign up for our newsletter
        </p>
        <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
          <input
            type="email"
            required
            placeholder="Your Email*"
            className="flex-1 rounded-sm border border-[#0c2542]/20 bg-white px-4 py-3 text-sm focus:border-[#0c2542] focus:outline-none"
            aria-label="Email address"
          />
          <button
            type="submit"
            className="rounded-sm bg-[#0c2542] px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-white shadow-sm transition hover:bg-[#163a66]"
          >
            Subscribe
          </button>
        </div>
      </form>
    </section>
  );
}

export function FindNearYouStrip() {
  return (
    <section className="bg-[#0c2542] py-10 text-white">
      <form
        className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 text-center"
        action="/product-finder"
        method="get"
      >
        <p className="text-sm font-bold uppercase tracking-[0.18em] sm:text-base">
          Find Two Roads Near You
        </p>
        <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
          <input
            type="text"
            name="zip"
            placeholder="Enter Address or Zip code"
            className="flex-1 rounded-sm border border-white/20 bg-white px-4 py-3 text-sm text-[#0c2542] focus:border-[#fcc500] focus:outline-none"
            aria-label="Address or ZIP code"
          />
          <button
            type="submit"
            className="rounded-sm bg-[#fcc500] px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-[#0c2542] shadow-sm transition hover:bg-[#ffd83a]"
          >
            Find Two Roads
          </button>
        </div>
      </form>
    </section>
  );
}
