import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AniListApi, normalizeMedia, stripHtml } from '../../internal/app/anilist/api';
import type { AniListMedia } from '../../internal/app/anilist/types';

// Raw AniList media entry with sane defaults; tests override per case.
const rawMedia = (over: Partial<AniListMedia> = {}): AniListMedia => ({
  id: 1,
  idMal: 101,
  title: { romaji: 'Romaji Title', english: 'English Title', native: 'Native Title' },
  description: 'A show.',
  season: 'SUMMER',
  seasonYear: 2026,
  format: 'TV',
  episodes: 12,
  duration: 24,
  genres: ['Action'],
  averageScore: 82,
  popularity: 5000,
  coverImage: { extraLarge: 'https://s4.anilist.co/xl/1.jpg', large: 'https://s4.anilist.co/l/1.jpg' },
  studios: { nodes: [{ name: 'Komorebi Works' }] },
  trailer: { id: 'abc123', site: 'youtube' },
  relations: { edges: [] },
  isAdult: false,
  ...over,
});

// One GraphQL page response wrapping the given entries.
const pageResponse = (media: AniListMedia[], hasNextPage = false) => ({
  data: {
    Page: {
      pageInfo: { currentPage: 1, hasNextPage },
      media,
    },
  },
});

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('stripHtml', () => {
  it('converts <br> variants to newlines and strips other tags', () => {
    expect(stripHtml('Line one.<br><br/>Line <i>two</i>.')).toBe('Line one.\n\nLine two.');
  });

  it('decodes entities, with &amp; decoded last so double-encoding survives', () => {
    expect(stripHtml('A &amp; B &lt;3 &quot;quoted&quot; &#039;s')).toBe('A & B <3 "quoted" \'s');
    // A literal "&lt;" that arrived double-encoded must NOT become "<".
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
  });

  it('collapses 3+ newlines and trims', () => {
    expect(stripHtml('  a<br><br><br><br>b  ')).toBe('a\n\nb');
  });
});

describe('normalizeMedia hostile-input guards (audit 17 M5)', () => {
  it('drops a null list element instead of throwing', () => {
    // Reachable input: partial GraphQL responses are served, and AniList
    // can null out an entry it failed to resolve. A throw here killed
    // the whole season refresh (and a cache-less first boot).
    expect(normalizeMedia(null as unknown as AniListMedia, 'SUMMER', 2026)).toBeUndefined();
    expect(normalizeMedia(undefined as unknown as AniListMedia, 'SUMMER', 2026)).toBeUndefined();
    expect(normalizeMedia('junk' as unknown as AniListMedia, 'SUMMER', 2026)).toBeUndefined();
  });

  it('drops entries without a usable numeric id', () => {
    expect(normalizeMedia(rawMedia({ id: undefined as unknown as number }), 'SUMMER', 2026)).toBeUndefined();
    expect(normalizeMedia(rawMedia({ id: 0 }), 'SUMMER', 2026)).toBeUndefined();
    expect(normalizeMedia(rawMedia({ id: 1.5 }), 'SUMMER', 2026)).toBeUndefined();
  });
});

