"use client";

import Link from "next/link";
import { formatRelative } from "@/lib/format-relative";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { SiteUrlBar } from "@/components/site-url-bar";
import {
  CustomDomainCard,
  type CustomDomainState,
} from "@/components/custom-domain-card";

export type WordPressConnectionStatus = "active" | "needs-refresh" | "failing";

export interface WordPressConnectionState {
  url: string;
  username: string;
  lastVerifiedAt: Date;
  status: WordPressConnectionStatus;
  /** Human copy when status is not active — shown inline. */
  message?: string;
}

export interface OwnershipSummary {
  totalTypes: number;
  wpManagedCount: number;
  jabManagedCount: number;
  /** When the assignment was last edited. */
  updatedAt?: Date;
}

export interface ConnectionsViewProps {
  wordpress: WordPressConnectionState;
  /** Default Jab-hosted URL (`client.jabwp.app/{slug}/`). */
  hostedUrl: string;
  /** The Jab-side host the customer's CNAME / A record should resolve to. */
  customDomainTarget: string;
  customDomain: CustomDomainState;
  ownership: OwnershipSummary;
  onRefreshWordPress: () => void;
  /** True while the refresh probe is in-flight. */
  refreshing?: boolean;
  onAddCustomDomain: (domain: string) => void;
  onCheckDomainStatus: () => void;
  onRemoveCustomDomain: () => void;
  /** True while any custom-domain server call is in-flight. */
  domainPending?: boolean;
  /** Opens the OwnershipPicker — usually a modal in the parent. */
  onEditOwnership: () => void;
  /** Route to the billing page. Phase 5. */
  billingHref?: string;
}

/**
 * §4 Phase 2 deliverable 2E + §13. Post-onboarding settings surface that
 * holds the cross-cutting "where does this project connect to the world"
 * concerns: WordPress credentials, hosted URL, custom domain, and the
 * per-type content-ownership assignment.
 *
 * Single-column on small screens; on `lg+` the WordPress + Hosting cards
 * sit side-by-side and the ownership + billing cards stack underneath.
 * Avoids the dashboard-tile look — these aren't metrics, they're settings.
 */
export function ConnectionsView({
  wordpress,
  hostedUrl,
  customDomainTarget,
  customDomain,
  ownership,
  onRefreshWordPress,
  refreshing = false,
  onAddCustomDomain,
  onCheckDomainStatus,
  onRemoveCustomDomain,
  domainPending = false,
  onEditOwnership,
  billingHref = "/billing",
}: ConnectionsViewProps) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-wht">Connections</h1>
        <p className="mt-1 text-sm text-gry">
          How this project connects to WordPress, your hosting, and where its
          content lives.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <WordPressCard
          state={wordpress}
          onRefresh={onRefreshWordPress}
          refreshing={refreshing}
        />
        <HostingCard
          hostedUrl={hostedUrl}
          customDomain={customDomain}
          customDomainTarget={customDomainTarget}
          onAddCustomDomain={onAddCustomDomain}
          onCheckDomainStatus={onCheckDomainStatus}
          onRemoveCustomDomain={onRemoveCustomDomain}
          domainPending={domainPending}
        />
      </div>

      <OwnershipCard ownership={ownership} onEdit={onEditOwnership} />

      <BillingCard billingHref={billingHref} />
    </div>
  );
}

