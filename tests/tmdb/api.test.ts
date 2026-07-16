import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { enrichStills, TmdbApi } from '../../internal/app/tmdb/api';

// Route-by-URL fetch stub (the tests/plex-era pattern): each test maps
// URL substrings to canned JSON responses.
let routes: Array<[match: string, body: unknown, status?: number]>;
const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
  const url = String(input);
  const hit = routes.find(([match]) => url.includes(match));
  if (!hit) throw new Error(`unrouted fetch: ${url}`);
  const [, body, status = 200] = hit;
  return new Response(JSON.stringify(body), { status });
});

beforeEach(() => {
  routes = [];
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const search = (id: number) => ({ results: [{ id }] });
const images = (...paths: string[]) => ({
  backdrops: paths.map((p) => ({ file_path: p })),
});

describe('TmdbApi.fetchStills', () => {
  it('searches TV with the year and returns image URLs', async () => {
    routes = [
      ['/search/tv', search(4242)],
      ['/tv/4242/images', images('/a.jpg', '/b.jpg')],
    ];
    const result = await new TmdbApi('v3key').fetchStills('Iron Bloom', 2026, 'tv');
    expect(result).toEqual({
      tmdbId: 4242,
      stills: [
        'https://image.tmdb.org/t/p/w780/a.jpg',
        'https://image.tmdb.org/t/p/w780/b.jpg',
      ],
    });
    const searchUrl = String(fetchMock.mock.calls[0][0]);
    expect(searchUrl).toContain('first_air_date_year=2026');
    expect(searchUrl).toContain('api_key=v3key');
  });

  it('routes MOVIE format to the movie index with year=', async () => {
    routes = [
      ['/search/movie', search(7)],
      ['/movie/7/images', images('/m.jpg')],
    ];
    await new TmdbApi('v3key').fetchStills('Some Film', 2026, 'movie');
    expect(String(fetchMock.mock.calls[0][0])).toContain('year=2026');
  });

  it('sends a v4 token as a Bearer header instead of api_key', async () => {
    routes = [
      ['/search/tv', search(1)],
      ['/tv/1/images', images('/x.jpg')],
    ];
    const jwt = 'eyJx.eyJy.zzz';
    await new TmdbApi(jwt).fetchStills('Show', 2026, 'tv');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).not.toContain('api_key');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${jwt}`);
  });

  it('retries without the year when the pinned search misses (returning shows)', async () => {
    // TMDB indexes a series by FIRST air date: a 2024 show airing its
    // sequel cour in Summer 2026 gets zero hits with the year pinned.
    routes = [
      ['first_air_date_year=2026', { results: [] }],
      ['/search/tv', search(777)],
      ['/tv/777/images', images('/smoke.jpg')],
    ];
    const result = await new TmdbApi('k').fetchStills('Smoking Behind the Supermarket with You', 2026, 'tv');
    expect(result?.tmdbId).toBe(777);
    // Two searches: pinned, then unpinned fallback.
    const searches = fetchMock.mock.calls.filter(([u]) => String(u).includes('/search/tv'));
    expect(searches).toHaveLength(2);
    expect(String(searches[1][0])).not.toContain('first_air_date_year');
  });

  it('validate() probes /configuration and maps status to boolean', async () => {
    routes = [['/configuration', { images: {} }]];
    expect(await new TmdbApi('good').validate()).toBe(true);
    routes = [['/configuration', { status_message: 'nope' }, 401]];
    expect(await new TmdbApi('bad').validate()).toBe(false);
  });

  it('returns undefined on no search hit or no backdrops', async () => {
    routes = [['/search/tv', { results: [] }]];
    expect(await new TmdbApi('k').fetchStills('Nothing', 2026, 'tv')).toBeUndefined();
    routes = [
      ['/search/tv', search(9)],
      ['/tv/9/images', { backdrops: [] }],
    ];
    expect(await new TmdbApi('k').fetchStills('Bare', 2026, 'tv')).toBeUndefined();
  });

  it('caps stills at six', async () => {
    routes = [
      ['/search/tv', search(1)],
      ['/tv/1/images', images('/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg', '/6.jpg', '/7.jpg', '/8.jpg')],
    ];
    const result = await new TmdbApi('k').fetchStills('Long', 2026, 'tv');
    expect(result?.stills).toHaveLength(6);
  });

  it('throws on an API error status', async () => {
    routes = [['/search/tv', { status_message: 'Invalid API key' }, 401]];
    await expect(new TmdbApi('bad').fetchStills('X', 2026, 'tv')).rejects.toThrow(/401/);
  });
});

describe('enrichStills', () => {
  it('fills stills + tmdbId for entries lacking them, skips the rest', async () => {
    routes = [
      ['/search/tv', search(50)],
      ['/tv/50/images', images('/s.jpg')],
    ];
    const entries = [
      { id: 1, title: 'Fresh', seasonYear: 2026, format: 'TV' },
      { id: 2, title: 'Done', seasonYear: 2026, format: 'TV', stills: ['https://image.tmdb.org/x.jpg'] },
    ];
    const count = await enrichStills(new TmdbApi('k'), entries, 0);
    expect(count).toBe(1);
    expect(entries[0].stills).toEqual(['https://image.tmdb.org/t/p/w780/s.jpg']);
    expect((entries[0] as { tmdbId?: number }).tmdbId).toBe(50);
    // The already-enriched entry produced no requests.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('Done'))).toHaveLength(0);
  });

  it('a per-title failure does not stop the batch', async () => {
    routes = [
      ['query=Bad', { oops: true }, 500],
      ['query=Good', search(60)],
      ['/tv/60/images', images('/g.jpg')],
    ];
    const entries: Array<{
      id: number; title: string; seasonYear: number; format: string; stills?: string[];
    }> = [
      { id: 1, title: 'Bad', seasonYear: 2026, format: 'TV' },
      { id: 2, title: 'Good', seasonYear: 2026, format: 'TV' },
    ];
    const count = await enrichStills(new TmdbApi('k'), entries, 0);
    expect(count).toBe(1);
    expect(entries[1].stills).toBeDefined();
  });
});
