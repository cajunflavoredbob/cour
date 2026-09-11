import { describe, expect, it } from 'vitest';
import {
  detectSeason,
  formatSeason,
  listFreezeAt,
  nextSeason,
  previousSeason,
  seasonLockAt,
  seasonStart,
  servedSeason,
} from '../../internal/app/anilist/season';

// Month boundaries follow the anime broadcast quarters: Jan-Mar WINTER,
// Apr-Jun SPRING, Jul-Sep SUMMER, Oct-Dec FALL. Dates are constructed with
// the (year, monthIndex, day) form so the test runs in local time -- the
// mapping reads getMonth()/getFullYear(), also local.
describe('detectSeason', () => {
  it.each([
    [0, 'WINTER'], // January
    [2, 'WINTER'], // March
    [3, 'SPRING'], // April
    [5, 'SPRING'], // June
    [6, 'SUMMER'], // July
    [8, 'SUMMER'], // September
    [9, 'FALL'], // October
    [11, 'FALL'], // December
  ])('maps month index %i to %s', (monthIndex, season) => {
    expect(detectSeason(new Date(2026, monthIndex as number, 15)).season).toBe(season);
  });

  it('uses the plain calendar year (January belongs to that year\'s WINTER)', () => {
    expect(detectSeason(new Date(2027, 0, 1))).toEqual({ season: 'WINTER', year: 2027 });
  });

  it('detects SUMMER 2026 for July 2026', () => {
    expect(detectSeason(new Date(2026, 6, 4))).toEqual({ season: 'SUMMER', year: 2026 });
  });
});

describe('formatSeason', () => {
  it('renders the display form', () => {
    expect(formatSeason('SUMMER', 2026)).toBe('Summer 2026');
    expect(formatSeason('FALL', 2026)).toBe('Fall 2026');
  });
});

// The rotation spec: the deck flips to the upcoming season at that
// season's lock instant -- two weeks before it airs, the same moment its
// list freezes (Sep 17 / Dec 18 / Mar 18 / Jun 17).
describe('servedSeason', () => {
  it.each([
    // [date, season, year]
    [new Date(2026, 8, 10), 'SUMMER', 2026], // Sep 10: summer is still airing
    [new Date(2026, 8, 16), 'SUMMER', 2026], // Sep 16: last summer-deck day
    [new Date(2026, 8, 17), 'FALL', 2026], // Sep 17: rotation to FALL
    [new Date(2026, 9, 15), 'FALL', 2026], // mid-season stays put
    [new Date(2026, 11, 17), 'FALL', 2026], // Dec 17: last fall-deck day
    [new Date(2026, 11, 18), 'WINTER', 2027], // Dec 18: WINTER of NEXT year
    [new Date(2027, 0, 15), 'WINTER', 2027],
    [new Date(2027, 2, 17), 'WINTER', 2027], // Mar 17: rotation is Mar 18
    [new Date(2027, 2, 18), 'SPRING', 2027],
    [new Date(2027, 5, 16), 'SPRING', 2027],
    [new Date(2027, 5, 17), 'SUMMER', 2027], // Jun 17: rotation to SUMMER
  ])('%s serves %s %d', (date, season, year) => {
    expect(servedSeason(date as Date)).toEqual({ season, year });
  });

  it('rolls the year with the season at the December lock', () => {
    expect(servedSeason(new Date(2026, 11, 31))).toEqual({ season: 'WINTER', year: 2027 });
    expect(servedSeason(new Date(2027, 0, 31))).toEqual({ season: 'WINTER', year: 2027 });
  });

  it('never serves a season whose list is still unfrozen', () => {
    // The whole point of locking the two dates together: whatever is
    // being served has already passed its own freeze instant.
    for (let day = 0; day < 400; day++) {
      const date = new Date(2026, 6, 1 + day);
      const { season, year } = servedSeason(date);
      expect(date.getTime()).toBeGreaterThanOrEqual(listFreezeAt(season, year).getTime());
    }
  });
});

describe('nextSeason / previousSeason', () => {
  it('steps a quarter in each direction, across the year boundary', () => {
    expect(nextSeason('SUMMER', 2026)).toEqual({ season: 'FALL', year: 2026 });
    expect(nextSeason('FALL', 2026)).toEqual({ season: 'WINTER', year: 2027 });
    expect(previousSeason('FALL', 2026)).toEqual({ season: 'SUMMER', year: 2026 });
    expect(previousSeason('WINTER', 2027)).toEqual({ season: 'FALL', year: 2026 });
  });
});

describe('seasonStart / seasonLockAt / listFreezeAt', () => {
  it('starts on the quarter boundary and locks two weeks before it', () => {
    expect(seasonStart('FALL', 2026)).toEqual(new Date(2026, 9, 1));
    expect(seasonLockAt('FALL', 2026)).toEqual(new Date(2026, 8, 17));
    expect(seasonStart('WINTER', 2027)).toEqual(new Date(2027, 0, 1));
    expect(seasonLockAt('WINTER', 2027)).toEqual(new Date(2026, 11, 18));
  });

  it('rotation and list freeze are the same instant, by construction', () => {
    // listFreezeAt is a plain alias of seasonLockAt, so asserting the two
    // are equal is a tautology. Pin the instants as LITERAL dates instead.
    // An earlier version computed the expectation with the same expression
    // the implementation uses, which only caught the lead constant
    // drifting and would have passed a wrong month or a sign error. The
    // 400-day invariant below cannot catch either, since it reads the same
    // lead from both sides and holds for any value.
    const EXPECTED: Record<string, [Date, Date]> = {
      // season -> [lock instant, season start]
      WINTER: [new Date(2026, 11, 18), new Date(2027, 0, 1)],
      SPRING: [new Date(2027, 2, 18), new Date(2027, 3, 1)],
      SUMMER: [new Date(2027, 5, 17), new Date(2027, 6, 1)],
      FALL: [new Date(2027, 8, 17), new Date(2027, 9, 1)],
    };
    for (const season of ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const) {
      const [expectedLock, expectedStart] = EXPECTED[season];
      const lock = seasonLockAt(season, 2027);
      expect(lock).toEqual(expectedLock);
      expect(seasonStart(season, 2027)).toEqual(expectedStart);
      expect(listFreezeAt(season, 2027)).toEqual(expectedLock);
      // Local midnight in EVERY timezone: the lead is calendar days, not
      // 14*24h of milliseconds, so a DST changeover inside the window
      // cannot shift the rotation (and the reaper) off the documented day.
      expect([lock.getHours(), lock.getMinutes(), lock.getSeconds()]).toEqual([0, 0, 0]);
      // And that instant is exactly when the deck rotates to it.
      expect(servedSeason(lock)).toEqual({ season, year: 2027 });
      expect(servedSeason(new Date(lock.getTime() - 1))).not.toEqual({ season, year: 2027 });
    }
  });
});
