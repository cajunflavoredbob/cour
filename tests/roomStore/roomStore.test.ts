import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn().mockReturnValue({
    servers: [{ type: 'anilist', url: 'https://graphql.anilist.co' }],
    anime: { season: 'SUMMER', year: 2026 },
  }),
}));

// Room's constructor kicks off a provider media fetch; a minimal fake
// keeps these tests at the persistence layer.
import * as fs from 'node:fs/promises';
import { openDb } from '../../internal/app/cour/db';
import { createCourStore, type CourStore } from '../../internal/app/cour/store';
import {
  loadRoom,
  reconcileRoomSeasons,
  resolveRoomSeason,
  saveRoom,
} from '../../internal/app/reely/roomStore';
import type { Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import { logger } from '../../internal/app/reely/logger';
import { makeMedia } from '../helpers';

let cour: CourStore;

const makeCtx = (withCour = true): RouteContext => ({
  providers: [
    {
      mediaOrdered: true,
      getMedia: vi.fn().mockResolvedValue([makeMedia({ id: '1' })]),
    } as unknown as RouteContext['providers'][number],
  ],
  ...(withCour ? { cour } : {}),
});

const makeWsRoom = (over: Partial<{
  roomName: string; displayName: string; routeContext: RouteContext;
}> = {}): Room => ({
  roomName: 'movie-night',
  displayName: 'Movie-Night',
  createdAt: 1000,
  routeContext: over.routeContext ?? makeCtx(),
  ...over,
} as unknown as Room);

beforeEach(() => {
  vi.clearAllMocks();
  cour = createCourStore(openDb(':memory:'));
});

describe('resolveRoomSeason', () => {
  it('prefers the config anime block over date detection', () => {
    // A config-pinned season is never provisional: only the provider's
    // boot fallback produces a season it knows is behind.
    expect(resolveRoomSeason()).toEqual({ season: 'SUMMER', year: 2026, provisional: false });
  });

  it('prefers the live provider season over everything', () => {
    const ctx = makeCtx();
    (ctx.providers[0] as { getSeason?: () => unknown }).getSeason = () => ({
      season: 'FALL',
      year: 2026,
    });
    expect(resolveRoomSeason(ctx.providers)).toEqual({
      season: 'FALL',
      year: 2026,
      provisional: false,
    });
  });

  it('loadRoom still deletes a mismatched room even while provisional (BENCH-NEEDED)', async () => {
    // Pins the CURRENT, deliberate behaviour so the reverted fix is not
    // silently reintroduced. Keeping the row instead of deleting it was
    // tried in the 1.3.7 audit and reverted: the surviving row gets
    // adopted by the create path, which permanently burns a locked
    // member's one-shot ranking and contaminates the next season's
    // standings. Deletion here is a known, recoverable data loss; the
    // alternative was an unrecoverable one. See the note at
    // roomStore.ts:167. Closing this properly is the owner's call.
    const ctx = makeCtx();
    const p = ctx.providers[0] as {
      getSeason?: () => unknown;
      isSeasonProvisional?: () => boolean;
    };
    // Provider fell back to SUMMER; the room belongs to the season we are
    // actually rotating into.
    p.getSeason = () => ({ season: 'SUMMER', year: 2026 });
    p.isSeasonProvisional = () => true;
    const created = cour.rooms.create({
      name: 'fall-room',
      displayName: 'Fall-Room',
      season: 'FALL',
      year: 2026,
      showSequels: false,
    });
    const user = cour.users.create('user1').id;
    cour.members.ensure(created.id, user);
    cour.verdicts.upsert(user, created.id, 101, 'like');

    expect(await loadRoom('fall-room', ctx)).toBeNull();
    // Deleted, not kept. If this ever starts passing with the row alive,
    // the reverted fix is back and the adoption path is reachable again.
    expect(cour.rooms.byName('fall-room')).toBeUndefined();
    expect(cour.members.list(created.id)).toHaveLength(0);
  });

  it('carries the provider provisional flag through to the delete paths', () => {
    // The destructive consumers (the boot sweep and loadRoom's stale
    // guard) must be able to see that the provider's season is a fallback
    // and is deliberately BEHIND the real one.
    const ctx = makeCtx();
    const p = ctx.providers[0] as {
      getSeason?: () => unknown;
      isSeasonProvisional?: () => boolean;
    };
    p.getSeason = () => ({ season: 'SUMMER', year: 2026 });
    p.isSeasonProvisional = () => true;
    expect(resolveRoomSeason(ctx.providers)).toEqual({
      season: 'SUMMER',
      year: 2026,
      provisional: true,
    });
  });
});

describe('reconcileRoomSeasons', () => {
  it('deletes stale-season rooms and leaves current ones untouched', () => {
    const user = cour.users.create('user1').id;
    const stale = cour.rooms.create({
      name: 'last-season', displayName: 'Last', season: 'SPRING', year: 2026, showSequels: false,
    });
    const fresh = cour.rooms.create({
      name: 'this-season', displayName: 'This', season: 'SUMMER', year: 2026, showSequels: false,
    });
    cour.members.ensure(stale.id, user);
    cour.verdicts.upsert(user, stale.id, 101, 'like');
    cour.members.ensure(fresh.id, user);
    cour.verdicts.upsert(user, fresh.id, 202, 'like');

    reconcileRoomSeasons(cour, { season: 'SUMMER', year: 2026 });

    // The rotation reaper (the owner's spec): rooms and their members
    // are deleted outright at the rotation mark.
    expect(cour.rooms.byId(stale.id)).toBeUndefined();
    expect(cour.members.list(stale.id)).toEqual([]);
    // The current-season room keeps everything, and users survive.
    expect(cour.verdicts.listFor(user, fresh.id)).toHaveLength(1);
    expect(cour.members.list(fresh.id)).toHaveLength(1);
    expect(cour.users.byId(user)).toBeDefined();
  });
});

describe('saveRoom (SQLite)', () => {
  it('creates the room row on first save', () => {
    saveRoom(makeWsRoom());
    const row = cour.rooms.byName('movie-night');
    expect(row?.displayName).toBe('Movie-Night');
    expect(row?.season).toBe('SUMMER');
    expect(row?.year).toBe(2026);
  });

  it('later saves are idempotent (no duplicate rows)', () => {
    const room = makeWsRoom();
    saveRoom(room);
    saveRoom(room);
    expect(cour.rooms.list()).toHaveLength(1);
  });

  it('no-ops without a cour store (test-harness Rooms)', () => {
    expect(() => saveRoom(makeWsRoom({ routeContext: makeCtx(false) }))).not.toThrow();
  });

});

describe('loadRoom (SQLite first)', () => {
  it('restores a room from its database row', async () => {
    cour.rooms.create({
      name: 'stored-room',
      displayName: 'Stored-Room',
      season: 'SUMMER',
      year: 2026,
      showSequels: false,
    });
    const room = await loadRoom('stored-room', makeCtx());
    expect(room?.roomName).toBe('stored-room');
    expect(room?.displayName).toBe('Stored-Room');
    // No filesystem read on the database path.
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });

  it('deletes a stale-season row on load instead of restoring old verdicts', async () => {
    const user = cour.users.create('user1').id;
    const row = cour.rooms.create({
      name: 'rolled-room',
      displayName: 'Rolled-Room',
      season: 'WINTER',
      year: 2025,
      showSequels: false,
    });
    cour.members.ensure(row.id, user);
    cour.verdicts.upsert(user, row.id, 101, 'like');

    // Config mock pins SUMMER 2026, so the stored WINTER 2025 is stale:
    // the rotation reaper's spec says the room is deleted, and loadRoom
    // reports "no room" (without falling through to the legacy JSON
    // path) so the join flow creates it fresh.
    const room = await loadRoom('rolled-room', makeCtx());
    expect(room).toBeNull();
    expect(cour.rooms.byId(row.id)).toBeUndefined();
    expect(cour.members.list(row.id)).toEqual([]);
  });

  it('returns null when neither the database nor legacy JSON knows the room', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    expect(await loadRoom('nowhere', makeCtx())).toBeNull();
  });

  it('returns null (row kept) when the provider fetch fails', async () => {
    cour.rooms.create({
      name: 'sad-room', displayName: 'sad', season: 'SUMMER', year: 2026, showSequels: false,
    });
    const ctx = makeCtx();
    (ctx.providers[0].getMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('anilist down'),
    );
    expect(await loadRoom('sad-room', ctx)).toBeNull();
    expect(cour.rooms.byName('sad-room')).toBeDefined();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('sad-room'),
    );
  });
});

