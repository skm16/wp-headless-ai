"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { PreviewFrame } from "@/components/preview-frame";
import { PreviewCompare } from "@/components/preview-compare";
import { SiteUrlBar } from "@/components/site-url-bar";
import { IntentChip } from "@/components/intent-picker";
import {
  DeploymentsPanel,
  type Deployment,
} from "@/components/deployments-panel";
import {
  IterationPanel,
  type IterationHistoryEntry,
  type IterationMode,
} from "@/components/iteration-panel";
import { PublishConfirmModal } from "@/components/publish-confirm-modal";
import { PagesList, type PageEntry } from "@/components/pages-list";
import { TrialExpiredOverlay } from "@/components/trial-expired-overlay";
import { PlanUpgradeModal } from "@/components/plan-upgrade-modal";
import type { PricingTier } from "@/lib/pricing";

const ACME_MOCK = `<!doctype html>
<html><head><meta charset="utf-8" /><title>Acme Coffee</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1e293b}
  nav{display:flex;justify-content:space-between;align-items:center;padding:1rem 2rem;border-bottom:1px solid #e2e8f0}
  nav .brand{font-weight:800;color:#4f46e5}
  nav ul{display:flex;gap:1.5rem;list-style:none;font-size:.875rem}
  nav a{color:#475569;text-decoration:none}
  .hero{padding:5rem 2rem 4rem;text-align:center;background:linear-gradient(180deg,#eef2ff 0%,#fff 100%)}
  .hero h1{font-size:2.5rem;line-height:1.1;letter-spacing:-.02em;margin-bottom:1rem;color:#0f172a}
  .hero p{color:#64748b;max-width:32rem;margin:0 auto 2rem}
  .hero a{display:inline-block;background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:.5rem;text-decoration:none;font-weight:500}
</style></head>
<body>
  <nav><span class="brand">Acme Coffee</span><ul><li><a href="#">Menu</a></li><li><a href="#">Shops</a></li><li><a href="#">About</a></li></ul></nav>
  <section class="hero"><h1>Roasted in Brooklyn.<br/>Served in your neighborhood.</h1><p>Small-batch coffee from a family-run roaster. Better mornings, three locations.</p><a href="#">Find a shop</a></section>
</body></html>`;

const ACME_AFTER_MOCK = `<!doctype html>
<html><head><meta charset="utf-8" /><title>Acme Coffee</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,"Times New Roman",serif;color:#1e293b}
  nav{display:flex;justify-content:space-between;align-items:center;padding:1.25rem 2.5rem;background:#fff7ed}
  nav .brand{font-weight:800;color:#9a3412;font-family:-apple-system,sans-serif}
  nav ul{display:flex;gap:1.5rem;list-style:none;font-size:.875rem;font-family:-apple-system,sans-serif}
  nav a{color:#78350f;text-decoration:none}
  .hero{padding:7rem 2rem 6rem;text-align:center;background:linear-gradient(180deg,#fff7ed 0%,#fed7aa 100%)}
  .hero h1{font-size:3.5rem;line-height:1.05;letter-spacing:-.03em;margin-bottom:1.5rem;color:#7c2d12;font-weight:400;font-style:italic}
  .hero p{color:#9a3412;max-width:34rem;margin:0 auto 2.5rem;font-family:-apple-system,sans-serif}
  .hero a{display:inline-block;background:#9a3412;color:#fff;padding:1rem 2rem;border-radius:9999px;text-decoration:none;font-weight:500;font-family:-apple-system,sans-serif}
</style></head>
<body>
  <nav><span class="brand">Acme Coffee</span><ul><li><a href="#">Menu</a></li><li><a href="#">Shops</a></li><li><a href="#">About</a></li></ul></nav>
  <section class="hero"><h1>Brooklyn-roasted coffee,<br/>made for your morning.</h1><p>Family-run since 2014. Three neighborhood shops, one promise: better coffee, served the way you'd serve a friend.</p><a href="#">Find a shop near you →</a></section>
</body></html>`;

const now = Date.now();
const PRODUCTION_URL = "https://client.jabwp.app/acme-coffee/";

const INITIAL_DEPLOYMENTS: Deployment[] = [
  {
    id: "dep_5",
    pagePath: "/",
    status: "published",
    productionUrl: PRODUCTION_URL,
    createdAt: new Date(now - 2 * 60_000),
  },
  {
    id: "dep_4",
    pagePath: "/",
    status: "preview",
    previewUrl: "https://acme-coffee-preview-d7a.jabwp.app/",
    createdAt: new Date(now - 5 * 60_000),
    feedback: "Make the hero copy warmer and use their actual address",
  },
  {
    id: "dep_3",
    pagePath: "/",
    status: "building",
    createdAt: new Date(now - 30_000),
  },
  {
    id: "dep_2",
    pagePath: "/",
    status: "failed",
    createdAt: new Date(now - 18 * 60_000),
    error:
      "We couldn't finalize this generation. Try again — this usually clears on retry.",
  },
  {
    id: "dep_1",
    pagePath: "/",
    status: "preview",
    previewUrl: "https://acme-coffee-preview-a12.jabwp.app/",
    createdAt: new Date(now - 35 * 60_000),
  },
];

