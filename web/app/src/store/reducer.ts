import type { Toast } from "../components/atoms/Toast";
import type { Actions, Store } from "./types";

// Auto-dismiss delay for error toasts (audit 12 #241). Without an explicit
// showTimeMs the toast persists until the user manually dismisses it,
// which piles up failure messages forever on a flaky connection. The
// connection-failure toast is intentionally NOT given a TTL -- it's
// cleared explicitly when the WS reconnects.
const ERROR_TOAST_MS = 5000;

// crypto.randomUUID() is only defined in secure contexts (https/localhost).
// reely's intended LAN deployment is plain http://192.168.x.x:8000, where
// the call throws TypeError. Use a per-Store counter + random suffix as a
// safe fallback: uniqueness only matters within the React tree, not
// cross-session.
//
// 0.4.46 (audit 13 #328): moved from a module-scope `let` to a counter on
// the Store. The reducer is now pure -- each Store instance keeps its own
// counters. The mintToastId helper is a pure function of the counter.
const mintToastId = (counter: number): string =>
  `toast-${counter}-${Math.random().toString(36).slice(2, 8)}`;

// Shared toast-counter-bump + push-with-Failure-appearance helper.
// Audit 15 #389 consolidated the error cases that all shared the same
// 9-line return. Returns the two state slices that change so each
// caller can splat them into its return value alongside any
// case-specific state.
const addErrorToast = (state: Store, message: string): Pick<Store, "toastCounter" | "toasts"> => {
  const toastCounter = state.toastCounter + 1;
  return {
    toastCounter,
    toasts: [
      ...state.toasts,
      { id: mintToastId(toastCounter), message, appearance: "Failure", showTimeMs: ERROR_TOAST_MS },
    ],
  };
};

export const initialState: Store = {
  connectionStatus: "disconnected",
  route: "loading",
  toasts: [],
  toastCounter: 0,
};

