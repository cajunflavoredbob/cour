/**
 * A generic interface that the Plex provider implements.
 *
 * Goals:
 * - Keep the Plex API integration (internal/app/plex) portable.
 * - Allow reely to use clean data structures that aren't tied to Plex's
 *   XML-derived idioms.
 * - Leave room for non-Plex providers (Emby, Jellyfin) without the rest of
 *   the codebase needing to know which backend it's talking to.
 *
 * Note: reely is designed for a single configured server. The array of
 * providers in RouteContext always has exactly one entry; the interface
 * exists to keep the Plex integration swappable, not to support
 * multi-server operation.
 */

import type {
  Media,
  ProviderType,
} from '../../../../types/reely';

export interface ReelyProvider {
  readonly type: ProviderType;
  options: { url: string };

  // True when getMedia() returns a deliberately-ordered list the deck should
  // preserve (the anilist provider orders by popularity). When absent/false,
  // Room.fetchMedia shuffles per room -- the right default for library
  // providers like Plex, where source order is alphabetical noise.
  readonly mediaOrdered?: boolean;

  isAvailable(): Promise<boolean>;

  getName(): Promise<string>;

  // The broadcast season the provider is currently serving. Optional:
  // only seasonal providers have one. Synchronous and cheap -- it's read
  // per config frame and per room save. This is the single source of
  // truth for "what season is it"; nothing else should consult the clock.
  getSeason?(): { season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; year: number };

  // Returns the Web-stream form of the artwork bytes. The poster handler
  // bridges this to a Node `Readable` via `Readable.fromWeb(stream as any)`
  // -- the `any` cast is intentional and documented at that call site
  // (`handlers/poster.ts`): TypeScript's Node + DOM ReadableStream typedefs
  // are incompatible at this boundary even though both are runtime-valid.
  // Providers should return whatever ReadableStream their upstream API
  // hands back; the bridge is the consumer's responsibility (audit 9 #114).
  getArtwork(
    key: string,
    // Aborts the upstream fetch when the requesting client disconnects.
    signal?: AbortSignal,
  ): Promise<[ReadableStream<Uint8Array>, Headers]>;

  getMedia(): Promise<Media[]>;
}

// (isUserAuthorized / getServerId / getLibraries / refresh / enrichStills
// left this interface in audit 17's dead-code sweep: all five had zero
// production callers after the 0.4.0 plex teardown and 0.12.0 admin
// removal. Internal refresh/enrichment still run inside the anilist
// provider; they're just not a public surface.)
