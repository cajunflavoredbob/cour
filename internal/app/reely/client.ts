import { WebSocket } from 'ws';
import type {
  ClientMessage,
  CreateRoomError,
  CreateRoomRequest,
  JoinRoomError,
  JoinRoomRequest,
  ProviderType,
  ServerMessage,
  User,
  VerdictValue,
} from '../../../types/reely';
import {
  addRoom,
  createRoom,
  getRoom,
  hasRoom,
  NoMediaError,
  type Room,
  RoomExistsError,
  RoomLimitError,
  RoomNotFoundError,
  UsernameTakenError,
} from './room';
import { loadRoom, resolveRoomSeason, saveRoom } from './roomStore';
import {
  sanitizeRoomNameCanonical,
  sanitizeRoomNameDisplay,
} from './util/sanitize';
import { getConfig } from './config/main';
import {
  AlreadySubmittedError,
  type CourStore,
  type CourUser,
  MAX_USERNAME_LEN,
  MemberLockedError,
  NotLockedError,
  UsernameTakenError as CourUsernameTakenError,
} from '../cour/store';
import type { RouteContext } from './types';
import { logger } from './logger';

// Per-connection WebSocket message rate limit (fixed window). Generous enough
// for rapid swiping plus the burst of messages on room join, tight enough to
// blunt a flood (e.g. repeated createRoom). Messages over the cap are dropped.
const MSG_RATE_WINDOW_MS = 10_000;
const MSG_RATE_MAX = 100;

// Deadline for the collision liveness probe below. Comfortably covers a WAN
// ping round-trip without stalling a colliding join noticeably.
const SOCKET_PROBE_TIMEOUT_MS = 2000;

// Backstop cap on user rows, mirroring MAX_ROOMS (audit 17 M10). User
// rows are permanent identities -- the season-rotation reaper deletes
// rooms, never users -- so without a cap an unauthenticated visitor
// could mint rows forever (a slow-burn disk DoS within the message rate
// limit). Existing names always log in; only NEW identities are refused
// at the cap. Set far above any household/friend-group deployment.
const MAX_USERS = 2000;

// Probe a socket's liveness with a short-deadline ping. readyState catches
// sockets already closing; the ping round-trip catches half-open zombies
// (peer vanished without a FIN) that still report OPEN until the 30s ping
// sweep in app.ts notices the missed pong. (audit 16 #421)
const isSocketResponsive = (ws: WebSocket): Promise<boolean> =>
  new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    const onPong = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ws.off('pong', onPong);
      resolve(false);
    }, SOCKET_PROBE_TIMEOUT_MS);
    ws.once('pong', onPong);
    try {
      ws.ping();
    } catch {
      // OPEN -> CLOSING race between the check above and the ping call.
      clearTimeout(timer);
      ws.off('pong', onPong);
      resolve(false);
    }
  });

export class Client {
  ws: WebSocket;
  ctx: RouteContext;
  room?: Room;
  userName?: string;
  isLoggedIn = false;
  // The claimed identity (0.12.0: passwordless -- login just names it).
  // Room flows key off the userName it assigns; verdict/review/lockIn
  // require it.
  authedUser?: CourUser;

  // Fixed-window message rate limiting -- see MSG_RATE_* above.
  private msgWindowStart = Date.now();
  private msgCount = 0;
  private msgRateLogged = false;

  // True while a join/create is mid-flight (room load, media fetch, the
  // 2s liveness probe are all awaits). handleLogin refuses identity
  // switches in that window: its in-room gate only sees this.room, which
  // is still unset mid-join, and a login landing there would install
  // room membership under the OLD name while broadcasts and verdict
  // writes use the NEW one -- leaving a ghost member the disconnect
  // cleanup's identity guard can never evict.
  private joinInFlight = false;


  constructor(
    ws: WebSocket,
    providers: RouteContext['providers'],
    // Optional so the many test constructions (and any future headless
    // embedding) don't have to build stores; handlers that need a missing
    // store answer with an error rather than crashing.
    cour?: RouteContext['cour'],
  ) {
    this.ws = ws;
    this.ctx = { providers, cour };

    this.ws.on('message', (data) => this.handleRawMessage(data.toString()));
    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', (err) => logger.error(`WebSocket error: ${err.message}`));

    this.sendConfig();
  }

  private async sendConfig() {
    const config = getConfig();
    const requiresConfiguration = config.servers.length === 0;
    let serverName: string | undefined;
    let providerType: ProviderType | undefined;
    let season: { season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; year: number } | undefined;
    if (!requiresConfiguration && this.ctx.providers.length > 0) {
      const provider = this.ctx.providers[0];
      providerType = provider.type;
      // The served season rides the config frame so the UI labels and
      // themes from the server's season, never the browser clock (which
      // disagrees during the pre-season window and across rollovers).
      season = provider.getSeason?.();
      try {
        serverName = await provider.getName();
      } catch {
        // server name is optional; ignore fetch failures
      }
    }
    this.sendMessage({
      type: 'config',
      payload: {
        requiresConfiguration,
        ...(serverName ? { serverName } : {}),
        ...(providerType ? { providerType } : {}),
        ...(season ? { season: season.season, year: season.year } : {}),
      },
    });
  }