export const reducer = (state: Store = initialState, action: Actions): Store => {
  switch (action.type) {
    case "updateConnectionStatus": {
      // Helper split out of the prior nested ternary, which read as one
      // unbroken array literal and forced the reader to mentally
      // disambiguate which branch handled the disconnected case (audit 9
      // #151). Logic: when disconnected, ensure a "connection-failure"
      // toast exists (idempotent); when connected/connecting, clear it.
      const updateConnectionToasts = (toasts: Toast[]): Toast[] => {
        if (action.payload === "disconnected") {
          const alreadyShown = toasts.some((t) => t.id === "connection-failure");
          return alreadyShown
            ? toasts
            : [
              { id: "connection-failure", message: "Disconnected", appearance: "Failure" },
              ...toasts,
            ];
        }
        return toasts.filter((t) => t.id !== "connection-failure");
      };
      return {
        ...state,
        connectionStatus: action.payload,
        toasts: updateConnectionToasts(state.toasts),
      };
    }
    case "config": {
      if (action.payload.requiresConfiguration) {
        return { ...state, config: action.payload, route: "config" };
      }
      return { ...state, config: action.payload };
    }
    case "enterDeckScope":
      return { ...state, deckScope: action.payload, route: "room" };
    case "exitDeckScope":
      return { ...state, deckScope: undefined, route: "home" };
    case "navigate":
      return {
        ...state,
        route: action.payload.route,
      };
    case "addToast":
      return { ...state, toasts: [...state.toasts, action.payload] };
    case "removeToast":
      // Filter by id, not by object identity. A dispatched payload that
      // isn't reference-equal to the stored toast (e.g. a fresh object
      // built from { id, message, ... }) would otherwise silently no-op
      // the removal.
      return {
        ...state,
        toasts: state.toasts.filter((toast) => toast.id !== action.payload.id),
      };
    case "setUser":
      return { ...state, user: action.payload };
    case "loginSuccess":
      // The claimed name is the whole identity now (0.12.0).
      return {
        ...state,
        user: { userName: action.payload.userName },
        joinError: undefined,
      };
    case "loginError":
      return { ...state, joinError: action.payload.message };
    case "hydratePrefs":
      return { ...state, soundPref: action.payload.soundPref };
    // ── Verdict flow ──
    case "reviewSuccess":
      return {
        ...state,
        review: action.payload,
        members: action.payload.members,
        ledgerStalled: undefined,
      };
    case "verdictSuccess": {
      if (!state.review) return state;
      const { titleId, verdict } = action.payload;
      const previous = state.review.verdicts.find((v) => v.titleId === titleId);
      const verdicts = previous
        ? state.review.verdicts.map((v) =>
          v.titleId === titleId ? { ...v, verdict, updatedAt: Date.now() } : v,
        )
        : [...state.review.verdicts, { titleId, verdict, updatedAt: Date.now() }];
      // Counts derive from the array they describe (audit 17): the old
      // incremental +1/-1 patching was a second bookkeeping path that
      // could drift from the server's deck-scoped counts until the next
      // refetch.
      const counts = { like: 0, dislike: 0, skip: 0 };
      for (const v of verdicts) counts[v.verdict] += 1;
      const base = { ...state, review: { ...state.review, verdicts, counts } };
      // A scoped re-review advances through ITS list only; the last
      // verdict (or the only one, for a single-row scope) lands back on
      // the review page. The titleId guard keeps unrelated
      // verdictSuccess traffic from stepping the scope.
      const scope = state.deckScope;
      if (scope && scope.titleIds[scope.position] === titleId) {
        const nextPosition = scope.position + 1;
        return nextPosition >= scope.titleIds.length
          ? { ...base, deckScope: undefined, route: "home" }
          : { ...base, deckScope: { ...scope, position: nextPosition } };
      }
      return base;
    }
    case "submitRankingsError":
      // Same as lockInError: a failed submit ends the ceremony.
      return { ...state, finalizing: undefined, ...addErrorToast(state, action.payload.message) };
    case "verdictError":
    case "reviewError":
    case "skipRemainingError":
    case "resultsError":
      return { ...state, ...addErrorToast(state, action.payload.message) };
    case "resultsSuccess":
      return { ...state, results: action.payload, members: action.payload.members };
    case "submitRankingsSuccess":
      // The server push (resultsSuccess to every member, submitter
      // included) carries the state change; nothing to do here.
      return state;
    case "lockInSuccess": {
      // No review to stamp lockedAt into (a season rotation replaced the
      // ledger while the lock request was in flight): the ceremony's
      // clear-effect keys off review.lockedAt and would never fire, so
      // the "Locking in..." hold must be released here or it sticks
      // forever.
      const base = state.review
        ? { ...state, review: { ...state.review, lockedAt: action.payload.lockedAt } }
        : { ...state, finalizing: undefined };
      if (!action.payload.roomLocked) return base;
      // The all-locked edge: scores just got tallied server-side. The
      // results surface isn't designed yet, so a toast carries the moment.
      return {
        ...base,
        toastCounter: base.toastCounter + 1,
        toasts: [
          ...base.toasts,
          {
            id: mintToastId(base.toastCounter + 1),
            appearance: "Success" as const,
            message: "Everyone's locked in -- rank your keeps!",
            showTimeMs: 6000,
          },
        ],
      };
    }
    case "lockInError":
      // A failed lock also ends its in-flight ceremony -- the button must
      // come back armed, not stick on "Locking in...".
      return { ...state, finalizing: undefined, ...addErrorToast(state, action.payload.message) };
    case "roomPulse": {
      // Another member locked in: refresh the live member state, and on
      // the all-locked edge fire the celebration here too -- the server
      // excludes the locker (their own toast rides lockInSuccess), and
      // only the true edge is broadcast, so no dedup is needed.
      // Deliberate (the owner's call, audit v1.2.0 low): a late joiner
      // un-completes the room, and when they lock, the celebration
      // fires AGAIN -- it's true again.
      const base = { ...state, members: action.payload.members };
      if (!action.payload.allLocked) return base;
      return {
        ...base,
        toastCounter: base.toastCounter + 1,
        toasts: [
          ...base.toasts,
          {
            id: mintToastId(base.toastCounter + 1),
            appearance: "Success" as const,
            message: "Everyone's locked in -- rank your keeps!",
            showTimeMs: 6000,
          },
        ],
      };
    }
    case "viewLockedReview":
      return { ...state, viewLockedReview: action.payload.open };
    case "tutorial":
      return { ...state, tutorialOpen: action.payload.open };
    case "ledgerStalled":
      return { ...state, ledgerStalled: action.payload.stalled || undefined };
    case "finalizing":
      return {
        ...state,
        finalizing: action.payload
          ? { kind: action.payload.kind, startedAt: Date.now() }
          : undefined,
      };
    case "seasonRotated": {
      // The server just rotated seasons: rooms were deleted and re-decked
      // server-side, so every piece of season-scoped client state is
      // stale. Clear it (fresh fetches follow) and say WHY the screen
      // just reset -- the rotation used to be completely silent (audit
      // v1.2.0 #6): mid-deck users silently jumped to card 1 and
      // standings readers were dumped onto an empty review.
      const raw = action.payload.season;
      const seasonName = raw.charAt(0) + raw.slice(1).toLowerCase();
      return {
        ...state,
        review: undefined,
        results: undefined,
        members: undefined,
        deckScope: undefined,
        viewLockedReview: undefined,
        toastCounter: state.toastCounter + 1,
        toasts: [
          ...state.toasts,
          {
            id: mintToastId(state.toastCounter + 1),
            appearance: "Success" as const,
            message: `The season rotated -- ${seasonName} is up. Fresh deck, everyone's picks reset.`,
            showTimeMs: 10000,
          },
        ],
      };
    }
    case "skipRemainingSuccess":
      return {
        ...state,
        toastCounter: state.toastCounter + 1,
        toasts: [
          ...state.toasts,
          {
            id: mintToastId(state.toastCounter + 1),
            appearance: "Success" as const,
            message: `Marked ${action.payload.skipped} titles unsure.`,
            showTimeMs: 4000,
          },
        ],
      };
    case "soundPref":
      // Local preference (0.12.0): persisted to localStorage by the
      // dispatch side-effect; the store copy drives the UI.
      return { ...state, soundPref: action.payload.enabled };
    case "createRoom":
    case "joinRoom":
    case "joinOrCreateRoom": {
      // Same-room rejoin (the auto-rejoin after every reconnect): keep
      // the current room state. Resetting it here wiped media/users and
      // briefly rendered the exhausted-deck screen with stale numbers on
      // every WS blip (audit 17 H3); the join reply refreshes everything
      // anyway. A join for a DIFFERENT room still starts clean.
      if (state.room?.joined && state.room.name === action.payload.roomName) {
        return { ...state, error: undefined };
      }
      return {
        ...state,
        error: undefined,
        room: { name: action.payload.roomName, joined: false },
      };
    }
    case "createRoomSuccess":
    case "joinRoomSuccess": {
      // No route change here (audit 17 H3/H4): where to land depends on
      // the verdict ledger (mid-deck vs ready-to-lock vs locked), which
      // arrives one round trip later. createStore routes on the post-join
      // reviewSuccess; a reconnect rejoin keeps the current route.
      if (state.room) {
        return {
          ...state,
          error: undefined,
          room: {
            ...state.room,
            // Prefer the server's sanitized canonical name when provided so
            // local state (and the URL bar) match what the server stores.
            name: action.payload.roomName ?? state.room.name,
            // Display form for UI; falls back to the canonical name.
            displayName: action.payload.displayName ?? state.room.displayName,
            joined: true,
            media: action.payload.media,
            users: action.payload.users,
          },
        };
      }
      // Defensive guard: room is always set before a success response per protocol
      return state;
    }
    case "mediaChanged": {
      // Server-initiated deck swap (the daily pre-freeze refresh, stills
      // enrichment, or a season-rotation re-deck).
      if (!state.room) return state;
      return {
        ...state,
        room: { ...state.room, media: action.payload.media },
      };
    }
    case "joinRoomError":
    case "createRoomError":
      // Room-flow errors surface on the home screen's join form.
      return { ...state, error: action.payload, route: "home", room: undefined };
    case "leaveRoomSuccess":
      return {
        ...state,
        room: undefined,
        review: undefined,
        results: undefined,
        deckScope: undefined,
        members: undefined,
        viewLockedReview: undefined,
        route: "home",
      };
    // leaveRoomError / logoutError previously had no case and fell through,
    // so a failed leave/logout gave the user no feedback at all. Surface a
    // toast. Both are edge cases (NOT_JOINED / NotLoggedIn).
    case "leaveRoomError":
      // NOT_JOINED means the server already considers us out of any room
      // (audit 16 #452): treat it as a successful leave instead of only
      // toasting. Before this, a failed silent rejoin left the user on a
      // room screen with no server-side membership -- swipes were
      // silently dropped and Leave dead-ended on this very error, a hard
      // trap only a page refresh escaped.
      if (action.payload?.errorType === "NOT_JOINED") {
        return { ...state, room: undefined, route: "home" };
      }
      return { ...state, ...addErrorToast(state, "Couldn't leave the room.") };
    // Room events only fire to clients joined to a room, so the server
    // contract guarantees state.room is set when these arrive. Even so,
    // the cases guard with `if (!state.room) return state;` rather than
    // spread `state.room!` -- a runtime invariant violation now becomes a
    // safe no-op instead of a thrown TypeError (audit 9 #120).
    case "userJoinedRoom":
      // Idempotent on userName: a reconnecting/rejoining user broadcasts
      // userJoinedRoom again, and a blind append would show that user twice
      // in everyone else's list. Drop any existing entry first.
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          users: [
            ...(state.room.users ?? []).filter(
              (user) => user.userName !== action.payload.userName,
            ),
            action.payload,
          ],
        },
      };
    case "userLeftRoom":
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          users: (state.room.users ?? []).filter(
            (user) => user.userName !== action.payload.userName,
          ),
        },
      };
    // The ServerMessage variants are dispatched by the UI and forwarded
    // to the WS client by createStore's dispatch wrapper. The reducer
    // doesn't react to them locally -- it waits for the server's reply
    // (the matching *Success / *Error / *Applied ClientMessage) which
    // IS handled above. Enumerating them as no-ops here lets the
    // `never` check below catch any future variant that gets added to
    // the Actions union without a deliberate decision (audit 13 #305).
    case "leaveRoom":
    case "chooseRoom":
    // Outbound requests the dispatch layer forwards to the WS client;
    // the reducer reacts to their replies above.
    case "login":
    case "verdict":
    case "review":
    case "skipRemaining":
    case "lockIn":
    case "submitRankings":
    case "results":
      return state;
    default: {
      // Exhaustive-check via `never`. A new variant added to the
      // Actions union without a case (or no-op above) errors at
      // typecheck. The `void _exhaustive` swallows the value so the
      // linter doesn't flag it as unused.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
};
