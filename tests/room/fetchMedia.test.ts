import { describe, expect, it } from 'vitest';
import { Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Media } from '../../types/reely';

// Room.fetchMedia (0.4.0 teardown shape): the per-room shuffle died with
// the plex provider -- the anilist provider's popularity ordering IS the
// deck, so order preservation is the whole contract now.

const mediaFixture = (count: number): Media[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    type: 'anime' as const,
    title: `Title ${i}`,
    description: '',
    genres: [],
  }));

const makeRoom = (media: Media[]): Room => {
  const ctx = {
    providers: [
      {
        mediaOrdered: true,
        getMedia: async () => media,
      },
    ],
  } as unknown as RouteContext;
  return new Room({ roomName: 'r', displayName: 'r' }, ctx);
};

describe('Room.fetchMedia ordering', () => {
  it('preserves provider order exactly', async () => {
    const source = mediaFixture(12);
    const room = makeRoom(source);
    const deck = await room.getMedia();
    expect(deck.map((m) => m.id)).toEqual(source.map((m) => m.id));
  });

  it("does not mutate the provider's cached array", async () => {
    const source = mediaFixture(5);
    const snapshot = source.map((m) => m.id);
    const room = makeRoom(source);
    await room.getMedia();
    expect(source.map((m) => m.id)).toEqual(snapshot);
  });

  it('throws NoMediaError via the media promise when the provider returns nothing', async () => {
    const room = makeRoom([]);
    await expect(room.media).rejects.toThrow(/no titles in the season data/);
  });
});
