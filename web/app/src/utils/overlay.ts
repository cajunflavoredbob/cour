// What a screen checks before it moves focus on its own.

/** A dialog or the account menu covers the screen. */
export const overlayOpen = (): boolean =>
  document.querySelector('[aria-modal="true"], [role="menu"]') != null;

/** Focus went with an element that left the page. */
export const focusLost = (): boolean =>
  document.activeElement == null || document.activeElement === document.body;

/**
 * Swallows the second press of a double-click on a control that just
 * changed the screen: it would land on whatever replaced the control.
 * Its mousedown too, so it moves no focus. 900ms covers the slowest
 * double-click setting systems offer.
 */
export const swallowSecondClick = () => {
  const swallow = (e: MouseEvent) => {
    if (e.detail < 2) return;
    e.stopPropagation();
    e.preventDefault();
  };
  for (const type of ["mousedown", "click"] as const) document.addEventListener(type, swallow, true);
  setTimeout(() => {
    for (const type of ["mousedown", "click"] as const) document.removeEventListener(type, swallow, true);
  }, 900);
};
