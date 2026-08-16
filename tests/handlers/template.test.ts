// This test file intentionally contains `${...}` placeholder strings
// in its template fixtures -- the handler under test is exactly the
// thing that interpolates them. Suppressing the noTemplateCurlyInString
// rule file-wide rather than per-line keeps the fixtures readable.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: template fixtures use literal ${...}.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// readFile is mocked so we can supply our own template HTML without
// touching disk. The handler memoizes the result via util/memo;
// vi.resetModules in beforeEach is necessary so the memo cache
// re-initializes per test (each test can override the template body).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedGetConfig = vi.fn();
vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: mockedGetConfig,
}));

const mockedGetVersion = vi.fn();
vi.mock('../../internal/app/reely/version', () => ({
  getVersion: mockedGetVersion,
}));

import { readFile } from 'node:fs/promises';

const mockedReadFile = vi.mocked(readFile);

// ─── Stubs ──────────────────────────────────────────────────────────────

const makeReq = (headers: Record<string, string | string[] | undefined> = {}): Request =>
  ({ headers } as unknown as Request);

const makeRes = () => {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  const r = {
    statusCode: 200,
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
    status: vi.fn(function (this: typeof r, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function (this: typeof r, payload: string) {
      body = payload;
      return this;
    }),
    headers,
    getBody: () => body,
  };
  return r as unknown as Response & typeof r;
};

const DEFAULT_TEMPLATE =
  '<html><head><title>reely ${version}</title></head>' +
  '<body><script>const root="${rootPath}";</script>${greeting}</body></html>';

// ─── Tests ──────────────────────────────────────────────────────────────

// resetModules between tests so `getTemplate`'s memo cache rebuilds
// against the per-test readFile mock value.
beforeEach(() => {
  vi.resetModules();
  mockedReadFile.mockResolvedValue(DEFAULT_TEMPLATE as never);
  mockedGetConfig.mockReturnValue({ rootPath: '' } as never);
  mockedGetVersion.mockResolvedValue('1.2.3');
});

describe('template handler: basic render', () => {
  it('substitutes ${version} from getVersion() and sends 200 + headers', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    // The entry HTML must NOT be cached -- a deploy could otherwise
    // leave the browser pointing at non-existent old asset filenames
    // (template.ts comment, audit-history).
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.getBody()).toContain('reely 1.2.3');
  });

  it('substitutes ${rootPath} from config when no proxy header is set', async () => {
    mockedGetConfig.mockReturnValue({ rootPath: '/reely' } as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toContain('const root="/reely";');
  });
});

describe('template handler: HTML escaping (XSS defense)', () => {
  it('escapes &, <, >, ", \' in substituted values', async () => {
    // Drive the escaper through ${version} (the i18n context died in
    // audit 17's sweep; the interpolate/escape machinery did not).
    mockedGetVersion.mockResolvedValue(`<script>alert("xss & 'pwn'")</script>`);
    mockedReadFile.mockResolvedValue('v=${version}' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.getBody() ?? '';
    // Raw script tag must not appear; escaped form must.
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;alert(&quot;xss &amp; &#39;pwn&#39;&quot;)&lt;/script&gt;');
  });
});

describe('template handler: rootPath resolution', () => {
  it('reads x-forwarded-prefix header in preference to config', async () => {
    mockedGetConfig.mockReturnValue({ rootPath: '/from-config' } as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '/from-proxy' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/from-proxy";');
  });

  it('takes the first element when x-forwarded-prefix is an array', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': ['/first', '/second'] }),
      res,
    );
    expect(res.getBody()).toContain('const root="/first";');
  });

  it('strips all whitespace from the prefix (not just edges)', async () => {
    // audit 9 #161: a proxy that forwards internal whitespace must not
    // poison the template -- silently drop the whitespace.
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '  /re ely  ' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/reely";');
  });

  it('strips a trailing slash from the prefix', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '/reely/' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/reely";');
  });

  // audit 12 #224: hostile header chars (.., <, >, etc) get HTML-escaped
  // at substitution but could land in href/src URL contexts where URL
  // parsers don't apply HTML escaping. Allowlist drops the value
  // entirely so the misconfiguration surfaces immediately.
  it.each([
    '/../system',     // .. path traversal -- caught by the explicit `..` check (added in this batch)
    '/foo/../bar',    // .. anywhere in the path, not just leading
    '/<script>',      // < / > rejected by the allowlist
    '/path?query',    // ? rejected by the allowlist
    '/path#fragment', // # rejected by the allowlist
    '/path&query=1',  // & rejected by the allowlist
  ])(
    'drops invalid prefix %j to empty string',
    async (badPrefix) => {
      const { handler } = await import('../../internal/app/reely/handlers/template');
      const res = makeRes();
      await handler(makeReq({ 'x-forwarded-prefix': badPrefix }), res);
      const body = res.getBody() ?? '';
      // After whitespace strip + trailing-slash strip + ..-check +
      // allowlist check, a failed gate drops the candidate to ''.
      expect(body).toContain('const root="";');
    },
  );

  it('strips internal whitespace BEFORE allowlist check, so /a b c becomes /abc (valid)', async () => {
    // Whitespace-rich paths are rescued by the audit-9 #161 strip, not
    // rejected outright. The resulting compact form passes the allowlist
    // when its remaining chars are valid.
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq({ 'x-forwarded-prefix': '/a b c' }), res);
    expect(res.getBody()).toContain('const root="/abc";');
  });

  it('falls back to empty string when neither header nor config is set', async () => {
    mockedGetConfig.mockReturnValue({} as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toContain('const root="";');
  });
});

