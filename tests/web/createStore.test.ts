import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ReelyClient is mocked out wholesale: the store's WS dispatch / event
// wiring is what we want to assert here, not the underlying socket
// behavior (already covered by tests/web/reelyClient.test.ts). The mock
// is an EventTarget so the store's addEventListener calls work, and each
// method is a vi.fn so we can assert the routing in dispatchToClient.
const makeClientMock = () => {
  const client = new EventTarget() as EventTarget & Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    'verdict', 'review', 'skipRemaining', 'lockIn', 'results', 'login',
    'createRoom', 'joinRoom', 'joinOrCreateRoom', 'leaveRoom',
    'sendMessage',
  ] as const) {
    // Default: every method returns a resolved Promise. Individual tests
    // can replace a method (e.g. with vi.fn().mockRejectedValue(...)) to
    // exercise the dispatch-catch path.
    client[name] = vi.fn().mockResolvedValue(undefined);
  }
  return client;
};

let clientMock: ReturnType<typeof makeClientMock>;
vi.mock('../../web/app/src/api/reely', () => ({
  // Constructor returns the shared mock so the test can assert against the
  // same instance the store binds its listeners to. When `new` calls a
  // function that returns an object, JS uses that object instead of the
  // freshly-allocated `this` (a legitimate constructor pattern). Note: must
  // be a function expression, not an arrow -- arrows can't be called with
  // `new`. The closure over `clientMock` is resolved at construction time,
  // not factory time, so beforeEach's re-assignment of clientMock is in
  // effect by the time createStore() runs.
  // biome-ignore lint/complexity/useArrowFunction: arrow functions can't be called with `new`, but createStore does `new ReelyClient()`. Function expression is required here.
  ReelyClient: function () {
    return clientMock;
  },
}));

// localStorage / location / history / navigator / document don't exist in
// the node test env. Each test sets them via stubs; the store reads them
// at module-load and inside the createStore() call.
const setupDomGlobals = (opts: {
  href?: string;
  token?: string | null;
} = {}) => {
  const store = new Map<string, string>();
  if (opts.token != null) store.set('courToken', opts.token);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  vi.stubGlobal('location', {
    href: opts.href ?? 'https://reely.example.com/',
    search: opts.href ? new URL(opts.href).search : '',
  });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('document', { title: 'Reely', body: { dataset: {} } });
};

const loadCreateStore = async () => {
  const mod = await import('../../web/app/src/store/createStore');
  return mod;
};

beforeEach(() => {
  clientMock = makeClientMock();
  setupDomGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createStore initial state', () => {
  it('applies "connecting" status as the first state update', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().connectionStatus).toBe('connecting');
  });


});

describe('dispatchToClient routing', () => {
  // One smoke test per ClientActions variant -- the switch's `default: never`
  // enforces exhaustiveness at compile time, but a routing typo (e.g. login
  // -> client.logout()) wouldn't fail typecheck. These tests pin the actual
  // method getting called per action type.
  const cases = [
    ['createRoom', { roomName: 'r' }],
    ['joinRoom', { roomName: 'r' }],
    ['joinOrCreateRoom', { roomName: 'r' }],
    ['verdict', { titleId: 101, verdict: 'like' }],
  ] as const;

  for (const [type, payload] of cases) {
    it(`routes "${type}" to ReelyClient.${type}`, async () => {
      const mod = await loadCreateStore();
      mod.createStore();
      // biome-ignore lint/suspicious/noExplicitAny: test action shape; reducer types not the point here.
      mod.useZustandStore.getState().dispatch({ type, payload } as any);
      expect(clientMock[type]).toHaveBeenCalledTimes(1);
      expect(clientMock[type]).toHaveBeenCalledWith(payload);
    });
  }

  it('routes "leaveRoom" as a no-arg call', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    const { dispatch } = useZustandStore.getState();
    dispatch({ type: 'leaveRoom' });
    expect(clientMock.leaveRoom).toHaveBeenCalledWith();
  });

  it('does not forward UI-only actions (addToast / navigate) to the WS client', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    const { dispatch } = useZustandStore.getState();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'addToast', payload: { id: 't', message: 'x', appearance: 'Success', showTimeMs: 1000 } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'navigate', payload: { route: 'home' } } as any);
    // No WS method should fire for either.
    for (const name of Object.keys(clientMock).filter((k) => typeof clientMock[k] === 'function')) {
      expect(clientMock[name]).not.toHaveBeenCalled();
    }
  });

});

describe('dispatch promise-rejection toast (audit 12 #246)', () => {
  // A request method's rejection (REQUEST_TIMEOUT_MS in api/reely.ts, or a
  // mid-wait close) must surface as a toast instead of leaving the UI hung
  // on an unhandled rejection.
  it('adds a "server isn\'t responding" toast when a dispatched request rejects', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({
      type: 'joinOrCreateRoom',
      payload: { roomName: 'movie-night' },
    });
    // Let the rejection microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.some((t) => t.message.includes("isn't responding"))).toBe(true);
  });

  it('does NOT add a toast when a dispatch resolves cleanly', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({ type: 'review' });
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.length).toBe(0);
  });
});

describe('loading-escape timer (audit 13 #303)', () => {
  it('navigates to home if still on the loading route 5s after createStore', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().route).toBe('loading');
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('home');
  });

  it('does NOT navigate if the route has already moved off "loading"', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    // Simulate something having navigated away first (the connected handler,
    // the user, etc.). The timer's check guards on `route === 'loading'`.
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'room' } } as any);
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('room');
  });

  it('is cleared by signal abort (HMR cycle)', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // Capture the FIRST store's handle BEFORE the re-call swaps the
    // exported binding. Without this, we'd be observing the second
    // store (whose own timer fires at 5s) and couldn't tell whether
    // the first's timer was actually cleared.
    const firstStore = mod.useZustandStore;
    mod.createStore();
    vi.advanceTimersByTime(5_001);
    // Without abort + clearTimeout, the first store's timer would have
    // navigated firstStore to 'home'. With it, firstStore stays put.
    expect(firstStore.getState().route).toBe('loading');
  });
});

describe('AbortController teardown across HMR (audit 13 #302 / audit 14 #365)', () => {
  it("removes the first call's listeners when createStore is invoked a second time", async () => {
    // EventTarget has no public listener-count API; observe behaviour
    // instead. With a stored name, dispatch "connected" after a second
    // createStore and assert the auto-login fires exactly once (one
    // bind), not twice.
    localStorage.setItem('courName', 'user1');
    const mod = await loadCreateStore();
    mod.createStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledTimes(1);
  });
});
