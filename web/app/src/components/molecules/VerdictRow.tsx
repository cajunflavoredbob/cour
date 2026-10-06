import { useEffect, useRef, useState } from "react";
import type { VerdictValue } from "../../../../../types/reely";
import { useDispatch, useSelector } from "../../store";
import { roomOffline } from "../../store/offline";
import styles from "./VerdictRow.module.css";

interface VerdictRowProps {
  titleId: number;
  /** Titles still unverdicted (drives the hold-to-skip-all countdown copy). */
  remaining: number;
  /** Hold-to-skip-all enabled (default). Scoped re-review passes turn it
   * off: "skip the rest of the season" has no business inside a
   * one-pile pass, and the server-side skipRemaining only targets
   * unverdicted titles anyway. */
  allowSkipAll?: boolean;
  /** The user's existing verdict for this title, when one exists --
   * re-review passes halo the matching button so the original choice
   * is visible at the moment of re-deciding. */
  currentVerdict?: VerdictValue;
}

// Hold duration for skip-all (design section 04 skip-states card).
const SKIP_ALL_HOLD_MS = 1500;

/**
 * The verdict row (design section 03): clay Pass pill, text-only Unsure
 * with press-and-hold-to-skip-all, solid accent Keep pill. Shared by the
 * deck lip and the drawer foot. Verdict taps advance the deck upstream
 * (the reducer drops the title from the unverdicted set on
 * verdictSuccess); there is no undo here -- corrections happen on the
 * review screen.
 */
