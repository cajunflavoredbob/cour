import { join, resolve, sep } from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import type { CreateRoomRequest } from '../../../types/reely';
import { detectSeason, servedSeason } from '../anilist/season';
import type { CourRoom } from '../cour/store';
import { getConfig } from './config/main';
import { logger } from './logger';
import { Room } from './room';
import type { RouteContext } from './types';

const ROOMS_DIR = join(process.cwd(), 'data', 'rooms');

/**
 * Room persistence (0.5.0): SQLite is the source of truth. The JSON room
 * files reely used are a read-only legacy path -- loadRoom imports one
 * into the database the first time it's asked for, then renames it to
 * `<name>.json.imported` so the migration is one-way and visible. The
 * debounced-save machinery died with the JSON write path: a SQLite
 * upsert per save is cheaper than the bookkeeping was.
 */

/**
 * Season/year a room row should carry: the provider's live season when
 * one is attached (the single source of truth -- it rotates and can lag
 * a failed rotation fetch), otherwise the same config-or-served
 * resolution the provider boots with (test harnesses construct Rooms
 * without a provider).
 */
export const resolveRoomSeason = (
  providers?: RouteContext['providers'],
): { season: CourRoom['season']; year: number; provisional: boolean } => {
  const live = providers?.[0]?.getSeason?.();
  // `provisional` rides along because the DESTRUCTIVE consumers of this
  // value must distrust it: a provider that fell back to the previous
  // season at boot is deliberately reporting a season BEHIND the real
  // one, and deleting rooms against it destroys the incoming season's
  // data (the boot sweep in app.ts defers for exactly this reason).
  if (live) {
    return { ...live, provisional: providers?.[0]?.isSeasonProvisional?.() ?? false };
  }
  const config = getConfig();
  // Everything below is the NO-PROVIDER fallback only: test harnesses
  // construct Rooms without one, and in production the provider above is
  // the single source of truth for what season it is.
  //
  // It no longer mirrors the provider exactly, and deliberately so. The
  // provider resolves a pin ONCE at construction (see the note at
  // providers/anime.ts), because recomposing the unset half of a partial
  // pin from a live clock made a "pinned" provider rotate at calendar
  // boundaries. This branch still composes, since it has no construction
  // point to freeze at. That drift is unreachable in production for the
  // reason above; if this ever becomes a production path, freeze it the
  // same way rather than leaving the two resolutions disagreeing.
  if (config.anime?.season != null || config.anime?.year != null) {
    const detected = detectSeason(new Date());
    return {
      season: config.anime?.season ?? detected.season,
      year: config.anime?.year ?? detected.year,
      provisional: false,
    };
  }
  return { ...servedSeason(new Date()), provisional: false };
};

/**
 * Season rollover sweep (the owner's spec): rooms and their members are
 * DELETED at the rotation mark (two weeks before the incoming season
 * airs) -- until then everything stays
 * saved. Deletion cascades members/verdicts/rankings; a reused room name
 * auto-creates fresh on the next join, and a client connected across the
 * rotation resurrects its room row on its next verdict-flow message
 * (verdictContext's byName-or-create), stamped with the new season. Runs
 * at boot (the server may have been down across a rotation point) and
 * from the provider's onSeasonRotated. Per-room failures are logged and
 * skipped so one bad row can't block the sweep.
 */
export const reconcileRoomSeasons = (
  cour: NonNullable<RouteContext['cour']>,
  served: { season: CourRoom['season']; year: number },
): void => {
  for (const room of cour.rooms.list()) {
    if (room.season === served.season && room.year === served.year) continue;
    try {
      cour.rooms.delete(room.id);
      logger.info(
        `Room "${room.name}": season rolled ${room.season} ${room.year} -> ` +
          `${served.season} ${served.year}; room deleted (rotation reaper).`,
      );
    } catch (err) {
      logger.error(`Room "${room.name}": rotation delete failed: ${String(err)}`);
    }
  }
};

// Defense-in-depth: assert the resolved path stays under ROOMS_DIR
// (audit 12 #230) -- the legacy import still reads by room name.
const ROOMS_DIR_RESOLVED = resolve(ROOMS_DIR);
const roomFilePath = (roomName: string) => {
  const candidate = join(ROOMS_DIR, `${roomName}.json`);
  const resolved = resolve(candidate);
  if (resolved !== candidate || !resolved.startsWith(ROOMS_DIR_RESOLVED + sep)) {
    throw new Error(`Refusing to use room file path outside ${ROOMS_DIR}: ${roomName}`);
  }
  return candidate;
};

