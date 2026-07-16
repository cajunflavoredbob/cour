import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSeasonCache,
  saveSeasonCache,
  SEASON_CACHE_VERSION,
  type SeasonCacheFile,
} from '../../internal/app/anilist/cache';
import type { SeasonalAnime } from '../../internal/app/anilist/types';

const entry = (id: number): SeasonalAnime => ({
  id,
  title: `Show ${id}`,
  description: '',
  season: 'SUMMER',
  seasonYear: 2026,
  genres: ['Action'],
  popularity: 100 - id,
  isSequel: false,
});

const file = (over: Partial<SeasonCacheFile> = {}): SeasonCacheFile => ({
  version: SEASON_CACHE_VERSION,
  fetchedAt: 1_780_000_000_000,
  season: 'SUMMER',
  year: 2026,
  media: [entry(1), entry(2)],
  ...over,
});

// Real filesystem in a per-test temp dir -- the atomic tmp+rename behavior
// is the point, so mocking fs would test the mock.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anilist-cache-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('saveSeasonCache + loadSeasonCache', () => {
  it('round-trips a season file', async () => {
    const saved = file();
    await saveSeasonCache(dir, saved);
    expect(await loadSeasonCache(dir, 'SUMMER', 2026)).toEqual(saved);
  });

  it('creates the cache dir when missing', async () => {
    const nested = join(dir, 'not', 'yet', 'created');
    await saveSeasonCache(nested, file());
    expect(await loadSeasonCache(nested, 'SUMMER', 2026)).toBeDefined();
  });

  it('leaves no .tmp file behind (atomic rename)', async () => {
    await saveSeasonCache(dir, file());
    const names = await readdir(dir);
    expect(names).toEqual(['anilist_summer_2026.json']);
  });

  it('keys files by season + year so seasons never collide', async () => {
    await saveSeasonCache(dir, file());
    await saveSeasonCache(dir, file({ season: 'FALL', media: [entry(9)] }));
    expect((await loadSeasonCache(dir, 'SUMMER', 2026))?.media).toHaveLength(2);
    expect((await loadSeasonCache(dir, 'FALL', 2026))?.media).toEqual([entry(9)]);
  });
});

describe('loadSeasonCache fail-soft paths', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await loadSeasonCache(dir, 'SUMMER', 2026)).toBeUndefined();
  });

  it('returns undefined on corrupt JSON', async () => {
    await writeFile(join(dir, 'anilist_summer_2026.json'), '{ truncated', 'utf-8');
    expect(await loadSeasonCache(dir, 'SUMMER', 2026)).toBeUndefined();
  });

  it('returns undefined on a version mismatch', async () => {
    await saveSeasonCache(dir, file({ version: SEASON_CACHE_VERSION + 1 }));
    expect(await loadSeasonCache(dir, 'SUMMER', 2026)).toBeUndefined();
  });

  it('returns undefined on a shape mismatch (media not an array)', async () => {
    await writeFile(
      join(dir, 'anilist_summer_2026.json'),
      JSON.stringify({ version: SEASON_CACHE_VERSION, media: 'nope' }),
      'utf-8',
    );
    expect(await loadSeasonCache(dir, 'SUMMER', 2026)).toBeUndefined();
  });

  it('round-trip preserves the saved JSON verbatim on disk', async () => {
    const saved = file();
    await saveSeasonCache(dir, saved);
    const raw = await readFile(join(dir, 'anilist_summer_2026.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(saved);
  });
});
