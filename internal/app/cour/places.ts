/**
 * The standings order and places, shared by the room's standings and the
 * refine round's: more points first, then the show more members ranked,
 * then the better single best rank. Shows level on all three share a
 * place, and the place after them skips (1, 2, 2, 4).
 */

export interface Scored {
  points: number;
  rankedBy: number;
  bestRank: number;
}

/** Standings order; rows level on all three compare equal. */
export const byStanding = (a: Scored, b: Scored): number =>
  b.points - a.points || b.rankedBy - a.rankedBy || a.bestRank - b.bestRank;

/** Rows already in standings order, each given its place. */
export const withPlaces = <T extends Scored>(rows: readonly T[]): Array<T & { rank: number }> => {
  const placed: Array<T & { rank: number }> = [];
  for (const [i, row] of rows.entries()) {
    const prev = placed[i - 1];
    placed.push({ ...row, rank: prev !== undefined && byStanding(prev, row) === 0 ? prev.rank : i + 1 });
  }
  return placed;
};
