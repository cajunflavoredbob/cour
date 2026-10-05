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
import { logger } from '../../internal/app/reely/logger';
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
  // A standalone function rather than `this.broadcastMessage`: inside an
  // object literal that is cast to Room, `this` types as {} and the
  // notify* helpers below would not compile.
  const broadcastMessage = (msg: object, sourceUserName?: string) => {
    const json = JSON.stringify(msg);
    for (const [userName, client] of users) {
      if (userName !== sourceUserName) client.sendRaw(json);
    }
  };
  return {
    roomName: name,
    displayName: name,
    filters: undefined,
    users,
    // saveRoom reads room.routeContext.cour, so the disconnect-time save
    // needs this or it throws inside handleClose before the assertion.
    get routeContext() {
      return { providers: [], cour };
    },
    media: Promise.resolve(new Map(
      titleIds.map((id) => [String(id), makeMedia({ id: String(id), anilistId: id })]),
    )),
    broadcastMessage,
    // Real Room fans these out via broadcastMessage; the disconnect path
    // (leaveRoomCleanup) calls notifyLeave, so the double needs them or a
    // close-event test dies inside the cleanup before reaching its
    // assertion.
    notifyJoin: (user: { userName: string }) =>
      broadcastMessage({ type: 'userJoinedRoom', payload: user }, user.userName),
    notifyLeave: (user: { userName: string }) =>
      broadcastMessage({ type: 'userLeftRoom', payload: user }, user.userName),
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

// A provider that has fallen back to the previous season and knows it.
const makeProvisionalProvider = (): ReelyProvider =>
  ({
    type: 'anilist',
    options: { url: 'https://graphql.anilist.co' },
    mediaOrdered: true,
    getName: vi.fn().mockResolvedValue('AniList Summer 2026'),
    getSeason: () => ({ season: 'SUMMER', year: 2026 }),
    isSeasonProvisional: () => true,
  }) as unknown as ReelyProvider;

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

  it('claims a new name without bidi controls or invisible marks', async () => {
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user1\u{202E}\u{200B}' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('user1');
    expect(cour.users.byName('user1')?.username).toBe('user1');
  });

  it('logs a name already on file in as stored, invisible marks and all', async () => {
    cour.users.create('user1\u{200B}');
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user1\u{200B}' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('user1\u{200B}');
    expect(cour.users.count()).toBe(1);
  });

  it('logs in a name on file made only of characters a new name may not carry', async () => {
    cour.users.create('\u{3164}');
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: '\u{3164}' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('\u{3164}');
    expect(cour.users.count()).toBe(1);
  });

  it('refuses an overlong name before cleaning or looking it up', async () => {
    const { ws } = makeClient();
    // Cleans down to a valid "ab", but no real name is this long.
    push(ws, { type: 'login', payload: { userName: `a${'\u{200B}'.repeat(300)}b` } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toMatch(/1 to \d+ characters/);
    expect(cour.users.count()).toBe(0);
  });

  it('reads a look-alike of a name on file as that name', async () => {
    cour.users.create('user1');
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user1\u{2060}' } });
    await flush();
    expect(last(ws, 'loginSuccess')?.payload.userName).toBe('user1');
    expect(cour.users.count()).toBe(1);
  });

  it('refuses a name made only of stripped characters', async () => {
    const { ws } = makeClient();
    push(ws, { type: 'login', payload: { userName: '\u{202E}\u{200B}' } });
    await flush();
    expect(last(ws, 'loginError')?.payload.message).toMatch(/1 to \d+ characters/);
    expect(cour.users.count()).toBe(0);
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

  it('does not mint a room row on disconnect while the season is settling', async () => {
    // saveRoom is create-if-absent and stamps with resolveRoomSeason,
    // which returns the PROVISIONAL season while the lockout holds. A
    // disconnect is the one room-row write that no refusal path covers,
    // so without this gate it mints an orphan row under a season the
    // reaper deletes as soon as the real one lands.
    const room = makeWsRoom();
    const ws = makeWs();
    const client = new Client(ws, [makeProvisionalProvider()], cour);
    push(ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    client.room = room;
    (room.users as Map<string, Client>).set('user1', client);

    vi.mocked(logger.warn).mockClear();
    // The socket closes.
    ws.emit('close');
    await flush();
    expect(cour.rooms.byName('couch-club')).toBeUndefined();
    // And it does NOT claim a refusal. The gate reads the pure predicate,
    // not seasonSettling, whose warn says "Joins, creates and verdicts
    // are refused" and would both lie about a clean disconnect and burn
    // the once-per-connection budget that a real refusal needs. Asserting
    // only the row cannot see the difference: both predicates return the
    // same boolean.
    expect(
      vi.mocked(logger.warn).mock.calls.filter((c) => String(c[0]).includes('Room access LOCKED')),
    ).toEqual([]);
  });

  it('DOES write the room row on disconnect once the season is settled', async () => {
    const room = makeWsRoom();
    const { ws, client } = makeClient();
    push(ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    client.room = room;
    (room.users as Map<string, Client>).set('user1', client);

    ws.emit('close');
    await flush();
    expect(cour.rooms.byName('couch-club')).toBeDefined();
  });

  it('refuses a verdict while the season is settling, and creates no room row', async () => {
    // Gating the join path alone is not enough: a member ALREADY in a room
    // when the provider falls back reaches verdictContext, which would
    // create the room row under the stale season (or write into one
    // stamped with the real season). Either way the reaper deletes it when
    // the real season lands, taking the verdicts with it.
    const room = makeWsRoom();
    const ws = makeWs();
    const client = new Client(ws, [makeProvisionalProvider()], cour);
    push(ws, { type: 'login', payload: { userName: 'user1' } });
    await flush();
    client.room = room;
    (room.users as Map<string, Client>).set('user1', client);
    ws.send.mockClear();

    push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();

    expect(last(ws, 'verdictError')?.payload.message).toMatch(/anime provider is down/i);
    expect(last(ws, 'verdictSuccess')).toBeUndefined();
    // Nothing was written, and no row was minted under the stale season.
    expect(cour.rooms.byName('couch-club')).toBeUndefined();
  });

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
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    // Complete decks: lock-in requires a verdict on every title now.
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();

    push(ws1, { type: 'lockIn' });
    await flush();
    expect(last(ws1, 'lockInSuccess')?.payload.roomLocked).toBe(false);

    push(ws2, { type: 'lockIn' });
    await flush();
    expect(last(ws2, 'lockInSuccess')?.payload.roomLocked).toBe(true);

    // Post-lock verdicts are refused.
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    await flush();
    expect(last(ws1, 'verdictError')?.payload.message).toContain('locked');
  });

  it('submitRankings: permutation-gated, one shot, pushes live standings to the room', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    // user1 likes both titles; user0 likes one.
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 102, verdict: 'dislike' } });
    await flush();

    // Before lock-in: refused.
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(ws1, 'submitRankingsError')?.payload.message).toContain('Lock in');

    push(ws1, { type: 'lockIn' });
    push(ws2, { type: 'lockIn' });
    await flush();

    // Not a permutation of the likes: refused (102 is a dislike for user0).
    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(ws2, 'submitRankingsError')?.payload.message).toContain('Kept titles');

    // user1 submits: BOTH members get a live resultsSuccess push.
    ws2.send.mockClear();
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [102, 101] } });
    await flush();
    expect(last(ws1, 'submitRankingsSuccess')).toBeDefined();
    const user1Results = last(ws1, 'resultsSuccess')?.payload;
    expect(user1Results?.mySubmitted).toBe(true);
    expect(user1Results?.myRanking).toEqual([102, 101]);
    expect(user1Results?.submittedCount).toBe(1);
    // "Everyone's #1": user1 ranked 102 first, so user1's top pick is 102.
    expect(user1Results?.topPicks).toEqual([{ userName: 'user1', titleId: 102 }]);
    const results2 = last(ws2, 'resultsSuccess')?.payload;
    expect(results2?.mySubmitted).toBe(false);
    expect(results2?.standings[0]).toMatchObject({ titleId: 102, points: 12, rank: 1 });

    // One shot: a resubmit is refused.
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(ws1, 'submitRankingsError')?.payload.message).toContain('already submitted');

    // user0 submits their single like; combined standings shift.
    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    await flush();
    const combined = last(ws2, 'resultsSuccess')?.payload;
    expect(combined?.submittedCount).toBe(2);
    // 101: 9 (user1 #2) + 12 (user0 #1) = 21; 102: 12.
    expect(combined?.standings[0]).toMatchObject({ titleId: 101, points: 21 });
    expect(combined?.standings[1]).toMatchObject({ titleId: 102, points: 12 });
  });

  it('submitRefinedRankings: opens once every ranking is in, shared shows only, one shot, pushed live', async () => {
    const room = makeWsRoomWithExtraTitle();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    // user1 keeps all three; user0 keeps 101 and 103, so those two are shared.
    for (const titleId of [101, 102, 103]) push(ws1, { type: 'verdict', payload: { titleId, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 102, verdict: 'dislike' } });
    push(ws2, { type: 'verdict', payload: { titleId: 103, verdict: 'like' } });
    push(ws1, { type: 'lockIn' });
    push(ws2, { type: 'lockIn' });
    await flush();
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [102, 101, 103] } });
    await flush();

    // One ranking still out: closed.
    expect(last(ws1, 'resultsSuccess')?.payload.refined).toBeUndefined();
    push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds: [101, 103] } });
    await flush();
    expect(last(ws1, 'submitRefinedRankingsError')?.payload.message).toContain('every ranking is in');

    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [103, 101] } });
    await flush();
    // Standings: 103 18 (best #1), 101 18 (best #2), 102 12. Shared: 103, 101.
    // Unrefined, each member counts with their ranking cut to the shared shows.
    const open = last(ws1, 'resultsSuccess')?.payload.refined;
    expect(open).toMatchObject({ sharedTitleIds: [103, 101], refinedCount: 0, myRefined: false, myOrder: [101, 103] });
    expect(open?.standings.map((s: { titleId: number; points: number }) => [s.titleId, s.points])).toEqual([
      [101, 21],
      [103, 21],
    ]);
    expect(last(ws2, 'resultsSuccess')?.payload.refined?.myOrder).toEqual([103, 101]);

    // Not exactly the shared shows, each once: refused.
    for (const rankedTitleIds of [[101, 102], [103, 103], [103], [103, 101, 103]]) {
      ws1.send.mockClear();
      push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds } });
      await flush();
      expect(last(ws1, 'submitRefinedRankingsError')?.payload.message).toContain('exactly the shared shows');
      expect(last(ws1, 'submitRefinedRankingsSuccess')).toBeUndefined();
    }

    // user1 refines: both members get the new shared standings.
    ws2.send.mockClear();
    push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds: [103, 101] } });
    await flush();
    expect(last(ws1, 'submitRefinedRankingsSuccess')).toBeDefined();
    expect(last(ws1, 'resultsSuccess')?.payload.refined).toMatchObject({
      refinedCount: 1,
      myRefined: true,
      myOrder: [103, 101],
    });
    const pushed = last(ws2, 'resultsSuccess')?.payload;
    expect(pushed?.refined).toMatchObject({ refinedCount: 1, myRefined: false });
    // Both now put 103 first: 24 against 18.
    expect(pushed?.refined?.standings.map((s: { titleId: number; points: number }) => [s.titleId, s.points])).toEqual([
      [103, 24],
      [101, 18],
    ]);
    expect(pushed?.members).toContainEqual({ userName: 'user1', locked: true, submitted: true, refined: true });
    // The normal standings are untouched.
    expect(pushed?.standings.map((s: { titleId: number }) => s.titleId)).toEqual([103, 101, 102]);

    // One shot.
    push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds: [101, 103] } });
    await flush();
    expect(last(ws1, 'submitRefinedRankingsError')?.payload.message).toContain('already in');
  });

  it('a new member closes the refine round for everyone, by push', async () => {
    const room = makeWsRoomWithExtraTitle();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    for (const ws of [ws1, ws2]) {
      push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
      push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
      push(ws, { type: 'verdict', payload: { titleId: 103, verdict: 'dislike' } });
      push(ws, { type: 'lockIn' });
    }
    await flush();
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [102, 101] } });
    await flush();
    expect(last(ws1, 'resultsSuccess')?.payload.refined?.sharedTitleIds).toHaveLength(2);

    // user2's first verdict-flow message makes them a member: two of three in.
    const { ws: ws3 } = await authedInRoom('user2', room);
    ws1.send.mockClear();
    push(ws3, { type: 'review' });
    await flush();
    const pushed = last(ws1, 'resultsSuccess')?.payload;
    expect(pushed).toMatchObject({ memberCount: 3, submittedCount: 2 });
    expect(pushed?.refined).toBeUndefined();
    push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    expect(last(ws1, 'submitRefinedRankingsError')?.payload.message).toContain('every ranking is in');
  });

  it('submitRefinedRankings refuses when fewer than two shows are shared', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 102, verdict: 'dislike' } });
    push(ws1, { type: 'lockIn' });
    push(ws2, { type: 'lockIn' });
    await flush();
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    await flush();
    expect(last(ws1, 'resultsSuccess')?.payload.refined?.sharedTitleIds).toEqual([101]);
    push(ws1, { type: 'submitRefinedRankings', payload: { rankedTitleIds: [101] } });
    await flush();
    expect(last(ws1, 'submitRefinedRankingsError')?.payload.message).toContain('fewer than two');
  });

  it('submitRefinedRankings rejects a malformed payload', async () => {
    const room = makeWsRoom();
    const { ws } = await authedInRoom('user1', room);
    push(ws, { type: 'submitRefinedRankings', payload: { rankedTitleIds: ['101'] } });
    await flush();
    expect(last(ws, 'submitRefinedRankingsError')?.payload.message).toBe('Invalid rankings payload.');
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

  it('a connected member with zero verdicts holds the room unlocked', async () => {
    // Membership rows are lazily created on the first verdict-flow
    // message; before the fix a member who had joined but not yet
    // verdicted had no row to count and allLocked fired prematurely.
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    await authedInRoom('user0', room); // joined, zero verdicts
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    await flush();
    push(ws1, { type: 'lockIn' });
    await flush();
    expect(last(ws1, 'lockInSuccess')?.payload.roomLocked).toBe(false);
  });

  // ── Member pulse payload + roomPulse push (audit 17 UX 3/7/11) ──

  it('review carries per-member lock/submit state', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    push(ws1, { type: 'lockIn' });
    await flush();
    push(ws2, { type: 'review' });
    await flush();
    const members = last(ws2, 'reviewSuccess')?.payload.members;
    expect(members).toEqual([
      { userName: 'user1', locked: true, submitted: false, refined: false },
      { userName: 'user0', locked: false, submitted: false, refined: false },
    ]);
  });

  it('locking in pushes roomPulse to the OTHER members only', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    for (const ws of [ws1, ws2]) {
      push(ws, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
      push(ws, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    }
    await flush();
    // Discard the member-join pulses so the lock assertions below see
    // only lock traffic.
    ws1.send.mockClear();
    ws2.send.mockClear();

    push(ws1, { type: 'lockIn' });
    await flush();
    // The other member sees the pulse; the locker does not (their own state
    // rides lockInSuccess, avoiding a duplicate celebration).
    expect(last(ws1, 'roomPulse')).toBeUndefined();
    const pulse = last(ws2, 'roomPulse')?.payload;
    expect(pulse?.allLocked).toBe(false);
    expect(pulse?.members).toContainEqual({ userName: 'user1', locked: true, submitted: false, refined: false });

    push(ws2, { type: 'lockIn' });
    await flush();
    // The FINAL lock's pulse carries the all-locked edge to the others.
    expect(last(ws1, 'roomPulse')?.payload.allLocked).toBe(true);
  });

  it('a NEW member joining the verdict flow pulses the others (audit v1.2.0 low)', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    await flush();
    ws1.send.mockClear();

    // A second member's FIRST verdict-flow message creates their row --
    // everyone else's "N OF M LOCKED" line updates now, not at the next
    // lock event. allLocked is false by construction, so no celebration.
    const { ws: ws2 } = await authedInRoom('user0', room);
    push(ws2, { type: 'review' });
    await flush();
    const pulse = last(ws1, 'roomPulse')?.payload;
    expect(pulse?.allLocked).toBe(false);
    expect(pulse?.members).toContainEqual({
      userName: 'user0', locked: false, submitted: false, refined: false,
    });

    // Repeat traffic from the SAME member does not re-pulse.
    ws1.send.mockClear();
    push(ws2, { type: 'review' });
    await flush();
    expect(last(ws1, 'roomPulse')).toBeUndefined();
  });

  it('standings rows carry who ranked them by name', async () => {
    const room = makeWsRoom();
    const { ws: ws1 } = await authedInRoom('user1', room);
    const { ws: ws2 } = await authedInRoom('user0', room);
    push(ws1, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws1, { type: 'verdict', payload: { titleId: 102, verdict: 'skip' } });
    push(ws2, { type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    push(ws2, { type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
    await flush();
    push(ws1, { type: 'lockIn' });
    push(ws2, { type: 'lockIn' });
    await flush();
    push(ws1, { type: 'submitRankings', payload: { rankedTitleIds: [101] } });
    push(ws2, { type: 'submitRankings', payload: { rankedTitleIds: [101, 102] } });
    await flush();
    push(ws1, { type: 'results' });
    await flush();
    const payload = last(ws1, 'resultsSuccess')?.payload;
    const top = payload?.standings.find((row: { titleId: number }) => row.titleId === 101);
    expect(top?.rankedByNames).toEqual(['user0', 'user1']);
    expect(payload?.members).toEqual([
      { userName: 'user1', locked: true, submitted: true, refined: false },
      { userName: 'user0', locked: true, submitted: true, refined: false },
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

