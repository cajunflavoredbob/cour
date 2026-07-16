/**
 * AniList GraphQL API types -- only the fields the seasonal query selects.
 *
 * Raw shapes mirror the wire format (nullable fields are `| null`, matching
 * GraphQL's explicit-null semantics rather than the omit-empty idiom Plex
 * uses). `SeasonalAnime` is the normalized in-process shape the rest of the
 * app consumes; it is also the on-disk cache format, so changes to it must
 * bump SEASON_CACHE_VERSION in cache.ts.
 */

export type AnimeSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export const ANIME_SEASONS: readonly AnimeSeason[] = [
  'WINTER',
  'SPRING',
  'SUMMER',
  'FALL',
];

// AniList media formats for type: ANIME. TV_SHORT etc. arrive verbatim from
// the API; the provider surfaces them as filter values without remapping.
export type AniListFormat =
  | 'TV'
  | 'TV_SHORT'
  | 'MOVIE'
  | 'SPECIAL'
  | 'OVA'
  | 'ONA'
  | 'MUSIC';

export interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

export interface AniListCoverImage {
  extraLarge: string | null;
  large: string | null;
}

export interface AniListTrailer {
  id: string | null;
  // "youtube" or "dailymotion" per AniList's schema docs.
  site: string | null;
}

export interface AniListRelationEdge {
  relationType: string | null;
  node: {
    id: number;
    type: 'ANIME' | 'MANGA' | null;
  } | null;
}

// One media entry as the seasonal query returns it.
export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: AniListTitle | null;
  description: string | null;
  season: AnimeSeason | null;
  seasonYear: number | null;
  format: AniListFormat | null;
  episodes: number | null;
  // Minutes per episode.
  duration: number | null;
  genres: string[] | null;
  // 0-100 mean score.
  averageScore: number | null;
  popularity: number | null;
  coverImage: AniListCoverImage | null;
  studios: { nodes: Array<{ name: string | null } | null> | null } | null;
  trailer: AniListTrailer | null;
  relations: { edges: Array<AniListRelationEdge | null> | null } | null;
  isAdult: boolean | null;
}

export interface AniListPage {
  pageInfo: {
    currentPage: number;
    hasNextPage: boolean;
  };
  media: AniListMedia[];
}

export interface AniListSeasonalResponse {
  data: { Page: AniListPage } | null;
  errors?: Array<{ message: string }>;
}

/**
 * Normalized per-entry shape: what the provider, the disk cache, and the
 * Media mapping all consume. Produced by api.ts's normalize step so the
 * GraphQL nullability idioms don't leak past the anilist package.
 */
export interface SeasonalAnime {
  id: number;
  idMal?: number;
  // Display title: english ?? romaji ?? native. AniList guarantees at least
  // one of the three is set on real entries; normalize drops the (broken)
  // entry otherwise rather than shipping an untitled card.
  title: string;
  // Romaji form when it exists AND differs from the display title -- the
  // deck renders it as the secondary line under the title (0.7.0).
  titleRomaji?: string;
  // HTML stripped (AniList descriptions carry <br>/<i>/<b> markup).
  description: string;
  season: AnimeSeason;
  seasonYear: number;
  format?: AniListFormat;
  episodes?: number;
  // Minutes per episode, as AniList reports it.
  duration?: number;
  genres: string[];
  // Rescaled to 0-10 (AniList's averageScore is 0-100) so it lines up with
  // the 0-10 scale Media.rating already uses for Plex ratings.
  rating?: number;
  popularity: number;
  coverUrl?: string;
  // Main studio name (first isMain node), for the deck meta line.
  studio?: string;
  trailer?: { site: string; id: string };
  // TMDB enrichment (0.9.0): resolved id (skip re-search on refresh) and
  // backdrop still URLs for the drawer's thumbnail strip. Absent until a
  // TMDB key is configured and the background enrichment has run.
  tmdbId?: number;
  stills?: string[];
  // True when the entry has a PREQUEL relation edge to another ANIME --
  // i.e. it continues an earlier work. Drives the sequels-hidden-by-default
  // behavior in the anime provider.
  isSequel: boolean;
}
