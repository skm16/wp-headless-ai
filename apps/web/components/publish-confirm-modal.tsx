"use client";

import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";

export interface PublishConfirmModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Where the deployment will live after publish. Shown verbatim in the modal. */
  productionUrl: string;
  /** Optional label for what's being published, e.g. "the latest preview" or "/blog". */
  what?: string;
}

/**
 * §10 #9 "publish guard" — confirmation before promoting a preview to
 * production. Production replacement is what the agency's client actually
 * sees, so the modal makes the destination URL visible and emphasizes that
 * the prior version stays in history (so this isn't a one-way action).
 *
 * disableEscClose stays off — nothing is destructive enough to require an
 * explicit click; ESC bails gracefully.
 */
export function PublishConfirmModal({
  isOpen,
  onCancel,
  onConfirm,
  productionUrl,
  what = "this version",
}: PublishConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Publish to production?"
    >
      <div className="space-y-3 text-sm text-gry">
        <p>
          Publishing {what} will replace what your client sees at:
        </p>
        <p className="break-all rounded-md bg-surf px-3 py-2 font-mono text-xs text-gry">
          {productionUrl}
        </p>
        <p>
          The current production version stays in your activity history — you
          can always promote it back later.
        </p>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Publish to production</Button>
      </ModalFooter>
    </Modal>
  );
}
