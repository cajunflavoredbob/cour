import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import styles from "./AuthBackground.module.css";

/**
 * The "Kanji watermark" auth background (design addendum
 * AUTH_BACKGROUND.md, adopted frame "Auth BG C"): a huge season kanji in
 * Shippori Mincho bleeding off the top-right, tinted with the seasonal
 * accent at watermark opacity, over a faint accent bloom. Opacity IS the
 * design -- glyph and bloom both stay <= 8% so the form always wins.
 *
 * Scope per the addendum: auth/first-run screens only. Never behind the
 * deck; the review screen MAY adopt it later (undecided).
 */
export const AuthBackground = () => {
  const { season } = useSeason();
  const { kanji } = SEASON_THEMES[season];
  return (
    <div className={styles.bg} aria-hidden="true">
      <span className={styles.kanji} translate="no">{kanji}</span>
    </div>
  );
};
