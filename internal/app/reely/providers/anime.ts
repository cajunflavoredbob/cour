import { join } from 'node:path';
import type { Media } from '../../../../types/reely';
import { AniListApi } from '../../anilist/api';
import { loadSeasonCache, saveSeasonCache, SEASON_CACHE_VERSION } from '../../anilist/cache';
import {
  detectSeason,
  formatSeason,
  listFreezeAt,
  previousSeason,
  servedSeason,
} from '../../anilist/season';
import type { AnimeSeason, SeasonalAnime } from '../../anilist/types';
import { enrichStills as tmdbEnrichStills, TmdbApi } from '../../tmdb/api';
import { logger } from '../logger';
import type { ReelyProvider } from './types';

export interface AnimeProviderConfig {
  url: string;
  season?: AnimeSeason;
  year?: number;
  showSequels?: boolean;
  cacheDir?: string;
  // Live read of the runtime TMDB key (0.9.0 stills enrichment). A getter
  // rather than a value: the key is browser-writable at runtime through
  // the settings dialog.
  getTmdbKey?: () => string | undefined;
  // Fired after enrichment adds stills, so the app layer can push the
  // refreshed media to rooms that are already open (0.9.1).
  onStillsEnriched?: () => void;
  // Fired after a same-season snapshot refresh lands (the startup
  // self-refresh and the daily pre-freeze refresh). Without it, open
  // rooms served their creation-day deck until a restart while the
  // provider snapshot moved on (audit v1.2.0 #13).
  onRefreshed?: () => void;
  // Fired after a season rotation LANDS (incoming-season fetch succeeded,
  // snapshot swapped). The app layer deletes last season's rooms and
  // pushes the new deck to open rooms. Never fires on a failed fetch --
  // the old deck keeps serving and the next tick retries.
  onSeasonRotated?: (season: { season: AnimeSeason; year: number }) => void;
}

// Upper bound on a single cover-image fetch through the poster proxy.
const COVER_FETCH_TIMEOUT_MS = 30_000;

/**
 * AniList-backed seasonal anime provider.
 *
 * Data flow: one seasonal snapshot (SeasonalAnime[]) held in memory, loaded
 * once per process via `ensureLoaded`:
 *   - disk cache hit  -> serve it immediately, refresh from AniList in the
 *     background (startup self-refresh), persist the refreshed snapshot.
 *   - disk cache miss -> block on the live fetch (first boot). If that also
 *     fails (first boot offline), isAvailable() reports false and app boot
 *     fails with ProviderUnavailableError -- there is nothing to serve.
 *
 * The list arrives from AniList in POPULARITY_DESC order and is served in
 * that order (`mediaOrdered: true`; Room.fetchMedia skips its shuffle).
 * Sequels -- entries with a PREQUEL relation -- are hidden unless
 * `showSequels` is set: the picker exists to find NEW shows, and season
 * N+1 of something the room isn't watching is dead-swipe noise.
 */
