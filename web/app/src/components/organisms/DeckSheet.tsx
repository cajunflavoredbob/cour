import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Media, VerdictValue } from "../../../../../types/reely";
import { DeckDetails } from "./DeckDetails";
import { VerdictRow } from "../molecules/VerdictRow";
import { useEscape } from "../../hooks/useEscape";
import styles from "./DeckSheet.module.css";

interface DeckSheetProps {
  media: Media;
  /** Titles still unverdicted (for the verdict row's skip-all copy). */
  remaining: number;
  /** Forwarded to the verdict row; scoped re-review passes disable
   * hold-to-skip-all. */
  allowSkipAll?: boolean;
  /** Forwarded to the verdict row: the existing verdict to halo. */
  currentVerdict?: VerdictValue;
}

// Pointer travel below this is a tap (toggle), not a drag.
const TAP_SLOP_PX = 8;
// Fraction of the panel height a drag must cover to commit a state
// change on release; anything less springs back.
const COMMIT_RATIO = 0.25;
// jsdom / pre-layout fallback so drag math never divides by zero.
const FALLBACK_PANEL_H = 400;
// The handle strip's fixed height -- the part of the panel that stays
// visible above the verdict row when closed. Must match the CSS.
const HANDLE_H = 62;

/**
 * The deck's bottom sheet (mobile only -- desktop mounts DeckDetails
 * directly in a pane). The verdict row alone is static chrome at the
 * bottom; the grabber + "Synopsis / PV / Links" strip is the TOP EDGE
 * of the panel and rides up with it. Closed, only that handle strip
 * pokes out above the verdict row; dragging pulls the panel up,
 * tracking the finger 1:1. Release past 25% of the travel commits
 * open/close; less springs back. Tap (or Enter) toggles.
 *
 * DeckDetails (the media box + thumb strip + text) mounts only while
 * the sheet is open or mid-drag -- which is also the guarantee a
 * closed sheet can't keep playing PV audio.
 */
export const DeckSheet = ({ media, remaining, allowSkipAll = true, currentVerdict }: DeckSheetProps) => {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startOffset: number; panelH: number; moved: boolean } | null>(null);
  // Suppresses the synthetic click that follows a real drag's pointerup.
  const suppressClick = useRef(false);

  // The verdict row is pinned absolutely to the bottom; the panel fills
  // the space above it. Measure the chrome's real height (safe-area
  // varies by device) into a CSS var so the panel reserves exactly that
  // -- nothing the panel does mid-animation can shove the row.
  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    const root = rootRef.current;
    if (!chrome || !root) return;
    const apply = () => root.style.setProperty("--chrome-h", `${chrome.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(chrome);
    return () => ro.disconnect();
  }, []);

  // Drag travel: the panel's height minus the handle strip that stays
  // visible when closed.
  const travelRange = () =>
    (panelRef.current?.offsetHeight || FALLBACK_PANEL_H) - HANDLE_H;

  const applyOffset = (px: number, range: number) => {
    if (panelRef.current) {
      panelRef.current.style.transform = `translateY(${px}px)`;
    }
    if (dimRef.current) {
      dimRef.current.style.opacity = String(1 - px / range);
    }
  };

  // Settled positions use calc() so first render (before layout) still
  // lands correctly; px values are only used mid-drag.
  useEffect(() => {
    if (dragging) return;
    if (panelRef.current) {
      panelRef.current.style.transform = open
        ? "translateY(0)"
        : `translateY(calc(100% - ${HANDLE_H}px))`;
    }
    if (dimRef.current) {
      dimRef.current.style.opacity = open ? "1" : "0";
    }
  }, [open, dragging]);

  useEscape(() => setOpen(false), open);

  const handleDown = (e: React.PointerEvent) => {
    const range = travelRange();
    drag.current = {
      startY: e.clientY,
      startOffset: open ? 0 : range,
      panelH: range,
      moved: false,
    };
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const handleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientY - d.startY;
    if (Math.abs(delta) > TAP_SLOP_PX) d.moved = true;
    if (d.moved) {
      applyOffset(Math.min(Math.max(d.startOffset + delta, 0), d.panelH), d.panelH);
    }
  };

  const handleUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (!d.moved) return; // the click handler owns taps
    suppressClick.current = true;
    const offset = Math.min(Math.max(d.startOffset + (e.clientY - d.startY), 0), d.panelH);
    // Starting closed: opening needs >25% of the height revealed.
    // Starting open: closing needs >25% dragged away.
    setOpen(
      d.startOffset === 0
        ? offset < d.panelH * COMMIT_RATIO
        : offset < d.panelH * (1 - COMMIT_RATIO),
    );
  };

  const handleCancel = () => {
    drag.current = null;
    setDragging(false);
  };

  const showContent = open || dragging;

  return (
    <>
      {/* Dim scrim: Esc and the handle are the keyboard paths. */}
      <div
        ref={dimRef}
        className={styles.dim}
        data-open={open}
        data-dragging={dragging}
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div ref={rootRef} className={styles.root}>
        <div
          ref={panelRef}
          className={styles.panel}
          data-open={open}
          data-dragging={dragging}
        >
          <button
            type="button"
            className={styles.handle}
            aria-expanded={open}
            data-test-handle="sheet-handle"
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={handleCancel}
            onClick={() => {
              // A drag's release fires a synthetic click; the drag
              // already committed, so swallow it.
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              setOpen((o) => !o);
            }}
          >
            <span className={styles.grabber} aria-hidden="true" />
            <span className={styles.handleLabel}>Synopsis &middot; PV &middot; Links</span>
          </button>
          {showContent && (
            <div className={styles.panelInner}>
              <DeckDetails media={media} />
            </div>
          )}
        </div>

        <div ref={chromeRef} className={styles.chrome}>
          <VerdictRow
            titleId={media.anilistId as number}
            remaining={remaining}
            allowSkipAll={allowSkipAll}
            currentVerdict={currentVerdict}
          />
        </div>
      </div>
    </>
  );
};
