"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: "sm" | "md" | "lg" | "xl";
  /** Set to false to prevent backdrop click from closing. Defaults to true. */
  closeOnBackdrop?: boolean;
  /** Disables ESC-to-close. Use only for confirmations that need an explicit choice. */
  disableEscClose?: boolean;
  children: React.ReactNode;
  className?: string;
}

const sizes: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

/**
 * Modal built on the native <dialog> element. The dialog IS the card — we
 * don't wrap it in a positioning container, because `showModal()` already
 * places the element in the top layer and centers it. Fighting that with
 * `fixed inset-0` produces visible clipping at the top edge on some browsers.
 *
 * Backdrop clicks: detected by comparing click coordinates against the
 * dialog's bounding rect. Clicks inside the rect = on the card; clicks
 * outside = on the ::backdrop. More reliable than the e.target === e.currentTarget
 * trick when the dialog is the card.
 *
 * ESC key is handled natively via the `cancel` event (suppressed when
 * disableEscClose is set).
 */
export function Modal({
  isOpen,
  onClose,
  title,
  description,
  size = "md",
  closeOnBackdrop = true,
  disableEscClose = false,
  children,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      if (disableEscClose) {
        e.preventDefault();
        return;
      }
      onClose();
    }
    // NB: deliberately no listener on the native `close` event. ESC closes
    // are handled via `cancel` above; backdrop clicks via handleDialogClick;
    // explicit button clicks via the consumer's own handlers. Listening to
    // `close` here caused a re-entrancy with the open useEffect — fired again
    // after our own dialog.close() and reopened on the next render. The
    // dialog's open state is now driven only by the `isOpen` prop.
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [disableEscClose, onClose]);

  function handleDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (!closeOnBackdrop) return;
    const dialog = e.currentTarget;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClick={handleDialogClick}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        // The dialog IS the card. Reset browser default chrome (padding,
        // borders) and let showModal() handle positioning + top-layer.
        "w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-0 shadow-xl",
        "max-h-[calc(100vh-2rem)] overflow-hidden",
        "backdrop:bg-slate-900/50 backdrop:backdrop-blur-sm",
        sizes[size],
        className,
      )}
    >
      {(title || description) && (
        <div className="border-b border-slate-200 px-6 py-4">
          {title && (
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
          )}
          {description && (
            <p id={descriptionId} className="mt-1 text-sm text-slate-600">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
    </dialog>
  );
}

export interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export function ModalFooter({ className, children, ...rest }: ModalFooterProps) {
  return (
    <div
      className={cn(
        "-mx-6 -mb-5 mt-5 flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/50 px-6 py-3",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
