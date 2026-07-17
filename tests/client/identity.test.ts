import { describe, it, expect, vi, beforeEach } from 'vitest';

import { loggerMockFactory, makeMedia } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn().mockReturnValue({
    servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
    anime: { season: 'SUMMER', year: 2026 },
  }),
}));

import { Client } from '../../internal/app/reely/client';
import { openDb } from '../../internal/app/cour/db';
import { createCourStore, type CourStore } from '../../internal/app/cour/store';
import type { ReelyProvider } from '../../internal/app/reely/providers/types';
import type { Room } from '../../internal/app/reely/room';
import { makeWs, push, sent, flush } from '../helpers';

// End-to-end handler tests over a real :memory: cour store: the
// passwordless identity (0.12.0) and the verdict flow -- verdicts,
// review, lock-in (incl. the all-locked edge), skip-all, and rankings.

let cour: CourStore;

const makeProvider = (): ReelyProvider =>
  ({
    type: 'anilist',
    options: { url: 'https://graphql.anilist.co' },
    mediaOrdered: true,
    getName: vi.fn().mockResolvedValue('AniList Summer 2026'),
  }) as unknown as ReelyProvider;

// Room double with a real broadcast fan-out (roomPulse and the live
// resultsSuccess push both ride Room.broadcastMessage).
const makeRoomWithTitles = (name: string, titleIds: number[]): Room => {
  const users = new Map<string, Client>();
  return {
    roomName: name,
    displayName: name,
    filters: undefined,
    users,
    media: Promise.resolve(new Map(
      titleIds.map((id) => [String(id), makeMedia({ id: String(id), anilistId: id })]),
    )),
    broadcastMessage(msg: object, sourceUserName?: string) {
      const json = JSON.stringify(msg);
      for (const [userName, client] of users) {
        if (userName !== sourceUserName) client.sendRaw(json);
      }
    },
  } as unknown as Room;
};

const makeWsRoom = (name = 'couch-club'): Room => makeRoomWithTitles(name, [101, 102]);

// Deck variants for the divergence tests (audit 17 H7): the same room
// after an upstream removal / a late-announcement addition.
const makeWsRoomSingleTitle = (name = 'couch-club'): Room => makeRoomWithTitles(name, [101]);

const makeWsRoomWithExtraTitle = (name = 'couch-club'): Room =>
  makeRoomWithTitles(name, [101, 102, 103]);

const makeClient = () => {
  const ws = makeWs();
  const client = new Client(ws, [makeProvider()], cour);
  ws.send.mockClear();
  return { ws, client };
};

const last = (ws: ReturnType<typeof makeWs>, type: string) =>
  sent(ws).filter((m) => m.type === type).at(-1);

beforeEach(() => {
  cour = createCourStore(openDb(':memory:'));
});

