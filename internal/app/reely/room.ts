import type {
  ClientMessage,
  CreateRoomRequest,
  Filter,
  Media,
  User,
} from '../../../types/reely';
import type { Client } from './client';
import type { RouteContext } from './types';

export class RoomExistsError extends Error { name = 'RoomExistsError'; }
export class RoomLimitError extends Error { name = 'RoomLimitError'; }
export class RoomNotFoundError extends Error { name = 'RoomNotFoundError'; }
export class NoMediaError extends Error { name = 'NoMediaError'; }
// Thrown when a join request tries to add a connection under a username
// that's already taken by a DIFFERENT live connection in the same room.
// The named error surfaces through the join path so the UI can show a
// clear "name taken" message and prompt for a different name.
export class UsernameTakenError extends Error { name = 'UsernameTakenError'; }

/**
 * 0.4.0 teardown note: Room is deck + membership only. The swipe-era
 * machinery (ratings, matches, per-user progress, TTL activity clock)
 * is gone; per-user verdicts and lock-in arrive with the SQLite-backed
 * 0.5.0 protocol pivot and live in the database, not on this class.
 * Rooms no longer expire -- a cour room lives until explicitly deleted.
 */
export class Room {
  routeContext: RouteContext;
  // Canonical name (lowercased, allowlist-stripped). The Map key, filename,
  // and URL parameter value all use this form.
  roomName: string;
  // Display name (case preserved). Used for UI rendering. Falls back to
  // roomName when undefined (legacy persisted rooms).
  displayName: string;
  // Connected clients. Mutated by Client.handle*Room to add/remove the
  // current connection; broadcast iterates this map. Not for external use
  // outside the Client/Room pair.
  users = new Map<string, Client>();
  filters?: Filter[];
  media: Promise<Map</* mediaId */ string, Media>>;

  createdAt: number = Date.now();

  constructor(req: CreateRoomRequest, ctx: RouteContext) {
    this.routeContext = ctx;
    this.roomName = req.roomName;
    this.displayName = req.displayName ?? req.roomName;
    this.filters = req.filters;
    this.media = this.fetchMedia();
  }

  private async fetchMedia(filters?: Filter[]): Promise<Map<string, Media>> {
    const [provider] = this.routeContext.providers;
    const applied = filters ?? this.filters;
    const sourceMedia = await provider.getMedia({ filters: applied });

    if (sourceMedia.length === 0) {
      // Only blame filters when some were actually applied (audit 17):
      // an empty unfiltered season is a data problem, not a user one.
      throw new NoMediaError(
        applied?.length
          ? 'There are no titles matching the applied filters.'
          : 'There are no titles in the season data yet. Try again shortly.',
      );
    }

    // The anilist provider returns a deliberately-ordered list (popularity
    // descending) -- the deck IS the ranking, order is preserved as-is.
    // (The per-room Durstenfeld shuffle died with the plex provider in the
    // 0.4.0 teardown; providers/types.ts keeps the mediaOrdered flag as
    // the extension point should an unordered source ever return.)
    return new Map<string, Media>(sourceMedia.map((m) => [m.id, m]));
  }

  // Monotonic token for applyFilters (the internal re-deck path: stills
  // enrichment + season rotation; the user-facing filter wire died in
  // audit 17's strip). Two applies racing used to be last-RESOLVED-wins;
  // the token makes it last-REQUESTED-wins.
  private applySeq = 0;

  async applyFilters(newFilters: Filter[]): Promise<Media[] | null> {
    // Fetch with new filters before mutating state -- if it throws (e.g. NoMediaError)
    // the room is left intact and this.media remains the previous resolved promise.
    const seq = ++this.applySeq;
    const mediaMap = await this.fetchMedia(newFilters);
    // Only commit if no newer applyFilters started while we were fetching --
    // otherwise we'd clobber the newer (last-requested) result with a stale one.
    // Returning null on the losing branch tells the caller not to broadcast
    // a filterChangeApplied for media the room never adopted.
    if (seq !== this.applySeq) {
      return null;
    }
    this.filters = newFilters;
    this.media = Promise.resolve(mediaMap);
    return [...mediaMap.values()];
  }

