import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../internal/app/cour/db';

// Audit 17 M2: the version stamp must never move backwards. A database
// written by a newer build refuses to open instead of being silently
// downgraded (which made the NEXT upgrade re-run migrations against
// already-migrated data).
describe('openDb schema-version guard', () => {
  it('refuses a database stamped by a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cour-db-'));
    try {
      const path = join(dir, 'cour.db');
      const future = new DatabaseSync(path);
      future.exec('PRAGMA user_version = 99');
      future.close();

      expect(() => openDb(path)).toThrow(/schema version 99/);
      // And it did not stamp the version down while failing.
      const check = new DatabaseSync(path);
      const row = check.prepare('PRAGMA user_version').get() as { user_version: number };
      check.close();
      expect(row.user_version).toBe(99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a fresh database and stamps the current version', () => {
    const db = openDb(':memory:');
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBeGreaterThan(0);
  });
});
