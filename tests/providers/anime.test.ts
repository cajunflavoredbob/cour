import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeasonalAnime } from '../../internal/app/anilist/types';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// AniListApi and the disk cache are mocked at the module boundary (same
// class-boundary pattern as tests/providers/plex.test.ts): the provider
// tests assert the load/refresh orchestration and the ReelyProvider surface,
// not HTTP or fs behavior -- those have their own suites under tests/anilist.
const { mockApi, AniListApiMock, loadCacheMock, saveCacheMock } = vi.hoisted(() => {
  const mockApi = {
    fetchSeason: vi.fn(),
  };
  class AniListApiMock {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: deliberate test double -- same pattern as plex.test.ts's PlexApiMock.
      return mockApi;
    }
  }
  return {
    mockApi,
    AniListApiMock,
    loadCacheMock: vi.fn(),
    saveCacheMock: vi.fn(),
  };
});

vi.mock('../../internal/app/anilist/api', async () => {
  // DegradedUpstreamError must be the REAL class: ensureLoaded branches on
  // `err instanceof DegradedUpstreamError` to decide whether the
  // previous-season fallback is allowed, and a stubbed-out (undefined)
  // export makes that expression throw rather than evaluate false.
  const actual = await vi.importActual<typeof import('../../internal/app/anilist/api')>(
    '../../internal/app/anilist/api',
  );
  return {
    AniListApi: AniListApiMock,
    ANILIST_API_URL: 'https://graphql.anilist.co',
    DegradedUpstreamError: actual.DegradedUpstreamError,
  };
});
vi.mock('../../internal/app/anilist/cache', () => ({
  SEASON_CACHE_VERSION: 1,
  loadSeasonCache: loadCacheMock,
  saveSeasonCache: saveCacheMock,
}));

const { tmdbEnrichMock } = vi.hoisted(() => ({ tmdbEnrichMock: vi.fn() }));
vi.mock('../../internal/app/tmdb/api', () => ({
  TmdbApi: class {},
  enrichStills: tmdbEnrichMock,
}));

import { DegradedUpstreamError } from '../../internal/app/anilist/api';
import { logger } from '../../internal/app/reely/logger';
import { type AnimeProviderConfig, createProvider } from '../../internal/app/reely/providers/anime';

const entry = (over: Partial<SeasonalAnime> = {}): SeasonalAnime => ({
  id: 1,
  title: 'Show',
  description: 'desc',
  season: 'SUMMER',
  seasonYear: 2026,
  genres: [],
  popularity: 0,
  isSequel: false,
  ...over,
});

// Popularity-ordered fixture: 3 originals + 1 sequel, mixed genres/formats.
const SEASON: SeasonalAnime[] = [
  entry({ id: 1, title: 'Alpha', popularity: 900, genres: ['Action', 'Fantasy'], format: 'TV' }),
  entry({ id: 2, title: 'Beta S2', popularity: 800, genres: ['Action'], format: 'TV', isSequel: true }),
  entry({ id: 3, title: 'Gamma', popularity: 700, genres: ['Romance'], format: 'ONA' }),
  entry({
    id: 4,
    title: 'Delta',
    popularity: 600,
    genres: ['Comedy'],
    format: 'MOVIE',
    idMal: 44,
    duration: 24,
    rating: 8.1,
    coverUrl: 'https://s4.anilist.co/xl/4.jpg',
    trailer: { site: 'youtube', id: 'vid4' },
  }),
];

const makeProvider = (over: Partial<AnimeProviderConfig> = {}) =>
  createProvider('0', {
    url: 'https://graphql.anilist.co',
    season: 'SUMMER',
    year: 2026,
    ...over,
  });

// Flush the fire-and-forget background refresh chain.
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockApi.fetchSeason.mockReset();
  loadCacheMock.mockReset();
  saveCacheMock.mockReset();
  // Default: no disk cache, live fetch succeeds.
  loadCacheMock.mockResolvedValue(undefined);
  mockApi.fetchSeason.mockResolvedValue(SEASON);
  saveCacheMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Several tests pin the clock (freeze windows, rotation marks).
  vi.useRealTimers();
});

