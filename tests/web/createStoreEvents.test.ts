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
    'submitRankings', 'submitRefinedRankings',
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
// The tab's own session storage, which a reload keeps.
let tabStore: Map<string, string>;

const stubStorage = (store: () => Map<string, string>) => ({
  getItem: (k: string) => store().get(k) ?? null,
  setItem: (k: string, v: string) => {
    store().set(k, v);
  },
  removeItem: (k: string) => {
    store().delete(k);
  },
  clear: () => store().clear(),
});

const stubLocation = (href: string | undefined) => {
  vi.stubGlobal('location', {
    href: href ?? 'https://cour.example.com/',
    search: href ? new URL(href).search : '',
  });
};

const setupDomGlobals = (opts: {
  href?: string;
  name?: string;
  room?: string;
  language?: string;
} = {}) => {
  localStore = new Map<string, string>();
  tabStore = new Map<string, string>();
  if (opts.name != null) localStore.set('courName', opts.name);
  if (opts.room != null) localStore.set('courRoom', opts.room);
  vi.stubGlobal('localStorage', stubStorage(() => localStore));
  vi.stubGlobal('sessionStorage', stubStorage(() => tabStore));
  stubLocation(opts.href);
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

// A reload of the same tab: a new page and socket over the same storage,
// at the URL the tab was on.
const reloadTab = async (href?: string) => {
  clientMock = makeClientMock();
  stubLocation(href);
  vi.resetModules();
  const mod = await loadCreateStore();
  mod.createStore();
  return mod;
};

const emit = (data: unknown) => {
  clientMock.dispatchEvent(new MessageEvent('message', { data } as MessageEventInit));
};

// Drive the store into route='room' state.
const enterRoom = (mod: Awaited<ReturnType<typeof loadCreateStore>>, roomName: string) => {
  mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName } });
  emit({ type: 'joinRoomSuccess', payload: { roomName, media: [], users: [] } });
  mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'room' } });
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

describe('disconnected handler', () => {
  const failureToast = (mod: Awaited<ReturnType<typeof loadCreateStore>>) =>
    mod.useZustandStore.getState().toasts.some((t) => t.id === 'connection-failure');

  it('shows the Disconnected toast when the socket drops', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    clientMock.dispatchEvent(new Event('disconnected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('disconnected');
    expect(failureToast(mod)).toBe(true);
  });

  it('reads a page parked in the back/forward cache as connecting, with no toast', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    clientMock.dispatchEvent(new CustomEvent('disconnected', { detail: { suspended: true } }));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('connecting');
    expect(failureToast(mod)).toBe(false);
  });
});

