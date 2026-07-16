import type { DatabaseSync } from 'node:sqlite';

/**
 * Accessors over the cour database.
 *
 * 0.4.0 brought users + sessions; 0.5.0 added rooms, members, verdicts,
 * and rankings; 0.12.0 stripped the credential layer (sessions,
 * passwords, roles) -- identity is a bare persistent username row now.
 * Handlers in client.ts and the roomStore season sweep are the callers.
 * (The session-token model this header used to describe died with
 * 0.12.0; the audit-17 sweep removed the stale doc.)
 */

export interface CourUser {
  id: number;
  username: string;
  createdAt: number;
}

export class UsernameTakenError extends Error {
  name = 'UsernameTakenError';
}
export class InvalidUsernameError extends Error {
  name = 'InvalidUsernameError';
}
export class MemberLockedError extends Error {
  name = 'MemberLockedError';
}
export class NotLockedError extends Error {
  name = 'NotLockedError';
}
export class AlreadySubmittedError extends Error {
  name = 'AlreadySubmittedError';
}

export type Verdict = 'like' | 'dislike' | 'skip';

export interface CourRoom {
  id: number;
  name: string;
  displayName: string;
  season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  year: number;
  // Room-creation-time filters, JSON-encoded on disk. Opaque to the store.
  filters?: unknown;
  showSequels: boolean;
  createdAt: number;
}

export interface RoomMember {
  roomId: number;
  userId: number;
  username: string;
  lockedAt: number | null;
  // Ranking submitted (one-shot). Rides along so the member-state
  // payloads (room pulse / standings WAITING ON) need one query.
  submittedAt: number | null;
}

// Single source for the name-length rule (audit 17: it was 32 at the
// login gate but 64 here and in the sanitizer -- three definitions that
// drifted). 32 is the user-facing contract.
export const MAX_USERNAME_LEN = 32;

// The row still carries the credential-era columns (role, sound_pref,
// password_hash) as documented dead weight -- see db.ts. The accessor
// layer stopped surfacing them in audit 17's sweep: nothing read them.
interface UserRow {
  id: number;
  username: string;
  created_at: number;
}

const toUser = (row: UserRow): CourUser => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at,
});

