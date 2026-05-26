"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { ProjectsListView } from "@/components/projects-list-view";
import type { ProjectListEntry } from "@/components/project-card";

type Scenario = "empty" | "one" | "many";

const now = Date.now();

const PROJECTS: Record<Scenario, ProjectListEntry[]> = {
  empty: [],
  one: [
    {
      id: "acme",
      name: "Acme Coffee",
      clientName: "Label Interactive · client",
      status: "live",
      wpUrl: "https://acmecoffee.wp",
      productionUrl: "https://acmecoffee.com",
      intent: "faithful",
      lastDeployedAt: new Date(now - 3 * 60_000),
    },
  ],
  many: [
    {
      id: "acme",
      name: "Acme Coffee",
      clientName: "Brooklyn-roasted, neighborhood-served",
      status: "live",
      wpUrl: "https://acmecoffee.wp",
      productionUrl: "https://acmecoffee.com",
      intent: "faithful",
      lastDeployedAt: new Date(now - 3 * 60_000),
    },
    {
      id: "tworoads",
      name: "Two Roads Brewing",
      clientName: "Independent craft brewery",
      status: "building",
      wpUrl: "https://tworoads.wp",
      intent: "refresh",
      lastDeployedAt: new Date(now - 90_000),
    },
    {
      id: "nordic",
      name: "Nordic Design Co",
      clientName: "Furniture studio",
      status: "live",
      wpUrl: "https://nordic.wp",
      productionUrl: "https://nordicdesign.co",
      intent: "reimagine",
      lastDeployedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    },
    {
      id: "bluefin",
      name: "Bluefin Yacht Club",
      clientName: "Members-only marina",
      status: "failed",
      wpUrl: "https://bluefin.wp",
      intent: "faithful",
      lastDeployedAt: new Date(now - 20 * 60_000),
      errorMessage:
        "We couldn't finalize this generation. Try again — this usually clears on retry.",
    },
    {
      id: "sunset",
      name: "Sunset Pottery",
      clientName: "Studio + storefront",
      status: "onboarding",
      wpUrl: "https://sunsetpottery.wp",
      intent: "refresh",
    },
    {
      id: "highland",
      name: "Highland Bakery",
      clientName: "Three-shop bakery",
      status: "draft",
      wpUrl: "https://highlandbakery.wp",
    },
  ],
};

export function ProjectsDemo() {
  const [scenario, setScenario] = useState<Scenario>("many");

  return (
    <WorkspaceShell
      navItems={[
        { label: "Projects", href: "/ui-kit/projects", active: true },
        { label: "Billing", href: "/ui-kit/billing" },
        { label: "Settings", href: "#" },
      ]}
      headerLeft={
        <>
          <Link
            href="/ui-kit/projects"
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
          onChange={setScenario}
          size="sm"
          ariaLabel="Demo scenario"
          options={[
            { value: "empty", label: "Empty" },
            { value: "one", label: "1 project" },
            { value: "many", label: "Many" },
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
      <ProjectsListView
        projects={PROJECTS[scenario]}
        projectHrefBase="/ui-kit/workspace"
        newProjectHref="#"
      />
    </WorkspaceShell>
  );
}
