import Link from "next/link";
import { MarketingHeader, MarketingFooter } from "@/components/marketing-chrome";
import { PricingTierCard } from "@/components/pricing-tier-card";
import { PRICING_TIERS, TRIAL_SUMMARY } from "@/lib/pricing";

/**
 * Public pricing page — Phase 5 deliverable.
 *
 * Tier shape (per-site recurring × tiered, plus per-site setup fee, plus
 * bundled generation allowance) is settled per §10 #11. Numbers are
 * placeholders — premium-vs-accessible positioning still open. Updating the
 * tiers is a one-file edit in `lib/pricing.ts`.
 *
 * No card required to start a trial — the implicit-trial model per §4
 * Phase 5 keeps the sign-up flow friction-free; first charge happens when
 * the trial converts.
 */
export const metadata = {
  title: "Pricing — Jab",
  description:
    "Per-site agency pricing for the managed headless platform that turns WordPress into modern frontends.",
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-bg text-wht">
      <MarketingHeader />
      <main>
        <Header />
        <Tiers />
        <Faq />
        <ClosingCta />
      </main>
      <MarketingFooter />
    </div>
  );
}

function Header() {
  return (
    <section className="mx-auto max-w-3xl px-6 pt-20 text-center lg:px-[60px]">
      <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-teal/20 bg-teal/[0.07] px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-teal">
        <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" />
        Pricing
      </span>
      <h1 className="font-display text-[44px] font-extrabold leading-[1.15] tracking-[-0.03em] text-wht sm:text-[56px]">
        Per-site pricing built for agencies.
      </h1>
      <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-[1.65] text-gry">
        You bill your client like you always have. We bill you per site, with a
        generous AI allowance baked in. No metered surprise charges.
      </p>
      <p className="mt-5 font-mono text-[13px] text-teal">
        Every plan starts with a {TRIAL_SUMMARY.durationDays}-day trial on{" "}
        {TRIAL_SUMMARY.siteLimit} site. No card required.
      </p>
    </section>
  );
}

function Tiers() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 lg:px-[60px]">
      <div className="grid gap-8 md:grid-cols-3">
        {PRICING_TIERS.map((tier) => (
          <PricingTierCard
            key={tier.id}
            tier={tier}
            ctaHref={`/sign-up?plan=${tier.id}`}
          />
        ))}
      </div>
      <p className="mt-10 text-center font-mono text-xs text-gry-d">
        All plans include AI iteration, the visual fidelity loop, ISR-cached
        hosting, and the WordPress sync. Need more than 15 sites?{" "}
        <a
          href="mailto:sales@jabwp.app?subject=Custom%20plan"
          className="font-medium text-teal hover:text-teal/80"
        >
          Talk to us
        </a>
        .
      </p>
    </section>
  );
}

function Faq() {
  const items = [
    {
      q: "Do I need to pay per generation?",
      a: "No. Each plan bundles a generous AI generation allowance per site per month. The number scales up as you add tiers, but generation isn't a metered surprise — your invoice is the plan fee + setup fees, full stop.",
    },
    {
      q: "What does the setup fee cover?",
      a: "The first deploy: WordPress probe, initial AI generation of every page template, custom-domain wiring if your client has one ready, and basic concierge support to get the first site across the finish line.",
    },
    {
      q: "What happens at the end of the trial?",
      a: "Your published site stays live at its hosted URL no matter what. AI generation and refinement pause until you upgrade — but your client never sees a broken page.",
    },
    {
      q: "Can I move a client off the platform later?",
      a: "Yes. The opt-in GitHub export gives you the full Next.js source for any site, so you can take a client elsewhere if the relationship changes.",
    },
  ];
  return (
    <section className="border-y border-bord bg-surf py-20 lg:py-24">
      <div className="mx-auto max-w-3xl px-6 lg:px-[60px]">
        <div className="mb-3 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          FAQ
        </div>
        <h2 className="text-center text-[32px] font-extrabold leading-[1.2] tracking-[-0.025em] text-wht sm:text-[40px]">
          Frequently asked
        </h2>
        <dl className="mt-10 space-y-4">
          {items.map((item) => (
            <div
              key={item.q}
              className="rounded-lg border border-bord bg-bg p-6"
            >
              <dt className="text-base font-bold leading-snug text-wht">
                {item.q}
              </dt>
              <dd className="mt-2 text-sm leading-[1.65] text-gry">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="border-t border-bord bg-surf px-6 py-24 text-center lg:px-[60px]">
      <div className="mx-auto max-w-2xl">
        <span className="mb-5 inline-block font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          Pick a plan
        </span>
        <h2 className="font-display text-[36px] font-extrabold leading-[1.2] tracking-[-0.03em] text-wht sm:text-[48px]">
          Bring your first client site over.
        </h2>
        <p className="mt-4 text-[17px] leading-[1.6] text-gry">
          Connect a WordPress install, finish onboarding, and build your first modern frontend on the trial.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
          >
            Start free trial
          </Link>
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 rounded-md border-[1.5px] border-bord bg-transparent px-6 py-3 text-[15px] font-medium text-wht no-underline transition-colors hover:border-gry"
          >
            Create an account
          </Link>
        </div>
      </div>
    </section>
  );
}
