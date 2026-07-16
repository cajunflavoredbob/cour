/**
 * Shared API interfaces between the frontend and backend.
 *
 * 0.4.0 teardown note: the swipe/match-era vocabulary (rate, match,
 * userProgress, Plex identity fields) is gone. The verdict/lock-in
 * vocabulary arrives with the 0.5.0 protocol pivot; mid-arc the wire
 * carries login + rooms + filters + media only.
 */

export interface BasicAuth {
  userName: string;
  password: string;
}

export interface Config {
  hostname: string;
  port: number;
  logLevel: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  rootPath: string;
  servers: Array<{
    type?: "anilist";
    url: string;
  }>;
  // AniList provider tuning.
  anime?: {
    // Broadcast season + year to serve. Setting EITHER pins the snapshot
    // and disables the automatic rotation; when both are absent the
    // served season auto-rotates one month ahead of the calendar
    // changeover (servedSeason's contract).
    // Env: ANIME_SEASON / ANIME_YEAR.
    season?: "WINTER" | "SPRING" | "SUMMER" | "FALL";
    year?: number;
    // Sequels (entries with a PREQUEL relation on AniList) are hidden from
    // the deck by default -- the picker's purpose is finding NEW shows.
    // Env: ANIME_SHOW_SEQUELS. A per-room toggle layers on top later.
    showSequels?: boolean;
    // Where the seasonal snapshot is persisted across restarts. Defaults to
    // <cwd>/data/anilist, next to the SQLite database.
    // Env: ANIME_CACHE_DIR.
    cacheDir?: string;
    // TMDB API key for screenshot enrichment (0.12.0: static config --
    // the runtime settings dialog died with the admin surface).
    // Env: TMDB_API_KEY.
    tmdbApiKey?: string;
  };
  basicAuth?: BasicAuth;
  tlsConfig?: {
    certFile: string;
    keyFile: string;
  };
  // Extra WebSocket Origin values to accept beyond same-origin. Needed when
  // a reverse proxy serves cour under an external origin that differs from
  // the internal Host header. Env: ALLOWED_ORIGINS (comma-separated).
  allowedOrigins?: string[];
}

// Messages intended for the Server
export type ServerMessage =
  | { type: "createRoom"; payload: CreateRoomRequest }
  | { type: "joinRoom"; payload: JoinRoomRequest }
  | { type: "joinOrCreateRoom"; payload: JoinRoomRequest }
  | { type: "leaveRoom" }
  // Claim an identity (0.12.0: back to reely's model -- a name, no
  // password; the owner's call after the recommendation-engine framing was
  // dropped). Creates the user on first sight; verdicts and locks stay
  // persistent because the user ROW is persistent, the credential isn't.
  // Refused while in a room (leave first).
  | { type: "login"; payload: { userName: string } }
  // Verdict on a title in the current room. Idempotent UPSERT -- also the
  // review screen's tap-to-change path. Rejected after lock-in.
  | { type: "verdict"; payload: VerdictRequest }
  // The verdict ledger for the current room (review screen payload).
  | { type: "review" }
  // Lock this member's verdicts in. When the last member locks, the
  // server tallies and stores the room's results.
  | { type: "lockIn" }
  // Hold-to-skip-all (design section 04): one call skips every title the
  // user hasn't verdicted yet. One message, not N -- the WS rate limit
  // (100/10s) would eat a per-title storm.
  | { type: "skipRemaining" }
  // Post-lock ranking (0.13.0, the couple-profile method): submit the
  // final order of YOUR liked titles, rank 1 first. One shot -- no
  // resubmits. Dislikes and skips never rank and never score.
  | { type: "submitRankings"; payload: { rankedTitleIds: number[] } }
  // The room's combined standings + this member's submission state.
  | { type: "results" };

// Messages intended for the UI
export type ClientMessage =
  | { type: "createRoomError"; payload: CreateRoomError }
  | { type: "createRoomSuccess"; payload: JoinRoomSuccess }
  | { type: "joinRoomError"; payload: JoinRoomError }
  | { type: "joinRoomSuccess"; payload: JoinRoomSuccess }
  | { type: "leaveRoomSuccess" }
  | { type: "leaveRoomError"; payload: LeaveRoomError }
  | { type: "config"; payload: AppConfig }
  | { type: "userJoinedRoom"; payload: User }
  | { type: "userLeftRoom"; payload: User }
  | { type: "filterChangeApplied"; payload: { appliedBy: string; media: Media[]; filters: Filter[] } }
  | { type: "loginSuccess"; payload: { userName: string } }
  | { type: "loginError"; payload: { message: string } }
  | { type: "verdictSuccess"; payload: { titleId: number; verdict: VerdictValue } }
  | { type: "verdictError"; payload: { message: string } }
  | { type: "reviewSuccess"; payload: ReviewPayload }
  | { type: "reviewError"; payload: { message: string } }
  | { type: "lockInSuccess"; payload: { lockedAt: number; roomLocked: boolean } }
  // PUSHED to the other room members when someone locks in: live room
  // pulse for open review screens, and the all-locked celebration for
  // everyone (the locker's own arrives via lockInSuccess.roomLocked).
  | { type: "roomPulse"; payload: { members: RoomMemberState[]; allLocked: boolean } }
  | { type: "lockInError"; payload: { message: string } }
  | { type: "skipRemainingSuccess"; payload: { skipped: number } }
  | { type: "skipRemainingError"; payload: { message: string } }
  | { type: "submitRankingsSuccess" }
  | { type: "submitRankingsError"; payload: { message: string } }
  // Also PUSHED to every connected room member when someone submits, so
  // open results screens update live.
  | { type: "resultsSuccess"; payload: RankingResults }
  | { type: "resultsError"; payload: { message: string } };