describe('load orchestration', () => {
  it('cache miss: blocks on the live fetch, then persists the snapshot', async () => {
    const provider = makeProvider();
    const media = await provider.getMedia();
    expect(media.length).toBeGreaterThan(0);
    expect(mockApi.fetchSeason).toHaveBeenCalledWith('SUMMER', 2026);
    await flush();
    expect(saveCacheMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ season: 'SUMMER', year: 2026, media: SEASON }),
    );
  });

  it('cache hit: serves the cached snapshot and refreshes in the background', async () => {
    // The startup self-refresh only fires before the list freeze (two
    // weeks ahead of the season start) -- pin the clock inside SUMMER
    // 2026's pre-season window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 15));
    const cachedOnly = [entry({ id: 99, title: 'Cached', popularity: 1 })];
    loadCacheMock.mockResolvedValue({
      version: 1,
      fetchedAt: 0,
      season: 'SUMMER',
      year: 2026,
      media: cachedOnly,
    });
    // Hold the live fetch open so the first read provably comes from cache.
    let releaseRefresh: (v: SeasonalAnime[]) => void = () => {};
    mockApi.fetchSeason.mockReturnValue(
      new Promise<SeasonalAnime[]>((r) => {
        releaseRefresh = r;
      }),
    );

    const provider = makeProvider();
    const before = await provider.getMedia();
    expect(before.map((m) => m.title)).toEqual(['Cached']);

    releaseRefresh(SEASON);
    await flush();
    const after = await provider.getMedia();
    expect(after.map((m) => m.id)).toEqual(['1', '3', '4']); // sequel hidden
    expect(saveCacheMock).toHaveBeenCalled();
  });

  it('cache hit + failed background refresh keeps serving the cached snapshot', async () => {
    const cachedOnly = [entry({ id: 99, title: 'Cached' })];
    loadCacheMock.mockResolvedValue({
      version: 1,
      fetchedAt: 0,
      season: 'SUMMER',
      year: 2026,
      media: cachedOnly,
    });
    mockApi.fetchSeason.mockRejectedValue(new Error('AniList down'));

    const provider = makeProvider();
    expect(await provider.isAvailable()).toBe(true);
    await flush();
    expect((await provider.getMedia()).map((m) => m.title)).toEqual(['Cached']);
  });

  it('first boot offline: isAvailable false, and a later call can recover', async () => {
    mockApi.fetchSeason.mockRejectedValueOnce(new Error('offline'));
    const provider = makeProvider();
    expect(await provider.isAvailable()).toBe(false);

    // The failed load cleared its slot; the next call retries and succeeds.
    mockApi.fetchSeason.mockResolvedValue(SEASON);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('cache persist failure does not fail the load', async () => {
    saveCacheMock.mockRejectedValue(new Error('read-only fs'));
    const provider = makeProvider();
    expect(await provider.isAvailable()).toBe(true);
    expect((await provider.getMedia()).length).toBeGreaterThan(0);
  });

  it('loads once: concurrent callers share a single fetch', async () => {
    const provider = makeProvider();
    await Promise.all([provider.getMedia(), provider.getMedia(), provider.isAvailable()]);
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(1);
  });
});

