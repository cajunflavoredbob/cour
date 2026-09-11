// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectSeason as serverDetectSeason,
  servedSeason as serverServedSeason,
} from '../../internal/app/anilist/season';
import {
  applySeasonTheme,
  detectSeason,
  SEASON_THEMES,
  seasonTheme,
  servedSeason,
} from '../../web/app/src/utils/season';

afterEach(() => {
  // applySeasonTheme writes inline styles on <html>; clear between tests.
  document.documentElement.removeAttribute('style');
});

describe('detectSeason', () => {
  // Mirrors the server's internal/app/anilist/season.ts boundaries -- the
  // two implementations must not drift or the client themes a different
  // season than the deck being served.
  it.each([
    ['2026-01-15', 'WINTER', 2026],
    ['2026-03-31', 'WINTER', 2026],
    ['2026-04-01', 'SPRING', 2026],
    ['2026-06-30', 'SPRING', 2026],
    ['2026-07-04', 'SUMMER', 2026],
    ['2026-09-30', 'SUMMER', 2026],
    ['2026-10-01', 'FALL', 2026],
    ['2026-12-31', 'FALL', 2026],
  ])('%s -> %s %d', (iso, season, year) => {
    // Parse as local time (matches how the server treats new Date()).
    expect(detectSeason(new Date(`${iso}T12:00:00`))).toEqual({ season, year });
  });
});

describe('seasonal themes', () => {
  it('every season carries its kanji and a full accent trio', () => {
    const kanji = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' } as const;
    for (const season of ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const) {
      const t = seasonTheme(season);
      expect(t.kanji).toBe(kanji[season]);
      expect(t.accent).toMatch(/^oklch\(/);
      expect(t.accentBright).toMatch(/^oklch\(/);
      // Soft variant is the accent at 16% alpha per the design tokens.
      expect(t.accentSoft).toContain('/ 0.16');
    }
  });

  it('summer accent matches the design handoff literal (and the CSS fallback)', () => {
    expect(SEASON_THEMES.SUMMER.accent).toBe('oklch(0.64 0.15 278)');
    expect(SEASON_THEMES.SUMMER.accentBright).toBe('oklch(0.75 0.13 278)');
  });
});

describe('applySeasonTheme', () => {
  it('sets the three accent custom properties for an explicit season', () => {
    const theme = applySeasonTheme('FALL');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--cour-accent')).toBe(SEASON_THEMES.FALL.accent);
    expect(style.getPropertyValue('--cour-accent-bright')).toBe(SEASON_THEMES.FALL.accentBright);
    expect(style.getPropertyValue('--cour-accent-soft')).toBe(SEASON_THEMES.FALL.accentSoft);
    expect(theme.season).toBe('FALL');
  });

  it('defaults to the current date season', () => {
    const applied = applySeasonTheme();
    expect(applied.season).toBe(detectSeason(new Date()).season);
  });
});

// NOTE on the server import above: web/app/tsconfig.json includes
// ../../tests/web, so importing internal/app/anilist/season pulls server
// source into the UI TypeScript project. That is acceptable here and only
// here: the server season module is deliberately pure, its sole import is
// a type-only AnimeSeason, and both tsconfigs share a compatible target.
// Keep it that way -- if that module ever grows a node: import, this
// import breaks `typecheck:ui` with a failure reported against a path
// outside web/app, which is a confusing place to land.
//
// The one test that mechanically ties the two implementations together.
// Everything else on both sides is a hand-maintained expectation table, so
// a one-sided edit to the lead time or the boundary rule would leave both
// files green while the UI themed and labelled a season the server was not
// serving. This imports BOTH and compares them directly.
describe('client mirror parity with the server', () => {
  it('agrees with internal/app/anilist/season.ts on every day for a decade', () => {
    const mismatches: string[] = [];
    const cursor = new Date(2024, 0, 1);
    const end = new Date(2034, 0, 1);
    while (cursor.getTime() < end.getTime()) {
      // Sample the hours AROUND local midnight, not just midday. The lock
      // instants are local midnight, so midday-only sampling cannot see a
      // client that computes the lock an hour early. That is exactly the
      // DST defect the calendar-arithmetic form fixes, and reverting the
      // client alone used to leave this suite green in every timezone.
      for (const hour of [0, 1, 12, 23]) {
        const at = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hour);
        const mine = servedSeason(at);
        const theirs = serverServedSeason(at);
        if (mine.season !== theirs.season || mine.year !== theirs.year) {
          mismatches.push(
            `${at.toString().slice(0, 24)}: client ${mine.season} ${mine.year} vs server ${theirs.season} ${theirs.year}`,
          );
        }
        const mineCal = detectSeason(at);
        const theirsCal = serverDetectSeason(at);
        if (mineCal.season !== theirsCal.season || mineCal.year !== theirsCal.year) {
          mismatches.push(`${at.toString().slice(0, 24)}: detectSeason disagrees`);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe('servedSeason', () => {
  // Mirrors the server's servedSeason (internal/app/anilist/season.ts):
  // the calendar season until the upcoming season's lock instant (two
  // weeks before it airs, the same moment its list freezes), so the UI's
  // pre-config fallback agrees with the served deck. Must not drift.
  it.each([
    ['2026-09-10', 'SUMMER', 2026], // summer is still airing
    ['2026-09-16', 'SUMMER', 2026],
    ['2026-09-17', 'FALL', 2026], // rotation, two weeks before Oct 1
    ['2026-12-17', 'FALL', 2026],
    ['2026-12-18', 'WINTER', 2027], // year rolls with the season
    ['2026-12-31', 'WINTER', 2027],
    ['2027-01-31', 'WINTER', 2027],
    ['2027-03-18', 'SPRING', 2027],
    ['2027-06-17', 'SUMMER', 2027],
  ])('%s serves %s %d', (iso, season, year) => {
    expect(servedSeason(new Date(`${iso}T12:00:00`))).toEqual({ season, year });
  });
});