function WordPressCard({
  state,
  onRefresh,
  refreshing,
}: {
  state: WordPressConnectionState;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const tone =
    state.status === "active"
      ? "success"
      : state.status === "needs-refresh"
        ? "warning"
        : "danger";
  const label =
    state.status === "active"
      ? "Connected"
      : state.status === "needs-refresh"
        ? "Needs refresh"
        : "Connection failing";

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>WordPress</CardTitle>
          <p className="mt-1 text-xs text-gry-d">
            The source of truth for WP-managed content.
          </p>
        </div>
        <Badge tone={tone}>
          <StatusDot tone={tone} pulse={state.status === "needs-refresh"} />
          {label}
        </Badge>
      </CardHeader>
      <CardBody className="space-y-4">
        {state.status !== "active" && state.message && (
          <Alert tone={tone}>{state.message}</Alert>
        )}

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-xs font-medium uppercase tracking-wider text-gry-d">
            Site URL
          </dt>
          <dd className="min-w-0 truncate font-mono text-gry">
            {state.url}
          </dd>

          <dt className="text-xs font-medium uppercase tracking-wider text-gry-d">
            User
          </dt>
          <dd className="min-w-0 truncate font-mono text-gry">
            {state.username}
          </dd>

          <dt className="text-xs font-medium uppercase tracking-wider text-gry-d">
            Last verified
          </dt>
          <dd className="text-gry">
            {formatRelative(state.lastVerifiedAt)}
          </dd>
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-bord pt-3">
          <p className="text-xs text-gry-d">
            Re-runs the WordPress probe with your saved app password.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            loading={refreshing}
            loadingText="Refreshing…"
          >
            Refresh credentials
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function HostingCard({
  hostedUrl,
  customDomain,
  customDomainTarget,
  onAddCustomDomain,
  onCheckDomainStatus,
  onRemoveCustomDomain,
  domainPending,
}: {
  hostedUrl: string;
  customDomain: CustomDomainState;
  customDomainTarget: string;
  onAddCustomDomain: (domain: string) => void;
  onCheckDomainStatus: () => void;
  onRemoveCustomDomain: () => void;
  domainPending: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hosting</CardTitle>
        <p className="mt-1 text-xs text-gry-d">
          Where your published site is served from.
        </p>
      </CardHeader>
      <CardBody className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-gry-d">
            Default URL
          </p>
          <SiteUrlBar url={hostedUrl} label="Hosted at" />
          <p className="text-xs text-gry-d">
            Path-based URLs work for previews and internal review, but most
            agencies want a custom domain before client hand-off.
          </p>
        </div>

        <div className="border-t border-bord pt-4">
          <CustomDomainCard
            state={customDomain}
            targetHost={customDomainTarget}
            onAddDomain={onAddCustomDomain}
            onCheckStatus={onCheckDomainStatus}
            onRemove={onRemoveCustomDomain}
            pending={domainPending}
          />
        </div>
      </CardBody>
    </Card>
  );
}

function OwnershipCard({
  ownership,
  onEdit,
}: {
  ownership: OwnershipSummary;
  onEdit: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Content ownership</CardTitle>
          <p className="mt-1 text-xs text-gry-d">
            Which content lives in WordPress vs in Jab. Set during onboarding;
            edits here are one-way for WP-managed types (see migration warning
            on the picker).
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit ownership →
        </Button>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-3 gap-4 text-center sm:grid-cols-3">
          <OwnershipStat
            label="WP-managed"
            count={ownership.wpManagedCount}
            tone="info"
          />
          <OwnershipStat
            label="Jab-managed"
            count={ownership.jabManagedCount}
            tone="brand"
          />
          <OwnershipStat
            label="Total types"
            count={ownership.totalTypes}
            tone="neutral"
          />
        </div>
        {ownership.updatedAt && (
          <p className="mt-4 text-center text-xs text-gry-d">
            Last edited {formatRelative(ownership.updatedAt)}.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function OwnershipStat({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "info" | "brand" | "neutral";
}) {
  const toneStyles: Record<typeof tone, string> = {
    info: "bg-blue/10 text-blue",
    brand: "bg-teal/10 text-teal",
    neutral: "bg-elev text-gry",
  };
  return (
    <div className={`rounded-lg px-3 py-3 ${toneStyles[tone]}`}>
      <p className="text-2xl font-bold tabular-nums">{count}</p>
      <p className="mt-0.5 text-xs font-medium">{label}</p>
    </div>
  );
}

function BillingCard({ billingHref }: { billingHref: string }) {
  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Billing</CardTitle>
          <p className="mt-1 text-xs text-gry-d">
            Account-level — plan, usage, payment method, and invoices.
          </p>
        </div>
        <Link href={billingHref}>
          <Button variant="secondary" size="sm">
            Manage billing →
          </Button>
        </Link>
      </CardHeader>
    </Card>
  );
}
