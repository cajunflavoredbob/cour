import { describe, expect, it } from 'vitest';
import { openDb } from '../../internal/app/cour/db';
import { createCourStore } from '../../internal/app/cour/store';
import {
  byName,
  POSITION_POINTS,
  refinedFor,
  refinedOrder,
  type RefineMember,
  refineRound,
  scoreOrders,
  sharedTitleIds,
} from '../../internal/app/cour/refine';

describe('sharedTitleIds', () => {
  it('keeps the titles every order has, in base order', () => {
    expect(sharedTitleIds([[1, 2, 3, 4], [4, 3, 9, 1]], [9, 4, 3, 2, 1])).toEqual([4, 3, 1]);
  });

  it('needs two orders or more', () => {
    expect(sharedTitleIds([[1, 2]], [1, 2])).toEqual([]);
    expect(sharedTitleIds([], [1])).toEqual([]);
  });

  it('is empty when a member ranked nothing', () => {
    expect(sharedTitleIds([[1, 2], []], [1, 2])).toEqual([]);
  });
});

describe('refinedOrder', () => {
  const shared = [3, 1, 4];

  it('cuts the ranking down to the shared titles before a refine', () => {
    expect(refinedOrder([5, 4, 1, 2, 3], [], shared)).toEqual([4, 1, 3]);
  });

  it('keeps a refine as made', () => {
    expect(refinedOrder([5, 4, 1, 2, 3], [3, 4, 1], shared)).toEqual([3, 4, 1]);
  });

  it('drops titles no longer shared and appends missing ones in ranking order', () => {
    expect(refinedOrder([4, 1, 3], [7, 3], shared)).toEqual([3, 4, 1]);
  });

  it('never repeats a title', () => {
    expect(refinedOrder([4, 1, 3], [3, 3, 4], shared)).toEqual([3, 4, 1]);
  });
});

describe('scoreOrders', () => {
  it('scores positions 12/9/6/3/1 and nothing deeper', () => {
    expect(POSITION_POINTS).toEqual([12, 9, 6, 3, 1]);
    const rows = scoreOrders([{ userName: 'user1', order: [1, 2, 3, 4, 5, 6] }]);
    expect(rows.map((s) => [s.titleId, s.points, s.rank])).toEqual([
      [1, 12, 1],
      [2, 9, 2],
      [3, 6, 3],
      [4, 3, 4],
      [5, 1, 5],
      [6, 0, 6],
    ]);
  });

  it('breaks point ties by the better best position, then the lower title id', () => {
    const rows = scoreOrders([
      { userName: 'user1', order: [7, 5] },
      { userName: 'user2', order: [5, 7] },
      { userName: 'user3', order: [9, 8] },
    ]);
    // 7 and 5 both score 21 with a best of 1; 9 scores 12; 8 scores 9.
    expect(rows.map((s) => s.titleId)).toEqual([5, 7, 9, 8]);
    expect(rows[0]).toMatchObject({ points: 21, bestRank: 1, rankedBy: 2 });
  });

  it('names the rankers in name order, ignoring ASCII case', () => {
    const [row] = scoreOrders([
      { userName: 'User2', order: [1] },
      { userName: 'user1', order: [1] },
    ]);
    expect(row.rankedByNames).toEqual(['user1', 'User2']);
    expect(row.rankedBy).toBe(2);
  });

  it('matches the store standings for the same rankings', () => {
    const store = createCourStore(openDb(':memory:'));
    const room = store.rooms.create({ name: 'r1', displayName: 'r1', season: 'SUMMER', year: 2026 });
    const orders: Record<string, number[]> = {
      user1: [5, 3, 8, 1, 2, 9],
      user2: [3, 5, 2, 7],
      user3: [8, 1, 3],
      user4: [9, 7, 5, 3, 1, 2, 8],
    };
    for (const [name, order] of Object.entries(orders)) {
      const user = store.users.create(name);
      store.members.ensure(room.id, user.id);
      store.members.lock(room.id, user.id);
      store.rankings.submit(user.id, room.id, order);
    }
    const scored = scoreOrders(Object.entries(orders).map(([userName, order]) => ({ userName, order })));
    expect(scored.map(({ rankedByNames: _, ...row }) => row)).toEqual(store.rankings.standings(room.id));
  });
});

