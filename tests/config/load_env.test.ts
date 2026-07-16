import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock readDockerSecret BEFORE importing load_env. The default returns
// undefined so the env vars are the only signal; individual tests can
// override it to exercise the secret-takes-precedence path.
//
// vi.hoisted is required here because vi.mock is itself hoisted above
// imports; a plain `const dockerSecretMock = vi.fn()` at module top
// would be in TDZ when the mock factory ran. Same root cause as the
// loggerMockFactory closure-form pattern from audit 13 / 0.4.24.
const { dockerSecretMock } = vi.hoisted(() => ({
  dockerSecretMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../internal/app/reely/config/load_secrets', () => ({
  readDockerSecret: dockerSecretMock,
}));

import { loadFromEnv } from '../../internal/app/reely/config/load_env';

beforeEach(() => {
  dockerSecretMock.mockClear();
  dockerSecretMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadFromEnv: trivial / empty', () => {
  it('returns undefined when no recognized env vars are set', async () => {
    expect(await loadFromEnv()).toBeUndefined();
  });
});

describe('loadFromEnv: scalar values', () => {
  it('reads HOST as a string', async () => {
    vi.stubEnv('HOST', '127.0.0.1');
    expect((await loadFromEnv())?.hostname).toBe('127.0.0.1');
  });

  it('reads PORT as a number', async () => {
    vi.stubEnv('PORT', '9000');
    expect((await loadFromEnv())?.port).toBe(9000);
  });

  // Number('abc') -> NaN; the loader rejects rather than letting NaN
  // override the default downstream.
  it('throws on a non-numeric PORT', async () => {
    vi.stubEnv('PORT', 'abc');
    await expect(loadFromEnv()).rejects.toThrow(/PORT="abc" is not a valid number/);
  });

  // Audit 12 #236: hostile env values get JSON.stringify-quoted in the
  // error so a `PORT="<script>..."` doesn't land in container logs as
  // raw HTML/script characters.
  it('JSON-quotes the offending PORT value in the error message (audit 12 #236)', async () => {
    vi.stubEnv('PORT', '<script>');
    await expect(loadFromEnv()).rejects.toThrow(/PORT="<script>"/);
  });

  it('reads LOG_LEVEL as a string', async () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');
    expect((await loadFromEnv())?.logLevel).toBe('DEBUG');
  });

  it('reads ROOT_PATH as a string', async () => {
    vi.stubEnv('ROOT_PATH', '/reely');
    expect((await loadFromEnv())?.rootPath).toBe('/reely');
  });
});

describe('loadFromEnv: EnvBool parsing', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses ANIME_SHOW_SEQUELS=%s as %s', async (raw, expected) => {
    vi.stubEnv('ANIME_SHOW_SEQUELS', raw);
    expect((await loadFromEnv())?.anime?.showSequels).toBe(expected);
  });

  // Silent coercion of an invalid value to the default would HIDE the
  // typo (ANIME_SHOW_SEQUELS=ture would just be "false"). Throw instead.
  it('throws on an invalid boolean value (no silent coercion to default)', async () => {
    vi.stubEnv('ANIME_SHOW_SEQUELS', 'ture');
    await expect(loadFromEnv()).rejects.toThrow(/not a valid boolean/);
  });
});

describe('loadFromEnv: EnvList parsing', () => {
  it('splits ALLOWED_ORIGINS on commas and trims segments', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'http://a, http://b , http://c');
    expect((await loadFromEnv())?.allowedOrigins).toEqual(['http://a', 'http://b', 'http://c']);
  });

  it('drops empty segments so "a,,b" yields ["a","b"]', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'http://a,,http://b');
    expect((await loadFromEnv())?.allowedOrigins).toEqual(['http://a', 'http://b']);
  });
});