  // ── Identity (0.12.0: back to a bare name -- reely's model. The
  // credentialed system and its admin surface were stripped; verdicts
  // and locks stay durable because the user ROW persists in SQLite,
  // the credential never did anything a friend group needed.) ──

  /**
   * Adopting an identity: userName drives every room flow (join,
   * broadcast identity, collision checks). Switching identities while in
   * a room leaves it cleanly first.
   */
  private assumeIdentity(user: CourUser): void {
    if (this.userName && this.userName !== user.username) {
      const previousRoom = this.leaveRoomCleanup();
      if (previousRoom) void saveRoom(previousRoom);
    }
    this.authedUser = user;
    this.userName = user.username;
    this.isLoggedIn = true;
  }

  private courOr(errType: 'loginError' | 'verdictError' | 'reviewError' | 'lockInError' | 'skipRemainingError' | 'submitRankingsError' | 'resultsError'): CourStore | undefined {
    if (this.ctx.cour) return this.ctx.cour;
    this.sendMessage({
      type: errType,
      payload: { message: 'This server has no account storage.' },
    } as ClientMessage);
    return undefined;
  }

  private handleLogin(payload: unknown) {
    const cour = this.courOr('loginError');
    if (!cour) return;
    const raw = (payload as { userName?: unknown } | null)?.userName;
    if (typeof raw !== 'string') {
      this.sendMessage({ type: 'loginError', payload: { message: 'Invalid login payload.' } });
      return;
    }
    const userName = raw.trim();
    if (userName.length < 1 || userName.length > MAX_USERNAME_LEN) {
      this.sendMessage({
        type: 'loginError',
        payload: { message: `Names are 1 to ${MAX_USERNAME_LEN} characters.` },
      });
      return;
    }
    if (this.room || this.joinInFlight) {
      // Identity switches inside a room would corrupt the membership
      // maps; the client leaves first (the UI enforces this too). The
      // joinInFlight half closes the mid-join window, where this.room is
      // still unset across the join's awaits but membership is about to
      // be installed under the current name.
      this.sendMessage({
        type: 'loginError',
        payload: { message: 'Leave the room before switching names.' },
      });
      return;
    }
    // First sight creates the row (case-insensitive: the same name in any
    // casing is the same person); verdicts and locks hang off it forever.
    let user = cour.users.byName(userName);
    if (!user) {
      if (cour.users.count() >= MAX_USERS) {
        this.sendMessage({
          type: 'loginError',
          payload: { message: 'This server has reached its user limit.' },
        });
        return;
      }
      try {
        user = cour.users.create(userName);
      } catch (err) {
        // Two connections claiming the same NEW name at once: the loser's
        // INSERT hits the UNIQUE constraint. Re-resolve and proceed --
        // the same recovery the room-create path uses. The old path let
        // the error escape to a log line, so the losing client got
        // neither success nor error and hung on the wordmark forever
        // (audit 17 M11).
        if (!(err instanceof CourUsernameTakenError)) throw err;
        user = cour.users.byName(userName);
        if (!user) {
          this.sendMessage({
            type: 'loginError',
            payload: { message: 'Logging in failed. Please try again.' },
          });
          return;
        }
      }
    }
    this.assumeIdentity(user);
    this.sendMessage({ type: 'loginSuccess', payload: { userName: user.username } });
  }

  /** Shared gate for the verdict flow: store + identity + current room. */
  private verdictContext(
    errType: 'verdictError' | 'reviewError' | 'lockInError' | 'skipRemainingError' | 'submitRankingsError' | 'resultsError',
  ): { cour: CourStore; user: CourUser; roomId: number } | undefined {
    const cour = this.courOr(errType);
    if (!cour) return undefined;
    const user = this.authedUser;
    if (!user) {
      this.sendMessage({
        type: errType,
        payload: { message: 'Set your name first.' },
      } as ClientMessage);
      return undefined;
    }
    if (!this.room) {
      this.sendMessage({
        type: errType,
        payload: { message: 'Join a room first.' },
      } as ClientMessage);
      return undefined;
    }
    // Season comes from the provider via resolveRoomSeason -- the single
    // source of truth. This used to re-derive from config + the clock,
    // which drifts from a rotated (or rotation-lagged) provider.
    const season = resolveRoomSeason(this.ctx.providers);
    const courRoom = cour.rooms.byName(this.room.roomName) ?? cour.rooms.create({
      name: this.room.roomName,
      displayName: this.room.displayName,
      season: season.season,
      year: season.year,
      showSequels: getConfig().anime?.showSequels ?? false,
    });
    const isNewMember = cour.members.ensure(courRoom.id, user.id);
    if (isNewMember && this.room) {
      // A genuinely-new member changes every open review screen's
      // "N OF M LOCKED" line and the standings' WAITING ON list -- pulse
      // the OTHERS now instead of waiting for the next lock event
      // (audit v1.2.0 low). allLocked is false by construction: this
      // member's fresh row is unlocked, so no celebration can fire.
      this.room.broadcastMessage(
        {
          type: 'roomPulse',
          payload: { members: this.memberStates(cour, courRoom.id), allLocked: false },
        },
        this.userName,
      );
    }
    return { cour, user, roomId: courRoom.id };
  }

