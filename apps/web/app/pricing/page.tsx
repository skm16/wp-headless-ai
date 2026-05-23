import Link from "next/link";
import { Button } from "@/components/ui/button";
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
    <div className="min-h-screen bg-slate-50">
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
    <section className="mx-auto max-w-3xl px-6 pt-16 text-center">
      <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
        Per-site pricing built for agencies.
      </h1>
      <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
        You bill your client like you always have. We bill you per site, with a
        generous AI allowance baked in. No metered surprise charges.
      </p>
      <p className="mt-4 text-sm text-brand-strong">
        Every plan starts with a {TRIAL_SUMMARY.durationDays}-day trial on{" "}
        {TRIAL_SUMMARY.siteLimit} site. No card required.
      </p>
    </section>
  );
}

function Tiers() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="grid gap-8 md:grid-cols-3">
        {PRICING_TIERS.map((tier) => (
          <PricingTierCard
            key={tier.id}
            tier={tier}
            ctaHref={`/sign-up?plan=${tier.id}`}
          />
        ))}
      </div>
      <p className="mt-10 text-center text-xs text-slate-500">
        All plans include AI iteration, the visual fidelity loop, ISR-cached
        hosting, and the WordPress sync. Need more than 15 sites?{" "}
        <a
          href="mailto:sales@jabwp.app?subject=Custom%20plan"
          className="font-medium text-brand hover:text-brand-hover"
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
    <section className="border-y border-slate-200 bg-white py-16">
      <div className="mx-auto max-w-3xl px-6">
        <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900">
          Frequently asked
        </h2>
        <dl className="mt-10 space-y-6">
          {items.map((item) => (
            <div
              key={item.q}
              className="rounded-lg border border-slate-200 bg-white p-5"
            >
              <dt className="text-base font-semibold text-slate-900">
                {item.q}
              </dt>
              <dd className="mt-2 text-sm text-slate-600">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="bg-slate-900 py-16 text-center">
      <div className="mx-auto max-w-2xl px-6">
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          See it on a real client site first.
        </h2>
        <p className="mt-3 text-base text-slate-300">
          Generate a preview before you pick a plan — no card, no account, about
          a minute.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/preview">
            <Button size="lg">Try it free</Button>
          </Link>
          <Link href="/sign-up">
            <Button size="lg" variant="ghost" className="text-white hover:text-white">
              Create an account
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