describe('reconnect identity', () => {
  it('relogs in as the member the tab already is and rejoins the room on screen, whatever another tab stored', async () => {
    setupDomGlobals({ name: 'user1', room: 'r' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    localStore.set('courName', 'user2');
    localStore.set('courRoom', 'other');
    clientMock.login.mockClear();
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    expect(localStore.get('courName')).toBe('user2');
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect(localStore.get('courRoom')).toBe('other');
  });

  it('rejoins a join still pending when nothing is stored', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'x' } });
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'x' });
  });

  it('claims its own member on the join form too, not a name another tab stored', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    localStore.set('courName', 'user5');
    localStore.set('courRoom', 'other');
    clientMock.login.mockClear();
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('keeps its own member and room after a refused rejoin, whatever another tab stored', async () => {
    setupDomGlobals({ name: 'user1', room: 'r' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    localStore.set('courName', 'user2');
    localStore.set('courRoom', 'other');
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    expect(mod.useZustandStore.getState().room).toBeUndefined();
    clientMock.login.mockClear();
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r' });
    // Back in its own room, the tab leaves the other tab's pair in storage.
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user2', 'other']);
  });

  it('stores the pair a tab first lands as, whatever another tab typed meanwhile', async () => {
    setupDomGlobals({ name: 'user2', room: 'r2' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user2' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    localStore.set('courName', 'user3');
    localStore.set('courRoom', 'r3');
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user2' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r2' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r2', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user2', 'r2']);
  });

  it('reclaims a typed name still in flight when the socket drops', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    clientMock.login.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user5' });
  });

  it('joins a room typed after a refused rejoin, not the room refused', async () => {
    setupDomGlobals({ name: 'user1', room: 'r' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    clientMock.joinOrCreateRoom.mockClear();
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'y' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'y' });
  });

  it('rejoins the room by the name the server gave it, not the one typed', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'movie night' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
    expect(mod.useZustandStore.getState().room?.joined).toBe(true);
  });

  it('goes on after a reload as the member the tab was, in its own room', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    localStore.set('courName', 'user2');
    localStore.set('courRoom', 'r2');
    await reloadTab('https://cour.example.com/?roomName=r1');
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r1' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user2', 'r2']);
  });

  it("joins no other tab's room after a reload of a tab that left its own", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    localStore.set('courName', 'user2');
    localStore.set('courRoom', 'r2');
    await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it("starts a new member without the last member's room", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    // A different member, whose own room is refused too.
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'x'.repeat(40) } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it('remembers a room reached through a link in an existing tab', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    await reloadTab('https://cour.example.com/?roomName=r9');
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r9' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r9', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user1', 'r9']);
  });

  it('heads for the same first room after a reload that came before it landed', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    localStore.set('courRoom', 'r2');
    await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it('heads for a room typed under the same name after a reload that came before it landed', async () => {
    setupDomGlobals({ href: 'https://cour.example.com/?roomName=r1', name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    first.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r7' } });
    expect(historyReplaceState).toHaveBeenLastCalledWith(null, 'cour', 'https://cour.example.com/');
    first.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r7' });
  });

  it("drops the last member's link and room for a new member, through a reload too", async () => {
    setupDomGlobals({ href: 'https://cour.example.com/?roomName=r1', name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    first.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    first.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(historyReplaceState).toHaveBeenLastCalledWith(null, 'cour', 'https://cour.example.com/');
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user5' });
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r5' });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it("starts a member typed after a reload's refused login without the old room", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    const page = await reloadTab('https://cour.example.com/?roomName=r1');
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginError', payload: { message: 'Logging in failed. Please try again.' } });
    page.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    page.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    historyReplaceState.mockClear();
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(historyReplaceState).toHaveBeenCalledWith(null, 'cour', 'https://cour.example.com/');
    expect([tabStore.get('courTabRoom'), tabStore.get('courTabJoining')]).toEqual([undefined, 'r5']);
  });

  it('reconnects a reloaded tab as the member it changed to', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    const page = await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    page.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    page.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r5', media: [], users: [] } });
    clientMock.login.mockClear();
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user5' });
    // The same member again: its room stays its own.
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r5' });
  });

  it('remembers a linked room that lands only after a reload', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    await reloadTab('https://cour.example.com/?roomName=r9');
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    await reloadTab('https://cour.example.com/?roomName=r9');
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r9' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r9', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user1', 'r9']);
  });

  it("keeps a refused typed name's room out of the tab", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    first.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    first.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    expect([tabStore.get('courTabName'), tabStore.get('courTabJoining')]).toEqual(['user1', undefined]);
    await reloadTab();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('speaks for the tab again when a page comes back from the back/forward cache', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    // Another page of the same tab became user5 in r5 while this one was cached.
    tabStore.set('courTabName', 'user5');
    tabStore.set('courTabRoom', 'r5');
    clientMock.dispatchEvent(new CustomEvent('disconnected', { detail: { suspended: true } }));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect([tabStore.get('courTabName'), tabStore.get('courTabRoom')]).toEqual(['user1', undefined]);
  });

  it('keeps the room a double submit chose through a drop', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    // Typed in another case: the server answers with the name it has.
    const submit = () => {
      mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r2' } });
      mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'User1' } });
    };
    submit();
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    // The second click's login meets the join in flight.
    submit();
    emit({ type: 'loginError', payload: { message: 'Leave the room before switching names.' } });
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r2' });
  });

  it("never seats a later typed member in the last member's room when an earlier name is refused", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    // Two names typed within one round trip: the first refused, the second taken.
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'x'.repeat(40) } });
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r6' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user6' } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    clientMock.joinOrCreateRoom.mockClear();
    emit({ type: 'loginSuccess', payload: { userName: 'user6' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it('tells names apart as the server does, past A to Z', async () => {
    setupDomGlobals({ name: 'émile', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'émile' } });
    // A different member on the server, typed twice while r1's join is out.
    const submit = () => {
      mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r3' } });
      mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'Émile' } });
    };
    submit();
    submit();
    emit({ type: 'loginError', payload: { message: 'Leave the room before switching names.' } });
    clientMock.joinOrCreateRoom.mockClear();
    emit({ type: 'loginSuccess', payload: { userName: 'Émile' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it('lets a link beat the room a reloaded tab was joining', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const first = await loadCreateStore();
    first.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(tabStore.get('courTabJoining')).toBe('r1');
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    expect(tabStore.get('courTabJoining')).toBeUndefined();
    emit({ type: 'leaveRoomSuccess' });
    first.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r7' } });
    first.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(tabStore.get('courTabJoining')).toBe('r7');
    await reloadTab('https://cour.example.com/?roomName=r9');
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom.mock.calls).toEqual([[{ roomName: 'r9' }]]);
  });

  it("holds a reloaded tab on loading while its own member's login is out", async () => {
    setupDomGlobals();
    tabStore.set('courTabName', 'user1');
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'config', payload: { requiresConfiguration: false } });
    expect(mod.useZustandStore.getState().route).toBe('loading');
  });

  it('keeps a link through a refused login', async () => {
    setupDomGlobals({ href: 'https://cour.example.com/?roomName=deep-link', name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginError', payload: { message: 'Logging in failed. Please try again.' } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'deep-link' });
    expect(mod.useZustandStore.getState().room?.name).toBe('deep-link');
  });

  it('remembers a room joined after leaving the last one', async () => {
    setupDomGlobals({ name: 'user1', room: 'r' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    expect(localStore.get('courRoom')).toBeUndefined();
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'Next Room' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'next-room', media: [], users: [] } });
    expect(localStore.get('courRoom')).toBe('next-room');
  });

  it('drops a typed name the server refuses, with the room typed alongside it', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'z' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    clientMock.login.mockClear();
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('stores a name the member types', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user3' } });
    expect(localStore.get('courName')).toBe('user3');
  });
});

