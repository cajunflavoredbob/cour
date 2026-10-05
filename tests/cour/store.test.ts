import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../internal/app/cour/db';
import { createCourStore, type CourStore } from '../../internal/app/cour/store';

// :memory: keeps these fast and hermetic; openDb applies the full schema
// either way, so the on-disk path only differs by mkdir + WAL file.
let db: ReturnType<typeof openDb>;
let store: CourStore;

beforeEach(() => {
  db = openDb(':memory:');
  store = createCourStore(db);
});

// Temp directories made by the on-disk migration tests, removed after each test.
const tempDirs: string[] = [];
const tempDbPath = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, 'cour.db');
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('users', () => {
  it('creates a user from a bare name and reads it back', () => {
    const user = store.users.create('User1');
    expect(user.username).toBe('User1');
    expect(store.users.byId(user.id)?.username).toBe('User1');
    expect(store.users.byName('user1')?.id).toBe(user.id);
  });

  it('rejects a duplicate username case-insensitively', () => {
    store.users.create('User1');
    expect(() => store.users.create('user1')).toThrow(/taken/);
  });

  it('rejects empty and over-long usernames', () => {
    // 32 is the single name-length rule now (audit 17: the store said 64
    // while the login gate said 32).
    expect(() => store.users.create('   ')).toThrow(/1-32/);
    expect(() => store.users.create('x'.repeat(33))).toThrow(/1-32/);
  });

  it('count tracks created users', () => {
    store.users.create('a');
    store.users.create('b');
    expect(store.users.count()).toBe(2);
  });
});

describe('schema', () => {

  it('an empty users table is a valid state (first-run setup gate reads count)', () => {
    expect(store.users.count()).toBe(0);
  });
});

describe('schema migration v3 (joined_at)', () => {
  it('adds joined_at to a pre-v3 database in place', () => {
    const { DatabaseSync } = require('node:sqlite');
    const path = tempDbPath('cour-mig-');
    // Build a v2-shaped database: room_members WITHOUT joined_at.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', sound_pref INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, season TEXT NOT NULL, year INTEGER NOT NULL, filters_json TEXT, show_sequels INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE room_members (room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, deck_position INTEGER NOT NULL DEFAULT 0, locked_at INTEGER, PRIMARY KEY (room_id, user_id));
      PRAGMA user_version = 2;
    `);
    old.close();

    const migrated = openDb(path);
    const cols = migrated.prepare("SELECT name FROM pragma_table_info('room_members')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('joined_at');
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(3);
    // And the store's recency machinery works on the migrated db.
    const s2 = createCourStore(migrated);
    const u = s2.users.create('user1');
    const r = s2.rooms.create({ name: 'r1', displayName: 'r1', season: 'SUMMER', year: 2026 });
    s2.members.ensure(r.id, u.id);
    // joined_at is written on the migrated column without erroring.
    expect(s2.members.list(r.id)).toHaveLength(1);
    migrated.close();
  });
});

describe('schema migration v6 (the refine round)', () => {
  it('adds refined_at and the refined_rankings table to a v5 database', () => {
    const { DatabaseSync } = require('node:sqlite');
    const path = tempDbPath('cour-mig6-');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', sound_pref INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, season TEXT NOT NULL, year INTEGER NOT NULL, filters_json TEXT, show_sequels INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE room_members (room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, deck_position INTEGER NOT NULL DEFAULT 0, locked_at INTEGER, joined_at INTEGER NOT NULL DEFAULT 0, rankings_submitted_at INTEGER, PRIMARY KEY (room_id, user_id));
      CREATE TABLE rankings (user_id INTEGER NOT NULL, room_id INTEGER NOT NULL, title_id INTEGER NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (user_id, room_id, title_id));
      INSERT INTO users (username, password_hash, created_at) VALUES ('user1', '', 1);
      INSERT INTO rooms (name, display_name, season, year, created_at) VALUES ('r1', 'r1', 'SUMMER', 2026, 1);
      INSERT INTO room_members (room_id, user_id, locked_at, rankings_submitted_at) VALUES (1, 1, 5, 6);
      INSERT INTO rankings (user_id, room_id, title_id, rank) VALUES (1, 1, 101, 1), (1, 1, 102, 2);
      PRAGMA user_version = 5;
    `);
    old.close();

    const migrated = openDb(path);
    const cols = migrated.prepare("SELECT name FROM pragma_table_info('room_members')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('refined_at');
    const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('refined_rankings');
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(6);
    // The existing member keeps their ranking and can now refine it.
    const s2 = createCourStore(migrated);
    expect(s2.members.get(1, 1)?.refinedAt).toBeNull();
    s2.refined.submit(1, 1, [102, 101]);
    expect(s2.refined.forUser(1, 1)).toEqual([102, 101]);
    migrated.close();
  });
});

describe('schema migration v4 (sessions dropped)', () => {
  it('drops the sessions table from a pre-v4 database', () => {
    const { DatabaseSync } = require('node:sqlite');
    const path = tempDbPath('cour-mig4-');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', sound_pref INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, stay_signed_in INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version = 3;
    `);
    old.close();

    const migrated = openDb(path);
    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('sessions');
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(4);
    migrated.close();
  });
});
