import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../reely/logger';
import type { AnimeSeason, SeasonalAnime } from './types';

/**
 * Disk cache for a fetched season. One JSON file per (season, year) under
 * the configured cache dir, so a season/year config change never serves the
 * wrong season's file and old seasons stick around for a future "browse past
 * seasons" feature without any migration.
 *
 * Load/save are deliberately fail-soft: the cache is an availability
 * optimization (serve the deck at boot before AniList answers; survive an
 * AniList outage), not a source of truth. A corrupt or unreadable file is
 * logged and treated as absent -- the caller falls back to a live fetch.
 */

// Bump when SeasonalAnime's shape changes incompatibly. A version mismatch
// treats the file as absent (re-fetch + overwrite) instead of risking a
// half-shaped entry reaching the deck.
export const SEASON_CACHE_VERSION = 3;

export interface SeasonCacheFile {
  version: number;
  // Epoch ms of the fetch that produced this file. Not consumed by logic
  // today (refresh is startup-driven, not age-driven); recorded so a future
  // age-based refresh policy doesn't need a cache format change.
  fetchedAt: number;
  season: AnimeSeason;
  year: number;
  media: SeasonalAnime[];
}

const cacheFilePath = (dir: string, season: AnimeSeason, year: number): string =>
  join(dir, `anilist_${season.toLowerCase()}_${year}.json`);

export const loadSeasonCache = async (
  dir: string,
  season: AnimeSeason,
  year: number,
): Promise<SeasonCacheFile | undefined> => {
  const path = cacheFilePath(dir, season, year);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // ENOENT is the normal first-boot case -- stay quiet. Anything else
    // (EACCES, EISDIR) is worth a warning but still falls back to a fetch.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`anilist cache read failed (${path}): ${String(err)}`);
    }
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object' ||
      typeof (parsed as SeasonCacheFile).version !== 'number' ||
      !Array.isArray((parsed as SeasonCacheFile).media)
    ) {
      logger.warn(`anilist cache ${path} has an unexpected shape; ignoring it`);
      return undefined;
    }
    const file = parsed as SeasonCacheFile;
    // An OLDER version still serves (0.7.0): SeasonalAnime only ever grows
    // optional fields, and refusing a stale-format cache would turn a
    // version bump + an AniList outage into a boot failure (the API was
    // literally down the day this was written). The background refresh
    // overwrites it at the current version as soon as the API answers.
    // A NEWER version (downgraded binary) is refused -- unknown future
    // shapes get no such guarantee.
    if (file.version > SEASON_CACHE_VERSION) {
      logger.warn(
        `anilist cache ${path} is from a newer version (${file.version} > ${SEASON_CACHE_VERSION}); ignoring it`,
      );
      return undefined;
    }
    if (file.version < SEASON_CACHE_VERSION) {
      logger.info(
        `anilist cache ${path} is version ${file.version} (current ${SEASON_CACHE_VERSION}); serving it until the next successful refresh`,
      );
    }
    return file;
  } catch (err) {
    logger.warn(`anilist cache ${path} is corrupt; ignoring it: ${String(err)}`);
    return undefined;
  }
};

// Atomic write via tmp + rename (same pattern as roomStore.ts): a crash or
// unclean shutdown mid-write can't leave a truncated JSON file where the
// next boot's load would find it.
export const saveSeasonCache = async (
  dir: string,
  file: SeasonCacheFile,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const path = cacheFilePath(dir, file.season, file.year);
  const tmp = `${path}.tmp`;
  // fsync before the rename (audit 17): without it a power cut can
  // commit the rename while the tmp file's CONTENT is still unflushed,
  // leaving a truncated cache under the final name -- the exact torn
  // state the tmp+rename dance exists to prevent.
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(file), 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
};
