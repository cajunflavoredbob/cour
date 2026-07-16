import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// loadFromYaml is mocked per-test via vi.mock(...) below; each test can
// override the return via the helper.
const mockLoadFromYaml = vi.fn();
vi.mock('../../internal/app/reely/config/load_yaml', () => ({
  loadFromYaml: mockLoadFromYaml,
}));

describe('loadConfig env/yaml merge', () => {
  // Tests share env-var pollution; reset on each run.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockLoadFromYaml.mockReset();
    // Strip every env key the loader looks at so individual tests start
    // clean. The plex-era vars died in the 0.4.0 teardown.
    for (const k of [
      'PROVIDER',
      'ANIME_SEASON', 'ANIME_YEAR', 'ANIME_SHOW_SEQUELS', 'ANIME_CACHE_DIR',
      'AUTH_USER', 'AUTH_PASS', 'TLS_CERT', 'TLS_KEY',
      'HOST', 'PORT', 'LOG_LEVEL', 'ROOT_PATH', 'ALLOWED_ORIGINS',
      'SECRETS_DIR',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('env-only config produces a usable Config with defaults filled in', async () => {
    process.env.PROVIDER = 'anilist';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(config.servers[0]).toEqual({
      type: 'anilist',
      url: 'https://graphql.anilist.co',
    });
    // applyDefaults fills these in.
    expect(config.hostname).toBe('0.0.0.0');
    expect(config.port).toBe(8000);
    expect(config.logLevel).toBe('INFO');
  });

  it('parses ALLOWED_ORIGINS into config.allowedOrigins', async () => {
    process.env.PROVIDER = 'anilist';
    process.env.ALLOWED_ORIGINS = 'https://cour.example.com, http://cour.lan';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(config.allowedOrigins).toEqual([
      'https://cour.example.com',
      'http://cour.lan',
    ]);
  });

  it('env vars override top-level yaml values', async () => {
    mockLoadFromYaml.mockResolvedValue({
      port: 1234,
      logLevel: 'DEBUG',
      servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
    });
    process.env.PORT = '9000';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    expect(config.port).toBe(9000);        // env wins
    expect(config.logLevel).toBe('DEBUG'); // yaml survives where env is silent
  });

  it('replaces the yaml server outright when env defines a server (#65)', async () => {
    mockLoadFromYaml.mockResolvedValue({
      servers: [{ type: 'anilist', url: 'http://yaml-proxy.lan:9999' }],
    });
    process.env.PROVIDER = 'anilist';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    // Bundle-replaces semantics: the env server bundle supersedes the yaml
    // entry wholesale -- no per-field merge that could mix the two.
    expect(config.servers).toEqual([
      { type: 'anilist', url: 'https://graphql.anilist.co' },
    ]);
  });

  it('uses the yaml server when env defines none', async () => {
    mockLoadFromYaml.mockResolvedValue({
      servers: [{ type: 'anilist', url: 'http://yaml-proxy.lan:9999' }],
    });

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    expect(config.servers[0].url).toBe('http://yaml-proxy.lan:9999');
  });

  it('skips the yaml file load entirely when path is /dev/null', async () => {
    process.env.PROVIDER = 'anilist';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(mockLoadFromYaml).not.toHaveBeenCalled();
    expect(config.servers[0].url).toBe('https://graphql.anilist.co');
  });

  it('rethrows when an explicit path is missing on disk', async () => {
    // With an explicit path, any load error is fatal regardless of type.
    mockLoadFromYaml.mockRejectedValue(new Error('/explicit/path.yaml does not exist'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig('/explicit/path.yaml')).rejects.toThrow(/does not exist/);
  });

  it('tolerates a missing default config file', async () => {
    // No path argument -> falls back to cwd/config.yaml. A genuine
    // file-not-found there is acceptable: loadConfig returns env+defaults.
    // ConfigFileNotFoundError is imported here (not at module scope) so it's
    // the same class instance the freshly-imported loadConfig sees -- the
    // beforeEach vi.resetModules() would otherwise break the instanceof check.
    const { ConfigFileNotFoundError } = await import('../../internal/app/reely/config/errors');
    mockLoadFromYaml.mockRejectedValue(new ConfigFileNotFoundError('default path absent'));
    process.env.PROVIDER = 'anilist';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig();

    expect(config.servers[0].url).toBe('https://graphql.anilist.co');
    expect(config.port).toBe(8000); // default
  });

  // #42: a malformed or unreadable default config file is NOT a missing file;
  // swallowing it would silently start the server with the wrong config.
  it('rethrows a malformed default config file rather than swallowing it (#42)', async () => {
    mockLoadFromYaml.mockRejectedValue(new Error('bad YAML indentation'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig()).rejects.toThrow(/bad YAML/);
  });

  describe('partial env bundles preserve YAML (audit 12 #198)', () => {
    it('AUTH_USER alone preserves YAML basicAuth password', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
        basicAuth: { userName: 'yaml-user', password: 'yaml-pass' },
      });
      process.env.AUTH_USER = 'env-user';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake-config.yaml');

      // The lone env half must NOT half-overwrite the yaml bundle.
      expect(config.basicAuth).toEqual({ userName: 'yaml-user', password: 'yaml-pass' });
    });

    it('TLS_CERT alone preserves YAML tlsConfig keyFile', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
        tlsConfig: { certFile: '/yaml/cert.pem', keyFile: '/yaml/key.pem' },
      });
      process.env.TLS_CERT = '/env/cert.pem';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake-config.yaml');

      expect(config.tlsConfig).toEqual({
        certFile: '/yaml/cert.pem',
        keyFile: '/yaml/key.pem',
      });
    });

    it('full env basicAuth bundle still overrides YAML', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
        basicAuth: { userName: 'yaml-user', password: 'yaml-pass' },
      });
      process.env.AUTH_USER = 'env-user';
      process.env.AUTH_PASS = 'env-pass';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake-config.yaml');

      expect(config.basicAuth).toEqual({ userName: 'env-user', password: 'env-pass' });
    });
  });

  describe('anime block merge', () => {
    it('env ANIME_* overrides the yaml anime block wholesale-per-field', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
        anime: { season: 'SPRING', year: 2026 },
      });
      process.env.ANIME_SEASON = 'SUMMER';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake-config.yaml');

      expect(config.anime?.season).toBe('SUMMER');
    });

    it('no ANIME_* env leaves the yaml anime block untouched', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
        anime: { season: 'FALL', year: 2026, showSequels: true },
      });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake-config.yaml');

      expect(config.anime).toEqual({ season: 'FALL', year: 2026, showSequels: true });
    });
  });
});
