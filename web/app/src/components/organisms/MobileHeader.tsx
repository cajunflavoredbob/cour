import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import { AccountMenu } from "./AccountMenu";
import styles from "./MobileHeader.module.css";

interface MobileHeaderProps {
  /** The control before the brand: the deck's progress chip or a way back. */
  leading?: ReactNode;
  /** The room, shown above the wordmark. */
  roomLabel?: string;
  /** Over poster art: the label, wordmark and chip border in translucent white. */
  overArt?: boolean;
  /** Placement from the screen: position and padding. */
  className?: string;
}

/**
 * The one phone header: an optional leading control, the room over
 * "cour" and the season chip, centered, and the account menu. The desktop
 * screens use AppHeader.
 */
export const MobileHeader = ({ leading, roomLabel, overArt, className }: MobileHeaderProps) => {
  const { season } = useSeason();
  const kanji = SEASON_THEMES[season].kanji;

  // Both sides take the wider side's width, so the brand stays at the
  // true center however long the room name or the leading control.
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<number>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new leading control is a new element to observe.
  useLayoutEffect(() => {
    const start = startRef.current;
    const end = endRef.current;
    if (!start || !end || typeof ResizeObserver === "undefined") return;
    // The control's full width, rounded up: its slot may already be squeezed.
    const width = (slot: HTMLElement) => Math.ceil(slot.firstElementChild?.getBoundingClientRect().width ?? 0);
    const measure = () => setSide(Math.max(width(start), width(end)));
    measure();
    const observer = new ResizeObserver(measure);
    for (const slot of [start, end]) {
      if (slot.firstElementChild) observer.observe(slot.firstElementChild);
    }
    return () => observer.disconnect();
  }, [leading]);

  return (
    <header
      className={className ? `${styles.header} ${className}` : styles.header}
      data-over-art={overArt || undefined}
      style={side ? ({ "--side": `${side}px` } as CSSProperties) : undefined}
    >
      <div ref={startRef} className={styles.start}>
        {leading}
      </div>
      <div className={styles.brand}>
        {roomLabel && <span className={styles.roomLabel}>{roomLabel}</span>}
        <span className={styles.wordRow}>
          <span className={styles.word} translate="no">
            cour
          </span>
          <span className={styles.kanjiChip} aria-hidden="true">
            {kanji}
          </span>
        </span>
      </div>
      <div ref={endRef} className={styles.end}>
        <AccountMenu />
      </div>
    </header>
  );
};