const INITIAL_HISTORY: IterationHistoryEntry[] = [
  {
    id: "iter_1",
    prompt: "Make the hero copy warmer and use their actual address",
    mode: "design",
    deploymentLabel: "preview · 5 min ago",
    createdAt: new Date(now - 5 * 60_000),
  },
];

const ITERATION_DELAY_MS = 2200;

const MOCK_PAGES: PageEntry[] = [
  {
    template: "Home",
    slug: "/",
    status: "live",
    ownership: "jab-managed",
    lastDeployedAt: new Date(now - 2 * 60_000),
    url: PRODUCTION_URL,
  },
  {
    template: "Blog index",
    slug: "/blog",
    status: "not-generated",
    ownership: "wp-managed",
    wpAdminUrl: "https://acmecoffee.wp/wp-admin/edit.php",
  },
  {
    template: "Blog post",
    slug: "/blog/[slug]",
    status: "not-generated",
    ownership: "wp-managed",
    entriesCount: 42,
    wpAdminUrl: "https://acmecoffee.wp/wp-admin/edit.php",
  },
  {
    template: "Generic page",
    slug: "/[slug]",
    status: "not-generated",
    ownership: "jab-managed",
    entriesCount: 8,
  },
];

type SecondaryView = "pages" | "activity";

export function WorkspaceDemo() {
  const [deployments, setDeployments] =
    useState<Deployment[]>(INITIAL_DEPLOYMENTS);
  const [history, setHistory] =
    useState<IterationHistoryEntry[]>(INITIAL_HISTORY);
  const [pendingIteration, setPendingIteration] = useState(false);
  const [previewMode, setPreviewMode] = useState<"single" | "compare">(
    "single",
  );
  const [publishTarget, setPublishTarget] = useState<Deployment | null>(null);
  const [generationsLeft, setGenerationsLeft] = useState(47);
  const [hasIterated, setHasIterated] = useState(false);
  const [secondaryView, setSecondaryView] = useState<SecondaryView>("activity");
  const [trialExpired, setTrialExpired] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // Cancel pending mock generations on unmount — see preview-flow for the
  // same pattern. The real iteration codepath will route through Inngest
  // polling; the ref structure carries over.
  const timeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
    };
  }, []);

  function handleIterationSubmit(prompt: string, mode: IterationMode) {
    setPendingIteration(true);
    const id = setTimeout(() => {
      const id = `iter_${Date.now()}`;
      const deploymentId = `dep_${Date.now()}`;
      const historyEntry: IterationHistoryEntry = {
        id,
        prompt,
        mode,
        deploymentLabel: "preview · just now",
        createdAt: new Date(),
      };
      const deployment: Deployment = {
        id: deploymentId,
        pagePath: "/",
        status: "preview",
        previewUrl: `https://acme-coffee-preview-${Date.now().toString(36).slice(-4)}.jabwp.app/`,
        createdAt: new Date(),
        feedback: prompt,
        parentId: "dep_5",
      };
      setHistory((prev) => [historyEntry, ...prev]);
      setDeployments((prev) => [deployment, ...prev]);
      if (mode === "design") {
        setGenerationsLeft((n) => Math.max(0, n - 1));
      }
      setHasIterated(true);
      setPreviewMode("compare");
      setPendingIteration(false);
    }, ITERATION_DELAY_MS);
    timeoutsRef.current.push(id);
  }

  function handlePromote(target: Deployment) {
    setPublishTarget(target);
  }

  function handlePublishConfirm() {
    if (!publishTarget) return;
    const targetId = publishTarget.id;
    setDeployments((prev) =>
      prev.map((d) => {
        if (d.id === targetId) {
          return {
            ...d,
            status: "published" as const,
            productionUrl: PRODUCTION_URL,
          };
        }
        if (d.status === "published" && d.id !== targetId) {
          return { ...d, status: "preview" as const };
        }
        return d;
      }),
    );
    setPublishTarget(null);
    setPreviewMode("single");
  }

  function handleRegenerate() {
    handleIterationSubmit("Retry generation", "design");
  }

  const latestPreview = deployments.find(
    (d) => d.status === "preview" || d.status === "published",
  );

  return (
    <WorkspaceShell
      navItems={[
        { label: "Overview", href: "/ui-kit/workspace", active: true },
        { label: "Connections", href: "/ui-kit/workspace/connections" },
        { label: "Settings", href: "#" },
      ]}
      headerLeft={
        <>
          <h1 className="truncate text-base font-semibold text-slate-900">
            Acme Coffee
          </h1>
          <Badge tone="success">
            <StatusDot tone="success" />
            Live
          </Badge>
          <IntentChip
            value="faithful"
            onEdit={() => alert("Open intent editor (mock)")}
          />
        </>
      }
      headerRight={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTrialExpired((v) => !v)}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            title="Demo toggle — flips the trial-expired overlay"
          >
            {trialExpired ? "Reactivate (demo)" : "Expire trial (demo)"}
          </button>
          <SiteUrlBar url={PRODUCTION_URL} compact />
        </div>
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
      <div className="space-y-8">
        {trialExpired && (
          <TrialExpiredOverlay
            productionUrl={PRODUCTION_URL}
            onUpgrade={() => setUpgradeOpen(true)}
          />
        )}
        {/* Preview — front and center */}
        <section className="space-y-3">
          {hasIterated && (
            <div className="flex items-center justify-between">
              <Segmented
                value={previewMode}
                onChange={setPreviewMode}
                size="sm"
                ariaLabel="Preview mode"
                options={[
                  { value: "single", label: "Single" },
                  { value: "compare", label: "Compare" },
                ]}
              />
              <Button variant="ghost" size="sm" onClick={handleRegenerate}>
                Regenerate
              </Button>
            </div>
          )}

          {previewMode === "compare" && hasIterated ? (
            <PreviewCompare
              before={{
                srcDoc: ACME_MOCK,
                url: PRODUCTION_URL,
                label: "Before",
                sublabel: "Currently live",
              }}
              after={{
                srcDoc: ACME_AFTER_MOCK,
                url: latestPreview?.previewUrl ?? "",
                label: "After",
                sublabel: latestPreview?.feedback ?? "Iteration",
              }}
            />
          ) : (
            <PreviewFrame
              url={
                latestPreview?.productionUrl ??
                latestPreview?.previewUrl ??
                PRODUCTION_URL
              }
              srcDoc={hasIterated ? ACME_AFTER_MOCK : ACME_MOCK}
              status="live"
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              This is what your client will see.
            </p>
            <div className="flex items-center gap-2">
              {!hasIterated && (
                <Button variant="ghost" size="sm" onClick={handleRegenerate}>
                  Regenerate
                </Button>
              )}
              {latestPreview?.status === "preview" && (
                <Button size="sm" onClick={() => handlePromote(latestPreview)}>
                  Publish to production
                </Button>
              )}
            </div>
          </div>
        </section>

        {/* Iteration */}
        <IterationPanel
          ownership="jab-managed"
          generationsLeft={generationsLeft}
          history={history}
          pending={pendingIteration}
          onSubmit={handleIterationSubmit}
        />

        {/* Pages / Activity — toggled views */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Segmented
              value={secondaryView}
              onChange={setSecondaryView}
              size="sm"
              ariaLabel="Secondary view"
              options={[
                { value: "pages", label: "Pages" },
                { value: "activity", label: "Activity" },
              ]}
            />
          </div>

          {secondaryView === "pages" ? (
            <PagesList
              pages={MOCK_PAGES}
              fallbackNote="Form pages (/contact, /signup) still load from WordPress for now."
              onGenerate={(p) =>
                alert(`Mock: would generate ${p.template} (${p.slug})`)
              }
              onIterate={(p) =>
                alert(`Mock: would open IterationPanel for ${p.template}`)
              }
              onRegenerate={(p) =>
                alert(`Mock: would regenerate ${p.template}`)
              }
            />
          ) : (
            <DeploymentsPanel
              deployments={deployments}
              onPromote={handlePromote}
              onRegenerate={handleRegenerate}
            />
          )}
        </section>
      </div>

      <PublishConfirmModal
        isOpen={publishTarget !== null}
        onCancel={() => setPublishTarget(null)}
        onConfirm={handlePublishConfirm}
        productionUrl={PRODUCTION_URL}
        what={
          publishTarget?.feedback
            ? `the iteration "${publishTarget.feedback}"`
            : "the latest preview"
        }
      />

      <PlanUpgradeModal
        isOpen={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onSelect={(tier: PricingTier) => {
          alert(`Mock: open Stripe checkout for ${tier.name}`);
          setUpgradeOpen(false);
          setTrialExpired(false);
        }}
      />
    </WorkspaceShell>
  );
}