describe('deck shape', () => {
  it('is popularity-ordered (source order preserved) and flags mediaOrdered', async () => {
    const provider = makeProvider({ showSequels: true });
    expect(provider.mediaOrdered).toBe(true);
    const media = await provider.getMedia();
    expect(media.map((m) => m.id)).toEqual(['1', '2', '3', '4']);
  });

  it('hides sequels by default and includes them with showSequels', async () => {
    expect((await makeProvider().getMedia()).map((m) => m.id)).toEqual(['1', '3', '4']);
    expect(
      (await makeProvider({ showSequels: true }).getMedia()).map((m) => m.id),
    ).toEqual(['1', '2', '3', '4']);
  });

  it('maps SeasonalAnime to the Media wire shape', async () => {
    const media = await makeProvider().getMedia();
    const delta = media.find((m) => m.id === '4');
    expect(delta).toEqual({
      id: '4',
      type: 'anime',
      title: 'Delta',
      titleRomaji: undefined,
      description: 'desc',
      year: 2026,
      posterUrl: '/api/poster/0/4/0',
      screenshotUrls: undefined,
      genres: ['Comedy'],
      duration: 24 * 60_000, // minutes -> ms (formatDuration's contract)
      rating: 8.1,
      anilistId: 4,
      malId: 44,
      format: 'MOVIE',
      episodes: undefined,
      studio: undefined,
      trailer: { site: 'youtube', id: 'vid4' },
    });
    // No cover art -> no posterUrl rather than a dead proxy link.
    expect(media.find((m) => m.id === '1')?.posterUrl).toBeUndefined();
  });
});

describe('identity surface', () => {
  it('names itself after the season', async () => {
    const provider = makeProvider();
    expect(provider.type).toBe('anilist');
    expect(await provider.getName()).toBe('AniList Summer 2026');
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
  });
});

describe('getArtwork', () => {
  const coverFetch = vi.fn();

  beforeEach(() => {
    coverFetch.mockReset();
    vi.stubGlobal('fetch', coverFetch);
  });

  it('proxies the cover image for a known id', async () => {
    const body = new ReadableStream<Uint8Array>();
    const headers = new Headers({ 'content-type': 'image/jpeg' });
    coverFetch.mockResolvedValue({ ok: true, body, headers });

    const provider = makeProvider();
    const [stream, respHeaders] = await provider.getArtwork('4/0');
    expect(stream).toBe(body);
    expect(respHeaders.get('content-type')).toBe('image/jpeg');
    expect(coverFetch).toHaveBeenCalledWith(
      'https://s4.anilist.co/xl/4.jpg',
      expect.anything(),
    );
  });

  it('rejects ids with no cover art', async () => {
    await expect(makeProvider().getArtwork('1/0')).rejects.toThrow(/no artwork/);
    expect(coverFetch).not.toHaveBeenCalled();
  });

  it('refuses a non-AniList cover host (tampered cache defense)', async () => {
    mockApi.fetchSeason.mockResolvedValue([
      entry({ id: 7, coverUrl: 'https://evil.example.com/x.jpg' }),
    ]);
    await expect(makeProvider().getArtwork('7/0')).rejects.toThrow(/refusing artwork URL host/);
    expect(coverFetch).not.toHaveBeenCalled();
  });

  it('refuses plain-http cover URLs', async () => {
    mockApi.fetchSeason.mockResolvedValue([
      entry({ id: 8, coverUrl: 'http://s4.anilist.co/x.jpg' }),
    ]);
    await expect(makeProvider().getArtwork('8/0')).rejects.toThrow(/refusing artwork URL host/);
  });

  it('surfaces upstream error statuses', async () => {
    coverFetch.mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      headers: new Headers(),
      text: async () => 'gone',
    });
    await expect(makeProvider().getArtwork('4/0')).rejects.toThrow(/404: gone/);
  });
});

