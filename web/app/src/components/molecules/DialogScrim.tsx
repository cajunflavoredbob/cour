import { type ReactNode, useEffect, useRef, useState } from "react";
import { useBackStep } from "../../hooks/useBackStep";

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

// What Tab can reach inside a dialog.
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal scrim: the one-shot confirmations (an alertdialog) and the
 * content dialogs (details, sharing, the tutorial). Escape and a backdrop
 * click dismiss it. Focus lands on the dialog when it opens, Tab and
 * Shift+Tab cycle its controls, and focus that escapes is pulled back.
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
  // Back closes the dialog, the same path as Escape.
  useBackStep(true, onDismiss, "overlay");

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
      if (e.key !== "Tab" || !dialog) return;
      // Past the last control to the first, and back from the first (or
      // the dialog itself) to the last, so focus never leaves the dialog.
      const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
      } else if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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
        // The second click of a double-click on the control that opened
        // the dialog lands here; it does not close it.
        if (e.target === e.currentTarget && !(e.detail > 1)) onDismiss();
      }}
      data-test-handle="dialog-backdrop"
    >
      {/* Two literal roles, not role={...}: biome's aria rule cannot see
          that aria-modal suits both. Keep the two elements alike. */}
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
