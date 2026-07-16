import { logger } from '../reely/logger';
import type {
  AniListMedia,
  AniListSeasonalResponse,
  AnimeSeason,
  SeasonalAnime,
} from './types';

// AniList's public GraphQL endpoint. The config layers fill this in as the
// server URL default for `type: anilist` entries; it stays configurable so
// tests (and any future proxy setup) can point elsewhere.
export const ANILIST_API_URL = 'https://graphql.anilist.co';

// Upper bound on any single AniList HTTP request. Same rationale as
// PLEX_FETCH_TIMEOUT_MS in plex/api.ts: without it a hung upstream leaves
// fetch() pending forever and stalls every caller behind the load.
const ANILIST_FETCH_TIMEOUT_MS = 30_000;

// Retry tuning, mirroring plex/api.ts (audit 14 #330 rationale). The
// seasonal query is a read (POST-as-transport, but idempotent), so retrying
// on a network blip / 5xx is safe. 429 is also retryable here -- AniList
// rate-limits per-IP (90 req/min nominal, degraded to 30 at times) and a
// seasonal fetch is a burst of ~6-8 paginated requests, so a brief 429 is
// an expected transient rather than an error.
const ANILIST_RETRY_ATTEMPTS = 2;
const ANILIST_RETRY_BACKOFF_MS = 500;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

// Same scheme allowlist as PlexApi: the URL is operator-configurable, and
// nothing good comes of letting the WHATWG parser accept file:/gopher: here.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// 50 is AniList's max perPage. A typical season is ~300-450 entries across
// all formats, so PAGE_CAP=20 (1000 entries) is far above any real season
// while still bounding a hypothetical hasNextPage-forever upstream bug.
const PER_PAGE = 50;
const PAGE_CAP = 20;

// One page of the seasonal browse. POPULARITY_DESC ordering is load-bearing:
// the provider serves the deck in the order this query returns (the anime
// deck is popularity-ordered by design, not shuffled -- see providers/
// anime.ts + Room.fetchMedia's mediaOrdered check).
//
// relations edges are fetched for sequel detection only: an entry with a
// PREQUEL edge to another ANIME continues an earlier work and is hidden by
// default. trailer + idMal ride along for later batches (trailer rendering
// and MAL links) -- captured now so the cache doesn't need a re-fetch when
// those land.
const SEASONAL_QUERY = `
query ($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { currentPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
      id
      idMal
      title { romaji english native }
      description
      season
      seasonYear
      format
      episodes
      duration
      genres
      averageScore
      popularity
      coverImage { extraLarge large }
      studios(isMain: true) { nodes { name } }
      trailer { id site }
      relations { edges { relationType node { id type } } }
      isAdult
    }
  }
}`;

// AniList descriptions are HTML fragments (<br>, <i>, <b>, entity-encoded
// text). Media.description is plain text on the wire, so flatten here.
// Entity decode runs after tag strip, with &amp; last so a literal
// "&amp;lt;" decodes to "&lt;", not "<".
export const stripHtml = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// Raw AniList entry -> normalized SeasonalAnime, or undefined when the entry
// should be dropped:
//   - isAdult: excluded unconditionally. Not configurable on purpose -- the
//     Radarr importer incident (bulk-added adult titles from a broad list
//     source) is exactly the failure mode this guards against.
//   - no title at all: a broken entry; an untitled card is useless.
export const normalizeMedia = (
  raw: AniListMedia,
  season: AnimeSeason,
  year: number,
): SeasonalAnime | undefined => {
  // A null or malformed list element is reachable input here: partial
  // GraphQL responses are deliberately served (200-with-errors), and
  // AniList can null out an entry it failed to resolve. One bad element
  // must drop, not throw -- an uncaught throw here killed the whole
  // season refresh, and on a cache-less first boot, the boot (audit 17
  // M5). An entry without a usable numeric id can't be verdicted or
  // proxied, so it drops too.
  if (!raw || typeof raw !== 'object') return undefined;
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id <= 0) {
    return undefined;
  }
  if (raw.isAdult) return undefined;

  const title = raw.title?.english ?? raw.title?.romaji ?? raw.title?.native;
  if (!title) return undefined;
  // Secondary romaji line only when it adds information (english title
  // shown AND romaji differs from it).
  const romaji = raw.title?.romaji ?? undefined;
  const titleRomaji = romaji && romaji !== title ? romaji : undefined;

  const studio = raw.studios?.nodes?.find((n) => n?.name)?.name ?? undefined;

  const isSequel = (raw.relations?.edges ?? []).some(
    (edge) => edge?.relationType === 'PREQUEL' && edge.node?.type === 'ANIME',
  );

  // Trailer only when both halves are present -- a site without an id (or
  // vice versa) can't build a playable embed.
  const trailer = (raw.trailer?.site && raw.trailer.id)
    ? { site: raw.trailer.site, id: raw.trailer.id }
    : undefined;

  return {
    id: raw.id,
    idMal: raw.idMal ?? undefined,
    title,
    titleRomaji,
    description: raw.description ? stripHtml(raw.description) : '',
    // The query filters by season/year, so trust the request parameters over
    // the (nullable) echo on each entry.
    season,
    seasonYear: year,
    format: raw.format ?? undefined,
    episodes: raw.episodes ?? undefined,
    duration: raw.duration ?? undefined,
    genres: raw.genres?.filter((g): g is string => typeof g === 'string') ?? [],
    // 0-100 -> 0-10 so it lines up with Media.rating's existing scale.
    rating: raw.averageScore != null ? raw.averageScore / 10 : undefined,
    popularity: raw.popularity ?? 0,
    coverUrl: raw.coverImage?.extraLarge ?? raw.coverImage?.large ?? undefined,
    studio,
    trailer,
    isSequel,
  };
};

