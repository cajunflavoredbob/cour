// Back inside cour. Every step away from home holds one history entry, so
// the browser's or the phone's Back closes a step instead of leaving the
// app. Screens (the deck, the review peek, the re-rank editor) sit under
// overlays (dialogs, the details sheet, the account menu): Back closes the
// top overlay first, then the newest screen. A step closed inside the app
// takes an entry back off.
//
// Entries are interchangeable: each carries only its height above the page's
// own entry (courDepth), so Back closes as many steps as it went entries
// down, whichever entries the app removed before.

/** Overlays close before the screens under them. */
export type StepLayer = "screen" | "overlay";

interface Step {
  id: number;
  layer: StepLayer;
  /** Returns false to refuse (the step stays, and keeps an entry). */
  onBack: () => unknown;
}

let steps: Step[] = [];
let lastId = 0;
// Our entries above the page's own.
let depth = 0;
// Traversals we started ourselves, whose popstate is not a Back.
let ownTraversals = 0;
let settling: ReturnType<typeof setTimeout> | undefined;
// The URL the app last chose; every entry Back lands on takes it.
let appHref: string | undefined;
// Pushes wait while a reload's leftover entries come off.
let clearing = false;
let waitingPushes = 0;

const depthOf = (state: unknown): number => {
  const d = (state as { courDepth?: unknown } | null)?.courDepth;
  return typeof d === "number" && d > 0 ? d : 0;
};

const push = () => {
  if (clearing) {
    waitingPushes += 1;
    return;
  }
  history.pushState({ courDepth: depth }, document.title);
};

const finishClearing = () => {
  if (!clearing) return;
  clearing = false;
  const pushes = waitingPushes;
  waitingPushes = 0;
  // Re-number from the page's own entry: the steps opened meanwhile.
  for (let d = depth - pushes + 1; d <= depth; d += 1) {
    history.pushState({ courDepth: d }, document.title);
  }
};

/** Rewrites the current entry's URL, keeping its step marker. */
export const replaceUrl = (href: string) => {
  appHref = href;
  history.replaceState(history.state ?? null, document.title, href);
};

// Entries left over by steps the app closed itself come off in one
// traversal, once the closing settles.
const settle = () => {
  settling = undefined;
  const extra = depth - steps.length;
  if (extra <= 0) return;
  depth = steps.length;
  if (clearing) {
    // Their entries were never pushed.
    waitingPushes = Math.max(0, waitingPushes - extra);
    return;
  }
  ownTraversals += 1;
  history.go(-extra);
};

// The step Back closes next: the top overlay, else the newest screen.
const topStep = (): Step | undefined => {
  const overlays = steps.filter((s) => s.layer === "overlay");
  const pool = overlays.length > 0 ? overlays : steps;
  return pool.reduce<Step | undefined>((top, s) => (top === undefined || s.id > top.id ? s : top), undefined);
};

const onPopState = (e: PopStateEvent) => {
  if (appHref !== undefined) history.replaceState(history.state ?? null, document.title, appHref);
  if (ownTraversals > 0) {
    ownTraversals -= 1;
    finishClearing();
    return;
  }
  const landed = depthOf(e.state);
  if (landed > depth) {
    // Forward onto an entry no open step holds: step back off it.
    ownTraversals += 1;
    history.go(depth - landed);
    return;
  }
  // Back (or a jump back several entries): that many steps close, top first.
  let closing = depth - landed;
  depth = landed;
  while (closing > 0) {
    closing -= 1;
    const step = topStep();
    if (!step) break;
    steps = steps.filter((s) => s !== step);
    if (step.onBack() === false) {
      // Refused (a ceremony is running): it stays open, with a new entry.
      steps.push(step);
      depth += 1;
      push();
    }
  }
};

if (typeof window !== "undefined") {
  // cour restores its own scroll (the review's ledger, the standings' top);
  // the browser's restore on these traversals would undo it.
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", onPopState);
  // A reload on a step's entry leaves the old session's entries above the
  // page's own; take them off before this session's steps go on.
  const stale = depthOf(history.state);
  if (stale > 0) {
    clearing = true;
    ownTraversals += 1;
    history.go(-stale);
    // A traversal that never reports (a browser quirk) must not hold the
    // pushes back for good.
    setTimeout(() => {
      if (!clearing) return;
      ownTraversals = Math.max(0, ownTraversals - 1);
      finishClearing();
    }, 1000);
  }
}

/** Opens a step: Back now calls `onBack`. Returns the close for the app's own exit. */
export const openStep = (onBack: () => unknown, layer: StepLayer = "screen"): (() => void) => {
  lastId += 1;
  const step: Step = { id: lastId, layer, onBack };
  steps.push(step);
  depth += 1;
  push();
  return () => {
    if (!steps.includes(step)) return;
    steps = steps.filter((s) => s !== step);
    if (settling === undefined) settling = setTimeout(settle, 0);
  };
};
