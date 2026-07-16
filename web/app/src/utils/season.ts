/**
 * Seasonal accent theme (0.3.0, Direction B "Seasonal print").
 *
 * cour's brand accent rotates with the broadcast season: same lightness/
 * chroma family, different hue per cour, plus the season's kanji for the
 * wordmark chip. Season boundaries mirror the server's
 * internal/app/anilist/season.ts (the industry quarter convention):
 * Jan-Mar WINTER, Apr-Jun SPRING, Jul-Sep SUMMER, Oct-Dec FALL.
 *
 * The server's season wins: the config frame carries the served
 * season/year and components read it through hooks/useSeason. The local
 * detection here is only the fallback for the beat before that frame
 * arrives (and the boot-time theme in main.tsx).
 */

export type CourSeason = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export interface SeasonTheme {
  season: CourSeason;
  kanji: string;
  /** Primary accent -- solid fills (Like pill, CTA). */
  accent: string;
  /** Brighter text-on-dark variant (kanji chip, accent text). */
  accentBright: string;
  /** 16%-alpha soft fill (active tabs, hold-to-skip sweep). */
  accentSoft: string;
}

// Hues from the design handoff's seasonal rotation table. L/C stay in the
// same family per the spec; sakura and ice run lighter by design.
export const SEASON_THEMES: Record<CourSeason, Omit<SeasonTheme, "season">> = {
  SPRING: {
    kanji: "春",
    accent: "oklch(0.75 0.12 350)",
    accentBright: "oklch(0.83 0.1 350)",
    accentSoft: "oklch(0.75 0.12 350 / 0.16)",
  },
  SUMMER: {
    kanji: "夏",
    accent: "oklch(0.64 0.15 278)",
    accentBright: "oklch(0.75 0.13 278)",
    accentSoft: "oklch(0.64 0.15 278 / 0.16)",
  },
  FALL: {
    kanji: "秋",
    accent: "oklch(0.68 0.15 55)",
    accentBright: "oklch(0.78 0.13 55)",
    accentSoft: "oklch(0.68 0.15 55 / 0.16)",
  },
  WINTER: {
    kanji: "冬",
    accent: "oklch(0.78 0.09 220)",
    accentBright: "oklch(0.85 0.08 220)",
    accentSoft: "oklch(0.78 0.09 220 / 0.16)",
  },
};

export const detectSeason = (date: Date): { season: CourSeason; year: number } => {
  const month = date.getMonth(); // 0-11
  const season: CourSeason =
    month < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";
  return { season, year: date.getFullYear() };
};

/**
 * Local mirror of the server's served-season rotation: the season
 * containing NEXT month, so the deck flips one month ahead of the
 * calendar changeover (Dec/Mar/Jun/Sep 1). Month arithmetic only --
 * Date.setMonth on Jan 31 would overflow past February. Fallback for
 * before the config frame lands; the server value wins after.
 */
export const servedSeason = (date: Date): { season: CourSeason; year: number } => {
  const month = date.getMonth() + 1; // one month ahead, 1-12
  const season: CourSeason =
    month % 12 < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";
  return { season, year: date.getFullYear() + (month > 11 ? 1 : 0) };
};

export const seasonTheme = (season: CourSeason): SeasonTheme => ({
  season,
  ...SEASON_THEMES[season],
});

/**
 * Point the --cour-accent* custom properties at the given (or current)
 * season's palette. Sets inline styles on <html>, which override the
 * summer-indigo fallbacks declared in main.css. Returns the applied theme
 * so callers (Wordmark) can read the kanji without re-deriving.
 */
export const applySeasonTheme = (
  season?: CourSeason,
  root: HTMLElement = document.documentElement,
): SeasonTheme => {
  const theme = seasonTheme(season ?? detectSeason(new Date()).season);
  root.style.setProperty("--cour-accent", theme.accent);
  root.style.setProperty("--cour-accent-bright", theme.accentBright);
  root.style.setProperty("--cour-accent-soft", theme.accentSoft);
  return theme;
};