export class AniListApi {
  private url: URL;

  constructor(url: string) {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error(
        `Invalid AniList URL scheme "${parsed.protocol}". Only http: and https: are allowed.`,
      );
    }
    this.url = parsed;
  }

  // Cheap reachability probe: page 1, perPage 1. Used by the provider's
  // isAvailable when no disk cache exists to fall back on.
  async isReachable(season: AnimeSeason, year: number): Promise<boolean> {
    try {
      await this.fetchPage(season, year, 1, 1);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetches the full season, paginating until hasNextPage is false, and
   * returns normalized entries in AniList's POPULARITY_DESC order (adult
   * entries and untitled broken entries dropped -- see normalizeMedia).
   *
   * Pages are fetched sequentially, not fanned out: AniList rate-limits
   * per-IP, and a whole-season fetch is already only ~6-8 requests.
   */
  async fetchSeason(season: AnimeSeason, year: number): Promise<SeasonalAnime[]> {
    const all: SeasonalAnime[] = [];
    for (let page = 1; page <= PAGE_CAP; page++) {
      const result = await this.fetchPage(season, year, page, PER_PAGE);
      for (const raw of result.media) {
        const normalized = normalizeMedia(raw, season, year);
        if (normalized) all.push(normalized);
      }
      if (!result.pageInfo.hasNextPage) {
        return all;
      }
    }
    // hasNextPage still true at the cap -- log what was dropped rather than
    // silently truncating (a real season never gets here; see PAGE_CAP).
    logger.warn(
      `AniList ${season} ${year}: still paginating at page cap ${PAGE_CAP}; ` +
        `serving the first ${all.length} entries`,
    );
    return all;
  }

  private async fetchPage(
    season: AnimeSeason,
    year: number,
    page: number,
    perPage: number,
  ): Promise<{ pageInfo: { hasNextPage: boolean }; media: AniListMedia[] }> {
    logger.debug(`AniList fetch: ${season} ${year} page ${page}`);

    const body = JSON.stringify({
      query: SEASONAL_QUERY,
      variables: { season, seasonYear: year, page, perPage },
    });

    let res: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < ANILIST_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(r, ANILIST_RETRY_BACKOFF_MS * 2 ** (attempt - 1)),
        );
        logger.debug(`AniList fetch retry ${attempt}: page ${page}`);
      }
      // Clear the previous attempt's response first (audit 17): if a
      // retryable 429/5xx was followed by a thrown network error, the
      // stale response used to survive the loop and the failure was
      // reported as that old status instead of the real network error.
      res = undefined;
      try {
        res = await fetch(this.url.href, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(ANILIST_FETCH_TIMEOUT_MS),
        });
        if (res.ok || !isRetryableStatus(res.status)) break;
        lastError = new Error(`AniList API ${res.status} (retryable)`);
      } catch (err) {
        // Network-level failure (fetch threw): retry.
        lastError = err;
      }
    }
    if (!res) {
      throw new Error(
        `AniList fetch failed after ${ANILIST_RETRY_ATTEMPTS} attempts`,
        { cause: lastError },
      );
    }

    if (!res.ok) {
      // Truncate the error body like plex/api.ts does (audit 12 #261
      // rationale): an upstream outage page can be multi-KB of HTML.
      const errBody = (await res.text()).slice(0, 200);
      throw new Error(`AniList API error ${res.status}: ${errBody}`);
    }

    let parsed: AniListSeasonalResponse;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error('Failed to parse AniList API response', { cause: err });
    }

    // GraphQL can 200 with an errors array and data: null. Partial
    // responses (data AND errors) are treated as success -- the data that
    // did arrive is served.
    if (!parsed.data?.Page) {
      const message = parsed.errors?.map((e) => e.message).join('; ')
        ?? 'no data in response';
      throw new Error(`AniList GraphQL error: ${message.slice(0, 200)}`);
    }

    return {
      pageInfo: { hasNextPage: parsed.data.Page.pageInfo?.hasNextPage ?? false },
      media: parsed.data.Page.media ?? [],
    };
  }
}
