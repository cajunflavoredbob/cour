import type { ReactNode } from "react";
import { AccountMenu } from "./AccountMenu";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import styles from "./AppHeader.module.css";

interface AppHeaderProps {
  /** Optional leading element before the brand -- the deck's progress
   * chip or scope-back control. */
  leading?: ReactNode;
  /** Room name shown muted after the kanji chip. */
  roomLabel?: string;
}

/**
 * The shared desktop header (docs/DESKTOP.md 0.15.0): brand (cour +
 * season kanji + room label) on the left, the account popover on the
 * right, with an optional leading slot. Replaces the three ad-hoc
 * desktop headers the deck/review/rank screens each grew. Desktop-only
 * -- mobile keeps each screen's own header.
 */
export const AppHeader = ({ leading, roomLabel }: AppHeaderProps) => {
  const { season } = useSeason();
  const kanji = SEASON_THEMES[season].kanji;
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        {leading}
        <span className={styles.brand} translate="no">
          <span className={styles.word}>cour</span>
          <span className={styles.kanjiChip} aria-hidden="true">{kanji}</span>
          {roomLabel && <span className={styles.roomLabel}>{roomLabel}</span>}
        </span>
      </div>
      <AccountMenu />
    </header>
  );
};