export const createProvider = (
  id: string,
  options: AnimeProviderConfig,
): ReelyProvider => {
  const api = new AniListApi(options.url);
  // A configured season or year pins the snapshot: no rotation, resolved
  // once (partial overrides compose with plain calendar detection, as
  // before -- season without year pins the season in the current year).
  // Unpinned is the production mode: the served season auto-rotates one
  // month ahead of the calendar changeover (servedSeason's contract).
  const pinned = options.season != null || options.year != null;
  const resolveTarget = (): { season: AnimeSeason; year: number } =>
    pinned
      ? {
        season: options.season ?? detectSeason(new Date()).season,
        year: options.year ?? detectSeason(new Date()).year,
      }
      : servedSeason(new Date());
  // The season the in-memory snapshot actually holds. Tracks the target,
  // with two exceptions: ensureLoaded may fall back one season when a
  // post-rotation boot can't fetch (rotation-pending), and a mid-flight
  // rotation swaps it only after the new fetch succeeds.
  let current = resolveTarget();
  const label = () => formatSeason(current.season, current.year);
  const showSequels = options.showSequels ?? false;
  const cacheDir = options.cacheDir ?? join(process.cwd(), 'data', 'anilist');

  let list: SeasonalAnime[] | undefined;
  // anilistId (stringified) -> cover URL / stills, for the poster proxy.
  // Rebuilt whenever the snapshot is replaced or enriched.
  const coverById = new Map<string, string>();
  const stillsById = new Map<string, string[]>();

  const setList = (media: SeasonalAnime[]) => {
    list = media;
    coverById.clear();
    stillsById.clear();
    for (const entry of media) {
      if (entry.coverUrl) coverById.set(String(entry.id), entry.coverUrl);
      if (entry.stills?.length) stillsById.set(String(entry.id), entry.stills);
    }
  };

  const persistSnapshot = async () => {
    try {
      await saveSeasonCache(cacheDir, {
        version: SEASON_CACHE_VERSION,
        fetchedAt: Date.now(),
        season: current.season,
        year: current.year,
        media: list ?? [],
      });
    } catch (err) {
      logger.warn(`AniList ${label()}: cache persist failed: ${String(err)}`);
    }
  };

  // Season lifecycle scheduler (the owner's rotation spec, replacing the
  // 0.12.0 end-of-season refresh). Hourly tick, two jobs:
  //   1. Rotation: when the served target moves past the snapshot
  //      (Dec/Mar/Jun/Sep 1), fetch the incoming season and swap.
  //   2. Pre-season refresh: from rotation until the list freeze (two
  //      weeks before the season starts), re-fetch daily so late title
  //      announcements land. Past the freeze the list never changes --
  //      people are locking in against it.
  // Keyed off the cache timestamp so restarts don't re-trigger; `busy`
  // serializes the jobs so a slow fetch can't stack.
  let lastFetchedAt = 0;
  let rotationCallbackPending = false;
  const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
  const SEASON_CHECK_MS = 60 * 60 * 1000;
  let busy = false;
  const scheduleCheck = setInterval(() => {
    if (busy) return;
    // A rotation whose post-swap callback threw retries here until it
    // lands (audit v1.2.0 #14).
    if (rotationCallbackPending) fireSeasonRotated();
    const target = resolveTarget();
    if (target.season !== current.season || target.year !== current.year) {
      busy = true;
      void rotate(target)
        .catch((err) => {
          logger.warn(
            `AniList ${formatSeason(target.season, target.year)}: rotation fetch failed; ` +
              `still serving ${label()}: ${String(err)}`,
          );
        })
        .finally(() => { busy = false; });
      return;
    }
    const freeze = listFreezeAt(current.season, current.year).getTime();
    if (Date.now() < freeze && Date.now() - lastFetchedAt >= REFRESH_EVERY_MS) {
      logger.info(`AniList ${label()}: pre-season list refresh`);
      busy = true;
      void refresh()
        .catch((err) => {
          logger.warn(`scheduled refresh failed: ${String(err)}`);
        })
        .finally(() => { busy = false; });
    }
  }, SEASON_CHECK_MS);
  // Never keep the process alive just for this timer.
  scheduleCheck.unref?.();

  // TMDB stills enrichment (0.9.0). Mutates the in-memory snapshot's
  // entries, rebuilds the proxy maps, and persists. Serialized: a second
  // call while one runs is a no-op (boot + settings-save can overlap).
  let enriching = false;
  const enrichFromTmdb = async (): Promise<number> => {
    const key = options.getTmdbKey?.();
    if (!key || !list || enriching) return 0;
    enriching = true;
    try {
      // Pin the array being enriched: the startup self-refresh can swap
      // `list` while the TMDB fetches are in flight (boot cache-hit runs
      // both concurrently), and the stills would land on the DISCARDED
      // array -- silently absent until the next restart (audit 17).
      const target = list;
      const enriched = await tmdbEnrichStills(new TmdbApi(key), target);
      if (enriched > 0) {
        if (list !== target && list) {
          // Snapshot swapped mid-enrichment: carry the fetched stills
          // onto the current entries by id. (refresh() couldn't -- the
          // stills didn't exist yet when it swapped.)
          const priorById = new Map(target.map((e) => [e.id, e]));
          for (const entry of list) {
            const old = priorById.get(entry.id);
            if (old?.stills?.length && !entry.stills?.length) {
              entry.stills = old.stills;
              entry.tmdbId = old.tmdbId;
            }
          }
        }
        setList(list);
        await persistSnapshot();
        logger.info(`TMDB: stills enriched for ${enriched} ${label()} entries`);
        options.onStillsEnriched?.();
      }
      return enriched;
    } finally {
      enriching = false;
    }
  };

  // Live fetch + swap + persist. Persist failures are logged, not thrown:
  // the in-memory snapshot is already serving, and a read-only cache dir
  // shouldn't take the deck down with it.
  const refresh = async (): Promise<void> => {
    // Pin the season this refresh is FOR. The startup self-refresh is
    // fire-and-forget and can still be in flight when the hourly tick
    // rotates the season under it; without this pin the late-arriving
    // old-season payload would stomp the freshly-rotated deck and
    // persist {new season, old media} into the new season's cache file.
    const target = { season: current.season, year: current.year };
    const media = await api.fetchSeason(target.season, target.year);
    if (current.season !== target.season || current.year !== target.year) {
      logger.warn(
        `AniList ${label()}: discarding refresh for ${target.season} ${target.year}; ` +
          'season rotated while it was in flight',
      );
      return;
    }
    // A degraded upstream can 200 into an empty page (media: null/[]
    // alongside a GraphQL errors array is deliberately treated as a
    // partial success by fetchPage). Swapping the serving snapshot for
    // an empty one AND persisting it would brick the season: past the
    // list freeze nothing ever refreshes again, so every join would
    // fail with NoMediaError until the next rotation. Treat empty as a
    // failed refresh whenever a non-empty deck is already serving; the
    // caller's catch keeps the current snapshot, and the scheduler
    // retries on its normal cadence.
    if (media.length === 0 && (list?.length ?? 0) > 0) {
      throw new Error(
        `refresh for ${target.season} ${target.year} returned 0 entries; keeping the serving snapshot`,
      );
    }
    // Carry existing enrichment across refreshes: AniList is the source
    // of truth for the catalog, TMDB data keys by id and survives.
    const prior = new Map((list ?? []).map((e) => [e.id, e]));
    for (const entry of media) {
      const old = prior.get(entry.id);
      if (old?.stills?.length) {
        entry.stills = old.stills;
        entry.tmdbId = old.tmdbId;
      }
    }
    setList(media);
    lastFetchedAt = Date.now();
    logger.info(`AniList ${label()}: loaded ${media.length} entries`);
    await persistSnapshot();
    // Open rooms re-deck off the fresh snapshot (audit v1.2.0 #13).
    options.onRefreshed?.();
    // Fill stills for anything new; fire-and-forget.
    void enrichFromTmdb().catch((err) => {
      logger.warn(`TMDB enrichment failed: ${String(err)}`);
    });
  };

  // Season rotation: fetch the incoming season and swap ONLY on success.
  // A failed fetch keeps the old deck serving (the tick retries hourly),
  // and onSeasonRotated fires strictly after the new snapshot is
  // servable, so the app layer never wipes room data it can't re-deck.
  // No enrichment carry-over: a new season shares no ids with the old.
  const fireSeasonRotated = () => {
    // The post-swap steps (reaper sweep, re-deck push, config broadcast)
    // must not half-land forever: the snapshot swap already happened, so
    // target === current and the rotation branch never re-fires. A throw
    // here marks the callback pending and the hourly tick retries it
    // (audit v1.2.0 #14).
    try {
      options.onSeasonRotated?.({ ...current });
      rotationCallbackPending = false;
    } catch (err) {
      rotationCallbackPending = true;
      logger.warn(
        `AniList ${label()}: onSeasonRotated failed; retrying next tick: ${String(err)}`,
      );
    }
  };

  const rotate = async (target: { season: AnimeSeason; year: number }): Promise<void> => {
    const media = await api.fetchSeason(target.season, target.year);
    // Same empty-page guard as refresh(), but unconditional: rotating an
    // empty deck in would evict every open room (the app-layer push
    // fails) and persist an empty snapshot for the incoming season. A
    // throw keeps the old deck serving and the hourly tick retries the
    // rotation, exactly the documented swap-only-on-success contract.
    if (media.length === 0) {
      throw new Error(
        `rotation fetch for ${target.season} ${target.year} returned 0 entries; deferring rotation`,
      );
    }
    current = target;
    setList(media);
    lastFetchedAt = Date.now();
    logger.info(`AniList ${label()}: season rotated in, ${media.length} entries`);
    await persistSnapshot();
    void enrichFromTmdb().catch((err) => {
      logger.warn(`TMDB enrichment failed: ${String(err)}`);
    });
    fireSeasonRotated();
  };

  // One-shot startup load (see the provider docstring for the flow). The
  // promise is cached so every caller shares one load; a FAILED first-boot
  // load clears the slot so the next call can retry -- same recover-on-
  // failure contract as cachePromise, but with the disk-vs-live branch.
  let loadPromise: Promise<void> | undefined;
  const ensureLoaded = (): Promise<void> => {
    if (!loadPromise) {
      loadPromise = (async () => {
        const cached = await loadSeasonCache(cacheDir, current.season, current.year);
        if (cached) {
          setList(cached.media);
          lastFetchedAt = cached.fetchedAt;
          logger.info(
            `AniList ${label()}: serving ${cached.media.length} cached entries; refreshing in background`,
          );
          // Stills for a cached snapshot too -- refresh() may fail (API
          // down) and enrichment shouldn't die with it.
          void enrichFromTmdb().catch((err) => {
            logger.warn(`TMDB enrichment failed: ${String(err)}`);
          });
          // Fire-and-forget startup self-refresh -- but only until the
          // list freeze. Past it the season's list is locked while people
          // finish picking (the owner's spec): a restart must not swap
          // titles under members who verdicted against the frozen set.
          // A failure keeps the cached snapshot serving -- exactly what
          // the cache is for.
          if (Date.now() < listFreezeAt(current.season, current.year).getTime()) {
            refresh().catch((err) => {
              logger.warn(
                `AniList ${label()}: background refresh failed; serving cached snapshot: ${String(err)}`,
              );
            });
          }
          return;
        }
        try {
          await refresh();
        } catch (err) {
          // A boot landing just past a rotation point with AniList down
          // has no cache for the incoming season -- serve the PREVIOUS
          // season's cache instead of failing boot, and let the hourly
          // tick complete the rotation once the API is back. A true
          // first boot (no prior season either) still fails: there is
          // nothing to serve.
          if (pinned) throw err;
          const prev = previousSeason(current.season, current.year);
          const fallback = await loadSeasonCache(cacheDir, prev.season, prev.year);
          if (!fallback) throw err;
          current = prev;
          setList(fallback.media);
          lastFetchedAt = fallback.fetchedAt;
          logger.warn(
            `AniList: incoming-season fetch failed (${String(err)}); ` +
              `serving cached ${label()} until a rotation attempt succeeds`,
          );
          void enrichFromTmdb().catch((enrichErr) => {
            logger.warn(`TMDB enrichment failed: ${String(enrichErr)}`);
          });
        }
      })();
      loadPromise.catch(() => {
        loadPromise = undefined;
      });
    }
    return loadPromise;
  };

  // The deck baseline every consumer (media, filter values) starts from:
  // the snapshot minus hidden sequels. Filter values derive from this same
  // baseline so the UI never offers a genre/format that only exists on
  // hidden entries.
  const visibleList = (): SeasonalAnime[] => {
    const all = list ?? [];
    return showSequels ? all : all.filter((a) => !a.isSequel);
  };

  const toMedia = (a: SeasonalAnime): Media => ({
    id: String(a.id),
    type: 'anime',
    title: a.title,
    description: a.description,
    year: a.seasonYear,
    posterUrl: a.coverUrl ? `/api/poster/${id}/${a.id}/0` : undefined,
    // Stills ride the same proxy: thumbId >= 1 indexes into the entry's
    // TMDB backdrops (0 stays the cover).
    screenshotUrls: a.stills?.length
      ? a.stills.map((_, i) => `/api/poster/${id}/${a.id}/${i + 1}`)
      : undefined,
    genres: a.genres,
    // AniList reports minutes-per-episode; Media.duration stays in
    // milliseconds on the wire (formatDuration's contract).
    duration: a.duration != null ? a.duration * 60_000 : undefined,
    rating: a.rating,
    anilistId: a.id,
    malId: a.idMal,
    titleRomaji: a.titleRomaji,
    format: a.format,
    episodes: a.episodes,
    studio: a.studio,
    trailer: a.trailer,
  });

  return {
    type: 'anilist',
    options,
    mediaOrdered: true,

    isAvailable: async () => {
      // Available = we have (or can get) a snapshot to serve: disk cache,
      // or a live first-boot fetch. First boot offline lands here as false
      // and boot fails with a clear ProviderUnavailableError.
      try {
        await ensureLoaded();
        return true;
      } catch (err) {
        logger.error(`AniList ${label()}: initial load failed: ${String(err)}`);
        return false;
      }
    },

    getName: () => Promise.resolve(`AniList ${label()}`),

    // Copy, not the live object: `current` swaps on rotation and callers
    // must not hold a reference that mutates under them.
    getSeason: () => ({ ...current }),

    getMedia: async (): Promise<Media[]> => {
      await ensureLoaded();
      // Order preserved from AniList's POPULARITY_DESC -- see mediaOrdered.
      // (The per-room filter application died with the filter rip-out:
      // cour deals the whole season.)
      return visibleList().map(toMedia);
    },

    getArtwork: async (
      key: string,
      signal?: AbortSignal,
    ): Promise<[ReadableStream<Uint8Array>, Headers]> => {
      // Poster route key form is "<metadataId>/<thumbId>": metadataId is
      // the AniList id; thumbId 0 is the cover, >= 1 indexes the entry's
      // TMDB stills (0.9.0). Both segments were validated as numeric by
      // the route.
      const [anilistId, thumbRaw] = key.split('/');
      const thumbId = Number(thumbRaw ?? '0');
      // A poster request can race the startup load (browser fetches posters
      // as soon as the deck renders) -- make sure the maps are built.
      await ensureLoaded();
      const imageUrl = thumbId >= 1
        ? stillsById.get(anilistId)?.[thumbId - 1]
        : coverById.get(anilistId);
      if (!imageUrl) {
        throw new Error(`no artwork ${thumbId} for AniList id ${anilistId}`);
      }
      // Defense in depth: image URLs come from API/cache data, but a
      // tampered cache file must not turn the poster proxy into an open
      // fetch relay. Covers live on *.anilist.co, stills on
      // image.tmdb.org, both https.
      const parsed = new URL(imageUrl);
      const hostOk =
        parsed.hostname === 'anilist.co' ||
        parsed.hostname.endsWith('.anilist.co') ||
        parsed.hostname === 'image.tmdb.org';
      if (parsed.protocol !== 'https:' || !hostOk) {
        throw new Error(`refusing artwork URL host ${parsed.hostname}`);
      }

      const timeout = AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS);
      const response = await fetch(imageUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok && response.body) {
        return [response.body, response.headers];
      }
      const body = (await response.text()).slice(0, 200);
      throw new Error(`${response.status}: ${body}`);
    },
  };
};
