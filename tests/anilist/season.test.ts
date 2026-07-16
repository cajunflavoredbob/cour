import { describe, expect, it } from 'vitest';
import {
  detectSeason,
  formatSeason,
  listFreezeAt,
  previousSeason,
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

// The rotation spec: the served season is the one containing NEXT month,
// so the deck flips one month ahead of each calendar changeover
// (Dec 1 / Mar 1 / Jun 1 / Sep 1).
describe('servedSeason', () => {
  it.each([
    // [date, season, year]
    [new Date(2026, 7, 31), 'SUMMER', 2026], // Aug 31: last summer-deck day
    [new Date(2026, 8, 1), 'FALL', 2026], // Sep 1: rotation to FALL
    [new Date(2026, 9, 15), 'FALL', 2026], // mid-season stays put
    [new Date(2026, 10, 30), 'FALL', 2026], // Nov 30: last fall-deck day
    [new Date(2026, 11, 1), 'WINTER', 2027], // Dec 1: WINTER of NEXT year
    [new Date(2027, 0, 15), 'WINTER', 2027],
    [new Date(2027, 1, 28), 'WINTER', 2027], // Feb: rotation to SPRING is Mar 1
    [new Date(2027, 2, 1), 'SPRING', 2027],
    [new Date(2027, 4, 31), 'SPRING', 2027],
    [new Date(2027, 5, 1), 'SUMMER', 2027], // Jun 1: rotation to SUMMER
  ])('%s serves %s %d', (date, season, year) => {
    expect(servedSeason(date as Date)).toEqual({ season, year });
  });

  it('does not overflow on long month ends (the setMonth trap)', () => {
    // Jan 31 + 1 month under setMonth semantics lands in March, which
    // would misfile late January as SPRING. Month arithmetic keeps it
    // WINTER until Mar 1.
    expect(servedSeason(new Date(2027, 0, 31))).toEqual({ season: 'WINTER', year: 2027 });
    expect(servedSeason(new Date(2026, 11, 31))).toEqual({ season: 'WINTER', year: 2027 });
  });
});

describe('previousSeason', () => {
  it('steps back one quarter, across the year boundary', () => {
    expect(previousSeason('FALL', 2026)).toEqual({ season: 'SUMMER', year: 2026 });
    expect(previousSeason('WINTER', 2027)).toEqual({ season: 'FALL', year: 2026 });
  });
});

describe('seasonStart / listFreezeAt', () => {
  it('starts on the quarter boundary and freezes two weeks before it', () => {
    expect(seasonStart('FALL', 2026)).toEqual(new Date(2026, 9, 1));
    expect(listFreezeAt('FALL', 2026)).toEqual(new Date(2026, 8, 17));
    expect(seasonStart('WINTER', 2027)).toEqual(new Date(2027, 0, 1));
    expect(listFreezeAt('WINTER', 2027)).toEqual(new Date(2026, 11, 18));
  });
});
