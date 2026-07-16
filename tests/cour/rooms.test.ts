import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../../internal/app/cour/db';
import {
  createCourStore,
  MemberLockedError,
  type CourStore,
} from '../../internal/app/cour/store';

// Rooms / members / verdicts / results (0.5.0 storage half).
let store: CourStore;
let roomId: number;
let user1: number;
let user2: number;

beforeEach(() => {
  store = createCourStore(openDb(':memory:'));
  user1 = store.users.create('user1').id;
  user2 = store.users.create('user2').id;
  roomId = store.rooms.create({
    name: 'couch-club',
    displayName: 'Couch-Club',
    season: 'SUMMER',
    year: 2026,
  }).id;
  store.members.ensure(roomId, user1);
  store.members.ensure(roomId, user2);
});

describe('rooms', () => {
  it('round-trips filters as JSON and reads back typed fields', () => {
    store.rooms.updateFilters(roomId, [{ key: 'genre', operator: '=', value: ['Action'] }]);
    const room = store.rooms.byName('couch-club');
    expect(room?.season).toBe('SUMMER');
    expect(room?.year).toBe(2026);
    expect(room?.filters).toEqual([{ key: 'genre', operator: '=', value: ['Action'] }]);
    expect(room?.showSequels).toBe(false);
  });

  it('delete leaves users intact (the rotation reaper kills rooms, not identities)', () => {
    store.verdicts.upsert(user1, roomId, 101, 'like');
    store.members.lock(roomId, user1);
    store.members.lock(roomId, user2);
    store.rankings.submit(user1, roomId, [101]);

    expect(store.rooms.delete(roomId)).toBe(true);

    expect(store.rooms.byName('couch-club')).toBeUndefined();
    // Users are global identities and survive every season.
    expect(store.users.byId(user1)?.username).toBe('user1');
    expect(store.users.byId(user2)?.username).toBe('user2');
    // A reused name simply creates fresh.
    const reborn = store.rooms.create({
      name: 'couch-club', displayName: 'Couch-Club', season: 'FALL', year: 2026,
    });
    expect(reborn.id).not.toBe(roomId);
    expect(store.members.list(reborn.id)).toEqual([]);
  });

  it('delete cascades to members, verdicts, and rankings', () => {
    store.verdicts.upsert(user1, roomId, 101, 'like');
    store.members.lock(roomId, user1);
    store.members.lock(roomId, user2);
    store.rankings.submit(user1, roomId, [101]);
    expect(store.rankings.standings(roomId).length).toBeGreaterThan(0);
    expect(store.rooms.delete(roomId)).toBe(true);
    expect(store.rankings.standings(roomId)).toEqual([]);
    expect(store.members.list(roomId)).toEqual([]);
  });
});

describe('members', () => {
  it('ensure is idempotent', () => {
    store.members.ensure(roomId, user1);
    store.members.ensure(roomId, user1);
    expect(store.members.list(roomId)).toHaveLength(2);
  });

  it('lock reports allLocked only on the last member', () => {
    const first = store.members.lock(roomId, user1);
    expect(first.allLocked).toBe(false);
    const second = store.members.lock(roomId, user2);
    expect(second.allLocked).toBe(true);
  });

  it('lock is idempotent and keeps the original timestamp', () => {
    const first = store.members.lock(roomId, user1);
    const again = store.members.lock(roomId, user1);
    expect(again.lockedAt).toBe(first.lockedAt);
  });

  it('lock throws for a non-member', () => {
    const user3 = store.users.create('user3').id;
    expect(() => store.members.lock(roomId, user3)).toThrow(/not a member/);
  });
});

describe('verdicts', () => {
  it('upsert changes an existing verdict in place (tap-to-change)', () => {
    store.verdicts.upsert(user1, roomId, 101, 'like');
    store.verdicts.upsert(user1, roomId, 101, 'skip');
    const list = store.verdicts.listFor(user1, roomId);
    expect(list).toHaveLength(1);
    expect(list[0].verdict).toBe('skip');
  });

  it('refuses new/changed verdicts after the member locks in', () => {
    store.verdicts.upsert(user1, roomId, 101, 'like');
    store.members.lock(roomId, user1);
    expect(() => store.verdicts.upsert(user1, roomId, 101, 'dislike')).toThrow(MemberLockedError);
    expect(() => store.verdicts.upsert(user1, roomId, 999, 'like')).toThrow(MemberLockedError);
  });

  it('keeps per-user ledgers separate', () => {
    store.verdicts.upsert(user1, roomId, 101, 'like');
    store.verdicts.upsert(user2, roomId, 101, 'dislike');
    expect(store.verdicts.listFor(user1, roomId)[0].verdict).toBe('like');
    expect(store.verdicts.listFor(user2, roomId)[0].verdict).toBe('dislike');
  });
});

