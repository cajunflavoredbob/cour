import { describe, it, expect, vi, beforeEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn().mockReturnValue({ servers: [], basicAuth: undefined }),
}));

vi.mock('../../internal/app/reely/roomStore', () => ({
  loadRoom: vi.fn().mockResolvedValue(undefined),
  saveRoom: vi.fn().mockResolvedValue(undefined),
  scheduleSaveRoom: vi.fn(),
}));

// Partial mock: replace the room registry functions with vi.fn()s but keep
// the real Room class and the error class hierarchy (RoomExistsError etc.)
// so the client's instanceof checks still work against thrown errors.
vi.mock('../../internal/app/reely/room', async () => {
  const actual = await vi.importActual<typeof import('../../internal/app/reely/room')>(
    '../../internal/app/reely/room',
  );
  return {
    ...actual,
    hasRoom: vi.fn().mockReturnValue(false),
    createRoom: vi.fn(),
    getRoom: vi.fn(),
    addRoom: vi.fn(),
  };
});

import { Client } from '../../internal/app/reely/client';
import {
  RoomExistsError,
  hasRoom,
  createRoom,
  getRoom,
} from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';
import { makeWs, push, sent, flush } from '../helpers';

// Cast helpers for the mocked exports.
const mockedHasRoom = vi.mocked(hasRoom);
const mockedCreateRoom = vi.mocked(createRoom);
const mockedGetRoom = vi.mocked(getRoom);

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------

