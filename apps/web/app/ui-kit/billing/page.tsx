import { notFound } from "next/navigation";
import { BillingDemo } from "./billing-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of the account-level Billing page (Phase 5 deliverable).
 * Two scenarios via the header toggle: "On trial" (no card, no invoices,
 * trial-countdown copy) and "Studio plan" (active subscription, payment
 * method, invoice list).
 *
 * The real route lands at `(app)/billing/page.tsx` once Stripe wiring is in.
 * Trade-offs noted on `BillingView`: it currently treats sites + generations
 * as account-level aggregates because tiers are sold at the account level —
 * if Sean picks a per-site billing dimension later, the per-site detail
 * folds into the existing structure with minimal disruption.
 */
export default function BillingDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <BillingDemo />;
}
