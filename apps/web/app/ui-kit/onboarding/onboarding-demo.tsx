"use client";

import { useRef, useState } from "react";
import {
  OnboardingWizard,
  type OnboardingConnectResult,
  type OnboardingWizardData,
} from "@/components/onboarding-wizard";
import type { WPContentType } from "@/components/ownership-picker";

/**
 * The stage-2 catalog the mock connect returns. Includes draft counts on
 * Pages (which a stage-1 public-REST probe wouldn't see) — the whole reason
 * Ownership lives AFTER Connect now is so the user can pick against this
 * richer view, not the partial public one.
 */
const STAGE_2_TYPES: WPContentType[] = [
  {
    slug: "page",
    pluralName: "Pages",
    kindLabel: "Page post type · includes 4 drafts",
    count: 12,
    recommendedMode: "jab-managed",
  },
  {
    slug: "post",
    pluralName: "Posts",
    kindLabel: "Built-in post type",
    count: 42,
    recommendedMode: "wp-managed",
  },
  {
    slug: "event",
    pluralName: "Events",
    kindLabel: "Custom post type",
    count: 17,
    recommendedMode: "wp-managed",
  },
  {
    slug: "team_member",
    pluralName: "Team members",
    kindLabel: "Custom post type · private",
    count: 6,
    recommendedMode: "wp-managed",
  },
  {
    slug: "menu_item",
    pluralName: "Menu items",
    kindLabel: "Taxonomy",
    count: 24,
    recommendedMode: "wp-managed",
  },
];

export function OnboardingDemo() {
  const [completed, setCompleted] = useState<OnboardingWizardData | null>(null);

  async function handleConnect(creds: {
    wpUrl: string;
    wpUsername: string;
    wpAppPassword: string;
  }): Promise<OnboardingConnectResult> {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // Mock backend: reject short app passwords (real WP probe rejects too).
    if (creds.wpAppPassword.length < 20) {
      return {
        ok: false,
        error:
          "That doesn't look like a WordPress application password. Generate one at Users → Profile → Application Passwords in wp-admin.",
      };
    }
    // Mock plugin-not-detected failure mode.
    if (creds.wpAppPassword.includes("skip-plugin")) {
      return {
        ok: false,
        error:
          "Authenticated, but we couldn't reach the Jab plugin endpoints. Go back and install the plugin, then try again.",
      };
    }
    return { ok: true, contentTypes: STAGE_2_TYPES };
  }

  async function handleComplete(data: OnboardingWizardData) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    setCompleted(data);
  }

  // Mock plugin verification — first call returns "not found" (what an
  // un-installed user would see), second call returns "ok".
  const verifyHitsRef = useRef(0);
  async function handleVerifyPlugin() {
    verifyHitsRef.current += 1;
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (verifyHitsRef.current % 2 === 1) {
      return {
        ok: false,
        message:
          "Plugin not found on acmecoffee.com — try the install steps again.",
      };
    }
    return { ok: true };
  }

  if (completed) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 py-12">
        <h1 className="text-2xl font-bold text-slate-900">Setup complete ✓</h1>
        <p className="text-sm text-slate-600">
          Mock backend received the final intent + ownership map. In the real
          flow, the parent now routes to the project workspace.
        </p>
        <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(completed, null, 2)}
        </pre>
        <button
          type="button"
          onClick={() => {
            setCompleted(null);
            verifyHitsRef.current = 0;
          }}
          className="text-sm font-medium text-brand hover:text-brand-hover"
        >
          ← Restart the demo
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto px-6 py-12">
      <OnboardingWizard
        wpUrl="https://acmecoffee.com"
        initialIntent="faithful"
        onConnect={handleConnect}
        onComplete={handleComplete}
        onVerifyPlugin={handleVerifyPlugin}
      />
    </div>
  );
}
