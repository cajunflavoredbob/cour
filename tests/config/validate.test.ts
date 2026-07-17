import { describe, it, expect } from 'vitest';

// Logger mock dropped in 0.4.16: validate.ts no longer imports the
// logger (redaction registration moved to config/redact.ts -- audit
// 12 #237 + #276). The validator is a pure (unknown) -> ReelyError[]
// with no transitive pino import, so the worker-thread guard the
// mock used to provide is no longer needed here.
import { normalizeAndValidateConfig } from '../../internal/app/reely/config/validate';

const errNames = (config: unknown): string[] =>
  normalizeAndValidateConfig(config).map((e) => e.name).sort();

describe('normalizeAndValidateConfig', () => {
  it.each<[unknown, string[]]>([
    [undefined,                                                    ['ConfigMustBeRecord']],
    [{},                                                           ['ServersMustBeArray']],
    [{ hostname: 123 },                                            ['HostNameMustBeString', 'ServersMustBeArray']],
    [{ port: '123' },                                              ['ServersMustBeArray']],
    [{ port: 'abc' },                                              ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ port: 123 },                                                ['ServersMustBeArray']],
    [{ port: 0 },                                                  ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ port: 65536 },                                              ['PortMustBeNumber', 'ServersMustBeArray']],
    [{ logLevel: 'debug' },                                        ['ServersMustBeArray']],
    [{ logLevel: 'not a level' },                                  ['LogLevelInvalid', 'ServersMustBeArray']],
    [{ servers: 123 },                                             ['ServersMustBeArray']],
    [{ servers: [] },                                              ['ServersMustNotBeEmpty']],
    [{ servers: [undefined] },                                     ['ServerMustBeRecord']],
    [{ servers: [{}] },                                            ['ServerUrlMustBeString']],
    [{ servers: [{ url: 'localhost' }] },                          ['ServerUrlInvalid']],
    [{ servers: [{ url: 'localhost' }] },                          ['ServerUrlInvalid']],
    [{ servers: [{ url: 'localhost', token: 'abc123' }] },         ['ServerUrlInvalid']],
    [{ servers: [{ url: 'http://localhost', token: 'abc123' }] },  []],
    [{ servers: [{ type: 'jellyfin', url: 'http://localhost', token: 'abc123' }] }, ['ServerTypeInvalid']],
    // libraryTypeFilter dropped in 0.4.1 (movies-only). An old config with
    // the field is silently ignored -- the validator doesn't error on unknown
    // server fields, so the line below must NOT produce a validation error.
    [{ servers: [{ libraryTypeFilter: ['movie'], url: 'http://localhost', token: 'abc123' }] }, []],
    [{ rootPath: '/' },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 123 },                                            ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ rootPath: 'noslash' },                                      ['ServerBasePathInvalid', 'ServersMustBeArray']],
    [{ basicAuth: 'user1:test' },                                   ['BasicAuthInvalid', 'ServersMustBeArray']],
    [{ basicAuth: {} },                                            ['BasicAuthPasswordInvalid', 'BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'user1' } },                          ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    // #57: an empty password used to pass (it is a string) -> silent auth bypass.
    [{ basicAuth: { userName: 'user1', password: '' } },            ['BasicAuthPasswordInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: '', password: 'test' } },            ['BasicAuthUserNameInvalid', 'ServersMustBeArray']],
    [{ basicAuth: { userName: 'user1', password: 'test' } },        ['ServersMustBeArray']],
    [{ tlsConfig: '/foo.crt' },                                    ['ServersMustBeArray', 'TlsConfigInvalid']],
    [{ tlsConfig: {} },                                            ['ServersMustBeArray', 'TlsConfigCertFileInvalid', 'TlsConfigKeyFileInvalid']],
    // 0.4.15 EXPOSE_PLEX_BASE_URL opt-out: must be a boolean when present.
    // The env loader coerces strings via EnvBool, so a non-boolean lands
  ])('%j → %j', (config, expected) => {
    expect(errNames(config)).toEqual([...expected].sort());
  });
});

// AniList provider config (0.2.x provider batch): anilist servers are
// token-less, and the `anime` tuning block gets its own validation.
describe('normalizeAndValidateConfig: anilist servers + anime block', () => {
  const VALID_SERVERS = [{ url: 'http://localhost', token: 'abc123' }];

  it.each<[unknown, string[]]>([
    // An anilist server is complete with just type + url -- no token.
    [{ servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }] }, []],
    // A plex server (explicit or defaulted type) still requires one.
    [{ servers: [{ type: 'plex', url: 'http://localhost' }] },    ['ServerTypeInvalid']],
    [{ servers: [{ url: 'http://localhost' }] },                  []],
    // A token on an anilist server is ignored, not an error (unknown-field
    // tolerance, same stance as libraryTypeFilter above).
    [{ servers: [{ type: 'anilist', url: 'https://graphql.anilist.co', token: 'ignored' }] }, []],
    // The URL is still validated for anilist servers.
    [{ servers: [{ type: 'anilist', url: 'not a url' }] },        ['ServerUrlInvalid']],

    // anime block field validation.
    [{ servers: VALID_SERVERS, anime: 'summer' },                 ['AnimeConfigInvalid']],
    [{ servers: VALID_SERVERS, anime: {} },                       []],
    [{ servers: VALID_SERVERS, anime: { season: 'SUMMER' } },     []],
    [{ servers: VALID_SERVERS, anime: { season: 'autumn' } },     ['AnimeSeasonInvalid']],
    [{ servers: VALID_SERVERS, anime: { season: 4 } },            ['AnimeSeasonInvalid']],
    [{ servers: VALID_SERVERS, anime: { year: 2026 } },           []],
    [{ servers: VALID_SERVERS, anime: { year: '2026' } },         []],
    [{ servers: VALID_SERVERS, anime: { year: 1899 } },           ['AnimeYearInvalid']],
    [{ servers: VALID_SERVERS, anime: { year: 20026 } },          ['AnimeYearInvalid']],
    [{ servers: VALID_SERVERS, anime: { year: 'soon' } },         ['AnimeYearInvalid']],
    [{ servers: VALID_SERVERS, anime: { year: 2026.5 } },         ['AnimeYearInvalid']],
    [{ servers: VALID_SERVERS, anime: { showSequels: true } },    []],
    // YAML `showSequels: "false"` would be truthy if let through.
    [{ servers: VALID_SERVERS, anime: { showSequels: 'false' } }, ['AnimeShowSequelsInvalid']],
    [{ servers: VALID_SERVERS, anime: { cacheDir: '/data' } },    []],
    [{ servers: VALID_SERVERS, anime: { cacheDir: '' } },         ['AnimeCacheDirInvalid']],
    [{ servers: VALID_SERVERS, anime: { cacheDir: 123 } },        ['AnimeCacheDirInvalid']],
  ])('%j → %j', (config, expected) => {
    expect(errNames(config)).toEqual([...expected].sort());
  });

  // Same in-place normalization contract as logLevel: case-insensitive
  // season input is canonicalized so downstream consumers (provider, cache
  // filename) always see the uppercase form.
  it('uppercases anime.season in place', () => {
    const config = { servers: VALID_SERVERS, anime: { season: 'summer' } };
    expect(errNames(config)).toEqual([]);
    expect(config.anime.season).toBe('SUMMER');
  });

  // String years are coerced in place, mirroring port.
  it('coerces a numeric-string anime.year in place', () => {
    const config = { servers: VALID_SERVERS, anime: { year: '2026' } };
    expect(errNames(config)).toEqual([]);
    expect(config.anime.year).toBe(2026);
  });
});
