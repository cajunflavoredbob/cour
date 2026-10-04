import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { dragTargetIndex, moveItem, reconcileOrder } from "../utils/rankOrder";

type SetOrder = Dispatch<SetStateAction<number[]>>;

// A vertical span of the viewport.
type Band = { top: number; bottom: number };

// Travel before a press becomes a drag.
const DRAG_THRESHOLD_PX = 4;
// Auto-scroll zone at the ends of the visible list, and its top speed per frame.
const EDGE_PX = 48;
const MAX_SCROLL_PX = 12;

const sameOrder = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The nearest ancestor that scrolls, else the page.
const scrollerOf = (el: HTMLElement): HTMLElement => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
};

// Moves the dragged row to the slot under the pointer.
const reflow = (list: HTMLElement, id: number, y: number, setOrder: SetOrder) => {
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-reorder-id]"));
  const ids = rows.map((row) => Number(row.dataset.reorderId));
  const from = ids.indexOf(id);
  if (from === -1) return;
  const to = dragTargetIndex(rows.map((row) => row.getBoundingClientRect()), from, y);
  if (to === from) return;
  // Skips the move while the rows lag a pending render; the next move redoes it.
  setOrder((cur) => (sameOrder(cur, ids) ? moveItem(cur, from, to) : cur));
};

// Sticky or fixed elements beside the list or beside any of its ancestors.
const barsAround = (list: HTMLElement): HTMLElement[] => {
  const bars: HTMLElement[] = [];
  for (let node = list; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      const { position } = getComputedStyle(sibling);
      if (position === "sticky" || position === "fixed") bars.push(sibling);
    }
  }
  return bars;
};

// The window's safe-area insets, where an installed app's status bar and
// home indicator sit over the page.
const safeInsets = () => {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)";
  document.body.append(probe);
  const { paddingTop, paddingBottom } = getComputedStyle(probe);
  probe.remove();
  return { top: Number.parseFloat(paddingTop) || 0, bottom: Number.parseFloat(paddingBottom) || 0 };
};

// Returns a reader for where the list shows in the viewport: the scroller's
// own box, or for the page the window less its safe-area insets and any bar
// over the list's top or bottom (the submit bar on phones).
const visibleBand = (list: HTMLElement, scroller: HTMLElement): (() => Band) => {
  if (scroller !== document.scrollingElement && scroller !== document.documentElement) {
    return () => scroller.getBoundingClientRect();
  }
  const bars = barsAround(list);
  const insets = safeInsets();
  return () => {
    const mid = window.innerHeight / 2;
    const { left, right } = list.getBoundingClientRect();
    let top = insets.top;
    let bottom = window.innerHeight - insets.bottom;
    for (const bar of bars) {
      const r = bar.getBoundingClientRect();
      if (!r.height || r.right <= left || r.left >= right) continue;
      if (r.bottom <= mid) top = Math.max(top, r.bottom);
      else if (r.top >= mid) bottom = Math.min(bottom, r.top);
    }
    return { top, bottom };
  };
};

// Pixels to scroll this frame toward the end of `band` the pointer is
// pushing against (it must have moved toward that end since the press),
// else 0.
const autoScrollStep = ({ top, bottom }: Band, y: number, startY: number): number => {
  let push = 0;
  if (y < startY && y < top + EDGE_PX) push = -(top + EDGE_PX - y);
  else if (y > startY && y > bottom - EDGE_PX) push = y - (bottom - EDGE_PX);
  if (push === 0) return 0;
  const speed = Math.round((Math.min(EDGE_PX, Math.abs(push)) / EDGE_PX) * MAX_SCROLL_PX);
  return Math.sign(push) * Math.max(1, speed);
};

/**
 * Pointer drag-to-reorder for the list on `listRef`, whose rows carry
 * `data-reorder-id`. A mouse drags from anywhere in a row; touch and pen drag
 * from `[data-drag-handle]` only. `[data-no-drag]` controls never start a
 * drag. The pointer is tracked on the window and a release anywhere ends the
 * drag. Escape restores the order from before the drag. While a row is
 * dragged, `<html>` carries `data-reordering`, which main.css keys the
 * grabbing cursor and the scroll-anchoring opt-out off. A drag whose list
 * leaves the page (a layout switch) ends.
 */
export const useDragReorder = (order: number[], setOrder: SetOrder) => {
  const listRef = useRef<HTMLUListElement>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, id: number) => {
    const list = listRef.current;
    const target = e.target as Element;
    if (e.button !== 0 || !list || stopRef.current || target.closest("[data-no-drag]")) return;
    const touchLike = e.pointerType === "touch" || e.pointerType === "pen";
    if (touchLike && !target.closest("[data-drag-handle]")) return;
    // No text selection or native image drag.
    e.preventDefault();

    const { pointerId, clientX: startX, clientY: startY } = e;
    const before = order;
    const scroller = scrollerOf(list);
    let band: () => Band;
    let lastY = startY;
    let dragging = false;
    let frame = 0;

    const tick = () => {
      if (!list.isConnected) return stop();
      const step = autoScrollStep(band(), lastY, startY);
      if (step !== 0) scroller.scrollTop += step;
      frame = requestAnimationFrame(tick);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // Ends the drag if the button came up where no pointerup reached the page.
      if (!touchLike && ev.buttons === 0) return stop();
      if (!list.isConnected) return stop();
      lastY = ev.clientY;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        setDraggingId(id);
        document.documentElement.setAttribute("data-reordering", "");
        window.getSelection()?.removeAllRanges();
        band = visibleBand(list, scroller);
        frame = requestAnimationFrame(tick);
      }
      reflow(list, id, lastY, setOrder);
    };
    const onScroll = () => {
      if (!list.isConnected) return stop();
      if (dragging) reflow(list, id, lastY, setOrder);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (dragging) setOrder((cur) => reconcileOrder(before, cur));
      stop();
    };
    const listeners = [
      ["pointermove", onMove],
      ["pointerup", onUp],
      ["pointercancel", onUp],
      ["keydown", onKey],
      ["scroll", onScroll],
    ] as const;
    const stop = () => {
      for (const [type, fn] of listeners) window.removeEventListener(type, fn as EventListener, true);
      window.removeEventListener("blur", stop);
      cancelAnimationFrame(frame);
      document.documentElement.removeAttribute("data-reordering");
      stopRef.current = null;
      if (dragging) setDraggingId(null);
      dragging = false;
    };

    for (const [type, fn] of listeners) window.addEventListener(type, fn as EventListener, true);
    window.addEventListener("blur", stop);
    stopRef.current = stop;
  };

  return { listRef, draggingId, onPointerDown };
};
