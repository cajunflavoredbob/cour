// What a screen checks before it moves focus on its own.

/** A dialog or the account menu covers the screen. */
export const overlayOpen = (): boolean =>
  document.querySelector('[aria-modal="true"], [role="menu"]') != null;

/** Focus went with an element that left the page. */
export const focusLost = (): boolean =>
  document.activeElement == null || document.activeElement === document.body;