describe('rankings (the couple-profile scoring, 0.13.0)', () => {
  const lockAndSubmit = (userId: number, order: number[]) => {
    store.members.ensure(roomId, userId);
    store.members.lock(roomId, userId);
    store.rankings.submit(userId, roomId, order);
  };

  it('refuses a submit before lock-in, and a resubmit after', () => {
    store.members.ensure(roomId, user1);
    expect(() => store.rankings.submit(user1, roomId, [101])).toThrow(/Lock in/);
    store.members.lock(roomId, user1);
    store.rankings.submit(user1, roomId, [101, 102]);
    expect(() => store.rankings.submit(user1, roomId, [102, 101])).toThrow(/already submitted/);
    expect(store.rankings.hasSubmitted(user1, roomId)).toBe(true);
    expect(store.rankings.forUser(user1, roomId)).toEqual([101, 102]);
  });

  it('scores top five 12/9/6/3/1 and combines across submitters', () => {
    const user4 = store.users.create('user4').id;
    lockAndSubmit(user1, [101, 102, 103, 104, 105, 106]);
    lockAndSubmit(user4, [102, 101]);
    const standings = store.rankings.standings(roomId);
    // 101: 12 (user1 #1) + 9 (user2 #2) = 21; 102: 9 + 12 = 21 -- tie on
    // points, broken by best single rank (both have a #1... user2 gave
    // 102 a #1 and user1 gave 101 a #1: bestRank ties at 1, so titleId).
    expect(standings[0]).toMatchObject({ titleId: 101, points: 21, rank: 1 });
    expect(standings[1]).toMatchObject({ titleId: 102, points: 21, rank: 2 });
    // User1's #6 scored zero but still appears, ranked by the others.
    const deep = standings.find((row) => row.titleId === 106);
    expect(deep?.points).toBe(0);
  });

  it('breaks point ties by the better single best rank', () => {
    const user4 = store.users.create('user4').id;
    const user5 = store.users.create('user5').id;
    lockAndSubmit(user1, [201, 202]);
    lockAndSubmit(user4, [301, 302]);
    lockAndSubmit(user5, [302, 301]);
    // 301: 12 + 9 = 21; 302: 9 + 12 = 21; bestRank both 1 -> titleId.
    const standings = store.rankings.standings(roomId);
    const s301 = standings.find((row) => row.titleId === 301);
    const s302 = standings.find((row) => row.titleId === 302);
    expect(s301?.points).toBe(21);
    expect(s302?.points).toBe(21);
    expect((s301?.rank ?? 0) < (s302?.rank ?? 0)).toBe(true);
  });

  it('progress reports submitted over member count', () => {
    const user4 = store.users.create('user4').id;
    store.members.ensure(roomId, user1);
    store.members.ensure(roomId, user4);
    store.members.lock(roomId, user1);
    store.rankings.submit(user1, roomId, [101]);
    // beforeEach already seats user2 in the room, so three members total.
    expect(store.rankings.progress(roomId)).toEqual({ submitted: 1, members: 3 });
  });

  it("topPicks returns each submitter's #1 with their name, ordered by name", () => {
    lockAndSubmit(user1, [102, 101]); // user1's #1 = 102
    lockAndSubmit(user2, [101, 103]); // user2's #1 = 101
    expect(store.rankings.topPicks(roomId)).toEqual([
      { userName: 'user1', titleId: 102 },
      { userName: 'user2', titleId: 101 },
    ]);
  });

  it('topPicks omits members who have not submitted', () => {
    lockAndSubmit(user1, [101, 102]);
    // user2 is a member but never submitted -> not in topPicks.
    expect(store.rankings.topPicks(roomId)).toEqual([{ userName: 'user1', titleId: 101 }]);
  });
});

