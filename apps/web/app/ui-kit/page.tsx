import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { ProgressSteps } from "@/components/ui/progress-steps";
import { StatusDot } from "@/components/ui/status-dot";
import { Stepper } from "@/components/ui/stepper";
import { QuotaMeter } from "@/components/quota-meter";
import { PreviewFrame } from "@/components/preview-frame";
import { CaveatsBanner } from "@/components/caveats-banner";
import { ContentDocStatus } from "@/components/content-doc-status";
import { IntentPickerDemo } from "./intent-picker-demo";
import {
  ModalDemo,
  OwnershipPickerDemo,
  SegmentedDemo,
} from "./ownership-picker-demo";
import { IterationPanelWPDemo } from "./iteration-panel-demo";
import { FidelityReportDemo } from "./fidelity-report-demo";
import { DesignTokensDemo } from "./design-tokens-demo";

export const dynamic = "force-dynamic";

const KITCHEN_SINK_MOCK = `<!doctype html>
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
  .features{display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;padding:3rem 2rem;max-width:60rem;margin:0 auto}
  .feature{padding:1.25rem;border:1px solid #e2e8f0;border-radius:.75rem}
  .feature h3{font-size:1rem;font-weight:600;margin-bottom:.5rem}
  .feature p{color:#64748b;font-size:.875rem}
  @media (max-width:720px){nav ul{display:none}.hero h1{font-size:1.875rem}.features{grid-template-columns:1fr}}
</style></head>
<body>
  <nav><span class="brand">Acme Coffee</span><ul><li><a href="#">Menu</a></li><li><a href="#">Shops</a></li><li><a href="#">About</a></li></ul></nav>
  <section class="hero"><h1>Roasted in Brooklyn.<br/>Served in your neighborhood.</h1><p>Small-batch coffee from a family-run roaster. Better mornings, three locations.</p><a href="#">Find a shop</a></section>
  <section class="features">
    <div class="feature"><h3>Our roasts</h3><p>Seasonal single-origin and house blends.</p></div>
    <div class="feature"><h3>Our shops</h3><p>Williamsburg, Bushwick, and Park Slope.</p></div>
    <div class="feature"><h3>Order online</h3><p>Pick up at any location or have it shipped.</p></div>
  </section>
</body></html>`;