interface LegacyPersistedRoom {
  roomName: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

const isLegacyRoomShape = (
  parsed: unknown,
  roomName: string,
): parsed is LegacyPersistedRoom => {
  const fail = (reason: string): false => {
    logger.error(`Room file "${roomName}" has an invalid shape: ${reason}; ignoring it.`);
    return false;
  };
  if (!parsed || typeof parsed !== 'object') return fail('not an object');
  const r = parsed as Partial<LegacyPersistedRoom>;
  if (typeof r.roomName !== 'string') return fail('roomName must be a string');
  if (r.displayName !== undefined && typeof r.displayName !== 'string') {
    return fail('displayName must be a string when present');
  }
  if (typeof r.createdAt !== 'number') return fail('createdAt must be a number');
  if (typeof r.updatedAt !== 'number') return fail('updatedAt must be a number');
  return true;
};

/**
 * Ensure the room's row exists. (Filters died in the audit-v1.2.0
 * rip-out; identity + season are all a row carries now.) No-op without
 * a cour store -- test harnesses construct Rooms without one.
 */
export const saveRoom = (room: Room): void => {
  const cour = room.routeContext.cour;
  if (!cour) return;
  try {
    if (!cour.rooms.byName(room.roomName)) {
      const { season, year } = resolveRoomSeason(room.routeContext.providers);
      cour.rooms.create({
        name: room.roomName,
        displayName: room.displayName,
        season,
        year,
        showSequels: getConfig().anime?.showSequels ?? false,
      });
    }
  } catch (err) {
    logger.error(`Failed to save room "${room.roomName}": ${String(err)}`);
  }
};

export const loadRoom = async (roomName: string, ctx: RouteContext): Promise<Room | null> => {
  // SQLite first: the source of truth since 0.5.0.
  const courRoom = ctx.cour?.rooms.byName(roomName);
  if (courRoom && ctx.cour) {
    // Belt-and-braces stale-season guard: the boot sweep and the rotation
    // callback should have deleted this row already, but a row that
    // slipped through (a sweep failure, a row written mid-rotation) must
    // not restore old-season verdicts against the new deck. Delete it
    // and report "no room" -- the join flow's create branch starts the
    // room fresh under the served season.
    const served = resolveRoomSeason(ctx.providers);
    if (courRoom.season !== served.season || courRoom.year !== served.year) {
      // NOTE (1.3.7 audit, BENCH-NEEDED): deleting here is a real data
      // loss when `served` is PROVISIONAL, because the provider is then
      // reporting a season it knows is behind. The obvious fix -- refuse
      // to restore but keep the row -- was tried and REVERTED: it is
      // worse. loadRoom returning null sends the join to the create path,
      // saveRoom no-ops because byName still finds the surviving row, and
      // verdictContext rebinds to it, so the session ends up bound to the
      // other season's row while being served the provisional deck. A
      // member who locked in before the restart then reads zero verdicts,
      // is routed to the rank screen, and submits an empty ranking that
      // the store stamps permanently; foreign title ids also land in the
      // row and survive the reaper once the season settles, because the
      // row matches by then. Deletion is recoverable by re-picking; that
      // is not. Closing this properly means teaching the CREATE/adopt
      // path about the provisional season too (saveRoom at :133 and
      // verdictContext in client.ts), which needs the owner's call on what
      // a join should do while the season is settling.
      ctx.cour.rooms.delete(courRoom.id);
      logger.info(
        `Room "${roomName}": stale season ${courRoom.season} ${courRoom.year} deleted on load.`,
      );
      return null;
    }
  }
  if (courRoom) {
    try {
      const room = new Room(
        {
          roomName: courRoom.name,
          displayName: courRoom.displayName,
        },
        ctx,
      );
      await room.media;
      room.createdAt = courRoom.createdAt;
      logger.info(`Restored room "${roomName}" from the database.`);
      return room;
    } catch (err) {
      // Most commonly the provider fetch failed (AniList down with no
      // cache). Row stays for the next attempt.
      logger.error(
        `Failed to restore room "${roomName}" from the database ` +
          `(most likely the provider fetch failed): ${String(err)}`,
      );
      return null;
    }
  }

  // Legacy JSON fallback: import once, then park the file.
  try {
    const filePath = roomFilePath(roomName);
    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isLegacyRoomShape(parsed, roomName)) return null;
    const req: CreateRoomRequest = {
      // The filename is the canonical identity, not the file's own field.
      roomName,
      displayName: parsed.displayName ?? roomName,
    };
    const room = new Room(req, ctx);
    await room.media;
    room.createdAt = parsed.createdAt;
    if (ctx.cour) {
      saveRoom(room);
      // One-way, visible migration marker. A failed rename just means the
      // next load takes the (now-idempotent) SQLite branch anyway.
      await rename(filePath, `${filePath}.imported`).catch(() => {});
      logger.info(`Imported legacy room file "${roomName}" into the database.`);
    } else {
      logger.info(`Restored room "${roomName}" from legacy JSON (no database attached).`);
    }
    return room;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(
        `Failed to restore room "${roomName}" from legacy JSON: ${String(err)}`,
      );
    }
    return null;
  }
};
