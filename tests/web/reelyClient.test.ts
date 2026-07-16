import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable WebSocket double. The real ReelyClient creates `new WebSocket(...)`
// inside its constructor and again inside its private reconnect path, so the test
// needs to capture each socket instance and drive its open/close/message events
// from the outside. `instances` is the bridge: every `new MockWebSocket(...)` pushes
// itself onto it, and `latest()` returns the one ReelyClient is currently bound to.
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances.at(-1);
    if (!last) throw new Error('no MockWebSocket has been constructed yet');
    return last;
  }
  static reset() {
    MockWebSocket.instances = [];
  }

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.simulateClose();
  }
  // Test-side drivers (named `simulate*` so the test reads as a script of events).
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  simulateMessage(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  simulateError() {
    this.dispatchEvent(new Event('error'));
  }
}

// API_URL is computed at module-load time from `location.href` and
// `document.body.dataset.rootPath`. Stub both before importing the module
// so the URL parses cleanly and we can also assert what it resolved to.
const setupDomGlobals = (rootPath = '') => {
  vi.stubGlobal('location', { href: 'https://reely.example.com:8000/app/' });
  vi.stubGlobal('document', { body: { dataset: { rootPath } } });
};

// Lazy import the module AFTER globals are stubbed. Each test that wants a
// different rootPath / location must call vi.resetModules() first.
const loadClient = async () => {
  const mod = await import('../../web/app/src/api/reely');
  return mod.ReelyClient;
};

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  setupDomGlobals('');
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('API_URL', () => {
  it('upgrades https -> wss and appends /api/ws under the rootPath', async () => {
    setupDomGlobals('/reely');
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url).toBe('wss://reely.example.com:8000/reely/api/ws');
  });

  it('uses ws:// when the page is plain http', async () => {
    vi.stubGlobal('location', { href: 'http://reely.local/' });
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url.startsWith('ws://')).toBe(true);
  });

  it('strips query params so page params are not carried into the WS URL', async () => {
    vi.stubGlobal('location', { href: 'https://reely.example.com/?debug=1' });
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url).not.toContain('debug=1');
  });
});

describe('handleMessage shape-guard (audit 13 #311)', () => {
  it('dispatches the message under its `type` and the generic "message"', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const typed = vi.fn();
    const generic = vi.fn();
    client.addEventListener('loginSuccess', typed);
    client.addEventListener('message', generic);
    MockWebSocket.latest().simulateMessage({ type: 'loginSuccess', payload: {} });
    expect(typed).toHaveBeenCalledTimes(1);
    expect(generic).toHaveBeenCalledTimes(1);
  });

  it('drops null frames without dispatching', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const heard = vi.fn();
    client.addEventListener('message', heard);
    MockWebSocket.latest().simulateMessage('null');
    expect(heard).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('drops frames whose `type` is not a string', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const heard = vi.fn();
    client.addEventListener('message', heard);
    MockWebSocket.latest().simulateMessage({ type: 42 });
    expect(heard).not.toHaveBeenCalled();
  });

  it('drops frames that fail JSON.parse without throwing', async () => {
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(() => MockWebSocket.latest().simulateMessage('not-json')).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('waitForConnected', () => {
  it('resolves immediately when the socket is already open', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    await expect(client.waitForConnected()).resolves.toBe(true);
  });

  it('waits for the "connected" event when the socket is still connecting', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const promise = client.waitForConnected();
    MockWebSocket.latest().simulateOpen();
    await expect(promise).resolves.toBe(true);
  });

  // Why a separate "connected" event instead of waiting on the socket's "open":
  // mid-reconnect the dead socket would never fire open, so we listen on the
  // client instead which survives the swap (comment in source).
  it('still resolves after a reconnect cycle (close -> connect -> open)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateClose();
    const promise = client.waitForConnected();
    vi.advanceTimersByTime(2_000); // wake the scheduled reconnect
    MockWebSocket.latest().simulateOpen();
    await expect(promise).resolves.toBe(true);
  });
});

describe('waitForAnyMessage', () => {
  it('resolves on the first matching message type', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess', 'loginError']);
    MockWebSocket.latest().simulateMessage({ type: 'loginSuccess', payload: {} });
    await expect(promise).resolves.toMatchObject({ type: 'loginSuccess' });
  });

  it('rejects when the socket closes mid-wait (audit 13 #312)', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess', 'loginError']);
    MockWebSocket.latest().simulateClose();
    await expect(promise).rejects.toThrow(/Socket closed/);
  });

  it('rejects after REQUEST_TIMEOUT_MS without a reply', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess']);
    // 15s is REQUEST_TIMEOUT_MS in the source.
    vi.advanceTimersByTime(15_001);
    await expect(promise).rejects.toThrow(/Timed out/);
  });

  // Fast verdict taps put several requests in flight at once; the match
  // predicate correlates each response to its caller's titleId.
  it('uses the match predicate to route responses to the right caller', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(
      ['verdictSuccess'],
      (m) => m.type === 'verdictSuccess' && m.payload.titleId === 101,
    );
    // Wrong-title response: must NOT resolve the waiter.
    MockWebSocket.latest().simulateMessage({
      type: 'verdictSuccess',
      payload: { titleId: 999, verdict: 'like' },
    });
    // Right-title response.
    MockWebSocket.latest().simulateMessage({
      type: 'verdictSuccess',
      payload: { titleId: 101, verdict: 'like' },
    });
    const msg = await promise;
    // biome-ignore lint/suspicious/noExplicitAny: discriminated-union payload narrowing not worth a generic in test code.
    expect((msg as any).payload.titleId).toBe(101);
  });
});

describe('reconnect backoff', () => {
  it('schedules a reconnect after close', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.latest().simulateClose();
    // Base 500ms + up to 1s jitter. Advance well past the worst case.
    vi.advanceTimersByTime(2_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('caps the backoff base at 30s even after many failed attempts', async () => {
    vi.useFakeTimers();
    // Pin jitter to 0 so we can assert the deterministic upper bound.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ReelyClient = await loadClient();
    new ReelyClient();
    // Force the backoff counter high enough that 500 * 2^n would exceed 30s.
    for (let i = 0; i < 8; i++) {
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(31_000);
    }
    const beforeCount = MockWebSocket.instances.length;
    MockWebSocket.latest().simulateClose();
    // Just under 30s: no new socket yet (proves cap is at least 30s, not above).
    vi.advanceTimersByTime(29_999);
    expect(MockWebSocket.instances.length).toBe(beforeCount);
    // Crossing 30s: the capped reconnect fires.
    vi.advanceTimersByTime(2);
    expect(MockWebSocket.instances.length).toBe(beforeCount + 1);
  });
});

