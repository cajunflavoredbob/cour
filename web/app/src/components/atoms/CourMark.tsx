interface CourMarkProps {
  /** Rendered size in px. Below 48 the four dots fuse into the small
   * two-arc variant (design addendum APP_MARK.md size rules). */
  size?: number;
  /** Dot radius in mark units: 4.5 standalone (the addendum), 5 inside
   * the stylized wordmark (style guide: "the dots read as the c's
   * counter" and need the extra weight beside the type). */
  dotRadius?: number;
}

/**
 * The "Dotted answer" mark: the large ivory arc is the c (cour); the
 * answer comes back as four dots -- the four seasons -- so the mark
 * belongs to no single season and never needs a seasonal update. Colors
 * are fixed by the addendum and deliberately NOT the rotating accent
 * custom properties.
 */
export const CourMark = ({ size = 40, dotRadius = 4.5 }: CourMarkProps) => {
  const full = size >= 48;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      role="img"
      aria-label="cour"
    >
      <path
        d="M 52 14 A 27 27 0 1 0 52 58"
        fill="none"
        stroke="oklch(0.97 0.008 85)"
        strokeWidth={full ? 8 : 10}
        strokeLinecap="round"
      />
      {full ? (
        <>
          <circle cx="50" cy="25" r={dotRadius} fill="oklch(0.75 0.12 350)" />
          <circle cx="56.5" cy="31.5" r={dotRadius} fill="oklch(0.64 0.15 278)" />
          <circle cx="56.5" cy="40.5" r={dotRadius} fill="oklch(0.68 0.15 55)" />
          <circle cx="50" cy="47" r={dotRadius} fill="oklch(0.78 0.09 220)" />
        </>
      ) : (
        <path
          d="M 50 26 A 13 13 0 1 1 50 46"
          fill="none"
          stroke="oklch(0.55 0.012 85)"
          strokeWidth={10}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
};