describe('loadRoom legacy JSON import', () => {
  const legacyBody = JSON.stringify({
    roomName: 'legacy-room',
    displayName: 'Legacy-Room',
    createdAt: 12345,
    updatedAt: 67890,
  });

  it('imports a legacy file into SQLite and parks the file', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(legacyBody as never);
    const room = await loadRoom('legacy-room', makeCtx());
    expect(room?.displayName).toBe('Legacy-Room');
    expect(room?.createdAt).toBe(12345);
    // Imported: the row exists now and the file was renamed one-way.
    expect(cour.rooms.byName('legacy-room')).toBeDefined();
    expect(vi.mocked(fs.rename)).toHaveBeenCalledWith(
      expect.stringContaining('legacy-room.json'),
      expect.stringContaining('legacy-room.json.imported'),
    );
    // Second load takes the database branch -- no more file reads.
    vi.mocked(fs.readFile).mockClear();
    const again = await loadRoom('legacy-room', makeCtx());
    expect(again?.displayName).toBe('Legacy-Room');
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });

  it('rejects a malformed legacy file', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ roomName: 'r' }) as never,
    );
    expect(await loadRoom('bad-legacy', makeCtx())).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('invalid shape'),
    );
  });

  it('refuses a path-traversal room name', async () => {
    expect(await loadRoom('../evil', makeCtx())).toBeNull();
    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
  });
});