describe('TMDB stills (0.9.0)', () => {
  const stillsEntry = entry({
    id: 9,
    title: 'Enriched',
    coverUrl: 'https://s4.anilist.co/xl/9.jpg',
    tmdbId: 42,
    stills: [
      'https://image.tmdb.org/t/p/w780/a.jpg',
      'https://image.tmdb.org/t/p/w780/b.jpg',
    ],
  });

  beforeEach(() => {
    tmdbEnrichMock.mockReset().mockResolvedValue(0);
  });

  it('maps stills to proxied screenshotUrls (thumbId 1..n)', async () => {
    loadCacheMock.mockResolvedValue({ version: 1, fetchedAt: 1, season: 'SUMMER', year: 2026, media: [stillsEntry] });
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));
    const provider = makeProvider();
    const [media] = await provider.getMedia();
    expect(media.screenshotUrls).toEqual(['/api/poster/0/9/1', '/api/poster/0/9/2']);
  });

  it('getArtwork serves still thumbIds from image.tmdb.org', async () => {
    loadCacheMock.mockResolvedValue({ version: 1, fetchedAt: 1, season: 'SUMMER', year: 2026, media: [stillsEntry] });
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));
    const provider = makeProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(['jpg']), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await provider.getArtwork('9/2');
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://image.tmdb.org/t/p/w780/b.jpg');
      // Out-of-range still is a clean error, not a crash.
      await expect(provider.getArtwork('9/7')).rejects.toThrow(/no artwork 7/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a still URL from a non-TMDB host (tampered cache defense)', async () => {
    const tampered = entry({
      id: 10,
      title: 'Evil',
      stills: ['https://evil.example.com/x.jpg'],
    });
    loadCacheMock.mockResolvedValue({ version: 1, fetchedAt: 1, season: 'SUMMER', year: 2026, media: [tampered] });
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));
    const provider = makeProvider();
    await expect(provider.getArtwork('10/1')).rejects.toThrow(/refusing artwork URL host/);
  });

  it('runs enrichment on load when a key getter is present, not otherwise', async () => {
    loadCacheMock.mockResolvedValue({ version: 1, fetchedAt: 1, season: 'SUMMER', year: 2026, media: [entry({ id: 1 })] });
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));
    const noKey = makeProvider();
    await noKey.getMedia();
    expect(tmdbEnrichMock).not.toHaveBeenCalled();

    const withKey = makeProvider({ getTmdbKey: () => 'key123' });
    await withKey.getMedia();
    // Enrichment is fire-and-forget off the load; give it a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(tmdbEnrichMock).toHaveBeenCalledTimes(1);
  });

  it('boot-time enrichment persists when entries gained stills', async () => {
    loadCacheMock.mockResolvedValue({ version: 1, fetchedAt: 1, season: 'SUMMER', year: 2026, media: [entry({ id: 1 })] });
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));
    tmdbEnrichMock.mockImplementation(async (_api, entries) => {
      for (const e of entries) e.stills = ['https://image.tmdb.org/t/p/w780/n.jpg'];
      return entries.length;
    });
    saveCacheMock.mockClear();
    const provider = makeProvider({ getTmdbKey: () => 'key123' });
    await provider.getMedia();
    await new Promise((r) => setTimeout(r, 0));
    expect(saveCacheMock).toHaveBeenCalled();
  });
});

