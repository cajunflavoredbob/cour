import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../../web/app/src/store/reducer';
import type { Actions, Store } from '../../web/app/src/store/types';

// Build a Store with a joined room carrying the given user list.
const withUsers = (users: NonNullable<Store['room']>['users']): Store => ({
  ...initialState,
  room: { name: 'movie-night', joined: true, users },
});

const joined = (userName: string): Actions => ({
  type: 'userJoinedRoom',
  payload: { userName },
});

describe('reducer userJoinedRoom', () => {
  it('appends a newly joined user', () => {
    const next = reducer(withUsers([]), joined('user1'));
    expect(next.room?.users).toEqual([{ userName: 'user1' }]);
  });

  // Finding 2: a reconnecting/rejoining user broadcasts userJoinedRoom again.
  // A blind append showed that user twice in everyone else's list.
  it('does not duplicate a user who rejoins', () => {
    const start = withUsers([{ userName: 'user1' }]);
    const next = reducer(start, joined('user1'));
    expect(next.room?.users).toEqual([{ userName: 'user1' }]);
  });

  it('keeps other users when one rejoins', () => {
    const start = withUsers([{ userName: 'user1' }, { userName: 'user2' }]);
    const next = reducer(start, joined('user1'));
    expect(next.room?.users?.map((u) => u.userName).sort()).toEqual(['user1', 'user2']);
  });
});

// #43 + #70: these error messages previously had no reducer case and fell
// through silently, leaving the user with no feedback.
describe('reducer error toasts', () => {
  it('verdictError surfaces the server message as a toast', () => {
    const next = reducer(initialState, {
      type: 'verdictError',
      payload: { message: 'Please wait a moment.' },
    } as Actions);
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].message).toBe('Please wait a moment.');
  });

  // Audit 16 #452 changed NOT_JOINED semantics: the server already
  // considers the user out of any room, so the reducer treats it as a
  // successful leave (clear room, route to login) instead of toasting --
  // the toast-only handling left the user trapped on a dead room screen
  // after a failed silent rejoin. The toast branch remains for any
  // future errorType.
  it('leaveRoomError NOT_JOINED is treated as a successful leave (audit 16 #452)', () => {
    const inRoom = {
      ...initialState,
      route: 'room',
      room: { name: 'movie-night' },
    } as unknown as Store;
    const next = reducer(inRoom, {
      type: 'leaveRoomError',
      payload: { errorType: 'NOT_JOINED' },
    } as Actions);
    expect(next.room).toBeUndefined();
    expect(next.route).toBe('home');
    expect(next.toasts).toHaveLength(0);
  });

  it('leaveRoomError with an unrecognized errorType still adds a toast (#70)', () => {
    const next = reducer(initialState, {
      type: 'leaveRoomError',
      payload: { errorType: 'SOMETHING_ELSE' },
    } as unknown as Actions);
    expect(next.toasts).toHaveLength(1);
  });


  // Audit 12 #241: every error toast must carry showTimeMs so it auto-
  // dismisses. Prior cases shipped a toast with no TTL, which left it
  // pinned to the screen until the user clicked. The connection-failure
  // toast is intentionally sticky (cleared on reconnect) and isn't
  // covered here -- that's the `updateConnectionStatus` path.
  it.each([
    // NOT_JOINED no longer toasts (audit 16 #452); exercise the toast
    // branch with a hypothetical future errorType.
    ['leaveRoomError', { type: 'leaveRoomError', payload: { errorType: 'OTHER' } } as unknown as Actions],
    ['verdictError', { type: 'verdictError', payload: { message: 'no' } } as Actions],
    ['reviewError', { type: 'reviewError', payload: { message: 'fail' } } as Actions],
  ])('%s carries a showTimeMs (audit 12 #241)', (_label, action) => {
    const next = reducer(initialState, action);
    expect(next.toasts[0].showTimeMs).toBeGreaterThan(0);
  });
});

