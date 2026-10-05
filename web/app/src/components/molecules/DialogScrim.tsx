import { type ReactNode, useEffect, useRef, useState } from "react";

interface DialogScrimProps {
  /** Accessible name for the dialog. */
  label: string;
  /** A confirmation that needs an answer (the default), or plain content. */
  alert?: boolean;
  /** Called on Escape and on backdrop click -- the "Not yet" path. */
  onDismiss: () => void;
  backdropClassName: string;
  dialogClassName: string;
  children: ReactNode;
}

/**
 * Shared modal scrim: the one-shot confirmations (an alertdialog) and the
 * content dialogs (details, sharing, the tutorial). Escape and a backdrop
 * click dismiss it. Focus lands on the dialog when it opens and is pulled
 * back if it escapes, a light containment rather than a full trap.
 */
export const DialogScrim = ({
  label,
  alert = true,
  onDismiss,
  backdropClassName,
  dialogClassName,
  children,
}: DialogScrimProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus goes back where it was when the dialog closes. Read on the first
  // render, before an autoFocus inside the dialog commits.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      // Still on the page: a StrictMode re-run, not a close.
      if (dialog?.isConnected) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Child effects and autoFocus commit BEFORE this parent effect runs:
    // a dialog whose content autofocuses its own control (the share-link
    // input) must keep that focus, not have the container steal it back.
    // Only claim focus when nothing inside the dialog holds it yet.
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (dialog && !dialog.contains(e.target as Node)) dialog.focus();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [onDismiss]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape (handled above) is the keyboard path; the backdrop click is a pointer affordance only.
    // biome-ignore lint/a11y/noStaticElementInteractions: same rationale -- the scrim is decorative click-catching chrome, not a control; the dialog inside carries the semantics.
    <div
      className={backdropClassName}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      data-test-handle="dialog-backdrop"
    >
      {alert ? (
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="alertdialog"
          aria-modal="true"
          aria-label={label}
          className={dialogClassName}
        >
          {children}
        </div>
      ) : (
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className={dialogClassName}
        >
          {children}
        </div>
      )}
    </div>
  );
};
