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

/** Month index a broadcast season starts in: Jan/Apr/Jul/Oct. */
const seasonStartMonth = (season: AnimeSeason): number =>
  season === 'WINTER' ? 0 : season === 'SPRING' ? 3 : season === 'SUMMER' ? 6 : 9;

/** The first instant of a broadcast season (local time): Jan/Apr/Jul/Oct 1. */
export const seasonStart = (season: AnimeSeason, year: number): Date =>
  new Date(year, seasonStartMonth(season), 1);

/** Lead time on a season's lock instant: two weeks before it airs. */
const LOCK_LEAD_DAYS = 14;

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
 *
 * CALENDAR arithmetic, never a raw millisecond subtraction: the Date
 * constructor normalizes a negative day-of-month back into the previous
 * month and always yields LOCAL midnight, whereas subtracting 14*24h of
 * milliseconds from a local midnight lands an hour off whenever a DST
 * changeover falls inside the window. That case is real and permanent,
 * not a leap-second curiosity: the EU changeover always sits between
 * Mar 18 and Apr 1, so every EU-clocked server would rotate (and reap
 * rooms) at Mar 17 23:00, a calendar day before every doc here says.
 * New Zealand gets the same on FALL, Morocco an hour the other way.
 */
export const seasonLockAt = (season: AnimeSeason, year: number): Date =>
  new Date(year, seasonStartMonth(season), 1 - LOCK_LEAD_DAYS);

/**
 * The same instant as seasonLockAt, under the name call sites asking
 * "is this list frozen yet?" read better with.
 */
export const listFreezeAt = seasonLockAt;

/**
 * How long into a season its list keeps being refreshed: four weeks from
 * the day it starts airing.
 *
 * AniList keeps filling a season in well after it premieres: late entries,
 * corrected titles and studios, new posters, and shows delayed out of the
 * quarter. A single fetch at the lock instant would miss all of it until
 * the next rotation.
 *
 * Measured from the season START, not from the lock: the lock is two weeks
 * earlier, so the refresh window runs about six weeks end to end and
 * covers the pre-air fill-in, premiere week, and the month after it, which
 * is where essentially all of the churn happens.
 */
const SETTLE_DAYS = 28;

/**
 * The instant a season's list stops being refreshed: Jan/Apr/Jul/Oct 29.
 *
 * CALENDAR arithmetic for the same reason seasonLockAt uses it: the Date
 * constructor normalizes the day-of-month and always yields LOCAL
 * midnight, whereas adding 28*24h of milliseconds to a local midnight
 * lands an hour off whenever a DST changeover falls inside the window.
 * The EU changeover sits inside the SPRING and FALL windows every year.
 */
export const listSettlesAt = (season: AnimeSeason, year: number): Date =>
  new Date(year, seasonStartMonth(season), 1 + SETTLE_DAYS);

/**
 * True while this season's list should still be refreshed: from whenever
 * it is first served (its lock instant, or earlier if pinned) until four
 * weeks after it airs.
 *
 * Refresh sites must use this, not the list freeze: an unpinned provider
 * only serves a season whose freeze has already passed, so a freeze test
 * is always false there and nothing would ever refresh.
 */
export const listIsSettling = (
  season: AnimeSeason,
  year: number,
  now: Date = new Date(),
): boolean => now.getTime() < listSettlesAt(season, year).getTime();

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