// Audit 9 #103: removeToast filtered by object identity, so a dispatched
// payload that wasn't reference-equal to the stored toast (e.g. a fresh
// object rebuilt from { id, message }) silently no-op'd the removal. 0.4.3
// switched the filter to compare by id.
describe('reducer removeToast (audit 9 #103)', () => {
  const seeded: Store = {
    ...initialState,
    toasts: [
      { id: 'a', message: 'one' },
      { id: 'b', message: 'two' },
    ],
  };

  it('removes the matching toast by id', () => {
    const next = reducer(seeded, {
      type: 'removeToast',
      payload: { id: 'a', message: 'one' },
    } as Actions);
    expect(next.toasts.map((t) => t.id)).toEqual(['b']);
  });

  it('removes by id even when the payload is a fresh object (not reference-equal)', () => {
    // Construct a payload with the same id but a different object identity
    // and different message text -- the prior identity filter would have
    // failed to match and left the toast in state.
    const next = reducer(seeded, {
      type: 'removeToast',
      payload: { id: 'a', message: 'different text', appearance: 'Failure' },
    } as Actions);
    expect(next.toasts.map((t) => t.id)).toEqual(['b']);
  });
});

// Audit 9 #120: the prior room-event cases spread `state.room!` (non-null
// assertion). A server-contract violation that ever delivered one of these
// events to a roomless client would have thrown a runtime TypeError. 0.4.6
// guards with `if (!state.room) return state;` -- the action becomes a
// safe no-op instead.
describe('reducer room-event guards (audit 9 #120)', () => {
  it('userJoinedRoom returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'userJoinedRoom',
      payload: { userName: 'user1' },
    } as Actions);
    expect(next).toBe(initialState);
  });

  it('userLeftRoom returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'userLeftRoom',
      payload: { userName: 'user1' },
    } as Actions);
    expect(next).toBe(initialState);
  });
});

// Audit 13 #328 lineage: the toast counter lives on the Store so the
// reducer stays pure. mediaVersionCounter died with CardStack in the
// 0.4.0 teardown.
describe('reducer toastCounter in state (audit 13 #328)', () => {
  it('initialState has toastCounter=0', () => {
    expect(initialState.toastCounter).toBe(0);
  });

  it('toastCounter increments on a toast-emitting action (verdictError)', () => {
    const next = reducer(initialState, {
      type: 'verdictError',
      payload: { message: 'no' },
    } as Actions);
    expect(next.toastCounter).toBe(1);
    expect(next.toasts).toHaveLength(1);
    // Toast id contains the counter: `toast-{counter}-{random}`.
    expect(next.toasts[0].id).toMatch(/^toast-1-/);
  });

  it('toastCounter does NOT increment on actions that do not mint a toast', () => {
    const next = reducer(initialState, { type: 'navigate', payload: { route: 'home' } } as Actions);
    expect(next.toastCounter).toBe(0);
  });

  // filterChangeApplied only bumps toastCounter when the apply came from a
  // DIFFERENT user (self-apply doesn't surface a toast).
  it('mediaChanged swaps media without any toast (server pushes only)', () => {
    const seeded: Store = {
      ...initialState,
      room: { name: 'movie-night', joined: true, media: [] },
    };
    const next = reducer(seeded, {
      type: 'mediaChanged',
      payload: { media: [] },
    } as Actions);
    expect(next.toasts).toHaveLength(0);
    expect(next.toastCounter).toBe(0);
  });

  it('two independent Store sequences produce identical counter trajectories (no cross-Store leak)', () => {
    const run = () => {
      let s: Store = initialState;
      s = reducer(s, { type: 'joinRoom', payload: { roomName: 'r' } } as Actions);
      s = reducer(s, { type: 'verdictError', payload: { message: 'x' } } as Actions);
      return s.toastCounter;
    };
    expect(run()).toBe(1);
    expect(run()).toBe(1);
  });
});