describe('Client malformed-payload handling', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    ws = makeWs();
  });

  // Finding 4: message.payload is untrusted JSON. A malformed message used to
  // throw inside the handler, get swallowed by the handleRawMessage catch, and
  // hang the client awaiting a response. Each handler must answer with its
  // own error message instead.
  it('answers a createRoom with no roomName with createRoomError', () => {
    const client = new Client(ws, []);
    client.userName = 'user1';
    client.isLoggedIn = true;
    ws.send.mockClear();
    push(ws, { type: 'createRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('createRoomError');
  });

  it('answers a joinRoom with no roomName with joinRoomError', () => {
    const client = new Client(ws, []);
    client.userName = 'user1';
    client.isLoggedIn = true;
    ws.send.mockClear();
    push(ws, { type: 'joinRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('joinRoomError');
  });

});

// ---------------------------------------------------------------------------

// Builds a minimal Room-shaped object that handleJoinOrCreateRoom can use.
const makeFakeRoom = (roomName: string) => ({
  roomName,
  users: new Map<string, Client>(),
  media: Promise.resolve(new Map()),
  filters: undefined as undefined | unknown[],
  getMedia: vi.fn().mockResolvedValue([]),
  getUsers: vi.fn().mockReturnValue([]),
  notifyJoin: vi.fn(),
} as unknown as Room);

describe('Client joinOrCreateRoom routing', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  beforeEach(() => {
    mockedHasRoom.mockReset();
    mockedCreateRoom.mockReset();
    mockedGetRoom.mockReset();
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();
    client.userName = 'user1';
    client.isLoggedIn = true;
  });

  it('takes the join path when the room already exists in memory', async () => {
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(makeFakeRoom('movie-night'));

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedGetRoom).toHaveBeenCalled();
    expect(mockedCreateRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
  });

  it('takes the create path when the room does not exist', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockResolvedValue(makeFakeRoom('movie-night'));

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalled();
    expect(mockedGetRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'createRoomSuccess')).toBe(true);
  });

  it('does not install a client whose socket died mid-join (audit 17 ghost member)', async () => {
    // The socket closes while createRoom's media fetch is in flight:
    // handleClose has already run (no room set, nothing to clean), so
    // installing the client now would park a dead entry in room.users
    // that holds the name until a liveness probe displaces it.
    const room = makeFakeRoom('movie-night');
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockResolvedValue(room);

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    (ws as unknown as { readyState: number }).readyState = 3; // CLOSED mid-await
    await flush();

    expect((room.users as Map<string, Client>).size).toBe(0);
    expect(sent(ws).some((m) => m.type === 'createRoomSuccess')).toBe(false);
  });

  // If another client wins the create race between our probe and our create
  // attempt (rare, but possible), handleJoinOrCreateRoom should catch the
  // RoomExistsError and retry as a join.
  it('retries as join when create loses a RoomExistsError race', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockRejectedValueOnce(new RoomExistsError('movie-night already exists.'));
    mockedGetRoom.mockReturnValue(makeFakeRoom('movie-night'));

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalledTimes(1);
    expect(mockedGetRoom).toHaveBeenCalledTimes(1);
    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(msgs.some((m) => m.type === 'createRoomError')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

// Audit 16 #419 + #421: username-collision handling on join. #419 -- a
// rejected joiner must not keep a this.room reference (it let a follow-up
// login-rename wipe the ACTIVE user's userProgress through
// leaveRoomCleanup's returned room). #421 -- the 0.5.22 UsernameTakenError
// guard must probe the holder's liveness so a user's own zombie connection
// (unclean drop; socket looks OPEN until the ping sweep) can't block their
// auto-rejoin: only a demonstrably live holder rejects.
describe('Client join username collision (audit 16 #419 + #421)', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  // Holder-socket double: EventEmitter (once/off for the pong listener) plus
  // the probe surface. `pong: true` answers the liveness ping synchronously
  // (a live connection); `pong: false` never answers (half-open zombie).
  const makeHolderWs = (opts: { pong?: boolean; readyState?: number } = {}) => {
    const holderWs = makeWs();
    return Object.assign(holderWs, {
      readyState: opts.readyState ?? 1, // WebSocket.OPEN
      ping: vi.fn(() => {
        if (opts.pong) holderWs.emit('pong');
      }),
      terminate: vi.fn(),
    });
  };

  const makeCollisionRoom = (holder: Client) => {
    const room = makeFakeRoom('movie-night');
    (room.users as Map<string, Client>).set('user1', holder);
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(room);
    return room;
  };

  beforeEach(() => {
    mockedHasRoom.mockReset();
    mockedGetRoom.mockReset();
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();
    client.userName = 'user1';
    client.isLoggedIn = true;
  });

  it('rejects the join when the name is held by a live connection', async () => {
    const holderWs = makeHolderWs({ pong: true });
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomError' && m.payload.name === 'UsernameTakenError')).toBe(true);
    expect(room.users.get('user1')).toBe(holder);
    expect(holderWs.terminate).not.toHaveBeenCalled();
    // #419: the rejected joiner holds no reference to the room.
    expect(client.room).toBeUndefined();
  });

  it('a rejected joiner cannot evict the active user via an identity switch (audit 16 #419)', async () => {
    const holderWs = makeHolderWs({ pong: true });
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();
    ws.send.mockClear();

    // The rejected user switches identity (the credentialed-era rename:
    // assumeIdentity leaves any current room first). Pre-fix, the cleanup
    // got the never-joined room back from leaveRoomCleanup and mutated
    // the ACTIVE user1's state through it. Drive assumeIdentity via the
    // internal path the auth handlers use.
    (client as unknown as {
      assumeIdentity(u: { id: number; username: string; createdAt: number }): void;
    }).assumeIdentity({ id: 2, username: 'user2', createdAt: 0 });
    await flush();

    expect(client.userName).toBe('user2');
    expect(room.users.get('user1')).toBe(holder);
  });

  it('displaces a holder whose socket is already closed (audit 16 #421)', async () => {
    const holderWs = makeHolderWs({ readyState: 3 }); // WebSocket.CLOSED
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(room.users.get('user1')).toBe(client);
    expect(client.room).toBe(room);
    expect(holderWs.terminate).toHaveBeenCalled();
  });

  it('displaces a holder that never answers the liveness probe (audit 16 #421)', async () => {
    vi.useFakeTimers();
    try {
      const holderWs = makeHolderWs({ pong: false }); // OPEN but half-open zombie
      const holder = { ws: holderWs } as unknown as Client;
      const room = makeCollisionRoom(holder);

      push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
      // Probe deadline is 2s; advance past it and drain the async join.
      await vi.advanceTimersByTimeAsync(2100);

      expect(holderWs.ping).toHaveBeenCalled();
      expect(holderWs.terminate).toHaveBeenCalled();
      expect(room.users.get('user1')).toBe(client);
      expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