export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto max-w-4xl space-y-12 px-6 py-12">
      <header className="space-y-5">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">UI kit</h1>
          <p className="mt-1 text-sm text-slate-600">
            Living reference for the Foundation pack primitives. Development
            only — this route 404s in production.
          </p>
        </div>
        <DemoRouteList />
        <SectionToc />
      </header>

      <Section title="Button">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-3">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-3">
          <Button loading>Saving</Button>
          <Button loading loadingText="Saving…" variant="primary">
            Save
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Neutral</Badge>
          <Badge tone="brand">Brand</Badge>
          <Badge tone="success">Live</Badge>
          <Badge tone="warning">Building</Badge>
          <Badge tone="danger">Failed</Badge>
          <Badge tone="info">Info</Badge>
        </div>
      </Section>

      <Section title="Status dot">
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <span className="inline-flex items-center gap-2">
            <StatusDot tone="success" /> Live
          </span>
          <span className="inline-flex items-center gap-2">
            <StatusDot tone="warning" pulse /> Building
          </span>
          <span className="inline-flex items-center gap-2">
            <StatusDot tone="danger" /> Failed
          </span>
          <span className="inline-flex items-center gap-2">
            <StatusDot tone="neutral" /> Draft
          </span>
        </div>
      </Section>

      <Section title="Field">
        <div className="grid max-w-md gap-4">
          <Field
            label="Email"
            type="email"
            placeholder="you@agency.com"
            hint="We never share this."
          />
          <Field
            label="WordPress URL"
            placeholder="https://clientsite.com"
            error="We need your WordPress site to use HTTPS."
          />
          <Field label="Disabled" disabled defaultValue="locked" />
        </div>
      </Section>

      <Section title="Alert">
        <div className="space-y-3">
          <Alert tone="info" title="Heads up">
            Custom domain wiring lands in Phase 2.
          </Alert>
          <Alert tone="success">Site is live at client.jabwp.app/acme-coffee/.</Alert>
          <Alert
            tone="warning"
            title="Quota"
            action={
              <Button size="sm" variant="secondary">
                Upgrade
              </Button>
            }
          >
            You&apos;ve used 8 of 10 generations this period.
          </Alert>
          <Alert
            tone="danger"
            title="Generation failed"
            action={
              <Button size="sm" variant="secondary">
                Regenerate
              </Button>
            }
          >
            We couldn&apos;t finalize this generation. Try again — this usually
            clears on retry.
          </Alert>
        </div>
      </Section>

      <Section title="Quota meter">
        <div className="grid max-w-md gap-6">
          <QuotaMeter
            label="Generations"
            used={3}
            limit={10}
            planName="Free trial"
            upgradeHref="/billing"
          />
          <QuotaMeter
            label="Generations"
            used={9}
            limit={10}
            planName="Free trial"
            upgradeHref="/billing"
          />
          <QuotaMeter
            label="Generations"
            used={10}
            limit={10}
            planName="Free trial"
            upgradeHref="/billing"
          />
          <QuotaMeter label="Sites" used={1} limit={3} planName="Studio" />
        </div>
      </Section>

      <Section title="Empty state">
        <EmptyState
          title="No projects yet"
          description="Connect a WordPress site to spin up your first headless project."
          action={<Button>Create project</Button>}
        />
      </Section>

      <Section title="Card">
        <Card>
          <CardHeader>
            <CardTitle>Latest deployment</CardTitle>
            <CardDescription>
              Generated 2 minutes ago · indigo-600 brand accent
            </CardDescription>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-slate-600">
              The preview URL is the unit of value. This Card composes Header +
              Body + Footer slots and is the base for most workspace panels.
            </p>
          </CardBody>
          <CardFooter>
            <Button variant="secondary" size="sm">
              Regenerate
            </Button>
            <Button size="sm">Publish</Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Stepper (onboarding)">
        <Stepper
          steps={[
            { label: "Connect WordPress", status: "done" },
            { label: "Generate", status: "current" },
            { label: "Publish", status: "pending" },
          ]}
        />
      </Section>

      <Section title="Segmented">
        <p className="text-xs text-slate-500">
          Controlled segmented selector. Used inside OwnershipPicker (WP/Jab)
          and the upcoming IterationPanel content/design toggle. Arrow keys
          cycle through enabled options.
        </p>
        <SegmentedDemo />
      </Section>

      <Section title="Modal">
        <p className="text-xs text-slate-500">
          Native &lt;dialog&gt; wrapper. ESC closes by default; pass
          closeOnBackdrop={"{false}"} for destructive confirmations.
        </p>
        <ModalDemo />
      </Section>

      <Section title="Content doc status (§13)">
        <p className="text-xs text-slate-500">
          Per-row badge surfacing whether a page&apos;s content lives in
          WordPress or in Jab. Used inside the Pages list (see the workspace
          demo at /ui-kit/workspace). Hover for the tooltip explanation.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <ContentDocStatus value="wp-managed" />
          <ContentDocStatus value="jab-managed" />
        </div>
      </Section>

      <Section title="Fidelity report (Phase 3 visual-diff)">
        <p className="text-xs text-slate-500">
          Renders the WP-rendered original next to the AI-generated output with
          a list of matched/missed dimensions. Honest framing — "Faithful means
          structurally similar, not pixel-exact." Engineering owns the
          screenshot + diff infra; this surface owns the vocabulary the checks
          render under.
        </p>
        <FidelityReportDemo />
      </Section>

      <Section title="Design tokens review (§10 #4 confidence threshold)">
        <p className="text-xs text-slate-500">
          Surfaces the Stage 2 extraction output (colors / typography / logo /
          buttons / personality) with per-field confidence + "Why this?"
          disclosure. Three confidence tiers: ≥0.7 high (success), 0.4-0.7
          review (warning), &lt;0.4 refuse (danger). Toggle the scenarios to
          see each state — the "Pending" tile is what the user sees while the
          background worker is still running.
        </p>
        <DesignTokensDemo />
      </Section>

      <Section title="Iteration panel — WP-managed state">
        <p className="text-xs text-slate-500">
          IterationPanel rendered with ownership=&quot;wp-managed&quot;. The
          Content edit toggle is disabled with explanatory copy; the active
          flow + Jab-managed default lives in the workspace demo.
        </p>
        <IterationPanelWPDemo />
      </Section>

      <Section title="Ownership picker (§12 step 7 + §13)">
        <p className="text-xs text-slate-500">
          Per-content-type assignment. Pages default to Jab-managed; collections
          default to WP-managed. Flipping a WP-managed type with entries to
          Jab-managed fires the MigrationConfirmModal — the one-way commitment
          point. Try flipping Posts or Events to Jab-managed.
        </p>
        <OwnershipPickerDemo />
      </Section>

      <Section title="Intent picker">
        <p className="text-xs text-slate-500">
          Three-option selector (§12 step 4) plus the IntentChip used on the
          project workspace. Arrow keys cycle between options; clicking Edit on
          the chip fires the consumer callback.
        </p>
        <IntentPickerDemo />
      </Section>

      <Section title="Caveats banner">
        <p className="text-xs text-slate-500">
          &quot;What we couldn&apos;t see&quot; copy under PreviewFrame on
          /preview. Defaults shown; both items and footer are overridable for
          reuse pre-plugin-connect on the project workspace.
        </p>
        <CaveatsBanner />
      </Section>

      <Section title="Preview frame">
        <p className="text-xs text-slate-500">
          Toggle the device buttons on each frame to test the responsive
          switching. Status and chrome states render distinct content.
        </p>
        <div className="space-y-6">
          <PreviewFrame
            url="https://acme-coffee.com"
            srcDoc={KITCHEN_SINK_MOCK}
            status="live"
            caption="This is what your client will see."
            title="Live preview example"
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <PreviewFrame
              url="https://acme-coffee.com"
              status="deploying"
              title="Deploying preview example"
            />
            <PreviewFrame
              url="https://acme-coffee.com"
              status="failed"
              title="Failed preview example"
            />
          </div>
          <PreviewFrame title="Idle preview example" />
        </div>
      </Section>

      <Section title="Progress steps (generation wait)">
        <Card>
          <CardBody>
            <ProgressSteps
              steps={[
                {
                  label: "Reading your WordPress content",
                  description: "Found 14 content types",
                  status: "done",
                },
                {
                  label: "Designing your homepage",
                  description: "This is the slow step — about 60 seconds",
                  status: "current",
                },
                { label: "Building the site", status: "pending" },
                {
                  label: "Going live on your preview URL",
                  status: "pending",
                },
              ]}
            />
          </CardBody>
        </Card>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const id = sectionSlug(title);
  return (
    <section id={id} className="scroll-mt-8 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        <a
          href={`#${id}`}
          className="group inline-flex items-center gap-2 hover:text-slate-700"
        >
          {title}
          <span
            aria-hidden
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            #
          </span>
        </a>
      </h2>
      {children}
    </section>
  );
}