describe('byName', () => {
  it("orders names as SQLite's NOCASE does, beyond ASCII too", () => {
    const db = openDb(':memory:');
    const store = createCourStore(db);
    // Fullwidth letters sit above emoji in UTF-16 but below them in UTF-8.
    const names = ['\u{1F600}bob', '\uFF22ob', 'User2', 'user1', 'ab', 'Abc', '\u00E9cole', 'zed'];
    for (const name of names) store.users.create(name);
    const sql = (db.prepare('SELECT username FROM users ORDER BY username COLLATE NOCASE').all() as Array<{ username: string }>)
      .map((r) => r.username);
    expect([...names].sort(byName)).toEqual(sql);
  });
});

describe('refineRound', () => {
  const members: RefineMember[] = [
    { userName: 'user1', ranking: [1, 2, 3, 4], refine: [], refined: false },
    { userName: 'user2', ranking: [4, 3, 9, 1], refine: [], refined: false },
  ];
  const standingsOrder = [4, 1, 3, 9, 2];

  const viewed = (list: readonly RefineMember[], me: string | undefined) => {
    const round = refineRound(list, true, standingsOrder);
    return round && refinedFor(round, me);
  };

  it('stays closed until two or more members have all submitted', () => {
    expect(refineRound(members, false, standingsOrder)).toBeUndefined();
    expect(refineRound(members.slice(0, 1), true, standingsOrder)).toBeUndefined();
  });

  it('opens with each member counted by their ranking cut down to the shared titles', () => {
    const r = viewed(members, 'user1');
    expect(r).toMatchObject({ sharedTitleIds: [4, 1, 3], refinedCount: 0, myRefined: false, myOrder: [1, 3, 4] });
    // user1 scores 1, 3, 4 as 12, 9, 6; user2 scores 4, 3, 1 as 12, 9, 6.
    expect(r?.standings.map((s) => [s.titleId, s.points])).toEqual([
      [1, 18],
      [4, 18],
      [3, 18],
    ]);
    expect(r?.topPicks).toEqual([
      { userName: 'user1', titleId: 1 },
      { userName: 'user2', titleId: 4 },
    ]);
  });

  it('lists the shared #1s in name order', () => {
    expect(viewed([members[1], members[0]], 'user1')?.topPicks).toEqual([
      { userName: 'user1', titleId: 1 },
      { userName: 'user2', titleId: 4 },
    ]);
  });

  it('counts a refine and reports it to the member who made it', () => {
    const withRefine = [{ ...members[0], refine: [3, 4, 1], refined: true }, members[1]];
    const mine = viewed(withRefine, 'user1');
    expect(mine).toMatchObject({ refinedCount: 1, myRefined: true, myOrder: [3, 4, 1] });
    expect(mine?.standings.map((s) => [s.titleId, s.points])).toEqual([
      [3, 21],
      [4, 21],
      [1, 12],
    ]);
    expect(viewed(withRefine, 'user2')).toMatchObject({
      myRefined: false,
      myOrder: [4, 3, 1],
    });
  });

  it('gives a viewer who is not a member an empty order', () => {
    expect(viewed(members, 'user9')).toMatchObject({ myOrder: [], myRefined: false });
    expect(viewed(members, undefined)).toMatchObject({ myOrder: [], myRefined: false });
  });

  it('puts nothing internal on the wire', () => {
    expect(Object.keys(viewed(members, 'user1') ?? {}).sort()).toEqual([
      'myOrder',
      'myRefined',
      'refinedCount',
      'sharedTitleIds',
      'standings',
      'topPicks',
    ]);
  });
});
