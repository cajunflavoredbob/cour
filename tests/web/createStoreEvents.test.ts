import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Companion to createStore.test.ts. That file covers init + dispatch +
// AbortController teardown; this one covers the connected / disconnected /
// message event-handler paths -- the reactive surface of the store,
// passwordless edition (0.12.0): stored-name auto-login, remembered-room
// auto-join, and the silent reconnect rejoin hang off login/config.

const makeClientMock = () => {
  const client = new EventTarget() as EventTarget & Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    'verdict', 'review', 'skipRemaining', 'lockIn', 'results', 'login',
    'createRoom', 'joinRoom', 'joinOrCreateRoom', 'leaveRoom',
    'requestFilters', 'requestFilterValues', 'applyFilters',
    'sendMessage',
  ] as const) {
    client[name] = vi.fn().mockResolvedValue(undefined);
  }
  return client;
};

let clientMock: ReturnType<typeof makeClientMock>;
vi.mock('../../web/app/src/api/reely', () => ({
  // biome-ignore lint/complexity/useArrowFunction: arrow functions can't be called with `new`, but createStore does `new ReelyClient()`. Function expression is required here.
  ReelyClient: function () {
    return clientMock;
  },
}));

let historyReplaceState: ReturnType<typeof vi.fn>;
let localStore: Map<string, string>;

const setupDomGlobals = (opts: {
  href?: string;
  name?: string;
  room?: string;
  language?: string;
} = {}) => {
  localStore = new Map<string, string>();
  if (opts.name != null) localStore.set('courName', opts.name);
  if (opts.room != null) localStore.set('courRoom', opts.room);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      localStore.set(k, v);
    },
    removeItem: (k: string) => {
      localStore.delete(k);
    },
    clear: () => localStore.clear(),
  });
  vi.stubGlobal('location', {
    href: opts.href ?? 'https://cour.example.com/',
    search: opts.href ? new URL(opts.href).search : '',
  });
  historyReplaceState = vi.fn();
  vi.stubGlobal('history', { replaceState: historyReplaceState });
  vi.stubGlobal('navigator', { language: opts.language ?? 'en-US' });
  vi.stubGlobal('document', {
    title: 'cour',
    body: { dataset: {} },
    // applySeasonTheme writes accent custom properties on <html> when a
    // config frame carries a season.
    documentElement: { style: { setProperty: () => {} } },
  });
};

const loadCreateStore = async () => {
  const mod = await import('../../web/app/src/store/createStore');
  return mod;
};

const emit = (data: unknown) => {
  clientMock.dispatchEvent(new MessageEvent('message', { data } as MessageEventInit));
};

// Drive the store into route='room' state.
const enterRoom = (mod: Awaited<ReturnType<typeof loadCreateStore>>, roomName: string) => {
  // biome-ignore lint/suspicious/noExplicitAny: dispatched action shape; full Actions narrowing not the point in test setup.
  mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName } } as any);
  emit({ type: 'joinRoomSuccess', payload: { roomName, media: [], users: [] } });
  // biome-ignore lint/suspicious/noExplicitAny: test navigation shortcut.
  mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'room' } } as any);
};

beforeEach(() => {
  clientMock = makeClientMock();
  setupDomGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connected handler', () => {
  it('applies "connected" connection status', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('connected');
  });

  it('auto-claims a stored name on connect', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    // login rides the request helper now (audit 17 M8), not the raw socket.
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
  });

  it('sends no login without a stored name (the join form owns it)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).not.toHaveBeenCalled();
  });
});

describe('config frame routing', () => {
  it('routes to home (the join form) when no name is stored', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'config', payload: { requiresConfiguration: false } });
    expect(mod.useZustandStore.getState().route).toBe('home');
  });

  it('stays on loading while a stored-name login is in flight', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'config', payload: { requiresConfiguration: false } });
    expect(mod.useZustandStore.getState().route).toBe('loading');
  });

  it('does not yank an active user off a non-loading route on reconnect', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    emit({ type: 'config', payload: { requiresConfiguration: false } });
    expect(mod.useZustandStore.getState().route).toBe('room');
  });
});

describe('login success side effects', () => {
  it('lands on home with no remembered room', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(mod.useZustandStore.getState().route).toBe('home');
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('auto-joins the remembered room', async () => {
    setupDomGlobals({ name: 'user1', room: 'couch-coop' });
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'couch-coop' });
  });

  it('?roomName deep link outranks the remembered room', async () => {
    setupDomGlobals({
      href: 'https://cour.example.com/?roomName=deep-link',
      name: 'user1',
      room: 'couch-coop',
    });
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'deep-link' });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'couch-coop' });
  });

  it('loginError lands on home so the join form can show it', async () => {
    setupDomGlobals({ name: 'x'.repeat(40) });
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    const state = mod.useZustandStore.getState();
    expect(state.route).toBe('home');
    expect(state.joinError).toContain('1 to 32');
  });
});