  private async handleVerdict(payload: unknown) {
    const ctx = this.verdictContext('verdictError');
    if (!ctx) return;
    const p = payload as { titleId?: unknown; verdict?: unknown } | null;
    const verdictOk = p?.verdict === 'like' || p?.verdict === 'dislike' || p?.verdict === 'skip';
    if (!p || typeof p.titleId !== 'number' || !Number.isInteger(p.titleId) || !verdictOk) {
      this.sendMessage({ type: 'verdictError', payload: { message: 'Invalid verdict payload.' } });
      return;
    }
    // The title must exist in this room's deck -- Media.id is the
    // stringified AniList id, verdicts key on the numeric form.
    const media = await (this.room as Room).media;
    if (!media.has(String(p.titleId))) {
      this.sendMessage({
        type: 'verdictError',
        payload: { message: 'That title is not in this room.' },
      });
      return;
    }
    try {
      ctx.cour.verdicts.upsert(ctx.user.id, ctx.roomId, p.titleId, p.verdict as VerdictValue);
      this.sendMessage({
        type: 'verdictSuccess',
        payload: { titleId: p.titleId, verdict: p.verdict as VerdictValue },
      });
    } catch (err) {
      const message = err instanceof MemberLockedError
        ? err.message
        : 'Recording the verdict failed. Please try again.';
      if (!(err instanceof MemberLockedError)) {
        logger.error(`verdict failed: ${String(err)}`);
      }
      this.sendMessage({ type: 'verdictError', payload: { message } });
    }
  }

  private async handleReview() {
    const ctx = this.verdictContext('reviewError');
    if (!ctx) return;
    const member = ctx.cour.members.get(ctx.roomId, ctx.user.id);
    const media = await (this.room as Room).media;
    // (deckPosition died in audit 17's dead-code sweep: the deck derives
    // its resume point from the verdict ledger, and nothing ever read
    // the persisted position.)
    // Scope the ledger to the CURRENT deck (audit 17 H7). Stored verdicts
    // can reference titles the deck no longer serves (filter changes,
    // upstream removals across a refresh); counting them against a total
    // drawn from the current media rendered "31 / 30 VERDICTS", negative
    // remaining, and a >100% progress fill. Orphan rows stay in the
    // database (a removed title can return) but never reach the wire.
    const verdicts = ctx.cour.verdicts
      .listFor(ctx.user.id, ctx.roomId)
      .filter((v) => media.has(String(v.titleId)));
    const counts: Record<VerdictValue, number> = { like: 0, dislike: 0, skip: 0 };
    for (const v of verdicts) counts[v.verdict] += 1;
    this.sendMessage({
      type: 'reviewSuccess',
      payload: {
        verdicts,
        counts,
        members: this.memberStates(ctx.cour, ctx.roomId),
        lockedAt: member?.lockedAt ?? null,
        total: media.size,
      },
    });
  }

  /** Hold-to-skip-all: one skip UPSERT per still-unverdicted title in the
   * room's deck. Refused after lock-in (the first upsert throws). */
  private async handleSkipRemaining() {
    const ctx = this.verdictContext('skipRemainingError');
    if (!ctx) return;
    const media = await (this.room as Room).media;
    const already = new Set(
      ctx.cour.verdicts.listFor(ctx.user.id, ctx.roomId).map((v) => v.titleId),
    );
    const remaining: number[] = [];
    for (const id of media.keys()) {
      const titleId = Number(id);
      if (!Number.isInteger(titleId) || already.has(titleId)) continue;
      remaining.push(titleId);
    }
    try {
      // One transaction (audit 17): the per-title upsert loop paid one
      // WAL commit per unverdicted title -- ~300 on a fresh season.
      ctx.cour.verdicts.skipAll(ctx.user.id, ctx.roomId, remaining);
      this.sendMessage({ type: 'skipRemainingSuccess', payload: { skipped: remaining.length } });
    } catch (err) {
      const message = err instanceof MemberLockedError
        ? err.message
        : 'Skipping the rest failed. Please try again.';
      if (!(err instanceof MemberLockedError)) {
        logger.error(`skipRemaining failed: ${String(err)}`);
      }
      this.sendMessage({ type: 'skipRemainingError', payload: { message } });
    }
  }

