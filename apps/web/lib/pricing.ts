/**
 * Pricing tier definitions — single source of truth read by both the public
 * pricing page and the in-app upgrade modal. Numbers are PLACEHOLDERS per
 * §10 #11; the *shape* (per-site recurring × tiered + per-site setup fee +
 * bundled generation allowance) is settled. Tier names and exact $ figures
 * are a copy pass that should land before the public marketing rewrite.
 *
 * Engineering note: when Stripe wiring lands, each tier needs `priceId`
 * (recurring) and `setupPriceId` (one-time) columns added here. Keep the
 * customer-facing fields and the Stripe IDs in the same record so changes
 * stay coupled.
 */

export type TierId = "solo" | "studio" | "agency";

export interface PricingTier {
  id: TierId;
  name: string;
  tagline: string;
  /** Per-site recurring, in USD. Multiplied by `siteLimit` at most. */
  monthlyPriceUsdPerSite: number;
  /** Per-site one-time fee on activation, in USD. */
  setupFeeUsdPerSite: number;
  siteLimit: number;
  generationsPerSitePerMonth: number;
  features: string[];
  /** Marked as the suggested tier in the public pricing layout. */
  recommended?: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "solo",
    name: "Solo",
    tagline: "For freelance agencies finishing one or two client sites at a time.",
    monthlyPriceUsdPerSite: 49,
    setupFeeUsdPerSite: 250,
    siteLimit: 2,
    generationsPerSitePerMonth: 50,
    features: [
      "Up to 2 client sites",
      "50 AI generations per site per month",
      "Custom domain on every site",
      "Email support",
    ],
  },
  {
    id: "studio",
    name: "Studio",
    tagline: "For small teams shipping a steady book of client work.",
    monthlyPriceUsdPerSite: 39,
    setupFeeUsdPerSite: 250,
    siteLimit: 5,
    generationsPerSitePerMonth: 75,
    features: [
      "Up to 5 client sites",
      "75 AI generations per site per month",
      "Custom domain on every site",
      "Priority support",
      "Concierge onboarding for your first site",
    ],
    recommended: true,
  },
  {
    id: "agency",
    name: "Agency",
    tagline: "For established shops with an active client roster.",
    monthlyPriceUsdPerSite: 29,
    setupFeeUsdPerSite: 250,
    siteLimit: 15,
    generationsPerSitePerMonth: 100,
    features: [
      "Up to 15 client sites",
      "100 AI generations per site per month",
      "Custom domain on every site",
      "Priority support",
      "Concierge onboarding for your first 3 sites",
      "Team seats included",
    ],
  },
];

export const TRIAL_SUMMARY = {
  durationDays: 7,
  siteLimit: 1,
  generationsIncluded: 25,
};

/**
 * Look up a tier by id. Returns `undefined` for unknown ids so callers can
 * render a graceful fallback — agency accounts that lived through a tier
 * rename can have a DB-stored `tierId` value that's no longer in the
 * canonical list; throwing would crash their billing page.
 */
export function findTier(id: TierId | string): PricingTier | undefined {
  return PRICING_TIERS.find((t) => t.id === id);
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