// Configure message

// Provider types implemented in this codebase. cour is anime-only (0.4.0);
// the union stays as an extension point for hypothetical future sources.
export type ProviderType = "anilist";

export interface AppConfig {
  requiresConfiguration: boolean;
  serverName?: string;
  providerType?: ProviderType;
  // The broadcast season the server is SERVING (rotates one month ahead
  // of the calendar changeover). The UI prefers this over its own clock
  // for theming and labels; absent only when no server is configured.
  season?: "WINTER" | "SPRING" | "SUMMER" | "FALL";
  year?: number;
}

export type VerdictValue = "like" | "dislike" | "skip";

// Per-member room state, shared by the review payload, the results
// payload, and the roomPulse push (audit 17 UX items 3/7/11): the review
// screen's "2 OF 4 LOCKED" pulse, the standings' FINAL / "WAITING ON"
// line, and who-ranked-what all read this one shape.
export interface RoomMemberState {
  userName: string;
  locked: boolean;
  submitted: boolean;
}

export interface VerdictRequest {
  // Media.id is the stringified AniList id; verdicts key on the numeric form.
  titleId: number;
  verdict: VerdictValue;
}

export interface RankingStanding {
  titleId: number;
  // Couple-profile points: #1=12 #2=9 #3=6 #4=3 #5=1 per submitter.
  points: number;
  // The single best rank any submitter gave it (the tiebreaker).
  bestRank: number;
  rankedBy: number;
  // Who ranked it (any position), ordered by name -- "RANKED BY 2" was
  // anonymous (audit 17 UX item 7).
  rankedByNames: string[];
  rank: number;
}

export interface RankingResults {
  submittedCount: number;
  memberCount: number;
  // Per-member lock/submit state (drives FINAL / "WAITING ON <names>").
  members: RoomMemberState[];
  mySubmitted: boolean;
  // This member's own submitted order (empty until they submit).
  myRanking: number[];
  standings: RankingStanding[];
  // Each submitted member's #1 pick (rank 1) with their name -- the
  // "everyone's favorite" strip, shown regardless of the pick's
  // combined position. (A first step toward full who-picked-what.)
  topPicks: Array<{ userName: string; titleId: number }>;
}

export interface ReviewPayload {
  verdicts: Array<{ titleId: number; verdict: VerdictValue; updatedAt: number }>;
  counts: Record<VerdictValue, number>;
  // Per-member lock/submit state (the review screen's room pulse).
  members: RoomMemberState[];
  lockedAt: number | null;
  // Deck size at review time, for the "32 / 90 verdicts" header math.
  total: number;
}

// The room-facing identity: what other members see in broadcasts. Since
// 0.6.0 it always mirrors an authenticated account's username.
export interface User {
  userName: string;
}

// Create Room

export interface Filter {
  key: string;
  operator: string;
  value: string[];
}

export interface CreateRoomRequest {
  // Canonical (lowercased, allowlist-stripped) room name. Used as Map key,
  // filename, and URL parameter value.
  roomName: string;
  // Display form -- preserves case for UI rendering.
  displayName?: string;
  filters?: Filter[];
}

export interface CreateRoomError {
  name:
    | "RoomExistsError"
    | "RoomLimitError"
    | "UnauthorizedError"
    | "NotLoggedInError"
    | "NoMediaError"
    | "InvalidRoomNameError"
    | "UnknownError";
  message: string;
}

// Join

export interface JoinRoomRequest {
  roomName: string;
}

export interface JoinRoomError {
  name:
    | "RoomNotFoundError"
    | "RoomLimitError"
    // The requested userName is in use by another live connection in
    // this room. The UI shows the message verbatim.
    | "UsernameTakenError"
    | "NotLoggedInError"
    | "UnknownError";
  message: string;
}

export interface JoinRoomSuccess {
  // The server-sanitized canonical room name -- clients adopt this as
  // authoritative over the user-typed input.
  roomName?: string;
  // Display form of the room name (case preserved).
  displayName?: string;
  media: Media[];
  users: User[];
  filters?: Filter[];
}

// Leave

export interface LeaveRoomError {
  errorType: "NOT_JOINED"; // Can't leave a room you're not in
}

// In-Room

export interface Media {
  id: string;
  // Always "anime" since the 0.4.0 plex teardown. Kept on the wire as a
  // discriminator so future non-seasonal decks stay possible.
  type: "anime";
  title: string;
  description: string;
  tagline?: string;
  year?: number;
  posterUrl?: string;
  genres: string[];
  // Optional: an AniList entry can legitimately omit these.
  duration?: number;
  rating?: number;
  contentRating?: string;
  anilistId?: number;
  malId?: number;
  // Deck presentation fields (0.7.0): romaji secondary line, broadcast
  // format, episode count, and main studio for the meta line.
  titleRomaji?: string;
  format?: string;
  episodes?: number;
  studio?: string;
  // Proxied TMDB backdrop stills (0.9.0) for the drawer's thumbnail
  // strip. Same-origin /api/poster paths -- the CSP img-src stays 'self'.
  screenshotUrls?: string[];
  // site is AniList's trailer host discriminator ("youtube" /
  // "dailymotion"); id is the host-local video id. Rendering lands with
  // the deck/drawer screens (0.7.0).
  trailer?: { site: string; id: string };
}

// (The Filters/FilterValue/FilterValueRequest/Library vocabulary died
// with the filter panel in audit 17's strip: cour deals the whole
// season, simple. `Filter` below survives -- legacy room rows may carry
// creation-time filters until the rotation reaper clears them, and the
// filterChangeApplied push reuses its shape.)
