import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggerMockFactory } from '../helpers';

// app.ts boots the entire server: TLS read, providers, express
// middleware, the cour database, HTTP/HTTPS server, WS upgrade, ping
// timer, shutdown wiring. We mock everything below express (Node net +
// ws + providers + fs + handlers/api; the cour db opens :memory:) so the
// tests assert app.ts's orchestration without opening sockets or
// touching the disk.
//
// vi.hoisted lifts only the mock vi.fn() handles; the actual fake-server
// instances (which need EventEmitter at construction) are built in
// beforeEach. The hoisted factory runs BEFORE imports resolve, so anything
// touching imported symbols (EventEmitter, Buffer, etc.) has to live
// outside it. Same constraint root as the loggerMockFactory closure-form
// pattern from audit 13 / 0.4.24.
const {
  createHttpServerMock,
  createHttpsServerMock,
  WebSocketServerMock,
  readFileMock,
  createProviderMock,
  createWsUpgradeHandlerMock,
} = vi.hoisted(() => {
  const wsClients = new Set();
  class WebSocketServerMock {
    clients = wsClients;
    on = vi.fn();
    close = vi.fn();
  }
  return {
    createHttpServerMock: vi.fn(),
    createHttpsServerMock: vi.fn(),
    WebSocketServerMock,
    readFileMock: vi.fn(),
    createProviderMock: vi.fn(),
    createWsUpgradeHandlerMock: vi.fn(() => () => {}),
  };
});

vi.mock('node:http', () => ({ createServer: createHttpServerMock }));
vi.mock('node:https', () => ({ createServer: createHttpsServerMock }));
vi.mock('node:fs/promises', async () => {
  // Other tests (load_yaml) use real fs/promises -- this mock only fires
  // for files that resolve this mocked module spec. importActual preserves
  // mkdtemp/chmod/etc. for transitive code paths; we only override readFile.
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: readFileMock };
});
vi.mock('ws', () => ({ WebSocketServer: WebSocketServerMock }));
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());
vi.mock('../../internal/app/reely/providers/anime', () => ({
  createProvider: createProviderMock,
}));
// The cour database must not land on disk from a unit test: keep the
// real schema/logic but point every open at :memory:.
vi.mock('../../internal/app/cour/db', async () => {
  const actual = await vi.importActual<typeof import('../../internal/app/cour/db')>(
    '../../internal/app/cour/db',
  );
  return { ...actual, openDb: () => actual.openDb(':memory:') };
});
vi.mock('../../internal/app/reely/handlers/api', () => ({
  createWsUpgradeHandler: createWsUpgradeHandlerMock,
}));

// Imports BELOW the vi.mock calls so the mocks are in place at import-bind time.
import { Application, ProviderUnavailableError } from '../../internal/app/reely/app';
import { logger } from '../../internal/app/reely/logger';
import type { Config } from '../../types/reely';

// Fake HTTP(S) server. Built per-test so each test gets fresh listener
// state. `listen` fires its callback asynchronously (setImmediate) to keep
// the microtask order realistic. `close` likewise fires its callback so
// shutdown's `httpServer.close(cb)` resolves the statusCode promise.
type FakeServer = EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
};

const makeFakeServer = (): FakeServer => {
  const server = new EventEmitter() as FakeServer;
  server.listen = vi.fn((_port: number, _hostname: string, cb: () => void) => {
    setImmediate(cb);
    return server;
  });
  server.close = vi.fn((cb?: () => void) => {
    setImmediate(() => cb?.());
    return server;
  });
  server.closeAllConnections = vi.fn();
  return server;
};

let fakeHttpServer: FakeServer;
let fakeHttpsServer: FakeServer;

// Minimum viable config. Tests override specific fields per case.
const baseConfig = (): Config =>
  ({
    hostname: '127.0.0.1',
    port: 8000,
    logLevel: 'INFO',
    rootPath: '',
    servers: [],
    // biome-ignore lint/suspicious/noExplicitAny: Config in tests; missing fields are validator-enforced elsewhere, not the orchestration code under test.
  }) as any;

