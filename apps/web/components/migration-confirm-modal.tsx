"use client";

import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import type { WPContentType } from "./ownership-picker";

export interface MigrationConfirmModalProps {
  /** The type whose ownership is being flipped from WP-managed to Jab-managed. */
  type: WPContentType | null;
  /** Called when the user confirms. Parent owns the actual state mutation. */
  onConfirm: () => void;
  /** Called on cancel, ESC, or backdrop click. */
  onCancel: () => void;
}

/**
 * Renders when the OwnershipPicker fires `onMigrationRequired`. The flip is
 * one-way per §13 — WP's copy goes vestigial after extraction — so this is
 * the visible commitment point. Copy spells out exactly what happens; no
 * fine print, no surprise.
 *
 * `disableEscClose` is intentionally off — users should be able to bail with
 * ESC. The decision isn't destructive enough to warrant forcing an explicit
 * click; nothing has been mutated yet at this point.
 */
export function MigrationConfirmModal({
  type,
  onConfirm,
  onCancel,
}: MigrationConfirmModalProps) {
  if (!type) return null;

  const contentLower = type.pluralName.toLowerCase();

  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      title={`Move ${type.pluralName} into Jab?`}
      description="This is a one-way change. Make it deliberately."
    >
      <div className="space-y-3 text-sm text-gry">
        <p>
          We&apos;ll copy{" "}
          <span className="font-semibold text-wht">
            {type.count} {contentLower}
          </span>{" "}
          from WordPress into Jab once. After that, edits to {contentLower} happen
          in Jab — through the AI iteration loop — not in wp-admin.
        </p>
        <p>
          WordPress still has the originals, but they won&apos;t update Jab
          after this point. Going back to WP-managed is post-MVP, so plan to
          keep these {contentLower} here.
        </p>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>
          Move {type.pluralName.toLowerCase()} into Jab
        </Button>
      </ModalFooter>
    </Modal>
  );
}