export const createCourStore = (db: DatabaseSync) => {
  const users = {
    count: (): number => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      return row.n;
    },

    /**
     * Create a user from a bare name (0.12.0: passwordless -- the row is
     * the durable identity, there is no credential). Username keeps the
     * typed casing but is unique case-insensitively; the legacy
     * password_hash column is written empty.
     */
    create: (username: string): CourUser => {
      const name = username.trim();
      if (name.length === 0 || name.length > MAX_USERNAME_LEN) {
        throw new InvalidUsernameError(
          `Username must be 1-${MAX_USERNAME_LEN} characters.`,
        );
      }
      try {
        const result = db
          .prepare(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, '', 'user', ?)",
          )
          .run(name, Date.now());
        return users.byId(Number(result.lastInsertRowid)) as CourUser;
      } catch (err) {
        if (String(err).includes('UNIQUE')) {
          throw new UsernameTakenError(`"${name}" is already taken.`);
        }
        throw err;
      }
    },

    byId: (id: number): CourUser | undefined => {
      const row = db
        .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
        .get(id) as UserRow | undefined;
      return row ? toUser(row) : undefined;
    },

    byName: (username: string): CourUser | undefined => {
      const row = db
        .prepare(
          'SELECT id, username, created_at FROM users WHERE username = ?',
        )
        .get(username.trim()) as UserRow | undefined;
      return row ? toUser(row) : undefined;
    },

  };

  interface RoomRow {
    id: number;
    name: string;
    display_name: string;
    season: CourRoom['season'];
    year: number;
    filters_json: string | null;
    show_sequels: number;
    created_at: number;
  }

  const toRoom = (row: RoomRow): CourRoom => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    season: row.season,
    year: row.year,
    filters: row.filters_json ? JSON.parse(row.filters_json) : undefined,
    showSequels: row.show_sequels === 1,
    createdAt: row.created_at,
  });

  const rooms = {
    create: (room: {
      name: string;
      displayName?: string;
      season: CourRoom['season'];
      year: number;
      filters?: unknown;
      showSequels?: boolean;
    }): CourRoom => {
      const result = db
        .prepare(
          `INSERT INTO rooms (name, display_name, season, year, filters_json, show_sequels, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room.name,
          room.displayName ?? room.name,
          room.season,
          room.year,
          room.filters !== undefined ? JSON.stringify(room.filters) : null,
          room.showSequels ? 1 : 0,
          Date.now(),
        );
      return rooms.byId(Number(result.lastInsertRowid)) as CourRoom;
    },

    byId: (id: number): CourRoom | undefined => {
      const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as
        | RoomRow
        | undefined;
      return row ? toRoom(row) : undefined;
    },

    byName: (name: string): CourRoom | undefined => {
      const row = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as
        | RoomRow
        | undefined;
      return row ? toRoom(row) : undefined;
    },

    list: (): CourRoom[] => {
      const rows = db
        .prepare('SELECT * FROM rooms ORDER BY created_at')
        .all() as unknown as RoomRow[];
      return rows.map(toRoom);
    },

    updateFilters: (roomId: number, filters: unknown): void => {
      db.prepare('UPDATE rooms SET filters_json = ? WHERE id = ?').run(
        filters !== undefined ? JSON.stringify(filters) : null,
        roomId,
      );
    },

    /** Cascades to members/verdicts/rankings. Rooms never expire on
     * their own mid-season; the season-rotation sweep (the owner's spec:
     * rooms and their members are deleted at the one-month rotation
     * mark) and a future explicit admin delete are the only callers. A
     * reused room name simply auto-creates fresh next season. */
    delete: (roomId: number): boolean => {
      const result = db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
      return Number(result.changes) > 0;
    },
  };

  const members = {
    /** Idempotent join: first sight inserts the membership row. joined_at
     * records when; nothing reads it back today (the lastRoomFor feature
     * it was added for never landed), so later calls are pure no-ops --
     * the recency re-stamp died in audit 17's sweep. */
    ensure: (roomId: number, userId: number): void => {
      db.prepare(
        'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
      ).run(roomId, userId, Date.now());
    },

    get: (roomId: number, userId: number): RoomMember | undefined => {
      const row = db
        .prepare(
          `SELECT m.room_id, m.user_id, m.locked_at, m.rankings_submitted_at, u.username
           FROM room_members m JOIN users u ON u.id = m.user_id
           WHERE m.room_id = ? AND m.user_id = ?`,
        )
        .get(roomId, userId) as
        | {
          room_id: number; user_id: number; locked_at: number | null;
          rankings_submitted_at: number | null; username: string;
        }
        | undefined;
      if (!row) return undefined;
      return {
        roomId: row.room_id,
        userId: row.user_id,
        username: row.username,
        lockedAt: row.locked_at,
        submittedAt: row.rankings_submitted_at,
      };
    },

    /** No production caller today; kept as the accessor the planned
     * member-visibility payloads (room pulse / who-ranked-what) and the
     * state-assertion tests read through. */
    list: (roomId: number): RoomMember[] => {
      const rows = db
        .prepare(
          `SELECT m.room_id, m.user_id, m.locked_at, m.rankings_submitted_at, u.username
           FROM room_members m JOIN users u ON u.id = m.user_id
           WHERE m.room_id = ? ORDER BY u.created_at`,
        )
        .all(roomId) as unknown as Array<{
          room_id: number; user_id: number; locked_at: number | null;
          rankings_submitted_at: number | null; username: string;
        }>;
      return rows.map((row) => ({
        roomId: row.room_id,
        userId: row.user_id,
        username: row.username,
        lockedAt: row.locked_at,
        submittedAt: row.rankings_submitted_at,
      }));
    },

    /**
     * Lock this member in. Idempotent (a second lock keeps the original
     * timestamp). Returns whether the whole room is now locked, plus
     * whether THIS call did the locking -- callers celebrate the
     * all-locked moment only on the true edge (allLocked && justLocked),
     * so a retried lockIn can't duplicate the ceremony (audit 17).
     */
    lock: (
      roomId: number,
      userId: number,
    ): { lockedAt: number; allLocked: boolean; justLocked: boolean } => {
      const result = db.prepare(
        `UPDATE room_members SET locked_at = ?
         WHERE room_id = ? AND user_id = ? AND locked_at IS NULL`,
      ).run(Date.now(), roomId, userId);
      const justLocked = Number(result.changes) > 0;
      const me = members.get(roomId, userId);
      if (!me?.lockedAt) {
        throw new Error(`lock: user ${userId} is not a member of room ${roomId}`);
      }
      const open = db
        .prepare(
          'SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND locked_at IS NULL',
        )
        .get(roomId) as { n: number };
      return { lockedAt: me.lockedAt, allLocked: open.n === 0, justLocked };
    },
  };

  const verdicts = {
    /**
     * Record (or change) a verdict. UPSERT is the review screen's
     * tap-to-change contract. Refused once the member has locked in --
     * lock-in is the point of no return until an unlock call exists.
     */
    upsert: (userId: number, roomId: number, titleId: number, verdict: Verdict): void => {
      const me = members.get(roomId, userId);
      if (me?.lockedAt) {
        throw new MemberLockedError('Verdicts are locked in for this room.');
      }
      db.prepare(
        `INSERT INTO verdicts (user_id, room_id, title_id, verdict, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, room_id, title_id)
         DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`,
      ).run(userId, roomId, titleId, verdict, Date.now());
    },

    /**
     * Bulk skip for hold-to-skip-all (audit 17): one transaction instead
     * of ~300 individual WAL commits on a full season. Lock guard checked
     * once; ON CONFLICT DO NOTHING so a concurrent verdict for the same
     * title is never overwritten with a skip.
     */
    skipAll: (userId: number, roomId: number, titleIds: number[]): void => {
      const me = members.get(roomId, userId);
      if (me?.lockedAt) {
        throw new MemberLockedError('Verdicts are locked in for this room.');
      }
      const insert = db.prepare(
        `INSERT INTO verdicts (user_id, room_id, title_id, verdict, updated_at)
         VALUES (?, ?, ?, 'skip', ?)
         ON CONFLICT (user_id, room_id, title_id) DO NOTHING`,
      );
      db.exec('BEGIN');
      try {
        for (const titleId of titleIds) {
          insert.run(userId, roomId, titleId, Date.now());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    listFor: (userId: number, roomId: number): Array<{
      titleId: number; verdict: Verdict; updatedAt: number;
    }> => {
      const rows = db
        .prepare(
          `SELECT title_id, verdict, updated_at FROM verdicts
           WHERE user_id = ? AND room_id = ? ORDER BY updated_at`,
        )
        .all(userId, roomId) as unknown as Array<{
          title_id: number; verdict: Verdict; updated_at: number;
        }>;
      return rows.map((r) => ({ titleId: r.title_id, verdict: r.verdict, updatedAt: r.updated_at }));
    },

  };

  const rankings = {
    /**
     * Submit a member's final ranking of their liked titles -- the
     * couple-profile scoring method: full order recorded, the top five
     * carry 12/9/6/3/1 points in the combined standings. One shot per
     * member (no turning back); requires being locked in first.
     */
    submit: (userId: number, roomId: number, orderedTitleIds: number[]): void => {
      const member = db
        .prepare(
          'SELECT locked_at, rankings_submitted_at FROM room_members WHERE room_id = ? AND user_id = ?',
        )
        .get(roomId, userId) as
        | { locked_at: number | null; rankings_submitted_at: number | null }
        | undefined;
      if (!member?.locked_at) {
        throw new NotLockedError('Lock in your verdicts before ranking.');
      }
      if (member.rankings_submitted_at != null) {
        throw new AlreadySubmittedError('Your ranking is already submitted.');
      }
      const insert = db.prepare(
        'INSERT INTO rankings (user_id, room_id, title_id, rank) VALUES (?, ?, ?, ?)',
      );
      db.exec('BEGIN');
      try {
        orderedTitleIds.forEach((titleId, i) => {
          insert.run(userId, roomId, titleId, i + 1);
        });
        db.prepare(
          'UPDATE room_members SET rankings_submitted_at = ? WHERE room_id = ? AND user_id = ?',
        ).run(Date.now(), roomId, userId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    hasSubmitted: (userId: number, roomId: number): boolean => {
      const row = db
        .prepare(
          'SELECT rankings_submitted_at FROM room_members WHERE room_id = ? AND user_id = ?',
        )
        .get(roomId, userId) as { rankings_submitted_at: number | null } | undefined;
      return row?.rankings_submitted_at != null;
    },

    /** A member's own submitted order (titleIds, rank 1 first). */
    forUser: (userId: number, roomId: number): number[] => {
      const rows = db
        .prepare(
          'SELECT title_id FROM rankings WHERE user_id = ? AND room_id = ? ORDER BY rank',
        )
        .all(userId, roomId) as unknown as Array<{ title_id: number }>;
      return rows.map((r) => r.title_id);
    },

    /**
     * Each submitted member's #1 pick (rank 1) with their name -- the
     * "everyone's favorite" strip on the standings, shown regardless of
     * where that pick lands in the combined order. Rankings rows only
     * exist for members who have submitted, so a rank-1 row IS a
     * submitted top pick.
     */
    topPicks: (roomId: number): Array<{ userName: string; titleId: number }> => {
      const rows = db
        .prepare(
          `SELECT u.username AS user_name, r.title_id
           FROM rankings r JOIN users u ON u.id = r.user_id
           WHERE r.room_id = ? AND r.rank = 1
           ORDER BY u.username COLLATE NOCASE`,
        )
        .all(roomId) as unknown as Array<{ user_name: string; title_id: number }>;
      return rows.map((r) => ({ userName: r.user_name, titleId: r.title_id }));
    },

    /**
     * Combined standings across every submitted ranking. Points per the
     * couple profile (#1=12 #2=9 #3=6 #4=3 #5=1, deeper ranks 0);
     * tiebreaks: better single best rank, then titleId (the profile's
     * coin flip, made deterministic).
     */
    standings: (roomId: number): Array<{
      titleId: number; points: number; bestRank: number; rankedBy: number; rank: number;
    }> => {
      const rows = db
        .prepare(
          `SELECT title_id,
                  SUM(CASE rank WHEN 1 THEN 12 WHEN 2 THEN 9 WHEN 3 THEN 6 WHEN 4 THEN 3 WHEN 5 THEN 1 ELSE 0 END) AS points,
                  MIN(rank) AS best_rank,
                  COUNT(*) AS ranked_by
           FROM rankings WHERE room_id = ?
           GROUP BY title_id
           ORDER BY points DESC, best_rank ASC, title_id ASC`,
        )
        .all(roomId) as unknown as Array<{
          title_id: number; points: number; best_rank: number; ranked_by: number;
        }>;
      return rows.map((r, i) => ({
        titleId: r.title_id,
        points: r.points,
        bestRank: r.best_rank,
        rankedBy: r.ranked_by,
        rank: i + 1,
      }));
    },

    /** Who ranked each title (any position), name-ordered -- feeds the
     * standings rows' who-ranked-what (audit 17 UX item 7). */
    rankersByTitle: (roomId: number): Array<{ titleId: number; userName: string }> => {
      const rows = db
        .prepare(
          `SELECT r.title_id, u.username
           FROM rankings r JOIN users u ON u.id = r.user_id
           WHERE r.room_id = ?
           ORDER BY u.username COLLATE NOCASE`,
        )
        .all(roomId) as unknown as Array<{ title_id: number; username: string }>;
      return rows.map((r) => ({ titleId: r.title_id, userName: r.username }));
    },

    /** How many members have submitted, over the room's member count. */
    progress: (roomId: number): { submitted: number; members: number } => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS members,
                  SUM(CASE WHEN rankings_submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted
           FROM room_members WHERE room_id = ?`,
        )
        .get(roomId) as { members: number; submitted: number | null };
      return { submitted: row.submitted ?? 0, members: row.members };
    },
  };

  return { users, rooms, members, verdicts, rankings };
};

export type CourStore = ReturnType<typeof createCourStore>;