  async getMedia(): Promise<Media[]> {
    const media = await this.media;
    return [...media.values()];
  }

  getUsers(): User[] {
    return [...this.users.values()].map((client) => client.getUser());
  }

  notifyJoin(user: User) {
    this.broadcastMessage({ type: 'userJoinedRoom', payload: user }, user.userName);
  }

  notifyLeave(user: User) {
    this.broadcastMessage({ type: 'userLeftRoom', payload: user }, user.userName);
  }

  notifyFilterApplied(appliedBy: string, media: Media[], filters: Filter[]) {
    this.broadcastMessage({
      type: 'filterChangeApplied',
      payload: { appliedBy, media, filters },
    });
  }

  broadcastMessage(msg: ClientMessage, sourceUserName?: string) {
    // Stringify once and forward the raw frame to every recipient
    // (audit 12 #201): with Media-bearing messages (filterChangeApplied)
    // the payload is multi-KB, so per-client stringify would compound.
    const json = JSON.stringify(msg);
    for (const [userName, client] of this.users.entries()) {
      if (userName !== sourceUserName) {
        client.sendRaw(json);
      }
    }
  }
}

type RoomName = string;
const rooms = new Map<RoomName, Room>();

// Hard cap on concurrently-tracked rooms. A backstop so a flood of createRoom
// calls can't exhaust memory/disk. Rooms no longer expire (0.4.0), so this
// is the only bound; household-scale deployments sit miles under it.
const MAX_ROOMS = 500;

export const hasRoom = (roomName: string): boolean => rooms.has(roomName);

export const addRoom = (room: Room): void => {
  // The disk-load join path adds rooms here -- enforce the same MAX_ROOMS cap
  // createRoom does, or a directory of persisted rooms could load past it and
  // defeat the memory-exhaustion backstop. Overwriting an existing key is not
  // a new room, so it isn't capped.
  if (!rooms.has(room.roomName) && rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  rooms.set(room.roomName, room);
};

// Snapshot iteration of all in-memory rooms. Returns an array (not the
// live iterator) so callers can safely call removeRoom() while iterating.
export const getAllRooms = (): Room[] => [...rooms.values()];

// MEMORY-ONLY removal -- does NOT unlink the persisted JSON file. A future
// explicit room-delete admin call must also unlink `roomFilePath(name)` or
// the room resurrects on next startup via `loadRoom` (audit 12 #203).
export const removeRoom = (roomName: string): boolean => rooms.delete(roomName);

export const createRoom = async (
  createRequest: CreateRoomRequest,
  ctx: RouteContext,
): Promise<Room> => {
  if (rooms.has(createRequest.roomName)) {
    throw new RoomExistsError(`${createRequest.roomName} already exists.`);
  }
  if (rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  const room = new Room(createRequest, ctx);
  await room.media;
  // Re-check after the await: two concurrent createRoom calls for the same
  // name can both pass the initial has() check (each yields on room.media
  // before setting). Without this guard the later writer silently overwrites
  // the earlier room's Map entry and the earlier client ends up orphaned.
  if (rooms.has(room.roomName)) {
    throw new RoomExistsError(`${createRequest.roomName} already exists.`);
  }
  rooms.set(room.roomName, room);
  return room;
};

export const getRoom = (roomName: string): Room => {
  const room = rooms.get(roomName);
  if (!room) throw new RoomNotFoundError(`The room "${roomName}" does not exist.`);

  // The same user rejoining (e.g. after a page refresh) is handled by the
  // caller: joinRoomFromSanitized probes a colliding entry's socket liveness
  // and displaces a dead holder (a stale WS entry can outlive the TCP close),
  // while a demonstrably live holder rejects the join with
  // UsernameTakenError (audit 16 #421). handleLeaveRoom guards its delete by
  // identity so a displaced WS's close won't evict the new one.
  return room;
};