describe('rejoin endings', () => {
  const rejoinPending = async () => {
    setupDomGlobals({ name: 'user1', room: 'r' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    return mod;
  };

  it('a rejoin left unanswered on a live socket keeps waiting, with Leave room open', async () => {
    const mod = await rejoinPending();
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let state = mod.useZustandStore.getState();
    expect(state.room?.joined).toBe(true);
    expect(state.rejoinOverdue).toBe(true);
    expect(state.error).toBeUndefined();
    // A late answer still lands the rejoin.
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    state = mod.useZustandStore.getState();
    expect(state.rejoining).toBeUndefined();
    expect(state.rejoinOverdue).toBeUndefined();
  });

  it('a relogin left unanswered on a live socket is overdue too', async () => {
    const mod = await rejoinPending();
    clientMock.login = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    clientMock.dispatchEvent(new Event('connected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mod.useZustandStore.getState().rejoinOverdue).toBe(true);
  });

  it('leaves a room the server seated after the screen gave the join up', async () => {
    const mod = await rejoinPending();
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The member takes the way out while the join is still in flight.
    mod.useZustandStore.getState().dispatch({ type: 'leaveRoom' });
    emit({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED', message: 'x' } });
    expect(mod.useZustandStore.getState().room).toBeUndefined();
    clientMock.review.mockClear();
    clientMock.leaveRoom.mockClear();
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect(clientMock.leaveRoom).toHaveBeenCalledTimes(1);
    expect(clientMock.review).not.toHaveBeenCalled();
    expect(mod.useZustandStore.getState().room).toBeUndefined();
    // A join typed meanwhile survives the leave's answer, which forgets nothing.
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'y' } });
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'y' } });
    emit({ type: 'leaveRoomSuccess' });
    expect(localStore.get('courRoom')).toBe('y');
    expect(mod.useZustandStore.getState().room).toEqual({ name: 'y', joined: false });
  });

  it('a resync leave whose answer was lost does not swallow the next Leave', async () => {
    const mod = await rejoinPending();
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mod.useZustandStore.getState().dispatch({ type: 'leaveRoom' });
    emit({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED', message: 'x' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    // The resync leave's answer is lost with the socket.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.joinOrCreateRoom = vi.fn().mockResolvedValue(undefined);
    clientMock.dispatchEvent(new Event('connected'));
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r' } });
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect(mod.useZustandStore.getState().room?.joined).toBe(true);
    mod.useZustandStore.getState().dispatch({ type: 'leaveRoom' });
    emit({ type: 'leaveRoomSuccess' });
    expect(mod.useZustandStore.getState().room).toBeUndefined();
    expect(localStore.get('courRoom')).toBeUndefined();
  });

  it('a Leave taken while the rejoin is overdue keeps the next reconnect out of the room', async () => {
    const mod = await rejoinPending();
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mod.useZustandStore.getState().dispatch({ type: 'leaveRoom' });
    emit({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED', message: 'x' } });
    clientMock.joinOrCreateRoom = vi.fn().mockResolvedValue(undefined);
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('a room typed after an unanswered join wins over the one still pending', async () => {
    setupDomGlobals({ name: 'user1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('Timed out waiting for a server reply'));
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'x' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'y' } });
    clientMock.joinOrCreateRoom = vi.fn().mockResolvedValue(undefined);
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'y' });
  });

  it('a rejoin cut short by another drop waits for the next reconnect', async () => {
    const mod = await rejoinPending();
    clientMock.joinOrCreateRoom = vi.fn(() => {
      clientMock.dispatchEvent(new Event('disconnected'));
      return Promise.reject(new Error('Socket closed waiting for a server reply'));
    });
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = mod.useZustandStore.getState();
    expect(state.room?.joined).toBe(true);
    expect(state.rejoining).toBe(true);
    expect(state.rejoinOverdue).toBeUndefined();
    // Leave room waits out the next socket's rejoin too.
    clientMock.dispatchEvent(new Event('connected'));
    expect(mod.useZustandStore.getState().rejoinOverdue).toBeUndefined();
  });

  it('drops a ledger refusal that lands after the room was left', async () => {
    const mod = await rejoinPending();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    emit({ type: 'leaveRoomSuccess' });
    emit({ type: 'reviewError', payload: { message: 'Join a room first.' } });
    expect(mod.useZustandStore.getState().toasts.map((t) => t.message)).not.toContain('Join a room first.');
  });

  it('a leave the server already made forgets the remembered room', async () => {
    const mod = await rejoinPending();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    emit({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED', message: 'x' } });
    expect(localStore.get('courRoom')).toBeUndefined();
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  it('the ledger retry waits out a rejoin, which fetches the ledger itself', async () => {
    clientMock.review = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    vi.useFakeTimers();
    clientMock.dispatchEvent(new Event('connected'));
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    await vi.advanceTimersByTimeAsync(0);
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    clientMock.review.mockClear();
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).not.toHaveBeenCalled();
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect(clientMock.review).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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

  it('stays on loading when a back/forward-cache suspension drops that login', async () => {
    setupDomGlobals({ name: 'user1' });
    clientMock.login = vi.fn().mockRejectedValue(Object.assign(new Error('Socket closed'), { suspended: true }));
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mod.useZustandStore.getState().route).toBe('loading');
  });

  it('does not yank an active user off a non-loading route on reconnect', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    emit({ type: 'config', payload: { requiresConfiguration: false } });
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  // The provider-down refusal tells the user access restores
  // automatically. The rotation landing is the event that lifts the
  // lockout, so it has to actually put them back in rather than leaving
  // them on the join form guessing when to click.
  // Every one of these drives the PRODUCTION frame order. The server
  // sends config from the Client constructor, and all three room errors
  // sit behind a login check, so a standing ProviderDownError always
  // implies loginSuccess already landed. Earlier versions of these tests
  // omitted loginSuccess, which made the lockout gate unreachable and
  // left them passing under mutations of the code they name.
  const lockedOut = (mod: Awaited<ReturnType<typeof loadCreateStore>>) => {
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    // A real ledger, so the refusal's clearing is not vacuous.
    emit({
      type: 'reviewSuccess',
      payload: { verdicts: [{ titleId: 101, verdict: 'like' }], total: 2, lockedAt: null },
    });
    emit({
      type: 'joinRoomError',
      payload: { name: 'ProviderDownError', message: 'The anime provider is down.' },
    });
    // The refusal ends the room, and its season's ledger with it.
    expect(mod.useZustandStore.getState().review).toBeUndefined();
    clientMock.joinOrCreateRoom.mockClear();
  };

  it('rejoins the refused room when a rotation lifts the lockout', async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);

    // The season lands, which is exactly when the lockout lifts.
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });

    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledTimes(1);
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
    expect(mod.useZustandStore.getState().error).toBeUndefined();
    // Their picks were reset with everyone's, so they hear why.
    expect(mod.useZustandStore.getState().toasts.map((t) => t.message)).toContain(
      "The season rotated: Fall is up. Fresh deck, everyone's picks reset.",
    );
  });

  it('sends exactly ONE rejoin when the lockout lifts across a reconnect', async () => {
    // The operational path: AniList goes down, users are refused, the
    // container is restarted (1.3.9's /health now reports 503, so an
    // operator is likelier to), and every locked-out client reconnects
    // into a settled season. The reconnect's own login rejoin and the
    // lockout rejoin both want to fire; only one may.
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);

    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    clientMock.joinOrCreateRoom.mockClear();
    // Fresh socket: config carries the settled season and arrives BEFORE
    // the relogin answers.
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });

    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledTimes(1);
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
  });

  it('lands a page lifted from a lockout as itself, whatever another tab typed meanwhile', async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);
    localStore.set('courName', 'user3');
    localStore.set('courRoom', 'r3');
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect([localStore.get('courName'), localStore.get('courRoom')]).toEqual(['user1', 'movie-night']);
  });

  it('lifts a lockout into the room the member typed, not the one the tab was in', async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    // A reconnect's rejoin is refused, and the member types another room.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'UsernameTakenError', message: 'Pick a different name.' } });
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r7' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'ProviderDownError', message: 'The anime provider is down.' } });
    clientMock.joinOrCreateRoom.mockClear();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r7' });
  });

  it("lifts a lockout into the tab's own room after a typed name was refused", async () => {
    setupDomGlobals({ name: 'user1', room: 'r1' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r1', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    emit({ type: 'joinRoomError', payload: { name: 'ProviderDownError', message: 'The anime provider is down.' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'x'.repeat(40) } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    clientMock.joinOrCreateRoom.mockClear();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r1' });
  });

  it("never lifts a lockout into another tab's room, or a refused name's", async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);
    // A typed name the server refuses takes its room back.
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    localStore.set('courName', 'user3');
    localStore.set('courRoom', 'r3');
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('lifts a lockout through a typed name in flight, joining once', async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    emit({ type: 'loginSuccess', payload: { userName: 'user5' } });
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledTimes(1);
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'r5' });
  });

  it('takes the lifted room back from a typed name the server refuses', async () => {
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    lockedOut(mod);
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'r5' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user5' } });
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    emit({ type: 'loginError', payload: { message: 'Names are 1 to 32 characters.' } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenLastCalledWith({ userName: 'user1' });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });

  it('does NOT rejoin on an ordinary rotation the user was not locked out of', async () => {
    // Only the lockout earns an automatic rejoin. Someone who simply left
    // a room must not be dragged back into it by a season change.
    setupDomGlobals({ name: 'user1', room: 'movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    emit({ type: 'loginSuccess', payload: { userName: 'user1' } });
    clientMock.joinOrCreateRoom.mockClear();

    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
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
    mod.useZustandStore.getState().dispatch({ type: 'soundPref', payload: { enabled: true } });
    expect(localStore.get('courAutoplaySound')).toBe('1');
    expect(mod.useZustandStore.getState().soundPref).toBe(true);
  });

  it('login dispatch remembers the name', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user6' } });
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
    mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'home' } });
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

  it('a rejoin before the ledger arrives keeps the fresh join landing', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    emit({ type: 'reviewSuccess', payload: ledger({ verdicts: [{ titleId: 1, verdict: 'like', updatedAt: 1 }] }) });
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  it('leaving drops a landing still pending', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'home' } });
    joinFresh(mod);
    emit({ type: 'leaveRoomSuccess' });
    emit({ type: 'reviewSuccess', payload: ledger({ verdicts: [{ titleId: 1, verdict: 'like', updatedAt: 1 }] }) });
    expect(mod.useZustandStore.getState().route).toBe('home');
  });

  it('a refused rejoin drops a landing still pending', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    joinFresh(mod);
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'joinRoomError', payload: { message: 'This room is locked.' } });
    emit({ type: 'reviewSuccess', payload: ledger({ verdicts: [{ titleId: 1, verdict: 'like', updatedAt: 1 }] }) });
    expect(mod.useZustandStore.getState().route).not.toBe('room');
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    clientMock.review.mockClear();
    emit({ type: 'mediaChanged', payload: { media: [] } });
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });

  it('does not refetch the ledger for a deck swap outside a joined room', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.review.mockClear();
    emit({ type: 'mediaChanged', payload: { media: [] } });
    expect(clientMock.review).not.toHaveBeenCalled();
  });

  it('routes the results dispatch through the request-helper method, not the raw socket', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'results' });
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect(mod.useZustandStore.getState().tutorialOpen).toBe(true);
  });

  it('a rejoin does not reopen a dismissed tutorial', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    mod.useZustandStore.getState().dispatch({ type: 'tutorial', payload: { open: false } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [] } });
    expect(mod.useZustandStore.getState().tutorialOpen).toBe(false);
  });

  it('stays closed once the seen-flag exists', async () => {
    localStore.set('courTutorialSeenV2', '1');
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
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
    mod.useZustandStore.getState().dispatch({ type: 'chooseRoom', payload: { roomName: 'beta' } });
    mod.useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'user1' } });
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } });
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

  it('a review dropped by a back/forward-cache suspension raises no toast and no retry', async () => {
    clientMock.review = vi.fn().mockRejectedValue(Object.assign(new Error('Socket closed'), { suspended: true }));
    const mod = await loadCreateStore();
    mod.createStore();
    vi.useFakeTimers();
    await join(mod);
    await vi.advanceTimersByTimeAsync(0);
    clientMock.review.mockClear();
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).not.toHaveBeenCalled();
    expect(mod.useZustandStore.getState().toasts.some((t) => t.id.startsWith('request-timeout'))).toBe(false);
    vi.useRealTimers();
  });

  it('a back/forward-cache suspension cancels a pending review retry', async () => {
    clientMock.review = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    vi.useFakeTimers();
    await join(mod);
    await vi.advanceTimersByTimeAsync(0);
    clientMock.review.mockClear();
    clientMock.dispatchEvent(new CustomEvent('disconnected', { detail: { suspended: true } }));
    await vi.advanceTimersByTimeAsync(4100);
    expect(clientMock.review).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a lock-in dropped by a back/forward-cache suspension still ends its ceremony', async () => {
    clientMock.lockIn = vi.fn().mockRejectedValue(Object.assign(new Error('Socket closed'), { suspended: true }));
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'finalizing', payload: { kind: 'lock' } });
    mod.useZustandStore.getState().dispatch({ type: 'lockIn' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mod.useZustandStore.getState().finalizing).toBeUndefined();
  });

  it.each(['submitRankingsError', 'submitRefinedRankingsError'])(
    'a %s refetches the results so the screen shows what the server holds',
    async (type) => {
      const mod = await loadCreateStore();
      mod.createStore();
      clientMock.results.mockClear();
      emit({ type, payload: { message: 'Re-ranking opens once every ranking is in.' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(clientMock.results).toHaveBeenCalledTimes(1);
      expect(mod.useZustandStore.getState().toasts.at(-1)?.message).toBe('Re-ranking opens once every ranking is in.');
    },
  );

  it('sends a refine to the server and ends its ceremony when the request dies', async () => {
    clientMock.submitRefinedRankings = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    mod.useZustandStore.getState().dispatch({ type: 'finalizing', payload: { kind: 'refine' } });
    mod.useZustandStore.getState().dispatch({ type: 'submitRefinedRankings', payload: { rankedTitleIds: [2, 1] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.submitRefinedRankings).toHaveBeenCalledWith({ rankedTitleIds: [2, 1] });
    expect(mod.useZustandStore.getState().finalizing).toBeUndefined();
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
    mod.useZustandStore.getState().dispatch({ type: 'review' });
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
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } });
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
    expect(state.toasts.map((t) => t.message)).toContain(
      "The season rotated: Fall is up. Fresh deck, everyone's picks reset.",
    );
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });

  it('fetches the new ledger after the rejoin when the rotation lands across a reconnect', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'SUMMER', year: 2026 } });
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'r' } });
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new Event('connected'));
    clientMock.review.mockClear();
    emit({ type: 'config', payload: { requiresConfiguration: false, season: 'FALL', year: 2026 } });
    expect(clientMock.review).not.toHaveBeenCalled();
    emit({ type: 'joinRoomSuccess', payload: { roomName: 'r', media: [], users: [] } });
    expect(clientMock.review).toHaveBeenCalledTimes(1);
  });
});
