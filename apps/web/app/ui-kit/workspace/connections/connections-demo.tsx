"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import {
  ConnectionsView,
  type WordPressConnectionState,
  type OwnershipSummary,
} from "@/components/connections-view";
import type { CustomDomainState } from "@/components/custom-domain-card";
import {
  OwnershipPicker,
  type OwnershipMode,
  type WPContentType,
} from "@/components/ownership-picker";
import { MigrationConfirmModal } from "@/components/migration-confirm-modal";
import { IntentChip } from "@/components/intent-picker";

const HOSTED_URL = "https://client.jabwp.app/acme-coffee/";
const CUSTOM_DOMAIN_TARGET = "client.jabwp.app";

const INITIAL_TYPES: WPContentType[] = [
  {
    slug: "page",
    pluralName: "Pages",
    kindLabel: "Page post type",
    count: 8,
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
    kindLabel: "Custom post type",
    count: 6,
    recommendedMode: "wp-managed",
  },
  {
    slug: "category",
    pluralName: "Categories",
    kindLabel: "Taxonomy",
    count: 12,
    recommendedMode: "wp-managed",
  },
];

const INITIAL_ASSIGNMENT: Record<string, OwnershipMode> = {
  page: "jab-managed",
  post: "wp-managed",
  event: "wp-managed",
  team_member: "wp-managed",
  category: "wp-managed",
};

export function ConnectionsDemo() {
  const [wordpress, setWordpress] = useState<WordPressConnectionState>({
    url: "https://acmecoffee.wp",
    username: "agency@labelinteractive.com",
    lastVerifiedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    status: "active",
  });
  const [refreshing, setRefreshing] = useState(false);

  const [customDomain, setCustomDomain] = useState<CustomDomainState>({
    status: "none",
  });
  const [domainPending, setDomainPending] = useState(false);

  const [assignment, setAssignment] =
    useState<Record<string, OwnershipMode>>(INITIAL_ASSIGNMENT);
  const [ownershipUpdatedAt, setOwnershipUpdatedAt] = useState<Date | undefined>(
    new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  );
  const [ownershipOpen, setOwnershipOpen] = useState(false);
  const [pendingMigration, setPendingMigration] = useState<{
    type: WPContentType;
    confirm: () => void;
  } | null>(null);

  const wpManagedCount = Object.values(assignment).filter(
    (v) => v === "wp-managed",
  ).length;
  const jabManagedCount = Object.values(assignment).filter(
    (v) => v === "jab-managed",
  ).length;
  const ownership: OwnershipSummary = {
    totalTypes: INITIAL_TYPES.length,
    wpManagedCount,
    jabManagedCount,
    updatedAt: ownershipUpdatedAt,
  };

  function handleRefreshWordPress() {
    setRefreshing(true);
    setTimeout(() => {
      setWordpress((prev) => ({ ...prev, lastVerifiedAt: new Date() }));
      setRefreshing(false);
    }, 1200);
  }

  function handleAddCustomDomain(domain: string) {
    setDomainPending(true);
    setTimeout(() => {
      setCustomDomain({
        status: "pending-dns",
        domain,
        lastCheckedAt: new Date(),
      });
      setDomainPending(false);
    }, 900);
  }

  function handleCheckDomainStatus() {
    setDomainPending(true);
    // Cycles the mock through pending → verified → active so the demo
    // exercises every state without needing real DNS.
    setTimeout(() => {
      setCustomDomain((prev) => {
        if (prev.status === "pending-dns") {
          return { ...prev, status: "verified", lastCheckedAt: new Date() };
        }
        if (prev.status === "verified") {
          return { ...prev, status: "active", lastCheckedAt: new Date() };
        }
        return { ...prev, lastCheckedAt: new Date() };
      });
      setDomainPending(false);
    }, 900);
  }

  function handleRemoveCustomDomain() {
    setCustomDomain({ status: "none" });
  }

  function handleOwnershipChange(slug: string, next: OwnershipMode) {
    setAssignment((prev) => ({ ...prev, [slug]: next }));
    setOwnershipUpdatedAt(new Date());
  }

  function handleMigrationRequired(
    type: WPContentType,
    confirm: () => void,
  ) {
    setPendingMigration({ type, confirm });
  }

  return (
    <WorkspaceShell
      navItems={[
        { label: "Overview", href: "/ui-kit/workspace" },
        {
          label: "Connections",
          href: "/ui-kit/workspace/connections",
          active: true,
        },
        { label: "Settings", href: "#" },
      ]}
      headerLeft={
        <>
          <Link
            href="/ui-kit/workspace"
            className="truncate text-base font-semibold text-slate-900 hover:text-brand"
          >
            Acme Coffee
          </Link>
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
      <ConnectionsView
        wordpress={wordpress}
        hostedUrl={HOSTED_URL}
        customDomainTarget={CUSTOM_DOMAIN_TARGET}
        customDomain={customDomain}
        ownership={ownership}
        onRefreshWordPress={handleRefreshWordPress}
        refreshing={refreshing}
        onAddCustomDomain={handleAddCustomDomain}
        onCheckDomainStatus={handleCheckDomainStatus}
        onRemoveCustomDomain={handleRemoveCustomDomain}
        domainPending={domainPending}
        onEditOwnership={() => setOwnershipOpen(true)}
        billingHref="#"
      />

      <Modal
        isOpen={ownershipOpen}
        onClose={() => setOwnershipOpen(false)}
        title="Edit content ownership"
        description="Per-content-type source of truth. WP → Jab flips a type to a Jab-managed copy and is one-way."
        size="xl"
      >
        <OwnershipPicker
          types={INITIAL_TYPES}
          value={assignment}
          onChange={handleOwnershipChange}
          onMigrationRequired={handleMigrationRequired}
        />
        <ModalFooter>
          <Button variant="ghost" onClick={() => setOwnershipOpen(false)}>
            Close
          </Button>
        </ModalFooter>
      </Modal>

      <MigrationConfirmModal
        type={pendingMigration?.type ?? null}
        onCancel={() => setPendingMigration(null)}
        onConfirm={() => {
          pendingMigration?.confirm();
          setPendingMigration(null);
        }}
      />
    </WorkspaceShell>
  );
}