// The owner's rotation spec: unpinned providers serve the calendar
// season until the upcoming season's lock instant -- two weeks before it
// airs, the same moment its list freezes -- then rotate to it, and reset
// room data only after a rotation fetch lands. Because rotation and
// freeze are one event, an unpinned deck is frozen from the moment it is
// served; the daily pre-season refresh only applies to pinned providers.
describe('season rotation (unpinned)', () => {
  const HOUR = 60 * 60 * 1000;

  const unpinned = (over: Partial<AnimeProviderConfig> = {}) =>
    makeProvider({ season: undefined, year: undefined, ...over });

  beforeEach(() => {
    // Fake only the clock + the hourly interval; setTimeout/setImmediate
    // stay real so flush() and promise chains behave.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'] });
  });

  it('keeps serving the airing season until the upcoming one locks', async () => {
    vi.setSystemTime(new Date(2026, 8, 10)); // Sep 10: FALL locks Sep 17
    const provider = unpinned();
    await provider.getMedia();
    expect(mockApi.fetchSeason).toHaveBeenCalledWith('SUMMER', 2026);
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
  });

  it('serves the upcoming season once its lock instant passes', async () => {
    vi.setSystemTime(new Date(2026, 8, 20)); // Sep 20: past FALL's Sep 17 lock
    const provider = unpinned();
    await provider.getMedia();
    expect(mockApi.fetchSeason).toHaveBeenCalledWith('FALL', 2026);
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
  });

  it('rotates at the lock instant and fires onSeasonRotated', async () => {
    vi.setSystemTime(new Date(2026, 8, 16, 12)); // Sep 16 noon: still SUMMER
    const onSeasonRotated = vi.fn();
    const provider = unpinned({ onSeasonRotated });
    await provider.getMedia();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });

    // Cross Sep 17 midnight; the next hourly tick fetches FALL and swaps.
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(mockApi.fetchSeason).toHaveBeenLastCalledWith('FALL', 2026);
    expect(onSeasonRotated).toHaveBeenCalledWith({ season: 'FALL', year: 2026 });
    await flush();
    expect(saveCacheMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ season: 'FALL', year: 2026 }),
    );
  });

  it('keeps serving the old season when the rotation fetch fails, then retries', async () => {
    vi.setSystemTime(new Date(2026, 8, 16, 12));
    const onSeasonRotated = vi.fn();
    const provider = unpinned({ onSeasonRotated });
    await provider.getMedia();

    // Persistent failure, not a single one: the stale-deck retry runs every
    // 30s, so a one-shot rejection would be recovered from inside the same
    // advance and never observed.
    mockApi.fetchSeason.mockRejectedValue(new Error('AniList down'));
    await vi.advanceTimersByTimeAsync(12 * HOUR); // FALL attempts keep failing
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(onSeasonRotated).not.toHaveBeenCalled();
    expect((await provider.getMedia()).length).toBeGreaterThan(0);

    mockApi.fetchSeason.mockResolvedValue(SEASON); // upstream recovers
    await vi.advanceTimersByTimeAsync(60_000); // next retry lands
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(onSeasonRotated).toHaveBeenCalledTimes(1);
  });

  it('boot after rotation with AniList down falls back to the previous season cache', async () => {
    vi.setSystemTime(new Date(2026, 8, 20)); // target FALL 2026 (locked Sep 17)
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(new Error('down'));

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(true);
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect((await provider.getMedia()).map((m) => m.title)).toEqual(['Old Season']);
  });

  it('never runs the daily refresh: a served deck is frozen on arrival', async () => {
    // Rotation and freeze are the same instant, so an unpinned provider
    // only ever serves a season whose list is already locked. The deck
    // the rotation fetch pulled is final -- nothing re-fetches it.
    //
    // Sep 5 is chosen because it DISCRIMINATES against the old behaviour:
    // the one-month rotation served FALL here with its freeze (Sep 17)
    // still ahead, so it refreshed daily. Under the unified lock the
    // served season is SUMMER, frozen since Jun 17. A date past Sep 17
    // would pass under both implementations and prove nothing.
    vi.setSystemTime(new Date(2026, 8, 5));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: Date.now() - 3 * 24 * HOUR, // stale enough to tempt a refresh
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Cached Summer' })],
        })
        : Promise.resolve(undefined));

    const provider = unpinned();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect((await provider.getMedia()).map((m) => m.title)).toEqual(['Cached Summer']);
    await flush();
    await vi.advanceTimersByTimeAsync(72 * HOUR); // three days of ticks
    await flush();
    expect(mockApi.fetchSeason).not.toHaveBeenCalled();
  });

  it('refuses an empty deck on a cold boot rather than serving it all season', async () => {
    // The guard in refresh() used to require a non-empty deck already
    // serving, so a cache-miss boot against a degraded AniList accepted
    // zero entries, persisted them, and served them until the next
    // rotation -- with nothing left to repair it, and the boot sweep
    // reaping the outgoing season's rooms on the way past. Boot must
    // fail loudly instead.
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockResolvedValue(undefined); // cache miss
    mockApi.fetchSeason.mockResolvedValue([]); // degraded upstream

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(false);
    expect(saveCacheMock).not.toHaveBeenCalled();
  });

  it('retries within seconds while provisional, not on the hourly tick', async () => {
    // Room joins, creates and verdicts are locked out for exactly as long
    // as the provisional state lasts, so retrying only hourly would keep
    // rooms locked for up to an hour AFTER AniList recovers, on top of the
    // outage. One minute of ticks must be enough to clear it.
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    await provider.getMedia();
    expect(provider.isSeasonProvisional?.()).toBe(true);

    // Upstream comes back.
    mockApi.fetchSeason.mockResolvedValue(SEASON);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('clears a stale provisional flag when the target converges on the served season', async () => {
    // The lockout is wired to this flag, and rotate() -- its only other
    // clearing edge -- is never reached when target already equals
    // current. So a clock that steps BACKWARD past a lock instant used to
    // park the provider provisional forever with a healthy deck in memory,
    // refusing every join, create and verdict for the process lifetime.
    vi.setSystemTime(new Date(2026, 8, 20)); // past FALL's Sep 17 lock
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    await provider.getMedia();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(true);

    // Clock steps back before the lock: the target is now SUMMER 2026,
    // which is exactly what the fallback already installed.
    vi.setSystemTime(new Date(2026, 8, 10));
    mockApi.fetchSeason.mockResolvedValue(SEASON);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await flush();

    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('re-arms the lockout when a rotation fails, and keeps it set while the deck is stale', async () => {
    // The flag used to have exactly one set site, inside ensureLoaded's
    // once-per-process catch. Combined with the new clearing edge that
    // meant a backward clock step could clear it and a forward step with
    // the upstream still down would leave rooms UNLOCKED against a stale
    // deck, stamping them with a season the reaper deletes on rotation.
    vi.setSystemTime(new Date(2026, 8, 20)); // target FALL 2026
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    await provider.getMedia();
    expect(provider.isSeasonProvisional?.()).toBe(true);

    // Clock steps back: target converges on what we serve, lockout clears.
    vi.setSystemTime(new Date(2026, 8, 10));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(provider.isSeasonProvisional?.()).toBe(false);

    // Clock steps forward again, upstream STILL down. The served deck is
    // stale once more, so the lockout must come back rather than leaving
    // rooms open against SUMMER while FALL is due.
    vi.setSystemTime(new Date(2026, 8, 20));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(true);
  });

  it('stays locked for as long as the upstream is down', async () => {
    // The equality guard in clearProvisionalIfSettled is what stops the
    // lockout lifting while the deck is genuinely still the old season.
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    await provider.getMedia();

    await vi.advanceTimersByTimeAsync(5 * 60_000); // five minutes of retries
    await flush();
    expect(provider.isSeasonProvisional?.()).toBe(true);
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    // The equality guard inside clearProvisionalIfSettled is what stops the
    // lockout lifting while the deck is genuinely still last season's.
    // Asserting only the FLAG cannot see that guard: the retry's failed
    // rotation re-arms it, so a wrongly-cleared flag is restored within the
    // same tick and the end state looks identical. The "cleared" log is the
    // observable that discriminates, and it must never appear here.
    const clearedLogs = vi.mocked(logger.info).mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('room lockout is cleared'));
    expect(clearedLogs).toEqual([]);
  });

  it('a DEGRADED upstream does not fall back: the season must not move backward', async () => {
    // The fallback exists for an UNREACHABLE upstream, so a boot can ride
    // out an outage. It must NOT engage for an upstream that answered with
    // garbage, because falling back moves the served season BACKWARD and
    // puts every room stamped with the real incoming season in front of
    // the reaper and loadRoom's delete. Before the truncation and
    // empty-deck guards existed, this case served a short deck with the
    // season still correct and the data intact, which was recoverable.
    vi.setSystemTime(new Date(2026, 8, 20)); // served season FALL 2026
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(
      new DegradedUpstreamError('page 2 returned no entries mid-pagination'),
    );

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(false);
    // Season stayed correct, and nothing was marked provisional, so the
    // boot sweep and loadRoom never act against a stale value.
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('an UNREACHABLE upstream still falls back (the outage path is unchanged)', async () => {
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(true);
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(true);
  });

  it('a discarded EMPTY served-season cache does not fall back either', async () => {
    // The empty-is-a-miss rule opened a second route into the backward
    // fallback: discard the served season's zero-entry file, fail the live
    // fetch with an unreachable-upstream error (a plain Error, so the
    // DegradedUpstreamError rethrow does not catch it), and the provider
    // would drop to the PREVIOUS season and set provisional, putting every
    // room stamped with the real served season in front of the reaper.
    // Before the rule existed this case served the empty file and kept the
    // season CORRECT, so falling back here is a regression against 1.3.6.
    vi.setSystemTime(new Date(2026, 8, 20)); // served season FALL 2026
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'FALL'
        ? Promise.resolve({ version: 1, fetchedAt: 5, season: 'FALL', year: 2026, media: [] })
        : Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        }));
    mockApi.fetchSeason.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(false);
    // Season stayed correct; nothing became provisional; no room is at risk.
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('an EMPTY previous-season cache is not served as a fallback', async () => {
    // A zero-entry fallback file would boot the app "healthy" on a dead
    // deck (every join dies with NoMediaError) AND set the provisional
    // flag that suppresses the boot reaper. A poisoned season file becomes
    // `prev` within one rotation, so this branch sees the same population
    // the primary cache read does.
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({ version: 1, fetchedAt: 5, season: 'SUMMER', year: 2026, media: [] })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const provider = unpinned();
    expect(await provider.isAvailable()).toBe(false);
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('a PARTIAL pin does not rotate at the calendar boundary', async () => {
    // A pin is documented as disabling rotation, but the target used to
    // be recomposed from the clock on every tick, so the unset half
    // tracked the calendar. A season-only pin flipped its YEAR at New
    // Year; a year-only pin flipped its SEASON each quarter and could
    // rotate twelve months backward. Every such rotation fires the
    // reaper over every room.
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30)); // New Year's Eve
    const provider = makeProvider({ season: 'SUMMER', year: undefined });
    await provider.getMedia();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });

    // Cross into the new year; a pinned provider must not move.
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
  });

  it('a YEAR-only pin does not rotate at a quarter boundary', async () => {
    vi.setSystemTime(new Date(2026, 8, 30, 23, 30)); // Sep 30, SUMMER ends
    const provider = makeProvider({ season: undefined, year: 2026 });
    await provider.getMedia();
    const before = provider.getSeason?.();
    expect(before).toEqual({ season: 'SUMMER', year: 2026 });

    await vi.advanceTimersByTimeAsync(3 * HOUR); // into Oct 1, FALL
    await flush();
    expect(provider.getSeason?.()).toEqual(before);
  });

  it('treats an EMPTY cache file as a miss rather than serving zero entries', async () => {
    // The population this protects: a data dir written by the pre-fix
    // cold-boot path, which persisted media: [] against a degraded
    // AniList. Upgrading alone would not repair it, because the refresh
    // gate is permanently shut for an unpinned provider, so the empty
    // file must not be accepted as a snapshot in the first place.
    vi.setSystemTime(new Date(2026, 8, 20));
    loadCacheMock.mockResolvedValue({
      version: 1,
      fetchedAt: Date.now(),
      season: 'FALL',
      year: 2026,
      media: [],
    });

    const provider = unpinned();
    await provider.getMedia();
    // Fell through to the live fetch instead of serving the empty file.
    expect(mockApi.fetchSeason).toHaveBeenCalledWith('FALL', 2026);
    expect((await provider.getMedia()).length).toBeGreaterThan(0);
  });

  it('flags a fallback season as provisional, and clears it once a rotation lands', async () => {
    // ensureLoaded falls back to the PREVIOUS season when the incoming
    // fetch fails, which moves the served season BACKWARDS. The reaper
    // deletes on any mismatch in either direction, so the boot sweep
    // would wipe the incoming season's rooms. The provisional flag is
    // what lets app.ts defer the sweep until the season settles.
    vi.setSystemTime(new Date(2026, 8, 20)); // targets FALL 2026
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'SUMMER'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 5,
          season: 'SUMMER',
          year: 2026,
          media: [entry({ id: 9, title: 'Old Season' })],
        })
        : Promise.resolve(undefined));
    mockApi.fetchSeason.mockRejectedValueOnce(new Error('AniList down'));

    const provider = unpinned();
    await provider.getMedia();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(true);

    // The hourly tick completes the rotation; the season is settled now.
    mockApi.fetchSeason.mockResolvedValue(SEASON);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(provider.isSeasonProvisional?.()).toBe(false);
  });

  it('still refreshes daily for a PINNED season before its lock instant', async () => {
    // Pinning is the one way to serve a season early, so it is the only
    // path where an unfrozen window still exists. SUMMER 2026 locks
    // Jun 17; Jun 5 sits inside its window.
    vi.setSystemTime(new Date(2026, 5, 5));
    loadCacheMock.mockResolvedValue({
      version: 1,
      fetchedAt: Date.now() - 3 * 24 * HOUR,
      season: 'SUMMER',
      year: 2026,
      media: [entry({ id: 9, title: 'Cached Summer' })],
    });

    const provider = makeProvider(); // pinned SUMMER 2026
    await provider.getMedia();
    await flush();
    // Startup self-refresh fired (stale cache, pre-lock).
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25 * HOUR); // Jun 6: daily refresh
    await flush();
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(2);

    // Past the lock (Jun 17): the list never changes again.
    vi.setSystemTime(new Date(2026, 5, 18));
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    await flush();
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(2);
  });

  it('does not fire the startup self-refresh past the freeze', async () => {
    vi.setSystemTime(new Date(2026, 8, 20)); // past FALL's Sep 17 freeze
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'FALL'
        ? Promise.resolve({
          version: 1,
          fetchedAt: 1,
          season: 'FALL',
          year: 2026,
          media: [entry({ id: 9, title: 'Frozen List' })],
        })
        : Promise.resolve(undefined));

    const provider = unpinned();
    expect((await provider.getMedia()).map((m) => m.title)).toEqual(['Frozen List']);
    await flush();
    expect(mockApi.fetchSeason).not.toHaveBeenCalled();
  });
});