describe('reconnect rejoin', () => {
  it('a reconnect login always rejoins the remembered room (rooms are permanent)', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    mod.useZustandStore.setState({ connectionStatus: 'connected' });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.joinOrCreateRoom.mockClear();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
  });
});

describe('room membership side effects', () => {
  it('joinRoomSuccess persists the room, updates the URL, and fetches the ledger', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect(localStore.get('courRoom')).toBe('movie-night');
    expect(historyReplaceState).toHaveBeenCalled();
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });

  it('leaveRoomSuccess forgets the remembered room', async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    emit({ type: 'leaveRoomSuccess' });
    expect(localStore.get('courRoom')).toBeUndefined();
  });
});

describe('verdict-flow side effects (0.7.0)', () => {
  it('re-fetches the ledger after skipRemainingSuccess', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    clientMock.review.mockClear();
    emit({ type: 'skipRemainingSuccess', payload: { skipped: 12 } });
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });
});

describe('local pref side effects (0.12.0)', () => {
  it('soundPref dispatch persists to localStorage and the store', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup.
    mod.useZustandStore.getState().dispatch({ type: 'soundPref', payload: { enabled: true } } as any);
    expect(localStore.get('courAutoplaySound')).toBe('1');
    expect(mod.useZustandStore.getState().soundPref).toBe(true);
  });

  it('login dispatch remembers the name', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup.
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user6' } } as any);
    expect(localStore.get('courName')).toBe('user6');
  });
});

// Audit 17 H3/H4/H5: routing waits for the post-join ledger; reconnect
// rejoins keep the current route and room state; a lost review reply is
// retried a bounded number of times.
describe('post-join ledger routing', () => {
  // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
  const joinFresh = (mod: any, roomName = 'movie-night') => {
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName } });
    emit({ type: 'joinRoomSuccess', payload: { roomName, media: [], users: [] } });
  };

  const ledger = (over: Partial<{
    verdicts: Array<{ titleId: number; verdict: string; updatedAt: number }>;
    lockedAt: number | null;
    total: number;
  }> = {}) => ({
    verdicts: over.verdicts ?? [],
    counts: { like: 0, dislike: 0, skip: 0 },
    lockedAt: over.lockedAt ?? null,
    total: over.total ?? 3,
  });

  it('does not navigate on joinRoomSuccess alone', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test navigation shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'home' } } as any);
    joinFresh(mod);
    expect(mod.useZustandStore.getState().route).toBe('home');
  });

  it('fresh join mid-pass lands on the deck once the ledger arrives', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    emit({ type: 'reviewSuccess', payload: ledger({ verdicts: [{ titleId: 1, verdict: 'like', updatedAt: 1 }] }) });
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  it('fresh join with the season finished lands on home (review + lock bar)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    emit({
      type: 'reviewSuccess',
      payload: ledger({
        total: 1,
        verdicts: [{ titleId: 1, verdict: 'like', updatedAt: 1 }],
      }),
    });
    expect(mod.useZustandStore.getState().route).toBe('home');
  });

  it('fresh join when locked in lands on home (standings via HomeScreen)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    emit({ type: 'reviewSuccess', payload: ledger({ lockedAt: 12345 }) });
    expect(mod.useZustandStore.getState().route).toBe('home');
  });

  it('a reconnect rejoin keeps the route and the live room state', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    emit({ type: 'reviewSuccess', payload: ledger() }); // mid-pass -> room
    expect(mod.useZustandStore.getState().route).toBe('room');
    const roomBefore = mod.useZustandStore.getState().room;

    // The auto-rejoin after a WS blip: same room, already joined.
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    expect(mod.useZustandStore.getState().room).toBe(roomBefore);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    emit({ type: 'reviewSuccess', payload: ledger() });
    // No teleport: the refetched ledger never navigates on a rejoin.
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  it('retries a failed review fetch up to three times, paced', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    vi.useFakeTimers();
    clientMock.review.mockClear();

    for (let attempt = 1; attempt <= 3; attempt++) {
      emit({ type: 'reviewError', payload: { message: 'nope' } });
      await vi.advanceTimersByTimeAsync(4100);
      expect(clientMock.review).toHaveBeenCalledTimes(attempt);
    }
    // Fourth failure: capped, no further retry.
    emit({ type: 'reviewError', payload: { message: 'nope' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clientMock.review).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a successful review resets the retry budget', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    vi.useFakeTimers();
    clientMock.review.mockClear();
    emit({ type: 'reviewError', payload: { message: 'nope' } });
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).toHaveBeenCalledTimes(1);

    emit({ type: 'reviewSuccess', payload: ledger() });
    // Simulate the ledger being cleared again (e.g. a later leave/join)
    // by failing anew: retries start from a fresh budget.
    mod.useZustandStore.setState({ review: undefined });
    emit({ type: 'reviewError', payload: { message: 'nope' } });
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

// Audit 17 H7/H8: the deck-swap ledger refetch and the results request
// going through the request helper instead of the raw socket.
describe('deck-swap and results handling', () => {
  it('refetches the ledger when the deck swaps under the room', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    clientMock.review.mockClear();
    emit({ type: 'filterChangeApplied', payload: { appliedBy: '', media: [], filters: [] } });
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });

  it('does not refetch the ledger for a deck swap outside a joined room', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.review.mockClear();
    emit({ type: 'filterChangeApplied', payload: { appliedBy: '', media: [], filters: [] } });
    expect(clientMock.review).not.toHaveBeenCalled();
  });

  it('routes the results dispatch through the request-helper method, not the raw socket', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'results' } as any);
    expect(clientMock.results).toHaveBeenCalledTimes(1);
    expect(clientMock.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'results' }),
    );
  });
});