  private async handleLockIn() {
    const ctx = this.verdictContext('lockInError');
    if (!ctx) return;
    try {
      // Completeness is enforced HERE, not just by the client's disabled
      // button (audit 17 H7): the deck can grow under a stale client (a
      // background refresh adds a late announcement), which could lock a
      // member in without ever seeing the new titles -- and no unlock
      // exists. Re-locking while already locked stays idempotent so a
      // post-lock deck change can't error the lock-state readback.
      const member = ctx.cour.members.get(ctx.roomId, ctx.user.id);
      if (!member?.lockedAt) {
        const media = await (this.room as Room).media;
        const verdicted = new Set(
          ctx.cour.verdicts.listFor(ctx.user.id, ctx.roomId).map((v) => v.titleId),
        );
        let remaining = 0;
        for (const id of media.keys()) {
          if (!verdicted.has(Number(id))) remaining += 1;
        }
        if (remaining > 0) {
          this.sendMessage({
            type: 'lockInError',
            payload: {
              message: `${remaining} title${remaining === 1 ? '' : 's'} still need a verdict before you can lock in.`,
            },
          });
          return;
        }
      }
      // Membership rows are created lazily on the first verdict-flow
      // message, so allLocked used to fire prematurely: a partner who
      // joined but hadn't verdicted yet had no row to count (audit 17).
      // Ensure a row for every CONNECTED identity in the room before
      // computing the edge.
      for (const memberClient of (this.room as Room).users.values()) {
        const memberUser = memberClient.authedUser;
        if (memberUser) ctx.cour.members.ensure(ctx.roomId, memberUser.id);
      }
      const { lockedAt, allLocked, justLocked } = ctx.cour.members.lock(ctx.roomId, ctx.user.id);
      // No tally here anymore (0.13.0): scoring IS the post-lock ranking;
      // standings compute on demand from submitted rankings.
      // Edge-gated (allLocked && justLocked): a retried lockIn reports
      // the room as locked=false so the celebration toast fires once.
      const roomLocked = allLocked && justLocked;
      if (roomLocked) {
        logger.info(`room ${ctx.roomId} fully locked -- ranking phase open`);
      }
      this.sendMessage({
        type: 'lockInSuccess',
        payload: { lockedAt, roomLocked },
      });
      // Live room pulse (audit 17 UX item 3): the OTHER members' review
      // screens update their "N OF M LOCKED" line, and the all-locked
      // celebration reaches everyone -- the locker's own arrives via
      // lockInSuccess.roomLocked above, so exclude them here (no double
      // toast).
      if (justLocked && this.room) {
        this.room.broadcastMessage(
          {
            type: 'roomPulse',
            payload: {
              members: this.memberStates(ctx.cour, ctx.roomId),
              allLocked,
            },
          },
          this.userName,
        );
      }
    } catch (err) {
      logger.error(`lockIn failed: ${String(err)}`);
      this.sendMessage({
        type: 'lockInError',
        payload: { message: 'Locking in failed. Please try again.' },
      });
    }
  }

  /** The shared per-member state payload (audit 17 UX items 3/7/11):
   * one shape feeds the review screen's room pulse, the standings'
   * FINAL / "WAITING ON" line, and the roomPulse push. */
  private memberStates(cour: CourStore, roomId: number) {
    return cour.members.list(roomId).map((m) => ({
      userName: m.username,
      locked: m.lockedAt != null,
      submitted: m.submittedAt != null,
    }));
  }

  /** Per-member results payload: shared standings + their own state. */
  private buildResults(cour: CourStore, roomId: number, userId: number) {
    const progress = cour.rankings.progress(roomId);
    // Names per title (who-ranked-what): one query, attached per row.
    const namesByTitle = new Map<number, string[]>();
    for (const r of cour.rankings.rankersByTitle(roomId)) {
      const names = namesByTitle.get(r.titleId) ?? [];
      names.push(r.userName);
      namesByTitle.set(r.titleId, names);
    }
    return {
      submittedCount: progress.submitted,
      memberCount: progress.members,
      members: this.memberStates(cour, roomId),
      mySubmitted: cour.rankings.hasSubmitted(userId, roomId),
      myRanking: cour.rankings.forUser(userId, roomId),
      standings: cour.rankings.standings(roomId).map((row) => ({
        ...row,
        rankedByNames: namesByTitle.get(row.titleId) ?? [],
      })),
      topPicks: cour.rankings.topPicks(roomId),
    };
  }