// Audit v1.2.0 #13/#14: refresh reaches open rooms; a throwing rotation
// callback retries instead of half-landing forever.
describe('refresh + rotation callbacks', () => {
  const HOUR = 60 * 60 * 1000;

  it('fires onRefreshed after the startup self-refresh lands (#13)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 15)); // pre-freeze for SUMMER 2026
    const onRefreshed = vi.fn();
    loadCacheMock.mockResolvedValue({
      version: 1, fetchedAt: 0, season: 'SUMMER', year: 2026,
      media: [entry({ id: 9, title: 'Cached' })],
    });
    const provider = makeProvider({ onRefreshed });
    await provider.getMedia();
    await flush();
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it('retries a throwing onSeasonRotated on the next tick (#14)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'] });
    vi.setSystemTime(new Date(2026, 8, 16, 12)); // SUMMER; FALL locks Sep 17
    const onSeasonRotated = vi.fn()
      .mockImplementationOnce(() => { throw new Error('reaper hiccup'); });
    const provider = makeProvider({ season: undefined, year: undefined, onSeasonRotated });
    await provider.getMedia();

    await vi.advanceTimersByTimeAsync(12 * HOUR); // rotation lands, callback throws
    await flush();
    expect(onSeasonRotated).toHaveBeenCalledTimes(1);
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });

    await vi.advanceTimersByTimeAsync(HOUR); // tick retries the callback
    await flush();
    expect(onSeasonRotated).toHaveBeenCalledTimes(2);
  });
});