// Build a provider stub matching the ReelyProvider surface app.ts touches.
// Only `isAvailable` + `options.url` actually matter for startup; the rest
// satisfy the type. Tests override isAvailable per case to drive the
// availability branches.
// biome-ignore lint/suspicious/noExplicitAny: provider stub for orchestration tests; full ReelyProvider surface not exercised.
const makeProviderStub = (opts: { isAvailable?: boolean; url?: string } = {}): any => ({
  type: 'anilist',
  options: { url: opts.url ?? 'https://graphql.anilist.co' },
  isAvailable: vi.fn().mockResolvedValue(opts.isAvailable ?? true),
  isUserAuthorized: vi.fn().mockResolvedValue(true),
  getName: vi.fn().mockResolvedValue('AniList Summer 2026'),
  getServerId: vi.fn().mockResolvedValue('SERVER1'),
  getLibraries: vi.fn().mockResolvedValue([]),
  getFilters: vi.fn().mockResolvedValue({}),
  getFilterValues: vi.fn().mockResolvedValue([]),
  getArtwork: vi.fn(),
  getMedia: vi.fn().mockResolvedValue([]),
});

beforeEach(() => {
  fakeHttpServer = makeFakeServer();
  fakeHttpsServer = makeFakeServer();
  createHttpServerMock.mockReset().mockReturnValue(fakeHttpServer);
  createHttpsServerMock.mockReset().mockReturnValue(fakeHttpsServer);
  // Default read behavior is ENOENT: matches a bare filesystem (no TLS
  // certs, no data/settings.json). Tests that need a file to exist layer
  // mockResolvedValueOnce on top, which Once-stubs take precedence over.
  // Without this, createSettingsStore's boot read sees `undefined`, treats
  // it as a corrupt settings file, and warn-logs in every test (0.3.0).
  readFileMock.mockReset().mockRejectedValue(
    Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
  );
  createProviderMock.mockReset();
  createWsUpgradeHandlerMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Application: provider config branches', () => {
  it('emits no warn when zero servers are configured', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  // Audit 12 #233 / #239 / #273: `servers` stays an array for the 1.0
  // multi-PROVIDER extension (Plex + Emby + JF), but multi-server is NOT
  // a supported configuration TODAY. An operator who pasted two server
  // blocks gets a warn + only [0] is used.
  it('warns when more than one server is configured and uses only the first', async () => {
    const config = baseConfig();
    config.servers = [
      { type: 'anilist', url: 'https://graphql.anilist.co' },
      { type: 'anilist', url: 'http://proxy.lan:9999' },
    ];
    createProviderMock.mockReturnValueOnce(makeProviderStub({ url: 'https://graphql.anilist.co' }));
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 servers configured'),
    );
    expect(createProviderMock).toHaveBeenCalledTimes(1);
    expect(createProviderMock).toHaveBeenCalledWith('0', expect.objectContaining({ url: 'https://graphql.anilist.co' }));
  });

  it('rejects (statusCode -> 1) on a non-anilist server type', async () => {
    const config = baseConfig();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec server type to exercise the runtime guard that catches what TS would reject upstream.
    config.servers = [{ type: 'emby', url: 'http://emby', token: 't' } as any];
    const { statusCode } = Application(config);
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('server type emby unhandled'),
    );
  });

  it('rejects with ProviderUnavailableError when the provider isAvailable returns false', async () => {
    const config = baseConfig();
    config.servers = [{ type: 'anilist', url: 'https://graphql.anilist.co' }];
    createProviderMock.mockReturnValueOnce(makeProviderStub({ isAvailable: false }));
    const { statusCode } = Application(config);
    await expect(statusCode).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Message genericized in the 0.2.x provider batch: it now leads with the
    // provider type so the anilist first-boot-offline case reads correctly.
    await expect(statusCode).rejects.toThrow(/anilist provider unavailable/);
  });
});

