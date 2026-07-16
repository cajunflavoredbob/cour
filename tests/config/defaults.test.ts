import { describe, expect, it } from 'vitest';
import { applyDefaults } from '../../internal/app/reely/config/defaults';

// Pure function: layers a defaults record over the partial input. The
// nested defaultServerConfig is merged into EACH item in `servers` (so
// every entry gets `type: 'anilist'` unless it already has one).

describe('applyDefaults', () => {
  it('returns the full defaults when given an empty object', () => {
    // AniList ships as the default server (0.13.2): zero config boots a
    // working app -- there is exactly one provider, so nothing to ask.
    expect(applyDefaults({})).toEqual({
      hostname: '0.0.0.0',
      port: 8000,
      logLevel: 'INFO',
      rootPath: '',
      servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
    });
  });

  it('lets the input override individual default keys', () => {
    const out = applyDefaults({ port: 9000, hostname: '127.0.0.1' });
    expect(out.port).toBe(9000);
    expect(out.hostname).toBe('127.0.0.1');
    // Other defaults must still be present.
    expect(out.logLevel).toBe('INFO');
  });

  it('layers defaultServerConfig (type: "anilist") onto each server entry', () => {
    const out = applyDefaults({
      servers: [{ url: 'https://graphql.anilist.co' }],
    });
    expect(out.servers).toEqual([
      { type: 'anilist', url: 'https://graphql.anilist.co' },
    ]);
  });

  it('lets an explicit server.type override the default', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec server shape to prove the merge preserves an explicit type. Validator catches unknown types elsewhere.
    const out = applyDefaults({ servers: [{ type: 'emby', url: 'http://x' } as any] });
    expect(out.servers?.[0]?.type).toBe('emby');
  });

  it('keeps `servers: []` as an empty array (the documented default)', () => {
    const out = applyDefaults({ servers: [] });
    expect(out.servers).toEqual([]);
  });

  // The `Array.isArray` guard means a non-array `servers` (e.g. a malformed
  // YAML scalar) doesn't crash the map call -- it just survives untouched
  // into the result, where the validator will catch it. Pin that behavior.
  it('does not throw when servers is not an array', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec input to exercise the Array.isArray guard.
    expect(() => applyDefaults({ servers: 'oops' as any })).not.toThrow();
  });

  it('does not mutate the input object', () => {
    const input = { port: 9000 };
    const before = JSON.stringify(input);
    applyDefaults(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// AniList servers: the public GraphQL endpoint is the only real URL, so
// applyDefaults fills it in -- YAML `servers: [{ type: anilist }]` (or an
// empty server object, since anilist is the type default) is a complete
// configuration.
describe('applyDefaults: anilist servers', () => {
  it('fills the AniList API URL when an anilist server omits url', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately partial server shape; the URL default under test is what completes it.
    const out = applyDefaults({ servers: [{ type: 'anilist' } as any] });
    expect(out.servers?.[0]?.url).toBe('https://graphql.anilist.co');
  });

  it('keeps an explicit anilist url untouched', () => {
    const out = applyDefaults({
      servers: [{ type: 'anilist', url: 'http://proxy.lan:9999' }],
    });
    expect(out.servers?.[0]?.url).toBe('http://proxy.lan:9999');
  });
});