describe('loadFromEnv: partial-bundle gates (audit 12 #198)', () => {
  // Each multi-field bundle (basicAuth, tlsConfig) is emitted ONLY when
  // both halves of its required pair are present. Without the gate,
  // setting only one half emits a bundle that spreads over YAML and
  // ERASES the partner field that was already configured there.

  it('emits a basicAuth bundle only when BOTH AUTH_USER and AUTH_PASS are set', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', 'hunter2');
    expect((await loadFromEnv())?.basicAuth).toEqual({ userName: 'admin', password: 'hunter2' });
  });

  it('emits NO basicAuth bundle when only AUTH_USER is set', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    expect((await loadFromEnv())?.basicAuth).toBeUndefined();
  });

  it('emits a tlsConfig bundle only when BOTH TLS_CERT and TLS_KEY are set', async () => {
    vi.stubEnv('TLS_CERT', '/etc/ssl/cert.pem');
    vi.stubEnv('TLS_KEY', '/etc/ssl/key.pem');
    expect((await loadFromEnv())?.tlsConfig).toEqual({
      certFile: '/etc/ssl/cert.pem',
      keyFile: '/etc/ssl/key.pem',
    });
  });

  it('emits NO tlsConfig bundle when only TLS_CERT is set', async () => {
    vi.stubEnv('TLS_CERT', '/etc/ssl/cert.pem');
    expect((await loadFromEnv())?.tlsConfig).toBeUndefined();
  });
});

describe('loadFromEnv: docker secrets take precedence over env vars', () => {
  // Audit 12 #209 made readDockerSecret async; loadFromEnv awaits it.
  // The secret takes precedence when present, so an operator who's set
  // up a secret can leave the env var unset (or even set, for migration)
  // and the secret wins.
  it('uses the auth_pass docker secret over AUTH_PASS env when both are set', async () => {
    dockerSecretMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'auth_pass' ? 'secret-pass' : undefined),
    );
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', 'env-pass');
    expect((await loadFromEnv())?.basicAuth?.password).toBe('secret-pass');
  });
});

describe('loadFromEnv: PROVIDER + ANIME_*', () => {
  it('PROVIDER=anilist emits a complete token-less server bundle', async () => {
    vi.stubEnv('PROVIDER', 'anilist');
    expect((await loadFromEnv())?.servers).toEqual([
      { type: 'anilist', url: 'https://graphql.anilist.co' },
    ]);
  });

  it('throws on an invalid PROVIDER instead of silently defaulting', async () => {
    vi.stubEnv('PROVIDER', 'anilst');
    await expect(loadFromEnv()).rejects.toThrow(/PROVIDER="anilst" is not a valid provider/);
  });

  it('rejects the retired PROVIDER=plex explicitly (0.4.0 teardown)', async () => {
    vi.stubEnv('PROVIDER', 'plex');
    await expect(loadFromEnv()).rejects.toThrow(/anime-only/);
  });

  it('reads the ANIME_* block', async () => {
    vi.stubEnv('ANIME_SEASON', 'SUMMER');
    vi.stubEnv('ANIME_YEAR', '2026');
    vi.stubEnv('ANIME_SHOW_SEQUELS', 'true');
    vi.stubEnv('ANIME_CACHE_DIR', '/data/anilist');
    expect((await loadFromEnv())?.anime).toEqual({
      season: 'SUMMER',
      year: 2026,
      showSequels: true,
      cacheDir: '/data/anilist',
    });
  });

  it('emits no anime block when no ANIME_* vars are set (cannot erase YAML)', async () => {
    vi.stubEnv('PROVIDER', 'anilist');
    expect((await loadFromEnv())?.anime).toBeUndefined();
  });

  it('throws on a non-numeric ANIME_YEAR', async () => {
    vi.stubEnv('ANIME_YEAR', 'soon');
    await expect(loadFromEnv()).rejects.toThrow(/ANIME_YEAR="soon" is not a valid number/);
  });

  it('throws on a non-boolean ANIME_SHOW_SEQUELS', async () => {
    vi.stubEnv('ANIME_SHOW_SEQUELS', 'ture');
    await expect(loadFromEnv()).rejects.toThrow(/not a valid boolean/);
  });
});
