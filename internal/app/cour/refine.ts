import type { RankingStanding, RefinedResults } from '../../../types/reely';
import { byStanding, withPlaces } from './places';

/**
 * The refine round: once every member's ranking is in, a member may
 * re-rank just the titles every member ranked. Until they do, their order
 * is their own ranking cut down to those titles, so the standings over
 * those titles are whole from the moment the round opens and refining
 * stays optional.
 */

/** Points by position, #1 first, as the ranking standings score them. */
export const POSITION_POINTS: readonly number[] = [12, 9, 6, 3, 1];

const utf8 = new TextEncoder();

/** SQLite's NOCASE order: ASCII letters folded, then the UTF-8 bytes compared. */
export const byName = (a: string, b: string): number => {
  const fold = (name: string) => utf8.encode(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  const x = fold(a);
  const y = fold(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
};

/** Titles present in every order, in `base` order. Needs two orders or more. */
export const sharedTitleIds = (
  orders: ReadonlyArray<readonly number[]>,
  base: readonly number[],
): number[] => {
  if (orders.length < 2) return [];
  const sets = orders.map((order) => new Set(order));
  return base.filter((id) => sets.every((set) => set.has(id)));
};

/**
 * A member's order over the shared titles. A refine keeps its order; titles
 * no longer shared drop out, and shared titles it lacks follow in the
 * member's ranking order. Without a refine, the ranking cut down to the
 * shared titles.
 */
export const refinedOrder = (
  ranking: readonly number[],
  refine: readonly number[],
  shared: readonly number[],
): number[] => {
  const sharedSet = new Set(shared);
  const out: number[] = [];
  const placed = new Set<number>();
  for (const id of [...refine, ...ranking, ...shared]) {
    if (sharedSet.has(id) && !placed.has(id)) {
      placed.add(id);
      out.push(id);
    }
  }
  return out;
};

/**
 * Standings over full orders, by the ranking standings' rule: points by
 * position, ordered and placed by places.ts; within a shared place, by
 * the lower title id.
 */
export const scoreOrders = (
  members: ReadonlyArray<{ userName: string; order: readonly number[] }>,
): RankingStanding[] => {
  const rows = new Map<number, { points: number; bestRank: number; names: string[] }>();
  for (const { userName, order } of members) {
    order.forEach((titleId, i) => {
      const row = rows.get(titleId) ?? { points: 0, bestRank: Number.POSITIVE_INFINITY, names: [] };
      row.points += POSITION_POINTS[i] ?? 0;
      row.bestRank = Math.min(row.bestRank, i + 1);
      row.names.push(userName);
      rows.set(titleId, row);
    });
  }
  const scored = [...rows.entries()].map(([titleId, row]) => ({
    titleId,
    points: row.points,
    bestRank: row.bestRank,
    rankedBy: row.names.length,
    rankedByNames: [...row.names].sort(byName),
  }));
  return withPlaces(scored.sort((a, b) => byStanding(a, b) || a.titleId - b.titleId));
};

export interface RefineMember {
  userName: string;
  ranking: readonly number[];
  refine: readonly number[];
  refined: boolean;
}

/** The round as the whole room sees it. */
export interface RefineRound {
  sharedTitleIds: number[];
  refinedCount: number;
  standings: RankingStanding[];
  orders: ReadonlyMap<string, number[]>;
  refined: ReadonlySet<string>;
}

/**
 * The refine round over members who have all submitted a ranking (the
 * caller checks), or undefined for fewer than two. `standingsOrder` is the
 * ranking standings' title order.
 */
export const refineRound = (
  members: readonly RefineMember[],
  standingsOrder: readonly number[],
): RefineRound | undefined => {
  if (members.length < 2) return undefined;
  const shared = sharedTitleIds(
    members.map((m) => m.ranking),
    standingsOrder,
  );
  const orders = members.map((m) => ({ userName: m.userName, order: refinedOrder(m.ranking, m.refine, shared) }));
  return {
    sharedTitleIds: shared,
    refinedCount: members.filter((m) => m.refined).length,
    standings: scoreOrders(orders),
    orders: new Map(orders.map((o) => [o.userName, o.order])),
    refined: new Set(members.filter((m) => m.refined).map((m) => m.userName)),
  };
};

/** The round as one member (by name) sees it; a non-member gets an empty order. */
export const refinedFor = (round: RefineRound, me: string | undefined): RefinedResults => ({
  sharedTitleIds: round.sharedTitleIds,
  refinedCount: round.refinedCount,
  myRefined: me != null && round.refined.has(me),
  myOrder: (me != null ? round.orders.get(me) : undefined) ?? [],
  standings: round.standings,
});
