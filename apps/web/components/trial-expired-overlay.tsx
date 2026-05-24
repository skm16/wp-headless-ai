"use client";

import { Button } from "@/components/ui/button";

export interface TrialExpiredOverlayProps {
  /** Production URL the published site is still being served at. */
  productionUrl: string;
  /** Opens the PlanUpgradeModal (or routes to /pricing on public surfaces). */
  onUpgrade: () => void;
}

/**
 * §10 #4 — soft trial pause. The published site stays live (the agency's
 * client never sees a dark page); only the generation + iteration affordances
 * are blocked.
 *
 * Renders as an absolutely-positioned panel that sits *inside* the workspace
 * shell — not a full-screen takeover. The workspace nav and project header
 * stay visible so the user can navigate to Connections / Billing without
 * being forced through the upgrade modal. The blocking surface here is the
 * preview + iteration area, which is what's actually inert.
 */
export function TrialExpiredOverlay({
  productionUrl,
  onUpgrade,
}: TrialExpiredOverlayProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-amb/40 bg-amb/10 p-8 text-center shadow-sm"
    >
      <div className="mx-auto max-w-xl space-y-4">
        <h2 className="text-2xl font-bold tracking-tight text-amb">
          Your trial has ended
        </h2>
        <p className="text-sm text-gry">
          Your site is still live at{" "}
          <a
            href={productionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono font-semibold text-wht underline-offset-2 hover:underline"
          >
            {productionUrl}
          </a>
          .
        </p>
        <p className="text-sm text-gry">
          You can&apos;t generate new pages or refine the design until you pick
          a plan — but nothing your client sees has changed.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button size="lg" onClick={onUpgrade}>
            Choose a plan
          </Button>
          <a href={productionUrl} target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="ghost">
              View site
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}