// Audit 17: the first-run tutorial trigger. Fires on landing IN a room,
// not on loginSuccess -- that arrived while the join form was still on
// screen and read as a pre-login popup (the owner's 1.1.0 feedback).
describe('first-run tutorial trigger', () => {
  it('does NOT open on loginSuccess alone (the join form is still up)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(mod.useZustandStore.getState().tutorialOpen).toBeUndefined();
  });

  it('opens on the first room join when never seen', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect(mod.useZustandStore.getState().tutorialOpen).toBe(true);
  });

  it('stays closed once the seen-flag exists', async () => {
    localStore.set('courTutorialSeenV2', '1');
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect(mod.useZustandStore.getState().tutorialOpen).toBeUndefined();
  });
});

// Audit v1.2.0 #4: editing the pre-filled room on a share link was
// silently ignored -- the ?roomName deep link beat the typed room.
describe('deep link vs typed room', () => {
  it('the ?roomName deep link drives the auto-join when untouched', async () => {
    setupDomGlobals({ href: 'https://cour.example.com/?roomName=alpha', name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'alpha' });
  });

  it('a chooseRoom (manual edit + submit) revokes the deep link', async () => {
    setupDomGlobals({ href: 'https://cour.example.com/?roomName=alpha' });
    const mod = await loadCreateStore();
    mod.createStore();
    // The join form: user overtypes the pre-filled room, submits.
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'beta' } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } } as any);
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'beta' });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'alpha' });
    expect(localStore.get('courRoom')).toBe('beta');
  });
});

// Audit v1.2.0 #5: a client-side review rejection (timeout / dropped
// reply) never retried -- only the server error FRAME did.
describe('review rejection-path retry + stall affordance', () => {
  const join = async (mod: Awaited<ReturnType<typeof loadCreateStore>>) => {
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
  };

  it('a rejected review dispatch schedules the paced retry', async () => {
    clientMock.review = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    vi.useFakeTimers();
    await join(mod); // join dispatches review -> rejects
    await vi.advanceTimersByTimeAsync(0); // settle the rejection
    clientMock.review.mockClear();
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('exhausted retries set the stall flag; a manual retry resets it', async () => {
    clientMock.review = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    vi.useFakeTimers();
    await join(mod);
    // Budget is 3 retries; the 4th failure stalls.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4100);
    }
    expect(mod.useZustandStore.getState().ledgerStalled).toBe(true);

    // The stall screen's retry: fresh budget, flag cleared.
    clientMock.review = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'review' } as any);
    expect(mod.useZustandStore.getState().ledgerStalled).toBeUndefined();
    expect(clientMock.review).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// Audit v1.2.0 #6: rotation used to be silent -- no toast, stale
// standings kept in state.
describe('season rotation reset', () => {
  it('clears season-scoped state and announces the rotation', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    // biome-ignore lint/suspicious/noExplicitAny: test setup shortcut.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } } as any);
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    emit({
      type: 'reviewSuccess',
      payload: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, members: [], lockedAt: 123, total: 3 },
    });
    mod.useZustandStore.setState({
      // biome-ignore lint/suspicious/noExplicitAny: partial results fixture.
      results: { mySubmitted: true } as any,
    });

    clientMock.review.mockClear();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });

    const state = mod.useZustandStore.getState();
    expect(state.review).toBeUndefined();
    expect(state.results).toBeUndefined();
    expect(state.toasts.some((t) => t.message.includes('season rotated'))).toBe(true);
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });
});