describe('normalizeMedia', () => {
  it('normalizes a full entry', () => {
    expect(normalizeMedia(rawMedia(), 'SUMMER', 2026)).toEqual({
      id: 1,
      idMal: 101,
      title: 'English Title',
      titleRomaji: 'Romaji Title',
      description: 'A show.',
      season: 'SUMMER',
      seasonYear: 2026,
      format: 'TV',
      episodes: 12,
      duration: 24,
      genres: ['Action'],
      rating: 8.2,
      popularity: 5000,
      coverUrl: 'https://s4.anilist.co/xl/1.jpg',
      studio: 'Komorebi Works',
      trailer: { site: 'youtube', id: 'abc123' },
      isSequel: false,
    });
  });

  it('drops adult entries unconditionally', () => {
    expect(normalizeMedia(rawMedia({ isAdult: true }), 'SUMMER', 2026)).toBeUndefined();
  });

  it('prefers english > romaji > native titles', () => {
    expect(
      normalizeMedia(rawMedia({ title: { english: null, romaji: 'R', native: 'N' } }), 'SUMMER', 2026)?.title,
    ).toBe('R');
    expect(
      normalizeMedia(rawMedia({ title: { english: null, romaji: null, native: 'N' } }), 'SUMMER', 2026)?.title,
    ).toBe('N');
  });

  it('drops entries with no title at all', () => {
    expect(
      normalizeMedia(rawMedia({ title: { english: null, romaji: null, native: null } }), 'SUMMER', 2026),
    ).toBeUndefined();
    expect(normalizeMedia(rawMedia({ title: null }), 'SUMMER', 2026)).toBeUndefined();
  });

  it('flags a PREQUEL relation to another ANIME as a sequel', () => {
    const entry = rawMedia({
      relations: {
        edges: [
          { relationType: 'ADAPTATION', node: { id: 9, type: 'MANGA' } },
          { relationType: 'PREQUEL', node: { id: 10, type: 'ANIME' } },
        ],
      },
    });
    expect(normalizeMedia(entry, 'SUMMER', 2026)?.isSequel).toBe(true);
  });

  it('does not count a PREQUEL edge to a MANGA (source material, not a prior season)', () => {
    const entry = rawMedia({
      relations: { edges: [{ relationType: 'PREQUEL', node: { id: 9, type: 'MANGA' } }] },
    });
    expect(normalizeMedia(entry, 'SUMMER', 2026)?.isSequel).toBe(false);
  });

  it('handles null relations / edges', () => {
    expect(normalizeMedia(rawMedia({ relations: null }), 'SUMMER', 2026)?.isSequel).toBe(false);
    expect(
      normalizeMedia(rawMedia({ relations: { edges: null } }), 'SUMMER', 2026)?.isSequel,
    ).toBe(false);
  });

  it('requires both trailer halves', () => {
    expect(
      normalizeMedia(rawMedia({ trailer: { id: null, site: 'youtube' } }), 'SUMMER', 2026)?.trailer,
    ).toBeUndefined();
    expect(
      normalizeMedia(rawMedia({ trailer: { id: 'x', site: null } }), 'SUMMER', 2026)?.trailer,
    ).toBeUndefined();
  });

  it('rescales averageScore to 0-10 and passes null through as undefined', () => {
    expect(normalizeMedia(rawMedia({ averageScore: 73 }), 'SUMMER', 2026)?.rating).toBe(7.3);
    expect(normalizeMedia(rawMedia({ averageScore: null }), 'SUMMER', 2026)?.rating).toBeUndefined();
  });

  it('falls back from extraLarge to large cover art', () => {
    expect(
      normalizeMedia(
        rawMedia({ coverImage: { extraLarge: null, large: 'https://s4.anilist.co/l/1.jpg' } }),
        'SUMMER',
        2026,
      )?.coverUrl,
    ).toBe('https://s4.anilist.co/l/1.jpg');
  });

  it('strips HTML from descriptions', () => {
    expect(
      normalizeMedia(rawMedia({ description: 'One<br>Two <b>bold</b>' }), 'SUMMER', 2026)?.description,
    ).toBe('One\nTwo bold');
  });
});

describe('AniListApi constructor', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => new AniListApi('file:///etc/passwd')).toThrow(/scheme/);
  });
});

describe('AniListApi.fetchSeason', () => {
  const api = () => new AniListApi('https://graphql.anilist.co');

  it('paginates until hasNextPage is false, preserving order', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pageResponse([rawMedia({ id: 1 }), rawMedia({ id: 2 })], true)))
      .mockResolvedValueOnce(jsonResponse(pageResponse([rawMedia({ id: 3 })], false)));

    const result = await api().fetchSeason('SUMMER', 2026);
    expect(result.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Page variable advances per request.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.variables).toMatchObject({
      season: 'SUMMER',
      seasonYear: 2026,
      page: 2,
    });
  });

  it('drops adult and untitled entries during pagination', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        pageResponse([
          rawMedia({ id: 1 }),
          rawMedia({ id: 2, isAdult: true }),
          rawMedia({ id: 3, title: null }),
        ]),
      ),
    );
    const result = await api().fetchSeason('SUMMER', 2026);
    expect(result.map((m) => m.id)).toEqual([1]);
  });

  it('retries a 5xx and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse(pageResponse([rawMedia()])));

    const promise = api().fetchSeason('SUMMER', 2026);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 (rate limit) the same way', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429))
      .mockResolvedValueOnce(jsonResponse(pageResponse([rawMedia()])));

    const promise = api().fetchSeason('SUMMER', 2026);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toHaveLength(1);
  });

  it('does not retry a 4xx (other than 429)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad query' }, 400));
    await expect(api().fetchSeason('SUMMER', 2026)).rejects.toThrow(/AniList API error 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a network-level failure', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(pageResponse([rawMedia()])));

    const promise = api().fetchSeason('SUMMER', 2026);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toHaveLength(1);
  });

  it('surfaces GraphQL errors from a 200 response with data: null', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, errors: [{ message: 'Invalid season' }] }),
    );
    await expect(api().fetchSeason('SUMMER', 2026)).rejects.toThrow(
      /AniList GraphQL error: Invalid season/,
    );
  });

  it('throws a parse error wrapper on malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
      text: async () => 'not json',
    });
    await expect(api().fetchSeason('SUMMER', 2026)).rejects.toThrow(
      /Failed to parse AniList API response/,
    );
  });
});

describe('AniListApi.isReachable', () => {
  it('true on a good response, false on failure', async () => {
    const api = new AniListApi('https://graphql.anilist.co');
    fetchMock.mockResolvedValueOnce(jsonResponse(pageResponse([])));
    expect(await api.isReachable('SUMMER', 2026)).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 404));
    expect(await api.isReachable('SUMMER', 2026)).toBe(false);
  });
});
