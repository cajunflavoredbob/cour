import type { AnimeSeason } from './types';

/** Quarter order, used to step between adjacent seasons. */
const SEASON_ORDER: readonly AnimeSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

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

/** The first instant of a broadcast season (local time): Jan/Apr/Jul/Oct 1. */
export const seasonStart = (season: AnimeSeason, year: number): Date => {
  const startMonth =
    season === 'WINTER' ? 0 : season === 'SPRING' ? 3 : season === 'SUMMER' ? 6 : 9;
  return new Date(year, startMonth, 1);
};

/** Lead time on a season's lock instant: two weeks before it airs. */
const LOCK_LEAD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The ONE instant that governs a season: the deck rotates to it and its
 * show list freezes at the same moment, two weeks before the season airs
 * (Sep 17 / Dec 18 / Mar 18 / Jun 17 for quarters starting on the 1st).
 *
 * Rotation used to run a month out (Dec/Mar/Jun/Sep 1) while the freeze
 * ran two weeks out. That opened picking against a list AniList was
 * still filling in, and retired the outgoing season a month before it
 * finished airing. Locking both to the LATER of those two dates -- the
 * freeze -- means a deck is never served before it is stable, and the
 * season you are still watching survives until two weeks out.
 *
 * The two concepts share one function so they cannot drift apart again.
 */
export const seasonLockAt = (season: AnimeSeason, year: number): Date =>
  new Date(seasonStart(season, year).getTime() - LOCK_LEAD_MS);

/**
 * The same instant as seasonLockAt, under the name call sites asking
 * "is this list frozen yet?" read better with.
 */
export const listFreezeAt = seasonLockAt;

/** The season immediately after the given one. */
export const nextSeason = (
  season: AnimeSeason,
  year: number,
): { season: AnimeSeason; year: number } => {
  const i = SEASON_ORDER.indexOf(season);
  return i === SEASON_ORDER.length - 1
    ? { season: 'WINTER', year: year + 1 }
    : { season: SEASON_ORDER[i + 1], year };
};

/** The season immediately before the given one -- the fallback snapshot a
 * boot can serve when the post-rotation fetch isn't possible yet. */
export const previousSeason = (
  season: AnimeSeason,
  year: number,
): { season: AnimeSeason; year: number } => {
  const i = SEASON_ORDER.indexOf(season);
  return i === 0
    ? { season: 'FALL', year: year - 1 }
    : { season: SEASON_ORDER[i - 1], year };
};

/**
 * The season the app SERVES right now (the owner's rotation spec): the
 * calendar season you are in, until the upcoming season's lock instant
 * passes -- then that one. Rotation and list freeze are the same event,
 * so a room never picks against a deck that can still shift.
 *
 * Date comparison, not month arithmetic: the rotation point sits mid-month
 * now, so the old "season containing next month" shortcut (and its Jan 31
 * setMonth overflow trap) no longer applies.
 */
export const servedSeason = (
  date: Date,
): { season: AnimeSeason; year: number } => {
  const calendar = detectSeason(date);
  const upcoming = nextSeason(calendar.season, calendar.year);
  return date.getTime() >= seasonLockAt(upcoming.season, upcoming.year).getTime()
    ? upcoming
    : calendar;
};

/** "SUMMER" + 2026 -> "Summer 2026" -- display form for library/server names. */
export const formatSeason = (season: AnimeSeason, year: number): string =>
  `${season.charAt(0)}${season.slice(1).toLowerCase()} ${year}`;
