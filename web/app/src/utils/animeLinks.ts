import type { Media } from "../../../../types/reely";

export interface AnimeLinkSet {
  /** AniList entry page. Present whenever the media carries an anilistId. */
  anilistUrl: string;
  /** MyAnimeList entry page. AniList doesn't have a MAL mapping for every
   * entry (very new or very obscure shows), so this can be absent. */
  malUrl?: string;
}

/**
 * Build the external database links for an anime media item. The anime
 * counterpart of buildPlexLinks: returns undefined for non-anime media
 * (no anilistId) so callers can fall through to the Plex path.
 *
 * Static URL construction from numeric ids -- no reachability probe like
 * the Plex local-server dance; both sites are public internet.
 */
export const buildAnimeLinks = (media: Media): AnimeLinkSet | undefined => {
  if (media.anilistId == null) return undefined;
  return {
    anilistUrl: `https://anilist.co/anime/${media.anilistId}`,
    ...(media.malId != null
      ? { malUrl: `https://myanimelist.net/anime/${media.malId}` }
      : {}),
  };
};