describe('template handler: missing-key + dotted-path resolution', () => {
  it('substitutes a missing key as empty string (not "undefined")', async () => {
    mockedReadFile.mockResolvedValue('greeting=[${greeting}]' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('greeting=[]');
  });

  it('resolves a dotted path that runs off the flat context as empty', async () => {
    // The context is flat (rootPath + version) since the i18n removal;
    // the dotted-path walker stays as audit 10 #168 hardening.
    mockedReadFile.mockResolvedValue('hi ${user.name}' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('hi ');
  });

  // audit 10 #168: the prior reduce form silently returned the parent
  // string when a later segment ran off the end (e.g. context {a: "x"}
  // and keyPath ['a','b'] returned "x"). Now: returns '' the moment any
  // intermediate node isn't an object.
  it('returns empty string when a dotted path runs into a non-object', async () => {
    mockedReadFile.mockResolvedValue('val=[${a.b}]' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('val=[]');
  });
});

// ─── Express 5 routing seam ─────────────────────────────────────────────

// app.ts registers `app.get('/{*splat}', ...)` as the SPA fallback: the
// express 5 (path-to-regexp v8) replacement for the v4 `'*'` catch-all.
// The unit tests above call the handler directly, so nothing else pins
// the DISPATCH semantics of that pattern -- an unbraced '/*splat' would
// silently stop matching '/', and a regression here ships a blank root
// page while every handler test stays green. This mini-app mirrors
// app.ts's registration order with stub handlers and drives real HTTP
// through a loopback listen, pinning:
//   - '/{*splat}' matches the root path AND deep client routes
//   - earlier routes (/health, the poster route) still win over it
//   - poster params arrive as plain single strings under express 5
describe('SPA fallback route dispatch (express 5 seam)', () => {
  it('routes /, deep links, and odd paths to the fallback; earlier routes win', async () => {
    const { default: express } = await import('express');
    const app = express();
    const hits: Array<{ route: string; params?: Record<string, unknown> }> = [];
    app.get('/health', (_req, res) => { hits.push({ route: 'health' }); res.status(200).send('ok'); });
    app.get('/api/poster/:providerIndex/:metadataId/:thumbId', (req, res) => {
      hits.push({ route: 'poster', params: req.params });
      res.status(200).send('poster');
    });
    app.get('/{*splat}', (_req, res) => { hits.push({ route: 'template' }); res.status(200).send('template'); });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('expected an AddressInfo');
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      expect(await (await fetch(`${base}/`)).text()).toBe('template');
      expect(await (await fetch(`${base}/room/deep/link`)).text()).toBe('template');
      expect(await (await fetch(`${base}//double-slash`)).text()).toBe('template');
      expect(await (await fetch(`${base}/health`)).text()).toBe('ok');
      expect(await (await fetch(`${base}/api/poster/3/14/15`)).text()).toBe('poster');

      const poster = hits.find((h) => h.route === 'poster');
      expect(poster?.params).toEqual({ providerIndex: '3', metadataId: '14', thumbId: '15' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
