"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import {
  BillingView,
  type BillingPlanState,
  type Invoice,
  type PaymentMethod,
} from "@/components/billing-view";
import { PlanUpgradeModal } from "@/components/plan-upgrade-modal";
import type { PricingTier } from "@/lib/pricing";

type ScenarioId = "trial" | "studio";

const SCENARIOS: Record<
  ScenarioId,
  {
    label: string;
    plan: BillingPlanState;
    paymentMethod: PaymentMethod | null;
    invoices: Invoice[];
  }
> = {
  trial: {
    label: "On trial",
    plan: {
      tierId: null,
      trialEndsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      sitesUsed: 1,
      generationsUsed: 12,
      generationsLimit: 25,
    },
    paymentMethod: null,
    invoices: [],
  },
  studio: {
    label: "Studio plan",
    plan: {
      tierId: "studio",
      sitesUsed: 3,
      generationsUsed: 178,
      generationsLimit: 375,
      renewsAt: new Date(Date.now() + 18 * 24 * 60 * 60 * 1000),
    },
    paymentMethod: {
      brand: "Visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2027,
    },
    invoices: [
      {
        id: "in_3",
        date: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        amountUsd: 117 + 250,
        status: "paid",
        hostedUrl: "#",
      },
      {
        id: "in_2",
        date: new Date(Date.now() - 42 * 24 * 60 * 60 * 1000),
        amountUsd: 117,
        status: "paid",
        hostedUrl: "#",
      },
      {
        id: "in_1",
        date: new Date(Date.now() - 72 * 24 * 60 * 60 * 1000),
        amountUsd: 78,
        status: "paid",
        hostedUrl: "#",
      },
    ],
  },
};

export function BillingDemo() {
  const [scenario, setScenario] = useState<ScenarioId>("studio");
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const { plan, paymentMethod, invoices } = SCENARIOS[scenario];

  function handleSelect(tier: PricingTier) {
    alert(`Mock: open Stripe checkout for ${tier.name}`);
    setUpgradeOpen(false);
  }

  return (
    <WorkspaceShell
      navItems={[
        { label: "Projects", href: "/ui-kit/workspace" },
        { label: "Billing", href: "/ui-kit/billing", active: true },
        { label: "Settings", href: "#" },
      ]}
      headerLeft={
        <>
          <Link
            href="/ui-kit/workspace"
            className="truncate text-base font-semibold text-slate-900 hover:text-brand"
          >
            Label Interactive
          </Link>
          <Badge tone="neutral">
            <StatusDot tone="neutral" />
            Account
          </Badge>
        </>
      }
      headerRight={
        <Segmented
          value={scenario}
          onChange={(next) => setScenario(next as ScenarioId)}
          size="sm"
          ariaLabel="Demo scenario"
          options={[
            { value: "trial", label: "On trial" },
            { value: "studio", label: "Studio plan" },
          ]}
        />
      }
      sidebarFooter={
        <div className="space-y-1">
          <p className="truncate text-xs text-slate-500">Signed in as</p>
          <p className="truncate text-sm font-medium text-slate-900">demo@jab</p>
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-900"
            onClick={() => alert("Sign out (mock)")}
          >
            Sign out
          </button>
        </div>
      }
    >
      <BillingView
        plan={plan}
        paymentMethod={paymentMethod}
        invoices={invoices}
        onChangePlan={() => setUpgradeOpen(true)}
        onUpdatePaymentMethod={() =>
          alert("Mock: open Stripe customer portal")
        }
        onManageSubscription={() =>
          alert("Mock: open Stripe customer portal")
        }
      />

      <PlanUpgradeModal
        isOpen={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        currentTierId={plan.tierId ?? undefined}
        onSelect={handleSelect}
      />
    </WorkspaceShell>
  );
}