describe('reducer verdict flow (0.7.0)', () => {
  const seeded: Store = {
    ...initialState,
    review: {
      verdicts: [{ titleId: 101, verdict: 'like', updatedAt: 1 }],
      counts: { like: 1, dislike: 0, skip: 0 },
      members: [],
      lockedAt: null,
      total: 3,
    },
  };

  it('reviewSuccess stores the ledger', () => {
    const next = reducer(initialState, {
      type: 'reviewSuccess',
      payload: seeded.review,
    } as Actions);
    expect(next.review?.total).toBe(3);
  });

  it('verdictSuccess appends a new verdict and bumps its count', () => {
    const next = reducer(seeded, {
      type: 'verdictSuccess',
      payload: { titleId: 102, verdict: 'skip' },
    } as Actions);
    expect(next.review?.verdicts).toHaveLength(2);
    expect(next.review?.counts).toEqual({ like: 1, dislike: 0, skip: 1 });
  });

  it('verdictSuccess on an already-verdicted title moves the count (tap-to-change)', () => {
    const next = reducer(seeded, {
      type: 'verdictSuccess',
      payload: { titleId: 101, verdict: 'dislike' },
    } as Actions);
    expect(next.review?.verdicts).toHaveLength(1);
    expect(next.review?.verdicts[0].verdict).toBe('dislike');
    expect(next.review?.counts).toEqual({ like: 0, dislike: 1, skip: 0 });
  });

  it('verdictSuccess without a ledger is a safe no-op', () => {
    const next = reducer(initialState, {
      type: 'verdictSuccess',
      payload: { titleId: 1, verdict: 'like' },
    } as Actions);
    expect(next).toBe(initialState);
  });

  it('skipRemainingSuccess toasts the skipped count', () => {
    const next = reducer(seeded, {
      type: 'skipRemainingSuccess',
      payload: { skipped: 41 },
    } as Actions);
    expect(next.toasts[0].message).toBe('Marked 41 titles unsure.');
  });

  it('leaveRoomSuccess clears the ledger with the room', () => {
    const next = reducer(seeded, { type: 'leaveRoomSuccess' } as Actions);
    expect(next.review).toBeUndefined();
  });
});

describe('deck scope (0.10.0 re-review passes)', () => {
  const seeded: Store = {
    ...initialState,
    route: 'home',
    review: {
      verdicts: [
        { titleId: 101, verdict: 'like', updatedAt: 1 },
        { titleId: 102, verdict: 'like', updatedAt: 2 },
        { titleId: 103, verdict: 'skip', updatedAt: 3 },
      ],
      counts: { like: 2, dislike: 0, skip: 1 },
      members: [],
      lockedAt: null,
      total: 3,
    },
  };

  it('enterDeckScope routes to the deck with the scope set', () => {
    const next = reducer(seeded, {
      type: 'enterDeckScope',
      payload: { titleIds: [101, 102], position: 0 },
    } as Actions);
    expect(next.route).toBe('room');
    expect(next.deckScope).toEqual({ titleIds: [101, 102], position: 0 });
  });

  it('a scoped verdict advances the pass; the last one exits to review', () => {
    const scoped = {
      ...seeded,
      route: 'room' as const,
      deckScope: { titleIds: [101, 102], position: 0 },
    };
    const mid = reducer(scoped, {
      type: 'verdictSuccess',
      payload: { titleId: 101, verdict: 'dislike' },
    } as Actions);
    expect(mid.deckScope?.position).toBe(1);
    expect(mid.route).toBe('room');
    // Ledger updated too: the like moved to dislike.
    expect(mid.review?.counts).toEqual({ like: 1, dislike: 1, skip: 1 });
    const done = reducer(mid, {
      type: 'verdictSuccess',
      payload: { titleId: 102, verdict: 'like' },
    } as Actions);
    expect(done.deckScope).toBeUndefined();
    expect(done.route).toBe('home');
  });

  it('a single-row scope exits back to review after its one verdict', () => {
    const scoped = {
      ...seeded,
      route: 'room' as const,
      deckScope: { titleIds: [103], position: 0 },
    };
    const next = reducer(scoped, {
      type: 'verdictSuccess',
      payload: { titleId: 103, verdict: 'like' },
    } as Actions);
    expect(next.deckScope).toBeUndefined();
    expect(next.route).toBe('home');
  });

  it('verdictSuccess for an unrelated title does not step the scope', () => {
    const scoped = {
      ...seeded,
      route: 'room' as const,
      deckScope: { titleIds: [101, 102], position: 0 },
    };
    const next = reducer(scoped, {
      type: 'verdictSuccess',
      payload: { titleId: 999, verdict: 'like' },
    } as Actions);
    expect(next.deckScope?.position).toBe(0);
  });

  it('exitDeckScope and leaveRoomSuccess both clear the scope', () => {
    const scoped = {
      ...seeded,
      route: 'room' as const,
      deckScope: { titleIds: [101], position: 0 },
    };
    expect(reducer(scoped, { type: 'exitDeckScope' } as Actions).deckScope).toBeUndefined();
    expect(reducer(scoped, { type: 'leaveRoomSuccess' } as Actions).deckScope).toBeUndefined();
  });
});

