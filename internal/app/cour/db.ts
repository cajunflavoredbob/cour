import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * cour's SQLite database (0.4.0 data layer, docs/SCOPE.md).
 *
 * `node:sqlite` over better-sqlite3: it ships inside our pinned Node 24,
 * needs no native build in the Docker image, and has the same synchronous
 * execution model. Synchronous is correct here -- every query is a
 * point lookup or tiny scan on a household-scale dataset, and the WS
 * handlers that call into the store are already sequential per
 * connection.
 *
 * Schema notes:
 * - users.username is UNIQUE COLLATE NOCASE: the same name in any casing is one
 *   identity, but the display casing the admin typed is preserved.
 * - (historical) sessions stored a SHA-256 of the token; the table was
 *   dropped in v4 when the credential layer died. A
 *   database exfiltration must not yield valid logins.
 * - Rooms have NO expiry column by design -- a cour room lives until the
 *   season-rotation reaper deletes it one month before the next season
 *   airs (the owner's spec; audit 17).
 * - verdicts carries one row per (user, room, title); verdict changes are
 *   UPSERTs (the review screen's tap-to-change contract).
 * - rankings carries each member's one-shot post-lock ordering (0.13.0
 *   replaced the room_results tally table -- the v5 migration drops it).
 * - room_members still carries credential-era and deck-position columns
 *   as documented dead weight (dropping a column is a table rebuild);
 *   the accessor layer no longer reads them.
 */

export const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  sound_pref    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  season       TEXT NOT NULL CHECK (season IN ('WINTER', 'SPRING', 'SUMMER', 'FALL')),
  year         INTEGER NOT NULL,
  filters_json TEXT,
  show_sequels INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_position INTEGER NOT NULL DEFAULT 0,
  locked_at     INTEGER,
  joined_at     INTEGER NOT NULL DEFAULT 0,
  rankings_submitted_at INTEGER,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title_id   INTEGER NOT NULL,
  verdict    TEXT NOT NULL CHECK (verdict IN ('like', 'dislike', 'skip')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id, title_id)
);
CREATE INDEX IF NOT EXISTS idx_verdicts_room ON verdicts(room_id);

CREATE TABLE IF NOT EXISTS rankings (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title_id  INTEGER NOT NULL,
  rank      INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id, title_id)
);
`;

export const defaultDbPath = (): string => join(process.cwd(), 'data', 'cour.db');

export const openDb = (path = defaultDbPath()): DatabaseSync => {
  // :memory: is the test path; real paths need their directory to exist.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    // The most common first-deploy failure: the container runs as the
    // unprivileged node user, but the mounted data volume is owned by
    // someone else (Unraid creates appdata dirs as nobody:users 755).
    // SQLite's bare "unable to open database file" says none of that.
    throw new Error(
      `Cannot open the database at ${path}. The data directory is probably ` +
      `not writable by the container user (uid 1000) -- on Unraid/docker, ` +
      `"chmod 777 <host data dir>" or chown it to uid 1000. (${String(err)})`,
    );
  }
  // WAL keeps readers unblocked during writes; NORMAL sync is the standard
  // WAL pairing (fsync on checkpoint, not per-commit -- a power cut can
  // lose the last moments of verdicts, never corrupt the file). Not
  // applicable to :memory: but harmless there.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // OFF by default in SQLite; without it the REFERENCES clauses above are
  // decoration and ON DELETE CASCADE never fires.
  db.exec('PRAGMA foreign_keys = ON');
  // Refuse to open a database from the FUTURE, before touching it at all
  // (audit 17 M2). Rolling the binary back after a schema bump used to
  // skip every migration gate below and then stamp the version DOWN, so
  // the next upgrade re-ran its migrations against already-migrated
  // data. The cache layer got this right from day one; this brings the
  // database in line.
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (versionRow.user_version > SCHEMA_VERSION) {
    throw new Error(
      `The database at ${path} is schema version ${versionRow.user_version}, ` +
      `but this build only understands up to ${SCHEMA_VERSION}. It was ` +
      `written by a newer cour -- upgrade the image (or restore a matching ` +
      `database backup) instead of running an older build against it.`,
    );
  }
  db.exec(SCHEMA);
  // In-place migrations for databases created before the current schema.
  // CREATE TABLE IF NOT EXISTS can't add columns to existing tables, so
  // each version step gets an explicit ALTER. v3 (0.8.0): joined_at on
  // room_members, so "your last room" resolves by recency for the
  // login-time auto-rejoin.
  if (versionRow.user_version > 0 && versionRow.user_version < 3) {
    try {
      db.exec('ALTER TABLE room_members ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists (a fresh CREATE above carries it) -- fine.
    }
  }
  // v4 (0.12.0): the credential layer died; sessions go with it. The
  // users table keeps its password_hash/role/sound_pref columns as dead
  // weight -- dropping columns means a table rebuild, and empty strings
  // are cheaper than migration risk.
  if (versionRow.user_version > 0 && versionRow.user_version < 4) {
    db.exec('DROP TABLE IF EXISTS sessions');
  }
  // v5 (0.13.0): ranking replaces the +1/0/-1 tally as the scoring
  // mechanism (the couple-profile method: rank your likes, top 5 score
  // 12/9/6/3/1). room_results goes; rankings + the submitted stamp come.
  if (versionRow.user_version > 0 && versionRow.user_version < 5) {
    db.exec('DROP TABLE IF EXISTS room_results');
    try {
      db.exec('ALTER TABLE room_members ADD COLUMN rankings_submitted_at INTEGER');
    } catch {
      // Column already exists (fresh CREATE carries it) -- fine.
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
};
