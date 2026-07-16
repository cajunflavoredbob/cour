import { CourMark } from "./CourMark";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import styles from "./Wordmark.module.css";

interface WordmarkProps {
  /** Wordmark font size in px (the kanji chip scales itself). */
  size?: number;
}

// The cour lockup (design addendum APP_MARK.md): the "Dotted answer" mark
// plus set type -- Shippori Mincho 600 "cour" -- plus the current season's
// kanji chip in the seasonal accent. The mark's colors are fixed (all four
// seasons present); only the chip rotates with the cour.
export const Wordmark = ({ size = 19 }: WordmarkProps) => {
  const { season } = useSeason();
  const { kanji } = SEASON_THEMES[season];
  return (
    <span className={styles.wrap}>
      {/* The lockup mark stays at or above the full-variant threshold
          (the guide's canonical lockup is the DOTTED mark at 56px; the
          two-arc fallback is for favicons, not headers). */}
      <CourMark size={Math.max(48, Math.round(size * 1.4))} />
      <span className={styles.word} style={{ fontSize: size }} translate="no">
        cour
      </span>
      <span className={styles.kanji} aria-hidden="true">
        {kanji}
      </span>
    </span>
  );
};
