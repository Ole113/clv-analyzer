"use client";

import { useEffect, useRef } from "react";

/**
 * An in-page dialog, used everywhere the app used to call window.confirm().
 *
 * The native dialog cannot be styled, says "localhost:4319 says", and blocks the whole renderer;
 * this reads as part of the app and keeps the page interactive underneath.
 */
export function Modal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the confirm button so the dialog is operable from the keyboard immediately, and so
    // Escape/Enter land somewhere sensible rather than on whatever was focused before.
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Without this a drag that ends on the scrim would close the dialog mid-interaction.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">{title}</h3>
        {body && <div className="modal-body">{body}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
