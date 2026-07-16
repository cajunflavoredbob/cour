import { describe, expect, it } from 'vitest';
import { buildAnimeLinks } from '../../web/app/src/utils/animeLinks';
import { makeMedia } from '../helpers';

describe('buildAnimeLinks', () => {
  it('returns undefined for non-anime media (no anilistId)', () => {
    expect(buildAnimeLinks(makeMedia())).toBeUndefined();
  });

  it('builds the AniList URL from anilistId', () => {
    const links = buildAnimeLinks(makeMedia({ anilistId: 12345 }));
    expect(links?.anilistUrl).toBe('https://anilist.co/anime/12345');
  });

  it('includes the MAL URL only when malId is present', () => {
    expect(buildAnimeLinks(makeMedia({ anilistId: 1 }))?.malUrl).toBeUndefined();
    expect(buildAnimeLinks(makeMedia({ anilistId: 1, malId: 999 }))?.malUrl).toBe(
      'https://myanimelist.net/anime/999',
    );
  });

  it('treats anilistId 0 as present (== null gate, not truthiness)', () => {
    // AniList ids start at 1 in practice, but the gate is deliberately
    // `== null` -- a falsy-number bug here would silently de-link an entry.
    expect(buildAnimeLinks(makeMedia({ anilistId: 0 }))?.anilistUrl).toBe(
      'https://anilist.co/anime/0',
    );
  });
});
