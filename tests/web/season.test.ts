// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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
