import { describe, expect, it } from 'vitest';
import { groupTopPicks, rankedByText, rankingsIn, rerankedByText, standingsFinal } from '../../web/app/src/utils/standingsText';

describe('standingsFinal', () => {
  it('is final once every member has submitted', () => {
    expect(standingsFinal(2, 2)).toBe(true);
    expect(standingsFinal(1, 2)).toBe(false);
    expect(standingsFinal(1, 1)).toBe(true);
  });

  it('is never final for an empty room', () => {
    expect(standingsFinal(0, 0)).toBe(false);
  });
});

describe('rankingsIn', () => {
  it('counts the rankings in', () => {
    expect(rankingsIn(3, 3)).toBe('ALL 3 RANKINGS IN');
    expect(rankingsIn(1, 3)).toBe('1 OF 3 RANKINGS IN');
  });

  it('speaks of a single ranking in a room of one', () => {
    expect(rankingsIn(1, 1)).toBe('1 RANKING IN');
    expect(rankingsIn(0, 1)).toBe('0 OF 1 RANKING IN');
  });
});

describe('rerankedByText', () => {
  it('names who re-ranked, as the rows name rankers, and says nothing while nobody has', () => {
    expect(rerankedByText([])).toBe('');
    expect(rerankedByText(['user9'])).toBe('RE-RANKED BY USER9');
    expect(rerankedByText(['user10', 'user9'])).toBe('RE-RANKED BY USER10 + USER9');
  });
});

describe('groupTopPicks', () => {
  it('puts members with the same #1 under one show, in first-seen order', () => {
    expect(
      groupTopPicks([
        { userName: 'user10', titleId: 1 },
        { userName: 'user18', titleId: 2 },
        { userName: 'user9', titleId: 2 },
      ]),
    ).toEqual([
      { titleId: 1, names: ['user10'] },
      { titleId: 2, names: ['user18', 'user9'] },
    ]);
    expect(groupTopPicks([])).toEqual([]);
  });
});

describe('rankedByText', () => {
  it('names who ranked a show', () => {
    expect(rankedByText(['user1', 'user2'], 2)).toBe('RANKED BY USER1 + USER2');
    expect(rankedByText(['user1'], 1)).toBe('RANKED BY USER1');
  });

  it('counts the rankers when the names are missing, or says nothing for one', () => {
    expect(rankedByText(undefined, 3)).toBe('RANKED BY 3');
    expect(rankedByText([], 3)).toBe('RANKED BY 3');
    expect(rankedByText([], 1)).toBe('');
  });
});
