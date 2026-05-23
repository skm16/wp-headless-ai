"use client";

import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { PricingTierCard } from "@/components/pricing-tier-card";
import { PRICING_TIERS, type PricingTier, type TierId } from "@/lib/pricing";

export interface PlanUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tier id of the user's current plan, if any. Marked as `current` in the grid. */
  currentTierId?: TierId;
  /** Fired when the user picks a tier — parent routes to Stripe checkout. */
  onSelect: (tier: PricingTier) => void;
}

/**
 * In-app plan picker shown from the quota meter, the trial-expired overlay,
 * and the billing surface. Reuses the same `PricingTierCard` as the public
 * `/pricing` page so the comparison ladder reads identically — agencies
 * picking inside the app see the same tier shape they remembered from the
 * marketing page.
 *
 * `current` flag suppresses the CTA on the active tier; downgrade flows
 * (post-MVP) will route through a different surface.
 */
export function PlanUpgradeModal({
  isOpen,
  onClose,
  currentTierId,
  onSelect,
}: PlanUpgradeModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Choose a plan"
      description="Picks below open Stripe checkout. You can change tiers from Billing any time."
      size="xl"
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {PRICING_TIERS.map((tier) => (
          <PricingTierCard
            key={tier.id}
            tier={tier}
            onSelect={onSelect}
            current={currentTierId === tier.id}
            compact
            ctaLabel={
              currentTierId === tier.id
                ? "Current plan"
                : currentTierId
                  ? "Switch to this plan"
                  : "Start with this plan"
            }
          />
        ))}
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
