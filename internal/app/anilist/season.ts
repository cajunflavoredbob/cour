import type { AnimeSeason } from './types';

/**
 * Maps a calendar date to the anime broadcast season containing it.
 *
 * Season boundaries follow the industry's quarter convention (the same one
 * AniList's own seasonal browse uses):
 *   Jan-Mar -> WINTER, Apr-Jun -> SPRING, Jul-Sep -> SUMMER, Oct-Dec -> FALL.
 *
 * The year is the plain calendar year: a January date belongs to that
 * year's WINTER season (Winter 2026 starts January 2026), so no year
 * adjustment is needed at the December/January boundary.
 */
const seasonOfMonth = (month: number): AnimeSeason =>
  month < 3 ? 'WINTER' : month < 6 ? 'SPRING' : month < 9 ? 'SUMMER' : 'FALL';

export const detectSeason = (
  date: Date,
): { season: AnimeSeason; year: number } => ({
  season: seasonOfMonth(date.getMonth()),
  year: date.getFullYear(),
});

/**
 * The season the app SERVES right now (the owner's rotation spec): the
 * deck rotates to the upcoming season one month ahead of the calendar
 * changeover, giving rooms the pre-season window to pick and lock in
 * before anything airs. Rotation points are therefore Dec 1 / Mar 1 /
 * Jun 1 / Sep 1 -- i.e. the season containing NEXT month.
 *
 * Month arithmetic only, never Date.setMonth: adding a month to Jan 31
 * overflows into March under setMonth semantics and would misfile late
 * January as SPRING.
 */
export const servedSeason = (
  date: Date,
): { season: AnimeSeason; year: number } => {
  const month = date.getMonth() + 1; // one month ahead, 1-12
  return {
    season: seasonOfMonth(month % 12),
    year: date.getFullYear() + (month > 11 ? 1 : 0),
  };
};

/** The season immediately before the given one -- the fallback snapshot a
 * boot can serve when the post-rotation fetch isn't possible yet. */
export const previousSeason = (
  season: AnimeSeason,
  year: number,
): { season: AnimeSeason; year: number } => {
  const order: AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const i = order.indexOf(season);
  return i === 0
    ? { season: 'FALL', year: year - 1 }
    : { season: order[i - 1], year };
};

/** The first instant of a broadcast season (local time): Jan/Apr/Jul/Oct 1. */
export const seasonStart = (season: AnimeSeason, year: number): Date => {
  const startMonth = season === 'WINTER' ? 0 : season === 'SPRING' ? 3 : season === 'SUMMER' ? 6 : 9;
  return new Date(year, startMonth, 1);
};

/**
 * When the served season's show list freezes: two weeks before the season
 * starts (the owner's spec). Late title announcements land via daily
 * refreshes during the pre-season window; past this instant the list is
 * stable so nobody's deck shifts under them while they finish locking in.
 */
export const listFreezeAt = (season: AnimeSeason, year: number): Date =>
  new Date(seasonStart(season, year).getTime() - 14 * 24 * 60 * 60 * 1000);

/** "SUMMER" + 2026 -> "Summer 2026" -- display form for library/server names. */
export const formatSeason = (season: AnimeSeason, year: number): string =>
  `${season.charAt(0)}${season.slice(1).toLowerCase()} ${year}`;