  private async handleSubmitRankings(payload: unknown) {
    const ctx = this.verdictContext('submitRankingsError');
    if (!ctx) return;
    const raw = (payload as { rankedTitleIds?: unknown } | null)?.rankedTitleIds;
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'number')) {
      this.sendMessage({
        type: 'submitRankingsError',
        payload: { message: 'Invalid rankings payload.' },
      });
      return;
    }
    // The submitted order must be exactly a permutation of the member's
    // LIKED titles IN THE CURRENT DECK: dislikes and skips never rank,
    // nothing liked can be silently dropped (an accidental partial
    // submit would score wrong forever -- there are no resubmits), and
    // orphaned likes for titles no longer served must not rank either
    // (they rendered as poster-less "#154768" standings rows soaking up
    // points; audit 17 H7). Mirrors handleReview's ledger scoping, so
    // the client's editor and this check see the same set.
    const media = await (this.room as Room).media;
    const likes = new Set(
      ctx.cour.verdicts
        .listFor(ctx.user.id, ctx.roomId)
        .filter((v) => v.verdict === 'like' && media.has(String(v.titleId)))
        .map((v) => v.titleId),
    );
    const submitted = new Set(raw);
    const isPermutation =
      submitted.size === raw.length &&
      submitted.size === likes.size &&
      raw.every((id) => likes.has(id));
    if (!isPermutation) {
      this.sendMessage({
        type: 'submitRankingsError',
        payload: { message: 'Rankings must order exactly your Kept titles.' },
      });
      return;
    }
    try {
      ctx.cour.rankings.submit(ctx.user.id, ctx.roomId, raw);
    } catch (err) {
      const message = err instanceof NotLockedError || err instanceof AlreadySubmittedError
        ? err.message
        : 'Submitting rankings failed. Please try again.';
      if (!(err instanceof NotLockedError) && !(err instanceof AlreadySubmittedError)) {
        logger.error(`submitRankings failed: ${String(err)}`);
      }
      this.sendMessage({ type: 'submitRankingsError', payload: { message } });
      return;
    }
    this.sendMessage({ type: 'submitRankingsSuccess' });
    // Live standings: every connected room member gets a fresh payload
    // (their own mySubmitted/myRanking, the shared standings), so open
    // results screens update the moment anyone submits.
    if (this.room) {
      for (const memberClient of this.room.users.values()) {
        const memberUser = memberClient.authedUser;
        if (!memberUser) continue;
        memberClient.sendMessage({
          type: 'resultsSuccess',
          payload: this.buildResults(ctx.cour, ctx.roomId, memberUser.id),
        });
      }
    }
  }

  private handleResults() {
    const ctx = this.verdictContext('resultsError');
    if (!ctx) return;
    this.sendMessage({
      type: 'resultsSuccess',
      payload: this.buildResults(ctx.cour, ctx.roomId, ctx.user.id),
    });
  }

  private async handleRawMessage(messageText: string) {
    if (this.ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (now - this.msgWindowStart >= MSG_RATE_WINDOW_MS) {
      this.msgWindowStart = now;
      this.msgCount = 0;
      this.msgRateLogged = false;
    }
    this.msgCount += 1;
    if (this.msgCount > MSG_RATE_MAX) {
      // Log once per window so a flood can't also flood the log.
      if (!this.msgRateLogged) {
        this.msgRateLogged = true;
        logger.warn(
          `WebSocket message rate limit exceeded (${MSG_RATE_MAX} per ${MSG_RATE_WINDOW_MS}ms); dropping further messages this window.`,
        );
      }
      return;
    }

    let message: ServerMessage;
    try {
      message = JSON.parse(messageText);
    } catch (err) {
      logger.error(`Failed to parse message: ${messageText} -- ${String(err)}`);
      return;
    }
    // Shape-guard (audit v1.2.0 low): JSON.parse("null") succeeds, and a
    // null/typeless frame used to throw in the switch AND AGAIN in the
    // catch below (message.type on null) -- an unhandled rejection.
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      logger.warn(`Dropping WS frame with unexpected shape: ${messageText.slice(0, 120)}`);
      return;
    }

    try {
      switch (message.type) {
        case 'createRoom': await this.handleCreateRoom(message.payload); break;
        case 'joinRoom': await this.handleJoinRoom(message.payload); break;
        case 'joinOrCreateRoom': await this.handleJoinOrCreateRoom(message.payload); break;
        case 'leaveRoom': this.handleLeaveRoom(); break;
        case 'login': this.handleLogin(message.payload); break;
        case 'verdict': await this.handleVerdict(message.payload); break;
        case 'review': await this.handleReview(); break;
        case 'lockIn': await this.handleLockIn(); break;
        case 'skipRemaining': await this.handleSkipRemaining(); break;
        case 'submitRankings': await this.handleSubmitRankings(message.payload); break;
        case 'results': this.handleResults(); break;
        default: logger.info(`Unhandled message: ${messageText}`);
      }
    } catch (err) {
      logger.error(`Error handling ${message?.type}: ${String(err)}`);
    }
  }

  getUsername() {
    return this.userName;
  }

  getUser(): User {
    // Explicit check rather than `getUsername()!`. The non-null assertion
    // was correct under the intended call pattern (only invoked from
    // handlers that gate on isLoggedIn), but it relied on an out-of-band
    // invariant -- and the type system can't enforce it. Throwing here
    // surfaces a violation cleanly instead of synthesizing a User with
    // `userName: undefined as string`, which would propagate through
    // broadcasts as the literal string "undefined".
    const userName = this.getUsername();
    if (!userName) {
      throw new Error('getUser() called without a logged-in user');
    }
    return { userName };
  }

  // Shared sanitize step for room requests. Derives the canonical (lowercased,
  // allowlist-stripped) name + the display (case-preserved) form from the
  // user-typed input. Idempotent, but we still want to call it exactly once
  // per inbound request so the join-or-create path doesn't double up.
  private sanitizeRoomReq<T extends { roomName: string }>(req: T): T & { displayName: string } {
    return {
      ...req,
      roomName: sanitizeRoomNameCanonical(req.roomName),
      displayName: sanitizeRoomNameDisplay(req.roomName),
    };
  }

  // Untrusted-payload guard for room requests. Validates that `req` has a
  // string roomName, runs sanitizeRoomReq, and confirms the canonical form
  // is non-empty. On failure sends the appropriate error response (createRoom
  // or join flavor) and returns undefined; on success returns the sanitized +
  // display-named form. Audit 15 #372 consolidated three near-identical guard
  // blocks across handleCreateRoom + handleJoinRoom + handleJoinOrCreateRoom
  // into this single helper. (handleLogin's similar-shape userName validation
  // stays inline -- its sanitize function, error vocabulary, and field name
  // diverge enough that a fully generic helper would have more params than
  // the call sites.)
  private validateRoomRequest<T extends { roomName: string }>(
    req: T,
    errorType: 'createRoomError' | 'joinRoomError',
  ): (T & { displayName: string }) | undefined {
    const sendError = (message: string) => {
      if (errorType === 'createRoomError') {
        this.sendMessage({
          type: 'createRoomError',
          payload: { name: 'InvalidRoomNameError', message },
        });
      } else {
        this.sendMessage({
          type: 'joinRoomError',
          payload: { name: 'RoomNotFoundError', message },
        });
      }
    };
    if (!req || typeof req.roomName !== 'string') {
      sendError('Room name must not be empty.');
      return undefined;
    }
    const sanitized = this.sanitizeRoomReq(req);
    if (!sanitized.roomName) {
      sendError('Room name must not be empty.');
      return undefined;
    }
    return sanitized;
  }

  // Inner create path. Pre: sanitizedReq.roomName is non-empty and already
  // sanitized; userName is set. Throws on any failure (RoomExistsError,
  // NoMediaError, etc.) so callers can branch on error type.
  private async createRoomFromSanitized(
    sanitizedReq: CreateRoomRequest,
    userName: string,
  ): Promise<void> {
    const room = await createRoom(sanitizedReq, this.ctx);
    // Same mid-await close guard as joinRoomFromSanitized (audit 17): a
    // socket that died during createRoom's fetch must not be installed
    // as a ghost member. The room itself stays created -- it's
    // persisted and joinable like any other.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // A crafted client can send createRoom while already in a room; the
    // standard frontend always leaves first. Without this cleanup the old
    // room keeps a ghost users entry that locks the username there until
    // restart. Runs after createRoom so a failed create leaves the current
    // membership untouched. (audit 16 #422)
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
    this.sendMessage({
      type: 'createRoomSuccess',
      payload: {
        roomName: room.roomName,
        displayName: room.displayName,
        media: await room.getMedia(),
        users: room.getUsers(),
      },
    });
  }

  // Inner join path. Pre: sanitizedReq.roomName is non-empty and already
  // sanitized; userName is set. Throws on failure.
  private async joinRoomFromSanitized(
    sanitizedReq: JoinRoomRequest,
    userName: string,
  ): Promise<void> {
    if (!hasRoom(sanitizedReq.roomName)) {
      const loaded = await loadRoom(sanitizedReq.roomName, this.ctx);
      // Re-check after the await: another client may have loaded the same room concurrently.
      if (loaded && !hasRoom(sanitizedReq.roomName)) addRoom(loaded);
    }

    const room = getRoom(sanitizedReq.roomName);
    // 0.5.22: reject same-username-different-connection collisions at the
    // room boundary so a second device picks a new name instead of silently
    // displacing the first (prior behavior left the displaced client
    // dead-looking + the active one in a rate-storm-prone state). `=== this`
    // is the re-join-in-same-session case (legitimate; just refresh the
    // slot).
    //
    // this.room is assigned only after the collision check passes: a
    // rejected joiner must not keep a reference to a room it never entered
    // (audit 16 #419 -- the reference let a follow-up login-rename wipe the
    // active user's userProgress via leaveRoomCleanup's returned room, and
    // let the non-member apply filters to the room).
    const existing = room.users.get(userName);
    if (existing && existing !== this) {
      // Liveness probe (audit 16 #421): after an unclean drop (phone sleep,
      // network switch) the stale Client holds the name with an OPEN-looking
      // socket until the ping sweep terminates it (up to ~60s), blocking the
      // same user's own auto-rejoin. Only a demonstrably live holder rejects
      // the join; a dead one is displaced like the pre-0.5.22 behavior.
      const responsive = await isSocketResponsive(existing.ws);
      // Re-check after the await: the holder may have closed and cleaned
      // itself up meanwhile, or a different connection may have taken the
      // slot (a fresh join implies liveness -- reject without re-probing).
      const holder = room.users.get(userName);
      if (holder && holder !== this) {
        if (holder !== existing || responsive) {
          throw new UsernameTakenError(
            `"${userName}" is already in this room. Pick a different name.`,
          );
        }
        // Dead holder: displace it. terminate() emits its close event on a
        // later tick -- after users.set below has replaced the slot -- so
        // the old client's leaveRoomCleanup identity guard skips the
        // eviction/broadcast (same shape as the soft-refresh race).
        holder.ws.terminate();
      }
    }
    // The awaits above (room load, liveness probe) can outlast this
    // connection: if the socket closed mid-join, handleClose has already
    // run -- with no room set, it cleaned nothing -- and will never run
    // again. Installing `this` now would park a dead client in
    // room.users, holding the name hostage until a liveness probe
    // displaces it (audit 17). Abort; there is nobody to answer.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // A crafted client can join while already in a different room; the
    // standard frontend always leaves first. Without this cleanup the old
    // room keeps a ghost users entry that locks the username there until
    // restart. Runs after the collision check so a rejected join leaves
    // the current membership untouched. (audit 16 #422)
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
    this.sendMessage({
      type: 'joinRoomSuccess',
      payload: {
        roomName: room.roomName,
        displayName: room.displayName,
        media: await room.getMedia(),
        users: room.getUsers(),
      },
    });

    room.notifyJoin(this.getUser());
  }

  private emitJoinError(err: unknown) {
    // joinOrCreateRoom's disk-load path can throw RoomLimitError from
    // addRoom -- the comment at the call site acknowledges this. Without
    // an allowlist entry here, the user saw the generic "unexpected
    // error" copy instead of the real "room limit reached" message.
    // emitCreateError already covers RoomLimitError; mirror it here
    // (audit 11 #177). JoinRoomError's name union was widened to
    // carry RoomLimitError in 0.4.9.
    let name: JoinRoomError['name'];
    let message: string;
    if (err instanceof RoomNotFoundError) {
      name = 'RoomNotFoundError';
      message = err.message;
    } else if (err instanceof RoomLimitError) {
      name = 'RoomLimitError';
      message = err.message;
    } else if (err instanceof UsernameTakenError) {
      name = 'UsernameTakenError';
      message = err.message;
    } else {
      name = 'UnknownError';
      message = 'An unexpected error occurred while joining the room. Please try again.';
    }
    this.sendMessage({ type: 'joinRoomError', payload: { name, message } });
  }

  private emitCreateError(err: unknown) {
    const isKnownError =
      err instanceof RoomExistsError ||
      err instanceof RoomLimitError ||
      err instanceof NoMediaError;
    // Only a known error's name is a valid CreateRoomError name -- the
    // instanceof check above guarantees that, so the cast is sound. An
    // unknown error (TypeError, plain Error) maps to UnknownError rather
    // than leaking an arbitrary err.name outside the protocol's union.
    const name: CreateRoomError['name'] = isKnownError
      ? ((err as Error).name as CreateRoomError['name'])
      : 'UnknownError';
    const message = isKnownError
      ? (err as Error).message
      : 'An unexpected error occurred while creating the room. Please try again.';
    this.sendMessage({ type: 'createRoomError', payload: { name, message } });
    logger.error(String(err));
  }

  private async handleCreateRoom(createRoomReq: CreateRoomRequest) {
    const userName = this.getUsername();
    if (!userName) {
      this.sendMessage({
        type: 'createRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must be logged in to create a room.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(createRoomReq, 'createRoomError');
    if (!sanitizedReq) return;
    this.joinInFlight = true;
    try {
      await this.createRoomFromSanitized(sanitizedReq, userName);
    } catch (err) {
      this.emitCreateError(err);
    } finally {
      this.joinInFlight = false;
    }
  }

  private async handleJoinRoom(joinRoomReq: JoinRoomRequest) {
    if (!this.isLoggedIn) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must log in before joining a room.' },
      });
      return;
    }
    const userName = this.getUsername();
    if (!userName) {
      // Defensive: isLoggedIn should imply userName is set.
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'UnknownError', message: 'Inconsistent login state.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(joinRoomReq, 'joinRoomError');
    if (!sanitizedReq) return;
    this.joinInFlight = true;
    try {
      await this.joinRoomFromSanitized(sanitizedReq, userName);
    } catch (err) {
      this.emitJoinError(err);
    } finally {
      this.joinInFlight = false;
    }
  }

  // Single-button "start screening" flow: join if the room exists, create if
  // not. Replaces the older client pattern of speculatively joining and then
  // auto-creating on RoomNotFoundError -- one round-trip, no swallowed errors.
  // Sanitizes the inbound request once and hands the cleaned payload to the
  // inner join/create methods (which would otherwise re-sanitize redundantly).
  private async handleJoinOrCreateRoom(req: JoinRoomRequest) {
    if (!this.isLoggedIn) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must log in before joining a room.' },
      });
      return;
    }
    const userName = this.getUsername();
    if (!userName) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'UnknownError', message: 'Inconsistent login state.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(req, 'joinRoomError');
    if (!sanitizedReq) return;

    // Probe the in-memory and on-disk room indexes; take the join path if
    // found, otherwise try create. A RoomExistsError from the create branch
    // is a race -- another client created the room between our probe and our
    // attempt -- and we recover by retrying as a join. The probe is inside
    // the try so a RoomLimitError from addRoom (disk-load past MAX_ROOMS)
    // surfaces as a proper error response instead of an unhandled throw.
    let exists = hasRoom(sanitizedReq.roomName);
    this.joinInFlight = true;
    try {
      if (!exists) {
        const loaded = await loadRoom(sanitizedReq.roomName, this.ctx);
        if (loaded) {
          if (!hasRoom(sanitizedReq.roomName)) addRoom(loaded);
          exists = true;
        }
      }
      if (exists) {
        await this.joinRoomFromSanitized(sanitizedReq, userName);
      } else {
        await this.createRoomFromSanitized(sanitizedReq, userName);
      }
    } catch (err) {
      if (err instanceof RoomExistsError) {
        // Lost the create race -- another client got there first. Retry as join.
        logger.debug(`joinOrCreate: create lost a race for "${sanitizedReq.roomName}", retrying as join`);
        try {
          await this.joinRoomFromSanitized(sanitizedReq, userName);
        } catch (joinErr) {
          this.emitJoinError(joinErr);
        }
      } else if (exists) {
        this.emitJoinError(err);
      } else {
        this.emitCreateError(err);
      }
    } finally {
      this.joinInFlight = false;
    }
  }

  // Evict this client from the room and notify the rest, if applicable. Pure
  // cleanup -- no message is sent back to the leaving client. Safe to call
  // from handleClose where the socket is already closed.
  //
  // Returns the room this client was evicted from (or undefined if it wasn't
  // in one) so callers can decide what to do with the prior room reference --
  // mutate userProgress on a rename, save it on disconnect, etc. Audit 15
  // #376: before that batch the method returned `boolean` and handleClose's
  // `if (this.room) saveRoom(...)` follow-up was dead because leaveRoomCleanup
  // had already cleared this.room. Returning the Room reference surfaces it
  // before the detach so the disconnect-time save actually fires now.
  private leaveRoomCleanup(): Room | undefined {
    const userName = this.getUsername();
    const room = this.room;
    if (!room || !userName) return undefined;
    // Only mutate the room if this client is still the active connection for
    // this username. If the user reconnected (e.g. soft refresh) before the
    // old WS close event fired, the new Client has already replaced this entry
    // and we must not evict it or broadcast a spurious leave.
    if (room.users.get(userName) === this) {
      room.users.delete(userName);
      room.notifyLeave(this.getUser());
    }
    // Detach this.room regardless of the active-connection check: this
    // Client is leaving by request, so later handlers must not keep
    // mutating the old room through a stale reference.
    this.room = undefined;
    return room;
  }

  private handleLeaveRoom() {
    if (this.leaveRoomCleanup()) {
      this.sendMessage({ type: 'leaveRoomSuccess' });
    } else {
      this.sendMessage({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED' } });
    }
  }

  private handleClose() {
    logger.info(`${this.getUsername() ?? 'Unknown user'} disconnected.`);
    // Use the cleanup-only path: the socket is already closed, so emitting
    // leaveRoomSuccess would just produce a noisy "tried to send to a
    // disconnected client" warning on every clean disconnect. Capture the
    // prior room from the helper's return so the save below actually runs
    // -- before audit 15 #376 this method called leaveRoomCleanup() (which
    // sets this.room = undefined on success) and then checked
    // `if (this.room) saveRoom(...)` -- always false; the disconnect-time
    // save never fired.
    const previousRoom = this.leaveRoomCleanup();
    if (previousRoom) void saveRoom(previousRoom);
  }

  // Beyond this much queued outbound data the WS is unhealthy -- either the
  // client is stuck or the network is fully congested. Terminate and let the
  // client auto-reconnect to re-sync state cleanly instead of buffering
  // unboundedly server-side.
  private static readonly MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

  // Server-initiated disconnect (room eviction). A plain close is enough:
  // the browser client auto-reconnects on ANY close and its login flow
  // rejoins the remembered room, which either rebuilds the room against
  // the current provider snapshot or surfaces the honest join error.
  // Without this, a client attached to an evicted room keeps verdicting
  // against the orphaned in-memory deck while verdictContext resurrects
  // the DB row under the new season (see app.ts pushMediaToOpenRooms).
  // 1012 = Service Restart: "server is going away, reconnect is expected".
  disconnect(): void {
    this.ws.close(1012, 'room evicted');
  }

  sendMessage(msg: ClientMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  // Pre-stringified path used by Room.broadcastMessage so a single payload
  // is encoded once and forwarded to N users instead of re-encoded per user
  // (audit 12 #201). The connection-state + backpressure guards are
  // identical to sendMessage.
  sendRaw(json: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Tried to send message to a disconnected client');
      return;
    }
    if (this.ws.bufferedAmount > Client.MAX_BUFFERED_BYTES) {
      logger.warn(
        `Terminating WS for ${this.getUsername() ?? 'unknown'} due to send-buffer backpressure (${this.ws.bufferedAmount} bytes queued)`,
      );
      this.ws.terminate();
      return;
    }
    this.ws.send(json);
  }
}