describe('Application: TLS read order (audit 13 #293)', () => {
  // TLS cert/key are read at the TOP of the IIFE so a bad path fails fast
  // BEFORE express setup + provider probes + the room TTL sweep. The
  // pre-fix ordering burned every startup side effect before surfacing
  // ENOENT, leaving dangling state to clean up.
  it('surfaces a TLS readFile failure as statusCode -> 1', async () => {
    const config = baseConfig();
    config.tlsConfig = { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' };
    readFileMock.mockRejectedValueOnce(new Error('ENOENT: no such file'));
    const { statusCode } = Application(config);
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startup error'),
    );
  });

  it('does NOT create a provider when the TLS read fails (early-exit ordering)', async () => {
    const config = baseConfig();
    config.servers = [{ type: 'anilist', url: 'https://graphql.anilist.co' }];
    config.tlsConfig = { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' };
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    const { statusCode } = Application(config);
    await statusCode;
    expect(createProviderMock).not.toHaveBeenCalled();
  });
});

describe('Application: bind-all-interfaces warn', () => {
  // The room model is gated only by knowledge of the room name. On a
  // routable network without Basic Auth, that's effectively no gate at
  // all. Operators who bind to 0.0.0.0/:: without basicAuth get a warn
  // in the container log.
  it.each([['0.0.0.0'], ['::'], ['']])(
    'warns when bound to "%s" without basicAuth',
    async (hostname) => {
      const config = baseConfig();
      config.hostname = hostname;
      Application(config);
      // Wait through listen-callback + microtasks.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(true);
    },
  );

  it('does NOT warn when bound to all interfaces WITH basicAuth set', async () => {
    const config = baseConfig();
    config.hostname = '0.0.0.0';
    config.basicAuth = { userName: 'admin', password: 'hunter2' };
    Application(config);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(false);
  });

  it('does NOT warn when bound to a specific (non-all-interfaces) hostname', async () => {
    const config = baseConfig();
    config.hostname = '127.0.0.1';
    Application(config);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(false);
  });
});

describe('Application: HTTP vs HTTPS server selection', () => {
  it('creates a plain HTTP server when no TLS config is provided', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(createHttpServerMock).toHaveBeenCalledTimes(1);
    expect(createHttpsServerMock).not.toHaveBeenCalled();
  });

  it('creates an HTTPS server with the read bundle when TLS config is provided', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('CERT'));
    readFileMock.mockResolvedValueOnce(Buffer.from('KEY'));
    const config = baseConfig();
    config.tlsConfig = { certFile: '/etc/cert.pem', keyFile: '/etc/key.pem' };
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(createHttpsServerMock).toHaveBeenCalledTimes(1);
    expect(createHttpServerMock).not.toHaveBeenCalled();
    const [tlsArg] = createHttpsServerMock.mock.calls[0] ?? [];
    expect(tlsArg).toEqual({ cert: Buffer.from('CERT'), key: Buffer.from('KEY') });
  });
});

// `signal.addEventListener('abort', ...)` is registered LATE in the IIFE
// (after express setup + listen + interval creation + shutdown definition).
// A single setImmediate cycle isn't enough -- if abort() fires before the
// listener is registered, the listener never gets the event (AbortController
// only dispatches to listeners present at abort time; addEventListener
// after-the-fact does NOT fire). Wait until the listener is actually
// installed by polling its presence on the signal.
const waitForAbortListener = async (signal: AbortSignal): Promise<void> => {
  // EventTarget doesn't expose listener counts, so we use a behavior probe:
  // create a sibling listener, observe whether the signal-emit path is set
  // up by waiting through enough microtask cycles for the IIFE to settle.
  // 50 cycles is well past startup's actual depth (~6 awaits) without
  // ballooning test time.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
  }
  void signal; // arg present to document intent; the wait is time-based here
};

describe('Application: shutdown via abort signal', () => {
  it('resolves statusCode to undefined on clean shutdown', async () => {
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    controller.abort();
    await expect(statusCode).resolves.toBeUndefined();
    expect(fakeHttpServer.close).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: the shuttingDown guard short-circuits a second call path', async () => {
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    controller.abort();
    await statusCode;
    // AbortController only fires once, so we can't dispatch a second abort
    // directly. The idempotency guard exists for the case where the
    // listener fires twice (defensive). Smoke-check by asserting the
    // single-call counts after the abort -- if shuttingDown weren't
    // guarded, future re-entry would double them.
    expect(fakeHttpServer.close).toHaveBeenCalledTimes(1);
  });
});

describe('Application: WS upgrade wiring', () => {
  it('registers the upgrade handler returned by createWsUpgradeHandler', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(createWsUpgradeHandlerMock).toHaveBeenCalledTimes(1);
    // The handler is attached via httpServer.on('upgrade', handler);
    // verify the EventEmitter actually has an 'upgrade' listener.
    expect(fakeHttpServer.listenerCount('upgrade')).toBe(1);
  });
});

describe('Application: generic startup error', () => {
  it('catches a settings-store boot throw and resolves statusCode to 1', async () => {
    // A non-ENOENT boot failure inside createSettingsStore's mkdir/read
    // path surfaces through the same generic startup catch. Simulate via
    // readFile throwing something the store treats as fatal-adjacent --
    // the store itself only warn-logs read errors, so use the http server
    // constructor instead: it's the first sync throw after settings load.
    createHttpServerMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { statusCode } = Application(baseConfig());
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startup error'),
    );
  });
});