describe('ranking results (0.13.0)', () => {
  const results = {
    submittedCount: 1,
    memberCount: 2,
    mySubmitted: true,
    myRanking: [101],
    standings: [{ titleId: 101, points: 12, bestRank: 1, rankedBy: 1, rank: 1 }],
  };

  it('resultsSuccess stores the payload (fetch AND live push land here)', () => {
    const next = reducer(initialState, { type: 'resultsSuccess', payload: results } as Actions);
    expect(next.results?.standings[0].titleId).toBe(101);
  });

  it('leaveRoomSuccess clears the results with the room', () => {
    const seeded = { ...initialState, results } as Store;
    const next = reducer(seeded, { type: 'leaveRoomSuccess' } as Actions);
    expect(next.results).toBeUndefined();
  });

  it('the all-locked toast points at ranking now', () => {
    const seeded: Store = {
      ...initialState,
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, members: [], lockedAt: null, total: 1 },
    };
    const next = reducer(seeded, {
      type: 'lockInSuccess',
      payload: { lockedAt: 1, roomLocked: true },
    } as Actions);
    expect(next.toasts[0].message).toContain('rank your keeps');
  });
});

// Audit 17 H3/H4: the join-request case used to reset room state on
// every dispatch (wiping media/users on each reconnect rejoin), and
// joinRoomSuccess force-routed to the deck. Routing now waits for the
// post-join ledger (createStore owns it); rejoins preserve live state.
describe('reducer join/rejoin room-state handling', () => {
  const liveRoom = (): Store => ({
    ...initialState,
    route: 'home',
    room: {
      name: 'movie-night',
      displayName: 'Movie-Night',
      joined: true,
      media: [],
      users: [{ userName: 'user1' }],
    },
  });

  it('a same-room rejoin request preserves live room state', () => {
    const state = liveRoom();
    const next = reducer(state, {
      type: 'joinOrCreateRoom',
      payload: { roomName: 'movie-night' },
    } as Actions);
    expect(next.room).toBe(state.room);
    expect(next.route).toBe('home');
  });

  it('a join request for a different room still starts clean', () => {
    const next = reducer(liveRoom(), {
      type: 'joinOrCreateRoom',
      payload: { roomName: 'other-room' },
    } as Actions);
    expect(next.room).toEqual({ name: 'other-room', joined: false });
  });

  it('joinRoomSuccess marks the room joined without navigating', () => {
    const state: Store = {
      ...initialState,
      route: 'home',
      room: { name: 'movie-night', joined: false },
    };
    const next = reducer(state, {
      type: 'joinRoomSuccess',
      payload: { roomName: 'movie-night', media: [], users: [] },
    } as Actions);
    expect(next.room?.joined).toBe(true);
    expect(next.route).toBe('home');
  });
});

// Audit 17 UX 3: live member pulse + the shared celebration edge.
describe('reducer roomPulse', () => {
  const members = [
    { userName: 'user1', locked: true, submitted: false },
    { userName: 'girlfriend', locked: false, submitted: false },
  ];

  it('updates member state without a toast when the room is not yet locked', () => {
    const next = reducer(initialState, {
      type: 'roomPulse',
      payload: { members, allLocked: false },
    } as Actions);
    expect(next.members).toEqual(members);
    expect(next.toasts).toHaveLength(0);
  });

  it('fires the celebration toast on the all-locked edge', () => {
    const next = reducer(initialState, {
      type: 'roomPulse',
      payload: {
        members: members.map((m) => ({ ...m, locked: true })),
        allLocked: true,
      },
    } as Actions);
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].message).toContain("Everyone's locked in");
  });
});

// Audit v1.2.0 #9: the one-shot finalizers' in-flight ceremony.
describe('reducer finalizing ceremony', () => {
  it('sets and clears the ceremony state', () => {
    const on = reducer(initialState, {
      type: 'finalizing', payload: { kind: 'lock' },
    } as Actions);
    expect(on.finalizing?.kind).toBe('lock');
    expect(on.finalizing?.startedAt).toBeGreaterThan(0);
    const off = reducer(on, { type: 'finalizing', payload: null } as Actions);
    expect(off.finalizing).toBeUndefined();
  });

  it.each([
    ['lockInError', { type: 'lockInError', payload: { message: 'no' } }],
    ['submitRankingsError', { type: 'submitRankingsError', payload: { message: 'no' } }],
  ])('%s ends the ceremony so the button re-arms', (_label, action) => {
    const armed = reducer(initialState, {
      type: 'finalizing', payload: { kind: 'lock' },
    } as Actions);
    const next = reducer(armed, action as Actions);
    expect(next.finalizing).toBeUndefined();
    expect(next.toasts).toHaveLength(1);
  });
});
