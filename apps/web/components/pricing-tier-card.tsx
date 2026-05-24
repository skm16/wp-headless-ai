import Link from "next/link";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUsd, type PricingTier } from "@/lib/pricing";

export interface PricingTierCardProps {
  tier: PricingTier;
  /** Marketing CTA href — `/sign-up?plan={id}` on the public page; an in-app
   *  upgrade flow uses an `onSelect` callback instead. */
  ctaHref?: string;
  ctaLabel?: string;
  /** Alternative to ctaHref when the card lives inside the in-app upgrade modal. */
  onSelect?: (tier: PricingTier) => void;
  /** Renders the card in a compact layout suitable for the in-app upgrade modal. */
  compact?: boolean;
  /** Shown as a "Current" badge when this tier matches the user's current plan. */
  current?: boolean;
  className?: string;
}

/**
 * Per-tier marketing card. One card = one tier, regardless of context (public
 * pricing page vs. in-app upgrade modal). The CTA mode toggles via prop —
 * link-out on public, callback in-app — so a tier rendered in either context
 * stays visually consistent.
 *
 * `recommended` tiers get the brand accent border + "Recommended" badge.
 * `current` overrides — there's no upsell on the user's existing tier.
 */
export function PricingTierCard({
  tier,
  ctaHref,
  ctaLabel,
  onSelect,
  compact = false,
  current = false,
  className,
}: PricingTierCardProps) {
  const recommended = tier.recommended && !current;
  const resolvedCtaLabel =
    ctaLabel ?? (current ? "Current plan" : "Start free trial");

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border bg-bg transition-colors",
        recommended
          ? "border-teal/40 ring-1 ring-teal/30"
          : "border-bord",
        compact ? "p-5" : "p-6 sm:p-7",
        className,
      )}
    >
      {recommended && (
        <span className="absolute -top-3 left-6 inline-flex items-center rounded-full bg-teal px-2.5 py-0.5 font-mono text-xs font-semibold text-bg">
          Recommended
        </span>
      )}
      {current && (
        <span className="absolute -top-3 left-6">
          <Badge tone="brand">Current plan</Badge>
        </span>
      )}

      <header>
        <h3 className="text-lg font-bold leading-snug text-wht">{tier.name}</h3>
        <p className="mt-1 text-sm text-gry">{tier.tagline}</p>
      </header>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-3xl font-extrabold tabular-nums text-wht">
          {formatUsd(tier.monthlyPriceUsdPerSite)}
        </span>
        <span className="text-sm text-gry-d">/ site / month</span>
      </div>
      <p className="mt-1 font-mono text-xs text-gry-d">
        + {formatUsd(tier.setupFeeUsdPerSite)} one-time setup per site
      </p>

      <ul className="mt-5 space-y-2 text-sm text-gry">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <CheckGlyph />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex-1" />

      <div className="pt-4">
        {ctaHref ? (
          <Link href={ctaHref} className="block">
            <Button
              variant={recommended ? "primary" : "secondary"}
              className="w-full"
              disabled={current}
            >
              {resolvedCtaLabel}
            </Button>
          </Link>
        ) : (
          <Button
            variant={recommended ? "primary" : "secondary"}
            className="w-full"
            onClick={() => onSelect?.(tier)}
            disabled={current || !onSelect}
          >
            {resolvedCtaLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

function CheckGlyph() {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal/10 text-xs font-semibold text-teal"
    >
      ✓
    </span>
  );
}
