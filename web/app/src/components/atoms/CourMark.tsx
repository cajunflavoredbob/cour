interface CourMarkProps {
  /** Rendered size in px. Below 48 the four dots fuse into the small
   * two-arc variant (design addendum APP_MARK.md size rules). */
  size?: number;
  /** Dot radius in mark units: 4.5 standalone (the addendum), 5 inside
   * the stylized wordmark (style guide: "the dots read as the c's
   * counter" and need the extra weight beside the type). */
  dotRadius?: number;
}

// Dual-surface contour (APP_MARK.md "Dual-surface variant"): a
// translucent warm-dark under-stroke behind every ivory/gray stroke,
// plus a hairline on the dots. On the app's dark surfaces it reads as
// subtle edge weight; on light surfaces it keeps the ivory arc from
// vanishing. One mark definition everywhere -- in-app, favicon, and
// the external transparent icon all carry it.
const CONTOUR = 'oklch(0.24 0.014 85 / 0.55)';
const DOT_HAIRLINE = 'oklch(0.24 0.014 85 / 0.35)';

/**
 * The "Dotted answer" mark: the large ivory arc is the c (cour); the
 * answer comes back as four dots -- the four seasons -- so the mark
 * belongs to no single season and never needs a seasonal update. Colors
 * are fixed by the addendum and deliberately NOT the rotating accent
 * custom properties.
 */
export const CourMark = ({ size = 40, dotRadius = 4.5 }: CourMarkProps) => {
  const full = size >= 48;
  const arcWidth = full ? 8 : 10;
  const dots: Array<[number, number, string]> = [
    [50, 25, 'oklch(0.75 0.12 350)'],
    [56.5, 31.5, 'oklch(0.64 0.15 278)'],
    [56.5, 40.5, 'oklch(0.68 0.15 55)'],
    [50, 47, 'oklch(0.78 0.09 220)'],
  ];
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
        stroke={CONTOUR}
        strokeWidth={arcWidth + 3}
        strokeLinecap="round"
      />
      <path
        d="M 52 14 A 27 27 0 1 0 52 58"
        fill="none"
        stroke="oklch(0.97 0.008 85)"
        strokeWidth={arcWidth}
        strokeLinecap="round"
      />
      {full ? (
        dots.map(([cx, cy, fill]) => (
          <circle
            key={fill}
            cx={cx}
            cy={cy}
            r={dotRadius}
            fill={fill}
            stroke={DOT_HAIRLINE}
            strokeWidth={1}
          />
        ))
      ) : (
        <>
          <path
            d="M 50 26 A 13 13 0 1 1 50 46"
            fill="none"
            stroke={CONTOUR}
            strokeWidth={13}
            strokeLinecap="round"
          />
          <path
            d="M 50 26 A 13 13 0 1 1 50 46"
            fill="none"
            stroke="oklch(0.55 0.012 85)"
            strokeWidth={10}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
};
