"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import {
  OwnershipPicker,
  type OwnershipMode,
  type WPContentType,
} from "@/components/ownership-picker";
import { MigrationConfirmModal } from "@/components/migration-confirm-modal";

/**
 * Kitchen-sink interactives. Three demos colocated because they share the
 * same client-mode + state shape:
 *   - OwnershipPickerDemo wires OwnershipPicker + MigrationConfirmModal end-to-end.
 *   - ModalDemo exercises the base Modal primitive in isolation.
 *   - SegmentedDemo shows the segmented control standalone.
 */

const MOCK_TYPES: WPContentType[] = [
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
    kindLabel: "Blog post type",
    count: 42,
    recommendedMode: "wp-managed",
  },
  {
    slug: "event",
    pluralName: "Events",
    kindLabel: "Custom post type",
    count: 12,
    recommendedMode: "wp-managed",
  },
  {
    slug: "product",
    pluralName: "Products",
    kindLabel: "Custom post type",
    count: 25,
    recommendedMode: "wp-managed",
  },
  {
    slug: "team_member",
    pluralName: "Team Members",
    kindLabel: "Custom post type",
    count: 5,
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

const INITIAL_OWNERSHIP: Record<string, OwnershipMode> = Object.fromEntries(
  MOCK_TYPES.map((t) => [t.slug, t.recommendedMode]),
);

export function OwnershipPickerDemo() {
  const [ownership, setOwnership] = useState(INITIAL_OWNERSHIP);
  const [pendingMigration, setPendingMigration] = useState<{
    type: WPContentType;
    confirm: () => void;
  } | null>(null);

  function handleChange(slug: string, next: OwnershipMode) {
    setOwnership((prev) => ({ ...prev, [slug]: next }));
  }

  function handleMigrationRequired(
    type: WPContentType,
    confirm: () => void,
  ) {
    setPendingMigration({ type, confirm });
  }

  function handleConfirm() {
    pendingMigration?.confirm();
    setPendingMigration(null);
  }

  return (
    <div className="space-y-3">
      <OwnershipPicker
        types={MOCK_TYPES}
        value={ownership}
        onChange={handleChange}
        onMigrationRequired={handleMigrationRequired}
      />
      <MigrationConfirmModal
        type={pendingMigration?.type ?? null}
        onConfirm={handleConfirm}
        onCancel={() => setPendingMigration(null)}
      />
      <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-700">
          Current ownership state (debug)
        </summary>
        <pre className="mt-2 overflow-x-auto text-[11px] text-slate-700">
          {JSON.stringify(ownership, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function ModalDemo() {
  const [openSimple, setOpenSimple] = useState(false);
  const [openNoBackdrop, setOpenNoBackdrop] = useState(false);

  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="secondary" onClick={() => setOpenSimple(true)}>
        Open simple modal
      </Button>
      <Modal
        isOpen={openSimple}
        onClose={() => setOpenSimple(false)}
        title="Confirm something"
        description="Close with ESC, backdrop click, or the Cancel button."
      >
        <p className="text-sm text-slate-700">
          Modal bodies can contain anything — copy, forms, lists. The footer is
          a slot; place primary actions on the right.
        </p>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setOpenSimple(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpenSimple(false)}>Confirm</Button>
        </ModalFooter>
      </Modal>

      <Button variant="secondary" onClick={() => setOpenNoBackdrop(true)}>
        Open destructive modal (no backdrop dismiss)
      </Button>
      <Modal
        isOpen={openNoBackdrop}
        onClose={() => setOpenNoBackdrop(false)}
        title="Hold up"
        description="Backdrop click won't close this — explicit choice required."
        closeOnBackdrop={false}
      >
        <p className="text-sm text-slate-700">
          Use this variant for confirmations where an accidental click should
          not dismiss the choice.
        </p>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setOpenNoBackdrop(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => setOpenNoBackdrop(false)}>
            Delete
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}

export function SegmentedDemo() {
  const [pair, setPair] = useState<"wp" | "jab">("jab");
  const [tri, setTri] = useState<"desktop" | "tablet" | "mobile">("desktop");

  return (
    <div className="flex flex-wrap items-center gap-6">
      <Segmented
        value={pair}
        onChange={setPair}
        ariaLabel="Content source"
        options={[
          { value: "wp", label: "WP-managed" },
          { value: "jab", label: "Jab-managed" },
        ]}
      />
      <Segmented
        value={tri}
        onChange={setTri}
        size="sm"
        ariaLabel="Device size"
        options={[
          { value: "desktop", label: "Desktop" },
          { value: "tablet", label: "Tablet" },
          { value: "mobile", label: "Mobile" },
        ]}
      />
    </div>
  );
}