describe('login (passwordless identity)', () => {
  it('claims a name, creating the user row on first sight', async () => {
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'User1' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('User1');
    expect(cour.users.byName('user1')?.username).toBe('User1');
  });

  it('re-claims are case-insensitive: USER1 is user1', async () => {
    cour.users.create('User1');
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'USER1' } });
    await flush();
    // The canonical stored casing comes back.
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('User1');
    expect(cour.users.count()).toBe(1);
  });

  it('verdicts survive across logins because the row persists', async () => {
    const first = makeClient();
    push(first.ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    first.client.room = makeWsRoom();
    push(first.ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();

    const second = makeClient();
    push(second.ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    second.client.room = makeWsRoom();
    push(second.ws, { type: 'review' });
    await flush();
    expect(last(second.ws, 'reviewSuccess')?.payload.verdicts).toHaveLength(1);
  });

  it('refuses empty and over-long names', async () => {
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: '   ' } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toContain('1 to 32');
    push(ws, { type: 'login', payload: { userName: 'x'.repeat(40) } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toContain('1 to 32');
  });

  it('refuses NEW identities at the user cap; existing names still log in', async () => {
    // Backstop against unbounded row-minting on the unauthenticated
    // login path (audit 17 M10). Fill to the cap directly in the store.
    cour.users.create('early-bird');
    for (let i = cour.users.count(); i < 2000; i++) {
      cour.users.create(`filler-${i}`);
    }
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'one-too-many' } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toContain('user limit');

    push(ws, { type: 'login', payload: { userName: 'early-bird' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('early-bird');
  });

  it('recovers a lost byName/create race instead of hanging the loser (audit 17 M11)', async () => {
    cour.users.create('user9');
    const realByName = cour.users.byName;
    // First lookup misses (the losing side of a concurrent first login);
    // the create then hits UNIQUE and the handler re-resolves.
    (cour.users as { byName: typeof cour.users.byName }).byName = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementation(realByName);
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user9' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('user9');
  });

  it('refuses a name switch while in a room', async () => {
    const { ws, client } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    client.room = makeWsRoom();
    push(ws, { type: 'login', payload: { userName: 'user6' } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toContain('Leave the room');
    // Identity unchanged.
    expect(client.userName).toBe('user1');
  });
});

describe('verdict / review / lockIn', () => {
  const authedInRoom = async (name: string, room: Room) => {
    const { ws, client } = makeClient();
    push(ws, { type: 'login', payload: { userName: name } });
    await flush();
    client.room = room;
    (room.users as Map<string, Client>).set(name, client);
    ws.send.mockClear();
    return { ws, client };
  };

  it('records a verdict for a title in the room deck', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    expect(last(ws, 'verdictSuccess')?.payload).toEqual({ titleId: 101, verdict: 'like' });
    const user = cour.users.byName('user1');
    const courRoom = cour.rooms.byName('couch-club');
    expect(cour.verdicts.listFor(user?.id as number, courRoom?.id as number)).toHaveLength(1);
  });

  it('rejects a title outside the deck', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 999, verdict: 'like' } });
    await flush();
    expect(last(ws, 'verdictError')?.payload.message).toContain('not in this room');
  });

  it('requires an identity (no login, no verdicts)', async () => {
    const { ws, client } = makeClient();
    client.room = makeWsRoom();
    ws.send.mockClear();
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    expect(last(ws, 'verdictError')?.payload.message).toContain('name');
  });

  it('review returns the ledger, counts, and lock state', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(ws, { type: 'review' });
    await flush();
    const payload = last(ws, 'reviewSuccess')?.payload;
    expect(payload.counts).toEqual({ like: 1, dislike: 0, skip: 1 });
    expect(payload.verdicts).toHaveLength(2);
    expect(payload.lockedAt).toBeNull();
    expect(payload.total).toBe(2);
  });

  it('lockIn seals verdicts; ranking is the post-lock phase', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    // Complete decks: lock-in requires a verdict on every title now.
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(wsG, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsG, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();

    push(wsK, { type: 'lockIn' });
    await flush();
    expect(last(wsK, 'lockInSuccess')?.payload.roomLocked).toBe(false);

    push(wsG, { type: 'lockIn' });
    await flush();
    expect(last(wsG, 'lockInSuccess')?.payload.roomLocked).toBe(true);

    // Post-lock verdicts are refused.
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    await flush();
    expect(last(wsK, 'verdictError')?.payload.message).toContain('locked');
  });

  it('submitRankings: permutation-gated, one shot, pushes live standings to the room', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    // user1 likes both titles; girlfriend likes one.
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    push(wsG, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsG, { type: 'verdict', payload: { titleId: 102, verdict: 'dislike' } });
    await flush();

    // Before lock-in: refused.
    push(wsK, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(wsK, 'submitRankingsError')?.payload.message).toContain('Lock in');

    push(wsK, { type: 'lockIn' });
    push(wsG, { type: 'lockIn' });
    await flush();

    // Not a permutation of the likes: refused (102 is a dislike for g).
    push(wsG, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(wsG, 'submitRankingsError')?.payload.message).toContain('Kept titles');

    // user1 submits: BOTH members get a live resultsSuccess push.
    wsG.send.mockClear();
    push(wsK, { type: 'submitRankings', payload: { rankedTitleIds: [102, 101] } });
    await flush();
    expect(last(wsK, 'submitRankingsSuccess')).toBeDefined();
    const user1Results = last(wsK, 'resultsSuccess')?.payload;
    expect(user1Results?.mySubmitted).toBe(true);
    expect(user1Results?.myRanking).toEqual([102, 101]);
    expect(user1Results?.submittedCount).toBe(1);
    // "Everyone's #1": user1 ranked 102 first, so his top pick is 102.
    expect(user1Results?.topPicks).toEqual([{ userName: 'user1', titleId: 102 }]);
    const gResults = last(wsG, 'resultsSuccess')?.payload;
    expect(gResults?.mySubmitted).toBe(false);
    expect(gResults?.standings[0]).toMatchObject({ titleId: 102, points: 12, rank: 1 });

    // One shot: a resubmit is refused.
    push(wsK, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(wsK, 'submitRankingsError')?.payload.message).toContain('already submitted');

    // girlfriend submits her single like; combined standings shift.
    push(wsG, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    await flush();
    const combined = last(wsG, 'resultsSuccess')?.payload;
    expect(combined?.submittedCount).toBe(2);
    // 101: 9 (user1 #2) + 12 (g #1) = 21; 102: 12.
    expect(combined?.standings[0]).toMatchObject({ titleId: 101, points: 21 });
    expect(combined?.standings[1]).toMatchObject({ titleId: 102, points: 12 });
  });

  it('results returns the payload on request', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'results' });
    await flush();
    const payload = last(ws, 'resultsSuccess')?.payload;
    expect(payload).toMatchObject({
      submittedCount: 0,
      mySubmitted: false,
      myRanking: [],
      standings: [],
    });
  });

  it('skipRemaining skips every unverdicted title in one call', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    push(ws, { type: 'skipRemaining' });
    await flush();
    expect(last(ws, 'skipRemainingSuccess')?.payload.skipped).toBe(1);
    const user = cour.users.byName('user1');
    const courRoom = cour.rooms.byName('couch-club');
    const rows = cour.verdicts.listFor(user?.id as number, courRoom?.id as number);
    // The earlier like is untouched; only the rest became skips.
    expect(rows.map((r) => r.verdict).sort()).toEqual(['like', 'skip']);
  });

  it('skipRemaining after lock-in is refused', async () => {
    const room = makeWsRoom();
    const { ws, client } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(ws, { type: 'lockIn' });
    await flush();
    // A late announcement grows the deck AFTER the lock: skip-all must
    // not write through the lock.
    client.room = makeWsRoomWithExtraTitle();
    push(ws, { type: 'skipRemaining' });
    await flush();
    expect(last(ws, 'skipRemainingError')?.payload.message).toContain('locked');
  });

  it('a retried lockIn does not re-fire the room-locked celebration', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(ws, { type: 'lockIn' });
    await flush();
    expect(last(ws, 'lockInSuccess')?.payload.roomLocked).toBe(true);

    // Double-tap / stale-button retry: idempotent lock, no second party.
    push(ws, { type: 'lockIn' });
    await flush();
    expect(last(ws, 'lockInSuccess')?.payload.roomLocked).toBe(false);
  });

  it('a connected partner with zero verdicts holds the room unlocked', async () => {
    // Membership rows are lazily created on the first verdict-flow
    // message; before the fix a partner who had joined but not yet
    // verdicted had no row to count and allLocked fired prematurely.
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    await authedInRoom('girlfriend', room); // joined, zero verdicts
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(wsK, { type: 'lockIn' });
    await flush();
    expect(last(wsK, 'lockInSuccess')?.payload.roomLocked).toBe(false);
  });

  // ── Member pulse payload + roomPulse push (audit 17 UX 3/7/11) ──

  it('review carries per-member lock/submit state', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(wsG, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    push(wsK, { type: 'lockIn' });
    await flush();
    push(wsG, { type: 'review' });
    await flush();
    const members = last(wsG, 'reviewSuccess')?.payload.members;
    expect(members).toEqual([
      { userName: 'user1', locked: true, submitted: false },
      { userName: 'girlfriend', locked: false, submitted: false },
    ]);
  });

  it('locking in pushes roomPulse to the OTHER members only', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    for (const ws of [wsK, wsG]) {
      push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
      push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    }
    await flush();
    // Discard the member-join pulses so the lock assertions below see
    // only lock traffic.
    wsK.send.mockClear();
    wsG.send.mockClear();

    push(wsK, { type: 'lockIn' });
    await flush();
    // The partner sees the pulse; the locker does not (their own state
    // rides lockInSuccess, avoiding a duplicate celebration).
    expect(last(wsK, 'roomPulse')).toBeUndefined();
    const pulse = last(wsG, 'roomPulse')?.payload;
    expect(pulse?.allLocked).toBe(false);
    expect(pulse?.members).toContainEqual({ userName: 'user1', locked: true, submitted: false });

    push(wsG, { type: 'lockIn' });
    await flush();
    // The FINAL lock's pulse carries the all-locked edge to the others.
    expect(last(wsK, 'roomPulse')?.payload.allLocked).toBe(true);
  });

  it('a NEW member joining the verdict flow pulses the others (audit v1.2.0 low)', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    wsK.send.mockClear();

    // A second member's FIRST verdict-flow message creates their row --
    // everyone else's "N OF M LOCKED" line updates now, not at the next
    // lock event. allLocked is false by construction, so no celebration.
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    push(wsG, { type: 'review' });
    await flush();
    const pulse = last(wsK, 'roomPulse')?.payload;
    expect(pulse?.allLocked).toBe(false);
    expect(pulse?.members).toContainEqual({
      userName: 'girlfriend', locked: false, submitted: false,
    });

    // Repeat traffic from the SAME member does not re-pulse.
    wsK.send.mockClear();
    push(wsG, { type: 'review' });
    await flush();
    expect(last(wsK, 'roomPulse')).toBeUndefined();
  });

  it('standings rows carry who ranked them by name', async () => {
    const room = makeWsRoom();
    const { ws: wsK } = await authedInRoom('user1', room);
    const { ws: wsG } = await authedInRoom('girlfriend', room);
    push(wsK, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsK, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(wsG, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(wsG, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    await flush();
    push(wsK, { type: 'lockIn' });
    push(wsG, { type: 'lockIn' });
    await flush();
    push(wsK, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    push(wsG, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    push(wsK, { type: 'results' });
    await flush();
    const payload = last(wsK, 'resultsSuccess')?.payload;
    const top = payload?.standings.find((row: { titleId: number }) => row.titleId === 101);
    expect(top?.rankedByNames).toEqual(['girlfriend', 'user1']);
    expect(payload?.members).toEqual([
      { userName: 'user1', locked: true, submitted: true },
      { userName: 'girlfriend', locked: true, submitted: true },
    ]);
  });

  // ── Deck/ledger divergence (audit 17 H7) ──

  it('lockIn is refused while titles remain unverdicted', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    push(ws, { type: 'lockIn' });
    await flush();
    expect(last(ws, 'lockInError')?.payload.message).toContain('still need a verdict');
    const user = cour.users.byName('user1');
    const courRoom = cour.rooms.byName('couch-club');
    expect(cour.members.get(courRoom?.id as number, user?.id as number)?.lockedAt).toBeNull();
  });

  it('re-locking stays idempotent even after the deck grows', async () => {
    const room = makeWsRoom();
    const { ws, client } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(ws, { type: 'lockIn' });
    await flush();
    const lockedAt = last(ws, 'lockInSuccess')?.payload.lockedAt;
    expect(lockedAt).toBeTruthy();

    // Deck grows post-lock (late announcement); a lock-state readback
    // must not error on the new unverdicted title.
    client.room = makeWsRoomWithExtraTitle();
    push(ws, { type: 'lockIn' });
    await flush();
    expect(last(ws, 'lockInSuccess')?.payload.lockedAt).toBe(lockedAt);
  });

  it('review scopes the ledger to the current deck (no orphan rows)', async () => {
    const room = makeWsRoom();
    const { ws, client } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();

    // Title 102 vanishes from the deck (delayed show pulled upstream).
    client.room = makeWsRoomSingleTitle();
    push(ws, { type: 'review' });
    await flush();
    const payload = last(ws, 'reviewSuccess')?.payload;
    // The orphaned 102 verdict never reaches the wire: no "2 / 1".
    expect(payload.total).toBe(1);
    expect(payload.verdicts).toHaveLength(1);
    expect(payload.verdicts[0].titleId).toBe(101);
    expect(payload.counts).toEqual({ like: 1, dislike: 0, skip: 0 });
  });

  it('submitRankings excludes orphaned likes from the permutation', async () => {
    const room = makeWsRoom();
    const { ws, client } = await authedInRoom('user1', room);
    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    await flush();
    push(ws, { type: 'lockIn' });
    await flush();

    // Liked title 102 vanishes from the deck post-lock: ranking it would
    // seed a poster-less standings row that soaks up points forever.
    // (Re-register the client in the swapped room's user map so the
    // live resultsSuccess push after submit still reaches it.)
    const shrunk = makeWsRoomSingleTitle();
    (shrunk.users as Map<string, Client>).set('user1', client);
    client.room = shrunk;
    push(ws, { type: 'submitRankings', payload: { rankedTitleIds: [102, 101] } });
    await flush();
    expect(last(ws, 'submitRankingsError')?.payload.message).toContain('Kept titles');

    push(ws, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    await flush();
    expect(last(ws, 'submitRankingsSuccess')).toBeDefined();
    const results = last(ws, 'resultsSuccess')?.payload;
    expect(results?.standings.map((s: { titleId: number }) => s.titleId)).toEqual([101]);
  });

});