/**
 * Stable URL-anchor slug for each section title. Matches the in-page TOC's
 * href targets — keep both in sync by using this function on both sides.
 */
function sectionSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[()§]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Source of truth for the kitchen-sink section list. Mirrors the order of
 * the `<Section>` calls in `UiKitPage`. The TOC at the top of the page
 * iterates this; adding a new section here adds a TOC entry automatically
 * — but the corresponding `<Section title="…">` still has to be added in
 * `UiKitPage` for the anchor target to exist.
 */
const SECTION_TOC: string[] = [
  "Button",
  "Badge",
  "Status dot",
  "Field",
  "Alert",
  "Quota meter",
  "Empty state",
  "Card",
  "Stepper (onboarding)",
  "Segmented",
  "Modal",
  "Content doc status (§13)",
  "Fidelity report (Phase 3 visual-diff)",
  "Design tokens review (§10 #4 confidence threshold)",
  "Iteration panel — WP-managed state",
  "Ownership picker (§12 step 7 + §13)",
  "Intent picker",
  "Caveats banner",
  "Preview frame",
  "Progress steps (generation wait)",
];

function SectionToc() {
  return (
    <nav
      aria-label="Component sections"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Components
      </p>
      <ul className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {SECTION_TOC.map((title) => (
          <li key={title}>
            <a
              href={`#${sectionSlug(title)}`}
              className="block truncate text-slate-700 hover:text-brand-strong"
            >
              {title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DemoRouteList() {
  const routes = [
    {
      href: "/ui-kit/projects",
      label: "Projects list demo",
      note: "post-sign-in landing — toggle empty / one / many",
    },
    {
      href: "/ui-kit/workspace",
      label: "Project workspace demo",
      note: "SiteHeader + DeploymentsPanel + PreviewFrame with mock data",
    },
    {
      href: "/ui-kit/workspace/connections",
      label: "Connections page demo",
      note: "WP creds + hosting + custom-domain state machine + ownership",
    },
    {
      href: "/ui-kit/billing",
      label: "Billing page demo",
      note: "Phase 5 — toggle trial vs Studio scenarios; PlanUpgradeModal wired",
    },
    {
      href: "/pricing",
      label: "Public pricing page",
      note: "real route; numbers in lib/pricing.ts are placeholders",
    },
    {
      href: "/ui-kit/settings",
      label: "Account settings demo",
      note: "profile + password + danger zone with type-to-confirm delete",
    },
    {
      href: "/ui-kit/onboarding",
      label: "Onboarding wizard demo",
      note: "§12 steps 4 → 7 — intent / install plugin / connect / ownership",
    },
    {
      href: "/sign-up?plan=studio",
      label: "/sign-up?plan=studio",
      note: "verifies the SignInForm honors validated tier from /pricing",
    },
  ];

  return (
    <nav
      aria-label="Full-screen demo routes"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Demo routes
      </p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {routes.map((r) => (
          <li key={r.href} className="text-sm">
            <a
              href={r.href}
              className="font-medium text-brand hover:text-brand-hover"
            >
              → {r.label}
            </a>
            <p className="mt-0.5 text-xs text-slate-500">{r.note}</p>
          </li>
        ))}
      </ul>
    </nav>
  );
}