export const VerdictRow = ({ titleId, remaining, allowSkipAll = true, currentVerdict }: VerdictRowProps) => {
  const dispatch = useDispatch();
  // Verdicts are disabled while offline, since one sent before the
  // reconnect rejoins the room is lost; the row is dimmed then.
  const offline = roomOffline(useSelector(["connectionStatus", "rejoining"]) ?? {});
  const [holding, setHolding] = useState(false);
  // Unsure's pressed look, cleared the moment a press is cancelled (the
  // browser's :active outlives a pointer dragged off the button).
  const [pressed, setPressed] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdFired = useRef(false);

  // Post-advance debounce (audit v1.2.0 #16): the next card's buttons
  // occupy the same coordinates the instant the deck advances, so a
  // double-tap could verdict a title the user never saw. Briefly disable
  // after the row re-targets. Skipped on first mount.
  const [settling, setSettling] = useState(false);
  const prevTitleId = useRef<number | null>(null);
  useEffect(() => {
    if (prevTitleId.current !== null && prevTitleId.current !== titleId) {
      setSettling(true);
      const timer = setTimeout(() => setSettling(false), 300);
      prevTitleId.current = titleId;
      return () => clearTimeout(timer);
    }
    prevTitleId.current = titleId;
  }, [titleId]);

  // One disabled flag for all three buttons: offline (audit 17 M7) or
  // the brief post-advance settle (audit v1.2.0 #16).
  const inputsDisabled = offline || settling;

  // True from a pointerdown that started on the Unsure button until its
  // release/cancel. endHold's tap-skip requires it: without the flag, a
  // mouse press that started on Keep/Pass and was aborted by dragging
  // off could release over Unsure and record a stray skip, and a release
  // after a mid-press cancel (disable window below) skipped the NEXT
  // card sight-unseen.
  const pressActive = useRef(false);

  // A button that disables MID-hold stops dispatching pointer events, so
  // neither endHold nor cancelHold would ever run -- the pending 1.5s
  // timer would still fire and silently skip-all the rest of the season
  // from a press the user thinks went dead. Kill any in-flight press the
  // moment the inputs disable.
  useEffect(() => {
    if (inputsDisabled) {
      clearTimeout(holdTimer.current);
      setHolding(false);
      setPressed(false);
      pressActive.current = false;
      holdFired.current = false;
    }
  }, [inputsDisabled]);

  const verdict = (v: "like" | "dislike" | "skip") =>
    dispatch({ type: "verdict", payload: { titleId, verdict: v } });

  const startHold = (e: React.PointerEvent<HTMLButtonElement>) => {
    // A right or middle press, or a Mac ctrl+click, opens a menu or
    // scrolls; only the main button (any touch or pen) presses Unsure.
    if (inputsDisabled || e.button !== 0 || e.ctrlKey) return;
    // Touch pointers are implicitly CAPTURED by the element receiving
    // pointerdown, which retargets every later pointer event back to the
    // button -- onPointerLeave (the slide-off abort, the only way out of
    // a hold besides releasing into a skip) would never fire on touch
    // and the 1.5s skip-all timer would run to completion under a finger
    // that slid away. Release the capture so touch gets the same
    // boundary events a mouse does.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Pointer events fire per pointerId against these shared refs: a
    // second finger down would overwrite holdTimer and ORPHAN the first
    // timer, so a quick two-finger tap fired a plain skip AND, 1.5s
    // later, a silent skip-all of the whole season (audit 17 M4). One
    // pending hold at a time.
    clearTimeout(holdTimer.current);
    holdFired.current = false;
    pressActive.current = true;
    setPressed(true);
    // Without skip-all, or with only this title left, the press is a plain
    // tap: no timer, no hold UI, but pressActive still arms endHold's
    // tap-skip path.
    if (!allowSkipAll || remaining < 2) return;
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      setHolding(false);
      dispatch({ type: "skipRemaining" });
    }, SKIP_ALL_HOLD_MS);
  };

  const endHold = () => {
    clearTimeout(holdTimer.current);
    setHolding(false);
    setPressed(false);
    // Released before the hold completed, from a press that started here
    // and was never cancelled: a single skip (the tap path).
    if (pressActive.current && !holdFired.current) verdict("skip");
    pressActive.current = false;
    holdFired.current = false;
  };

  const cancelHold = () => {
    clearTimeout(holdTimer.current);
    setHolding(false);
    setPressed(false);
    pressActive.current = false;
    holdFired.current = false;
  };

  return (
    <div className={styles.row} data-offline={offline}>
      <button
        type="button"
        className={styles.dislikeBtn}
        data-current={currentVerdict === "dislike"}
        aria-label={currentVerdict === "dislike" ? "Pass (your current pick)" : undefined}
        onKeyDown={(e) => {
          // Held Enter synthesizes a click per repeat tick (audit v1.2.0
          // #10); swallow the repeats, keep the first press's click.
          if (e.key === "Enter" && e.repeat) e.preventDefault();
        }}
        onClick={() => verdict("dislike")}
        disabled={inputsDisabled}
        data-test-handle="verdict-dislike"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        pass
      </button>

      <button
        type="button"
        className={styles.skipBtn}
        data-current={currentVerdict === "skip"}
        aria-label={currentVerdict === "skip" ? "Unsure (your current pick)" : undefined}
        data-holding={holding}
        data-pressed={pressed}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onKeyDown={(e) => {
          // Keyboard path: plain skip; hold-to-skip-all is pointer-only.
          // e.repeat: a held key fires per OS repeat tick and would
          // mass-verdict (audit v1.2.0 #10 -- the global K/P/U shortcuts
          // were guarded in audit 17; the focused button wasn't).
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (e.repeat) return;
            verdict("skip");
          }
        }}
        disabled={inputsDisabled}
        data-test-handle="verdict-skip"
      >
        <span className={styles.skipFill} aria-hidden="true" />
        <span className={styles.skipLabel}>
          {holding ? `all ${remaining} unsure\u2026` : "unsure"}
        </span>
      </button>

      <button
        type="button"
        className={styles.likeBtn}
        data-current={currentVerdict === "like"}
        aria-label={currentVerdict === "like" ? "Keep (your current pick)" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.repeat) e.preventDefault();
        }}
        onClick={() => verdict("like")}
        disabled={inputsDisabled}
        data-test-handle="verdict-like"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 13.5S2.5 10.2 2.5 6.4C2.5 4.4 4 3 5.8 3c1 0 1.8.5 2.2 1.2C8.4 3.5 9.2 3 10.2 3 12 3 13.5 4.4 13.5 6.4c0 3.8-5.5 7.1-5.5 7.1Z"
            fill="currentColor"
          />
        </svg>
        keep
      </button>
    </div>
  );
};
