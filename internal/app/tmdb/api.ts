import { logger } from '../reely/logger';

/**
 * Minimal TMDB client (0.9.0): resolve an anime title to a TMDB entry and
 * pull its backdrop stills for the details drawer's thumbnail strip.
 *
 * Auth accepts either credential form the settings dialog might receive:
 * a v4 access token (a JWT -- detected by its dots) goes in the
 * Authorization header; a v3 key rides the api_key query param.
 *
 * Matching is deliberately modest: first search hit for (title, year),
 * TV or movie index by the AniList format. Wrong matches cost a wrong
 * screenshot row, not data -- an acceptable trade until someone cares
 * enough to wire external-ID mapping.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w780';
const REQUEST_TIMEOUT_MS = 15_000;
// Backdrops per title actually kept -- the drawer strip shows a handful.
const MAX_STILLS = 6;

export interface TmdbStillsResult {
  tmdbId: number;
  stills: string[];
}

const isV4Token = (key: string): boolean => key.split('.').length === 3;

export class TmdbApi {
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${TMDB_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (isV4Token(this.key)) {
      headers.authorization = `Bearer ${this.key}`;
    } else {
      url.searchParams.set('api_key', this.key);
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`TMDB ${path} ${response.status}: ${body}`);
    }
    return response.json();
  }

  /**
   * Cheap authenticated probe -- proves the key works without touching
   * any real data. Used for save-time feedback in the settings dialog.
   */
  async validate(): Promise<boolean> {
    try {
      await this.get('/configuration', {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Search TMDB for the title and return up to MAX_STILLS backdrop URLs.
   * `kind` follows AniList's format: MOVIE searches movies, everything
   * else searches TV. Returns undefined when nothing matches or the
   * match has no backdrops -- callers treat that as "no stills", never
   * an error.
   */
  async fetchStills(
    title: string,
    year: number | undefined,
    kind: 'tv' | 'movie',
  ): Promise<TmdbStillsResult | undefined> {
    const searchParams: Record<string, string> = {
      query: title,
      include_adult: 'false',
    };
    if (year !== undefined) {
      searchParams[kind === 'movie' ? 'year' : 'first_air_date_year'] = String(year);
    }
    let search = (await this.get(`/search/${kind}`, searchParams)) as {
      results?: Array<{ id?: number }>;
    };
    let hit = search.results?.find((r) => typeof r.id === 'number');
    // Returning shows: TMDB indexes a series by its FIRST air date, so a
    // Summer 2026 sequel season of a 2024 show gets zero hits with the
    // year pinned (found via "Smoking Behind the Supermarket with You",
    // the owner's first live test). Retry without the year before giving up.
    if (!hit?.id && year !== undefined) {
      search = (await this.get(`/search/${kind}`, {
        query: title,
        include_adult: 'false',
      })) as { results?: Array<{ id?: number }> };
      hit = search.results?.find((r) => typeof r.id === 'number');
    }
    if (!hit?.id) return undefined;

    const images = (await this.get(`/${kind}/${hit.id}/images`, {})) as {
      backdrops?: Array<{ file_path?: string | null }>;
    };
    const stills = (images.backdrops ?? [])
      .map((b) => b.file_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, MAX_STILLS)
      .map((p) => `${IMAGE_BASE}${p}`);
    if (stills.length === 0) return undefined;
    return { tmdbId: hit.id, stills };
  }
}

/**
 * Enrich a batch of entries with stills, sequentially (TMDB's limiter is
 * generous, but a 90-title burst at boot is rude and unnecessary --
 * ~180 requests spread over a couple of minutes is invisible). Failures
 * are per-title and logged at debug: a fuzzy title that matches nothing
 * is normal, not an incident.
 */
export const enrichStills = async (
  api: TmdbApi,
  entries: Array<{
    id: number;
    title: string;
    seasonYear?: number;
    format?: string;
    tmdbId?: number;
    stills?: string[];
  }>,
  // Small pause between titles; also the test seam.
  pauseMs = 250,
): Promise<number> => {
  let enriched = 0;
  for (const entry of entries) {
    if (entry.stills?.length) continue;
    try {
      const result = await api.fetchStills(
        entry.title,
        entry.seasonYear,
        entry.format === 'MOVIE' ? 'movie' : 'tv',
      );
      if (result) {
        entry.tmdbId = result.tmdbId;
        entry.stills = result.stills;
        enriched += 1;
      }
    } catch (err) {
      logger.debug(`tmdb: stills for "${entry.title}" failed: ${String(err)}`);
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return enriched;
};
