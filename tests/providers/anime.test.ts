import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeasonalAnime } from '../../internal/app/anilist/types';

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

vi.mock('../../internal/app/anilist/api', () => ({
  AniListApi: AniListApiMock,
  ANILIST_API_URL: 'https://graphql.anilist.co',
}));
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

// The owner's rotation spec: unpinned providers serve the season
// containing NEXT month (the deck flips one month ahead of the calendar
// changeover), refresh daily until the list freeze two weeks before the
// season starts, and reset room data only after a rotation fetch lands.
describe('season rotation (unpinned)', () => {
  const HOUR = 60 * 60 * 1000;

  const unpinned = (over: Partial<AnimeProviderConfig> = {}) =>
    makeProvider({ season: undefined, year: undefined, ...over });

  beforeEach(() => {
    // Fake only the clock + the hourly interval; setTimeout/setImmediate
    // stay real so flush() and promise chains behave.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'] });
  });

  it('serves the season containing next month', async () => {
    vi.setSystemTime(new Date(2026, 8, 10)); // Sep 10: FALL starts Oct 1
    const provider = unpinned();
    await provider.getMedia();
    expect(mockApi.fetchSeason).toHaveBeenCalledWith('FALL', 2026);
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
  });

  it('rotates at the one-month mark and fires onSeasonRotated', async () => {
    vi.setSystemTime(new Date(2026, 7, 31, 12)); // Aug 31 noon: still SUMMER
    const onSeasonRotated = vi.fn();
    const provider = unpinned({ onSeasonRotated });
    await provider.getMedia();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });

    // Cross Sep 1 midnight; the next hourly tick fetches FALL and swaps.
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
    vi.setSystemTime(new Date(2026, 7, 31, 12));
    const onSeasonRotated = vi.fn();
    const provider = unpinned({ onSeasonRotated });
    await provider.getMedia();

    mockApi.fetchSeason.mockRejectedValueOnce(new Error('AniList down'));
    await vi.advanceTimersByTimeAsync(12 * HOUR); // first FALL attempt fails
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'SUMMER', year: 2026 });
    expect(onSeasonRotated).not.toHaveBeenCalled();
    expect((await provider.getMedia()).length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(HOUR); // next tick retries and lands
    await flush();
    expect(provider.getSeason?.()).toEqual({ season: 'FALL', year: 2026 });
    expect(onSeasonRotated).toHaveBeenCalledTimes(1);
  });

  it('boot after rotation with AniList down falls back to the previous season cache', async () => {
    vi.setSystemTime(new Date(2026, 8, 10)); // target FALL 2026
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

  it('refreshes daily during the pre-season window and freezes two weeks before start', async () => {
    // Sep 5: inside FALL 2026's window (rotation Sep 1, freeze Sep 17).
    vi.setSystemTime(new Date(2026, 8, 5));
    loadCacheMock.mockImplementation((_dir: string, season: string) =>
      season === 'FALL'
        ? Promise.resolve({
          version: 1,
          fetchedAt: Date.now() - 3 * 24 * HOUR,
          season: 'FALL',
          year: 2026,
          media: [entry({ id: 9, title: 'Cached Fall' })],
        })
        : Promise.resolve(undefined));

    const provider = unpinned();
    await provider.getMedia();
    await flush();
    // Startup self-refresh fired (stale cache, pre-freeze).
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25 * HOUR); // Sep 6: daily refresh
    await flush();
    expect(mockApi.fetchSeason).toHaveBeenCalledTimes(2);

    // Jump past the freeze (Sep 17): no more refreshes, ever.
    vi.setSystemTime(new Date(2026, 8, 18));
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
    vi.setSystemTime(new Date(2026, 7, 31, 12)); // SUMMER; rotates Sep 1
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
