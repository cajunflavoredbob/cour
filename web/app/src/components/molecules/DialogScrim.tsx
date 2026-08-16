import { type ReactNode, useEffect, useRef } from "react";

interface DialogScrimProps {
  /** Accessible name for the alertdialog. */
  label: string;
  /** Called on Escape and on backdrop click -- the "Not yet" path. */
  onDismiss: () => void;
  backdropClassName: string;
  dialogClassName: string;
  children: ReactNode;
}

/**
 * Shared modal scrim for the lock-in and submit confirmations (audit
 * 17): both dialogs ignored Escape and backdrop clicks and never took
 * focus, so keyboard and AT users were stranded behind them. Focus
 * lands on the dialog when it opens and is pulled back if it escapes
 * (a light containment -- the dialogs are two controls, a full trap
 * ring adds nothing).
 */
export const DialogScrim = ({
  label,
  onDismiss,
  backdropClassName,
  dialogClassName,
  children,
}: DialogScrimProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);

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
    </div>
  );
};
