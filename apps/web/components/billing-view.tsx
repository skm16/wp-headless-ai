"use client";

import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format-relative";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { QuotaMeter } from "@/components/quota-meter";
import {
  findTier,
  formatUsd,
  TRIAL_SUMMARY,
  type TierId,
} from "@/lib/pricing";

export interface BillingPlanState {
  /** `null` when the account is on a trial. */
  tierId: TierId | null;
  /** Used for trial countdown copy. */
  trialEndsAt?: Date;
  /** Sites used / sites bought. */
  sitesUsed: number;
  /** Generations used across all sites this period. */
  generationsUsed: number;
  /** Generations purchased this period (sum across all paid sites). */
  generationsLimit: number;
  /** Next renewal date — null when on trial. */
  renewsAt?: Date;
}

export interface PaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface Invoice {
  id: string;
  date: Date;
  amountUsd: number;
  status: "paid" | "open" | "void";
  hostedUrl?: string;
}

export interface BillingViewProps {
  plan: BillingPlanState;
  paymentMethod: PaymentMethod | null;
  invoices: Invoice[];
  /** Opens the PlanUpgradeModal. */
  onChangePlan: () => void;
  /** Routes to Stripe customer portal — usually external. */
  onUpdatePaymentMethod: () => void;
  /** Routes to Stripe portal — usually external. */
  onManageSubscription: () => void;
}

/**
 * Account-level billing surface. Sits at `/billing`, not inside the project
 * scope — agencies on the Studio/Agency tiers pay for N sites and their
 * billing concerns aren't per-project.
 *
 * Trial state inverts the layout slightly: there's no payment method or
 * invoice list, the plan card invites the user to pick a tier, and the
 * usage section reflects the trial's bundled allowance.
 */
export function BillingView({
  plan,
  paymentMethod,
  invoices,
  onChangePlan,
  onUpdatePaymentMethod,
  onManageSubscription,
}: BillingViewProps) {
  const onTrial = plan.tierId === null;
  const tier = plan.tierId ? findTier(plan.tierId) : null;
  // tier === null is the trial case (no tierId). undefined means the DB had
  // a tierId that's no longer in the canonical list — e.g. an old tier slug
  // after a rename. Surface that as a "pick a new plan" prompt rather than
  // crashing.
  const tierUnknown = plan.tierId !== null && !tier;
  const planLimits = tier ?? {
    siteLimit: TRIAL_SUMMARY.siteLimit,
    name: tierUnknown ? "Unknown plan" : "Free trial",
    monthlyPriceUsdPerSite: 0,
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
        <p className="mt-1 text-sm text-slate-600">
          Plan, usage, payment method, and invoices.
        </p>
      </header>

      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{planLimits.name}</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              {onTrial
                ? `${TRIAL_SUMMARY.siteLimit} site · ${TRIAL_SUMMARY.generationsIncluded} generations included`
                : tier
                  ? `${formatUsd(tier.monthlyPriceUsdPerSite)} / site / month · up to ${tier.siteLimit} sites`
                  : "Your plan is no longer available — pick a new one to continue."}
            </p>
          </div>
          {onTrial ? (
            <Badge tone="warning">Trial</Badge>
          ) : tierUnknown ? (
            <Badge tone="danger">Action needed</Badge>
          ) : (
            <Badge tone="success">Active</Badge>
          )}
        </CardHeader>
        <CardBody className="space-y-4">
          {onTrial && plan.trialEndsAt && (
            <Alert tone="info">
              Trial ends {formatRelative(plan.trialEndsAt)}. Your site stays
              live after it ends, but AI generation pauses until you pick a
              plan.
            </Alert>
          )}
          {tierUnknown && (
            <Alert tone="warning" title="Plan no longer available">
              The plan on your account isn&apos;t one of the current options.
              Pick a new one — your sites stay live in the meantime.
            </Alert>
          )}

          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <Stat label="Plan">{planLimits.name}</Stat>
            <Stat label="Sites">
              {plan.sitesUsed} of {planLimits.siteLimit}
            </Stat>
            <Stat label={onTrial ? "Trial ends" : "Renews"}>
              {onTrial && plan.trialEndsAt
                ? formatRelative(plan.trialEndsAt)
                : plan.renewsAt
                  ? formatRelative(plan.renewsAt)
                  : "—"}
            </Stat>
          </dl>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={onManageSubscription}
              disabled={onTrial || tierUnknown}
            >
              Manage subscription
            </Button>
            <Button size="sm" onClick={onChangePlan}>
              {onTrial || tierUnknown ? "Pick a plan" : "Change plan"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage this period</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            Across all sites. Resets at the start of each billing cycle.
          </p>
        </CardHeader>
        <CardBody className="space-y-5">
          <QuotaMeter
            label="Sites"
            used={plan.sitesUsed}
            limit={planLimits.siteLimit}
            planName={planLimits.name}
            upgradeHref="#"
          />
          <QuotaMeter
            label="Generations"
            used={plan.generationsUsed}
            limit={plan.generationsLimit}
            planName={planLimits.name}
            upgradeHref="#"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Payment method</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Updates open Stripe&apos;s secure portal.
            </p>
          </div>
          {paymentMethod && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUpdatePaymentMethod}
            >
              Update →
            </Button>
          )}
        </CardHeader>
        <CardBody>
          {paymentMethod ? (
            <p className="font-mono text-sm text-slate-700">
              {paymentMethod.brand} •••• {paymentMethod.last4}
              <span className="ml-3 text-slate-500">
                expires {String(paymentMethod.expMonth).padStart(2, "0")}/
                {paymentMethod.expYear}
              </span>
            </p>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-600">
                No card on file. You&apos;ll add one when you pick a plan.
              </p>
              <Button size="sm" onClick={onChangePlan}>
                Pick a plan
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {invoices.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-slate-500">
              No invoices yet. The first one lands when your trial converts.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-6 py-3 text-left font-medium">Date</th>
                  <th className="px-6 py-3 text-left font-medium">Amount</th>
                  <th className="px-6 py-3 text-left font-medium">Status</th>
                  <th className="px-6 py-3 text-right font-medium">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-6 py-3 text-slate-700">
                      {invoice.date.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-3 font-mono tabular-nums text-slate-700">
                      {formatUsd(invoice.amountUsd)}
                    </td>
                    <td className="px-6 py-3">
                      <Badge tone={invoiceTone(invoice.status)}>
                        {invoice.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-right">
                      {invoice.hostedUrl ? (
                        <a
                          href={invoice.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-brand hover:text-brand-hover"
                        >
                          View →
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className={cn("mt-1 text-sm text-slate-900")}>{children}</dd>
    </div>
  );
}

function invoiceTone(
  status: Invoice["status"],
): "success" | "warning" | "neutral" {
  if (status === "paid") return "success";
  if (status === "open") return "warning";
  return "neutral";
}
