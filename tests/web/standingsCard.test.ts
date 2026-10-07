// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { RankingResults } from '../../types/reely';
import {
  buildStandingsCard,
  CARD_STANDINGS,
  cardAltText,
  cardFilename,
  cardSignature,
  fitText,
  offCardPicks,
  pickLines,
  pickNames,
  pickTag,
  type StandingsCardData,
  statusLine,
  wrapText,
} from '../../web/app/src/utils/standingsCard';
import { makeMedia } from '../helpers';

const ids = [101, 102, 103, 104, 105, 106, 107];
const mediaById = new Map(
  ids.map((id) => [id, makeMedia({ id: String(id), anilistId: id, title: `Show ${id}`, posterUrl: `/api/poster/${id}` })]),
);

// Two members, scored 12/9/6/3/1: user1 ranked 101,102,103,104,105 and user2
// ranked 102,101,106,103,107. Places as the server gives them: 101 and 102
// are level on points, rankers and best rank, so they share first place, as
// 105 and 107 share sixth.
const standings: RankingResults['standings'] = [
  { titleId: 101, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
  { titleId: 102, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
  { titleId: 103, points: 9, bestRank: 3, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 3 },
  { titleId: 106, points: 6, bestRank: 3, rankedBy: 1, rankedByNames: ['user2'], rank: 4 },
  { titleId: 104, points: 3, bestRank: 4, rankedBy: 1, rankedByNames: ['user1'], rank: 5 },
  { titleId: 105, points: 1, bestRank: 5, rankedBy: 1, rankedByNames: ['user1'], rank: 6 },
  { titleId: 107, points: 1, bestRank: 5, rankedBy: 1, rankedByNames: ['user2'], rank: 6 },
];

// A standings row with just what ordering and the card read.
const row = (titleId: number, rank: number, points = 12): RankingResults['standings'][number] => ({
  titleId,
  points,
  bestRank: 1,
  rankedBy: 1,
  rankedByNames: ['user1'],
  rank,
});

const results = (overrides: Partial<RankingResults> = {}): RankingResults => ({
  submittedCount: 2,
  memberCount: 2,
  members: [],
  mySubmitted: true,
  myRanking: [],
  standings,
  topPicks: [
    { userName: 'user1', titleId: 101 },
    { userName: 'user2', titleId: 102 },
  ],
  ...overrides,
});

const card = (overrides: Partial<StandingsCardData> = {}): StandingsCardData => ({
  ...buildStandingsCard({ results: results(), season: 'FALL', year: 2026, roomName: 'Couch-Coop', mediaById }),
  ...overrides,
});

// 10px per character.
const measure = (text: string) => text.length * 10;

afterEach(() => {
  delete document.body.dataset.rootPath;
});

describe('buildStandingsCard', () => {
  it('keeps the scoring positions with their places, titles and posters', () => {
    const c = card();
    expect(c.standings).toHaveLength(CARD_STANDINGS);
    expect(c.standings.map((s) => [s.titleId, s.rank, s.title, s.poster])).toEqual([
      [101, 1, 'Show 101', '/api/poster/101'],
      [102, 1, 'Show 102', '/api/poster/102'],
      [103, 3, 'Show 103', '/api/poster/103'],
      [106, 4, 'Show 106', '/api/poster/106'],
      [104, 5, 'Show 104', '/api/poster/104'],
    ]);
    expect(c.standings[0]).toMatchObject({ points: 21, rankedBy: 2, rankedByNames: ['user1', 'user2'] });
    expect(c.topPicks).toEqual([
      { titleId: 101, userName: 'user1', title: 'Show 101' },
      { titleId: 102, userName: 'user2', title: 'Show 102' },
    ]);
  });

  it('lists the shows of a shared place A to Z', () => {
    const titled = new Map([
      [201, makeMedia({ id: '201', anilistId: 201, title: 'zeta' })],
      [202, makeMedia({ id: '202', anilistId: 202, title: 'Alpha' })],
      [203, makeMedia({ id: '203', anilistId: 203, title: 'beta' })],
    ]);
    const r = results({ standings: [row(201, 1), row(202, 1), row(203, 3, 6)] });
    const c = buildStandingsCard({ results: r, season: 'FALL', year: 2026, roomName: 'x', mediaById: titled });
    expect(c.standings.map((s) => s.title)).toEqual(['Alpha', 'zeta', 'beta']);
  });

  it('keeps every show sharing the last scoring place', () => {
    const r = results({
      standings: [row(101, 1), row(102, 2, 9), row(103, 3, 6), row(104, 4, 3), row(105, 5, 1), row(106, 5, 1), row(107, 7, 0)],
    });
    const c = buildStandingsCard({ results: r, season: 'FALL', year: 2026, roomName: 'x', mediaById });
    expect(c.standings.map((s) => [s.titleId, s.rank])).toEqual([
      [101, 1],
      [102, 2],
      [103, 3],
      [104, 4],
      [105, 5],
      [106, 5],
    ]);
  });

  it('holds at most six shows on the top row and six below it, and counts every show sharing first', () => {
    const many = Array.from({ length: 30 }, (_, i) => 300 + i);
    const titled = new Map(many.map((id) => [id, makeMedia({ id: String(id), anilistId: id, title: `Show ${id}` })]));
    const tiedFirst = results({ standings: many.slice(0, 8).map((id) => row(id, 1)), topPicks: [] });
    const first = buildStandingsCard({ results: tiedFirst, season: 'FALL', year: 2026, roomName: 'x', mediaById: titled });
    expect(first.standings).toHaveLength(6);
    expect(first.firstPlaceCount).toBe(8);
    expect(first.hiddenCount).toBe(2);
    expect(cardAltText(first)).toContain('2 more shows in the top five.');
    const tiedSecond = results({ standings: [row(many[0], 1), ...many.slice(1, 8).map((id) => row(id, 2, 9))], topPicks: [] });
    const c = buildStandingsCard({ results: tiedSecond, season: 'FALL', year: 2026, roomName: 'x', mediaById: titled });
    expect(c.standings.map((s) => s.rank)).toEqual([1, 2, 2, 2, 2, 2, 2]);
    expect(c.hiddenCount).toBe(1);
    expect(cardAltText(c)).toContain('1 more show in the top five.');
    expect(card().hiddenCount).toBe(0);
    expect(cardAltText(card())).not.toContain('more show');
  });

  it('prefixes posters with the mount path', () => {
    document.body.dataset.rootPath = '/cour';
    expect(card().standings[0].poster).toBe('/cour/api/poster/101');
  });

  it('labels a show the deck no longer has by its id', () => {
    const r = results({ standings: [{ titleId: 999, points: 12, bestRank: 1, rankedBy: 1, rankedByNames: ['user1'], rank: 1 }] });
    const c = buildStandingsCard({ results: r, season: 'FALL', year: 2026, roomName: 'x', mediaById });
    expect(c.standings[0].title).toBe('#999');
    expect(c.standings[0].poster).toBeUndefined();
  });
});

describe('card text', () => {
  it('reads FINAL once every member has submitted, SO FAR before', () => {
    expect(statusLine(card())).toBe('ALL 2 RANKINGS IN · FINAL');
    expect(statusLine(card({ submittedCount: 1 }))).toBe('1 OF 2 RANKINGS IN · SO FAR');
    expect(statusLine(card({ submittedCount: 1, memberCount: 1 }))).toBe('1 RANKING IN · FINAL');
  });

  it('names whose #1 a show is', () => {
    expect(pickNames(card(), 101)).toEqual(['USER1']);
    expect(pickNames(card(), 103)).toEqual([]);
  });

  it('lists the picks whose show did not make the card', () => {
    const c = card({ topPicks: [
      { titleId: 101, userName: 'user1', title: 'Show 101' },
      { titleId: 105, userName: 'user2', title: 'Show 105' },
    ] });
    expect(offCardPicks(c)).toEqual([{ titleId: 105, userName: 'user2', title: 'Show 105' }]);
    expect(offCardPicks(card())).toEqual([]);
  });

  it('names the file after the season and room', () => {
    expect(cardFilename(card())).toBe('cour-fall-2026-couch-coop.png');
    expect(cardFilename(card({ roomName: '  Movie Night!! ' }))).toBe('cour-fall-2026-movie-night.png');
    expect(cardFilename(card({ roomName: '☆☆' }))).toBe('cour-fall-2026-room.png');
  });
});

describe('cardSignature', () => {
  it('is the same for the same standings in a fresh object', () => {
    expect(cardSignature(card())).toBe(cardSignature(card()));
  });

  it('changes with anything the card shows', () => {
    expect(cardSignature(card({ submittedCount: 1 }))).not.toBe(cardSignature(card()));
    expect(cardSignature(card({ roomName: 'Other' }))).not.toBe(cardSignature(card()));
  });
});

describe('cardAltText', () => {
  it('reads the card in words: rows, rankers, whose #1, and the status', () => {
    expect(cardAltText(card())).toBe(
      'Standings card for Couch-Coop, fall 2026. ' +
        "tied for 1, Show 101, 21 points, ranked by user1 and user2, user1's number 1. " +
        "tied for 1, Show 102, 21 points, ranked by user1 and user2, user2's number 1. " +
        '3, Show 103, 9 points, ranked by user1 and user2. ' +
        '4, Show 106, 6 points, ranked by user2. ' +
        '5, Show 104, 3 points, ranked by user1. ' +
        'all 2 rankings in, final.',
    );
  });

  it('names a #1 that missed the card, and says so far before every ranking is in', () => {
    const c = card({
      submittedCount: 1,
      topPicks: [{ titleId: 105, userName: 'user2', title: 'Show 105' }],
    });
    expect(cardAltText(c)).toContain("user2's number 1 is Show 105.");
    expect(cardAltText(c)).toMatch(/1 of 2 rankings in, so far\.$/);
  });

  it('says 1 point, not 1 points', () => {
    const c = card();
    const last = { ...c.standings[4], points: 1 };
    expect(cardAltText({ ...c, standings: [...c.standings.slice(0, 4), last] })).toContain('5, Show 104, 1 point, ranked by user1.');
  });
});

describe('pickTag', () => {
  it('shows every name when they fit', () => {
    expect(pickTag(measure, ['USER1'], 200)).toBe("USER1'S #1");
    expect(pickTag(measure, ['USER1', 'USER2'], 200)).toBe("USER1 + USER2'S #1");
  });

  it('shortens a long name, never the #1', () => {
    expect(pickTag(measure, ['NINECHARS'], 130)).toBe("NINECHA…'S #1");
  });

  it('counts the rest when several names do not fit', () => {
    expect(pickTag(measure, ['USER1', 'USER2'], 130)).toBe("USER1 +1'S #1");
    expect(pickTag(measure, ['ELEVENCHARS', 'USER2', 'USER3'], 130)).toBe("ELEV… +2'S #1");
  });

  it('has nothing to say for a show nobody picked first', () => {
    expect(pickTag(measure, [], 200)).toBeUndefined();
  });
});

describe('pickLines', () => {
  const pick = (userName: string, title: string) => ({ titleId: 1, userName, title });

  it('puts picks that fit on one line', () => {
    expect(pickLines(measure, [pick('a', 'X'), pick('b', 'Y')], 400, 2)).toEqual(["A'S #1 · X   B'S #1 · Y"]);
  });

  it('wraps onto a second line', () => {
    expect(pickLines(measure, [pick('a', 'XXXXX'), pick('b', 'YYYYY')], 150, 2)).toEqual([
      "A'S #1 · XXXXX",
      "B'S #1 · YYYYY",
    ]);
  });

  it('counts the picks that do not fit, shortening a title to make room', () => {
    const picks = [pick('a', 'XXXXX'), pick('b', 'YYYYY'), pick('c', 'ZZZZZ'), pick('d', 'WWWWW')];
    const lines = pickLines(measure, picks, 220, 2);
    expect(lines).toEqual(["A'S #1 · XXXXX", "B'S #1 · YY…   +2 MORE"]);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(220);
  });

  it('drops picks from the last line to fit the count', () => {
    const picks = [pick('a', 'X'), pick('b', 'Y'), pick('c', 'Z'), pick('d', 'W')];
    expect(pickLines(measure, picks, 240, 1)).toEqual(["A'S #1 · X   +3 MORE"]);
  });

  it('shortens a title too long for a line', () => {
    expect(pickLines(measure, [pick('a', 'A VERY LONG TITLE INDEED')], 150, 2)).toEqual(["A'S #1 · A VER…"]);
  });

  it('returns nothing without picks', () => {
    expect(pickLines(measure, [], 400, 2)).toEqual([]);
  });
});

describe('fitText', () => {
  it('leaves text that fits alone', () => {
    expect(fitText(measure, 'abcdef', 60)).toBe('abcdef');
  });

  it('cuts text that does not fit, ellipsis included in the width', () => {
    expect(fitText(measure, 'abcdefgh', 60)).toBe('abcde…');
    expect(measure(fitText(measure, 'a very long title indeed', 90))).toBeLessThanOrEqual(90);
  });

  it('drops trailing spaces before the ellipsis', () => {
    expect(fitText(measure, 'abcd efgh', 60)).toBe('abcd…');
  });

  it('never splits an emoji', () => {
    expect(fitText(measure, 'RANKED BY USER3\u{1F525} + USER4', 170)).toBe('RANKED BY USER3…');
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(fitText(measure, `AB${family}CD`, 60)).toBe('AB…');
  });
});

describe('wrapText', () => {
  it('wraps on words', () => {
    expect(wrapText(measure, 'one two three', 90, 2)).toEqual(['one two', 'three']);
  });

  it('ellipsizes whatever does not fit on the last line', () => {
    expect(wrapText(measure, 'one two three four five', 90, 2)).toEqual(['one two', 'three fo…']);
  });

  it('cuts a single word longer than the line', () => {
    expect(wrapText(measure, 'supercalifragilistic', 90, 2)).toEqual(['supercal…']);
  });

  it('cuts a long word on an earlier line too', () => {
    expect(wrapText(measure, 'supercalifragilistic word', 90, 2)).toEqual(['supercal…', 'word']);
  });

  it('returns nothing for empty text', () => {
    expect(wrapText(measure, '   ', 90, 2)).toEqual([]);
  });
});
