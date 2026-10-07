import { describe, expect, it } from 'vitest';
import { byStanding, withPlaces } from '../../internal/app/cour/places';

const row = (id: number, points: number, rankedBy: number, bestRank: number) => ({ id, points, rankedBy, bestRank });

describe('byStanding', () => {
  it('puts more points first, then more rankers, then the better best place', () => {
    const rows = [row(1, 9, 2, 2), row(2, 12, 1, 1), row(3, 12, 2, 2), row(4, 12, 2, 1)];
    expect([...rows].sort(byStanding).map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it('finds rows level on all three equal', () => {
    expect(byStanding(row(1, 21, 2, 1), row(2, 21, 2, 1))).toBe(0);
  });
});

describe('withPlaces', () => {
  it('shares a place among level rows, and the next place skips', () => {
    const placed = withPlaces([row(1, 27, 3, 1), row(2, 27, 3, 1), row(3, 27, 3, 1), row(4, 6, 1, 3), row(5, 6, 1, 3), row(6, 1, 1, 5)]);
    expect(placed.map((r) => r.rank)).toEqual([1, 1, 1, 4, 4, 6]);
  });

  it('numbers rows in order when none are level', () => {
    expect(withPlaces([row(1, 12, 1, 1), row(2, 9, 1, 2), row(3, 9, 1, 3)]).map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('keeps every field of the rows it places', () => {
    expect(withPlaces([row(7, 12, 1, 1)])).toEqual([{ id: 7, points: 12, rankedBy: 1, bestRank: 1, rank: 1 }]);
  });
});
