import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { ReelyClient } from "../api/reely";
import type { ClientMessage } from "../../../../types/reely";
import { reducer, initialState } from "./reducer";
import type { Actions, ClientActions, Dispatch, Store } from "./types";
import { applySeasonTheme } from "../utils/season";
import {
  clearStoredRoom,
  getStoredName,
  getStoredRoom,
  getStoredSoundPref,
  getStoredTutorialSeen,
  setStoredName,
  setStoredRoom,
  setStoredSoundPref,
} from "../utils/prefs";

// Exhaustive ClientActions -> ReelyClient method dispatch. ClientActions
// is `ServerMessage | { type: "addToast" | "removeToast" | "navigate"; ... }`
// -- the UI-only variants don't have a corresponding ReelyClient method,
// so they return undefined and the caller skips them.
//
// Audit 13 #285: previously this lived alongside a parallel
// `SERVER_MESSAGE_TYPES` Set used as a runtime guard. The Set + the
// switch covered the same types and had to stay in sync, so adding a
// new ServerMessage required two updates. Folded the runtime guard
// into the switch's no-op cases; the `default: never` still enforces
// exhaustiveness at compile time, so a new ClientAction variant added
// without a case here now errors at typecheck instead of silently
// being dispatched to the WS client.
//
// The original allowlist (audit 9 #159) guarded against bugs like
// `if (action.type in client)` matching inherited EventTarget methods.
// The switch covers the same surface explicitly without inheritance.
const dispatchToClient = (
  client: ReelyClient,
  msg: ClientActions,
): unknown => {
  switch (msg.type) {
    case "login":             return client.login(msg.payload);
    case "createRoom":        return client.createRoom(msg.payload);
    case "joinRoom":          return client.joinRoom(msg.payload);
    case "joinOrCreateRoom":  return client.joinOrCreateRoom(msg.payload);
    case "leaveRoom":         return client.leaveRoom();
    case "verdict":           return client.verdict(msg.payload);
    case "review":            return client.review();
    case "skipRemaining":     return client.skipRemaining();
    case "submitRankings":    return client.submitRankings(msg.payload);
    case "results":           return client.results();
    case "lockIn":            return client.lockIn();
    // UI-only actions: not server-bound, return undefined so the caller
    // skips the Promise.catch attach. soundPref persists via the
    // dispatch side-effect (0.12.0: it's a localStorage pref now).
    case "addToast":
    case "removeToast":
    case "navigate":
    case "enterDeckScope":
    case "exitDeckScope":
    case "soundPref":
    case "viewLockedReview":
    case "tutorial":
    case "chooseRoom":
    case "finalizing":
      return undefined;
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
};

type ZustandStore = Store & { dispatch: Dispatch };


// Singleton client; useZustandStore is populated by createStore()
let client: ReelyClient;
export let useZustandStore: UseBoundStore<StoreApi<ZustandStore>>;

// AbortController for the listeners createStore registers below
// (audit 13 #302 / audit 14 #365). Previously the listeners were never
// removed; a second createStore call (HMR, repeated init) would
// double-bind. Now a re-call aborts the prior signal first, tearing
// down every listener in one operation. We track the controller at
// module scope so the next call can abort the previous one.
let listenerController: AbortController | undefined;

export const createStore = () => {
  if (!client) client = new ReelyClient();
  // Tear down any listeners from a prior createStore call (HMR cycle).
  listenerController?.abort();
  listenerController = new AbortController();
  const { signal } = listenerController;

  useZustandStore = create<ZustandStore>()((set, _get) => ({
    ...initialState,
    dispatch: (action: ClientActions) => {
      // ServerMessage variants forward to a ReelyClient method;
      // ClientAction-only variants (addToast / removeToast / navigate)
      // return undefined from the dispatch and skip the catch attach.
      const result: unknown = dispatchToClient(client, action);
      // Request methods (login / joinRoom / leaveRoom / createRoom /
      // joinOrCreateRoom / verdict / review / ...) reject if the
      // server reply times out (REQUEST_TIMEOUT_MS in
      // api/reely.ts). Surface that as a toast rather than leaving an
      // unhandled rejection and a UI stuck waiting on a reply that
      // will never arrive.
      //
      // Fire-and-forget dispatches (`soundPref` and friends) return
      // undefined above, so this catch only ever sees real requests.
      if (result instanceof Promise) {
        result.catch(() => {
          set((state) =>
            reducer(state, {
              type: "addToast",
              payload: {
                id: `request-timeout-${Date.now()}`,
                message: "The server isn't responding. Please try again.",
                appearance: "Failure",
                showTimeMs: 5000,
              },
            }),
          );
          // A review fetch can die CLIENT-side too (15s timeout, reply
          // lost mid-reconnect) -- the reviewError frame path never runs
          // then, and Home/Deck held the pulse forever (audit v1.2.0 #5).
          if (action.type === "review") {
            scheduleReviewRetry();
          }
          // A lock/submit that never got an answer must not stick on its
          // in-flight ceremony forever -- the timeout toast plus a
          // re-armed button is the honest state (audit v1.2.0 #9).
          if (action.type === "lockIn" || action.type === "submitRankings") {
            set((state) => reducer(state, { type: "finalizing", payload: null }));
          }
          // A login that never got an answer must not strand the wordmark
          // pulse: the 5s loading escape was already cleared on connect
          // (audit 17 M8). Fall back to the join form so the user can act.
          if (action.type === "login") {
            set((state) =>
              state.route === "loading"
                ? reducer(state, { type: "navigate", payload: { route: "home" } })
                : state,
            );
          }
        });
      }

      // Local prefs persist at dispatch time (0.12.0).
      if (action.type === "soundPref") {
        setStoredSoundPref(action.payload.enabled);
      }
      if (action.type === "login") {
        setStoredName(action.payload.userName);
      }
      if (action.type === "chooseRoom") {
        // The typed room beats the ?roomName deep link (audit v1.2.0 #4):
        // before this, pendingRoomJoin silently won and the user landed
        // in the URL's room, with their edit rewritten under them.
        setStoredRoom(action.payload.roomName);
        pendingRoomJoin = null;
      }
      if (action.type === "review" && useZustandStore.getState().ledgerStalled) {
        // A manual retry from the stall screen starts a fresh budget.
        reviewRetries = 0;
        set((state) => reducer(state, { type: "ledgerStalled", payload: { stalled: false } }));
      }

      // Zustand merges shallowly: reducer updates Store keys, dispatch is preserved
      set((state) => reducer(state, action as Actions));
    },
  }));

  // apply is used for internal state changes that aren't component-driven actions
  const apply = (action: Actions) =>
    useZustandStore.setState((state) => reducer(state, action));

  const { dispatch } = useZustandStore.getState();

  apply({ type: "updateConnectionStatus", payload: "connecting" });
  apply({ type: "hydratePrefs", payload: { soundPref: getStoredSoundPref() } });

  // Safety-net: if we're still on the loading screen 5 seconds after page
  // load and no room join is in progress, escape to the login screen.
  // The timer is captured + cleared on a successful "connected" event
  // (audit 13 #303): once we've connected, the loading-screen escape
  // is moot because the connected handler navigates explicitly. The
  // prior unconditional setTimeout still fired (as a no-op via the
  // route check) on every page load even after the user had joined.
  // signal.addEventListener("abort", ...) wires the timer into the
  // listenerController teardown so HMR cycles don't leak.
  const loadingEscapeTimer = setTimeout(() => {
    const s = useZustandStore.getState();
    if (s.route === "loading" && !s.room) {
      apply({ type: "navigate", payload: { route: "home" } });
    }
  }, 5000);
  signal.addEventListener("abort", () => clearTimeout(loadingEscapeTimer), { once: true });

  // Room to auto-join after login, populated from the URL on initial page load.
  // Cleared after use or when a server-restart reconnect forces the user to login manually.
  const initialParams = new URLSearchParams(location.search);
  let pendingRoomJoin: string | null = initialParams.get("roomName");

  // Set by a FRESH join success (not a reconnect rejoin): the next
  // reviewSuccess decides where to land based on the ledger (audit 17
  // H4) -- mid-deck resumes the deck, done-or-locked lands on home,
  // where HomeScreen picks review vs standings.
  let routeOnNextReview = false;
  // Bounded retry for a failed review fetch (audit 17 H5 + v1.2.0 #5):
  // without the ledger the deck is held in a loading state, so a lost
  // reply must not strand it forever. Covers BOTH failure shapes -- a
  // reviewError frame and a client-side rejection. When the budget
  // exhausts, Home/Deck swap the pulse for a retry affordance.
  let reviewRetries = 0;
  let reviewRetryTimer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(reviewRetryTimer), { once: true });
  function scheduleReviewRetry() {
    const state = useZustandStore.getState();
    if (!state.room?.joined || state.review) return;
    if (reviewRetries >= 3) {
      apply({ type: "ledgerStalled", payload: { stalled: true } });
      return;
    }
    reviewRetries += 1;
    clearTimeout(reviewRetryTimer);
    reviewRetryTimer = setTimeout(() => {
      const s = useZustandStore.getState();
      if (s.room?.joined && !s.review) dispatch({ type: "review" });
    }, 4000);
  }

  // If there's a room in the URL but no session token, the auto-join can
  // never fire -- keep the pending name so the home screen's join form can
  // pre-fill after a manual login, but route decisions won't wait on it.
  //
  // (Deliberately no early navigate here: the setup-vs-login decision
  // needs the config frame's needsSetup flag, which arrives right after
  // the socket opens.)

  client.addEventListener("connected", () => {
    apply({ type: "updateConnectionStatus", payload: "connected" });
    // Clear the 5s loading-escape timer: we're connected; the config /
    // resume handlers below route the user explicitly.
    clearTimeout(loadingEscapeTimer);

    // Auto-login (0.12.0): a stored name silently re-claims itself on
    // every (re)connect; loginSuccess below decides whether a room
    // rejoin follows. No stored name -> the join form (home fallback).
    const storedName = getStoredName();
    if (storedName) {
      dispatch({ type: "login", payload: { userName: storedName } });
    }
  }, { signal });

  client.addEventListener("disconnected", () => {
    apply({ type: "updateConnectionStatus", payload: "disconnected" });
  }, { signal });

  client.addEventListener("message", (e) => {
    const msg: ClientMessage = (e as MessageEvent<ClientMessage>).data;

    // ── Auth side effects (0.6.0): token persistence + navigation ──
    // The reducer owns identity/error state; everything filesystem- or
    // navigation-shaped lives here, mirroring the old loginSuccess
    // consolidated-entry-point pattern (audit 13 #304).
    if (msg.type === "config") {
      // Season rollover detection BEFORE the frame is applied: the server
      // re-broadcasts config when its served season rotates mid-session.
      const prevSeason = useZustandStore.getState().config?.season;
      apply(msg as Actions);
      if (msg.payload.season) {
        // The server's season always wins over the boot-time local guess.
        applySeasonTheme(msg.payload.season);
        if (prevSeason && prevSeason !== msg.payload.season) {
          // Mid-session rotation: the server deleted the room's data and
          // re-decked. Clear every season-scoped slice (stale standings
          // used to flash) and SAY so -- the reset was silent before
          // (audit v1.2.0 #6) -- then pull the fresh ledger.
          const state = useZustandStore.getState();
          if (state.room?.joined) {
            apply({ type: "seasonRotated", payload: { season: msg.payload.season } });
            dispatch({ type: "review" });
          }
        }
      }
      // First frame routing: only while still on the loading screen, so a
      // reconnect can't yank an active user off their screen. With a
      // stored name the connected handler already dispatched login; stay
      // on loading until it answers. Without one, home shows the join
      // form.
      const state = useZustandStore.getState();
      if (state.route === "loading" && !getStoredName()) {
        apply({ type: "navigate", payload: { route: "home" } });
      }
      return;
    }

    if (msg.type === "loginSuccess") {
      apply(msg as Actions);
      // Rooms are permanent and membership durable (0.12.0), so every
      // login -- cold start or reconnect -- simply rejoins the ?roomName
      // deep link or the remembered room. No rejoin window: there is no
      // "dead room" to protect against anymore.
      const route = useZustandStore.getState().route;
      const rejoin = pendingRoomJoin ?? getStoredRoom();
      pendingRoomJoin = null;
      if (rejoin) {
        dispatch({ type: "joinOrCreateRoom", payload: { roomName: rejoin } });
      }
      if (route === "loading") {
        apply({ type: "navigate", payload: { route: "home" } });
      }
      return;
    }

    if (msg.type === "loginError") {
      // A bad stored name (or a name-switch refusal) lands on the join
      // form with the message.
      apply(msg as Actions);
      apply({ type: "navigate", payload: { route: "home" } });
      return;
    }

    // For room events, apply the message first (which adopts the server's
    // canonical roomName when present), then read post-update state for the URL.
    if (msg.type === "joinRoomSuccess" || msg.type === "createRoomSuccess") {
      // A reconnect rejoin (room already joined) keeps the current route;
      // only a fresh join routes, and only once the ledger arrives.
      routeOnNextReview = useZustandStore.getState().room?.joined !== true;
      // First-run tutorial: one page, once per browser, shown when the
      // user first lands IN a room. Not on loginSuccess -- that arrives
      // while the join form is still on screen and read as popping up
      // "before logging in" (the owner's 1.1.0 feedback). Fresh joins
      // only, so a mid-session reconnect can't interrupt with it.
      if (routeOnNextReview && !getStoredTutorialSeen()) {
        apply({ type: "tutorial", payload: { open: true } });
      }
      apply(msg as Actions);
      const roomName = useZustandStore.getState().room?.name;
      if (roomName) {
        setStoredRoom(roomName);
        const newUrl = new URL(location.href);
        newUrl.searchParams.set("roomName", roomName);
        history.replaceState(null, document.title, newUrl.href);
      }
      // The deck needs the verdict ledger (progress chip, current card,
      // resume point) -- fetch it as part of entering the room.
      dispatch({ type: "review" });
      return;
    }

    if (msg.type === "reviewSuccess") {
      apply(msg as Actions);
      reviewRetries = 0;
      // Post-join landing (audit 17 H4): the ledger knows what the deck
      // couldn't -- resume the deck mid-pass, otherwise land on home,
      // where HomeScreen shows the review (ready to lock) or the
      // standings (locked). Later ledger refetches (skip-all, season
      // rotation) never navigate.
      if (routeOnNextReview) {
        routeOnNextReview = false;
        const review = useZustandStore.getState().review;
        if (review) {
          const midDeck = review.lockedAt == null && review.verdicts.length < review.total;
          apply({ type: "navigate", payload: { route: midDeck ? "room" : "home" } });
        }
      }
      return;
    }

    if (msg.type === "reviewError") {
      apply(msg as Actions);
      // The deck is held behind the ledger (H5); a lost review reply must
      // not strand it. Three paced retries, then the stall affordance.
      scheduleReviewRetry();
      return;
    }

    if (msg.type === "skipRemainingSuccess") {
      apply(msg as Actions);
      // The ledger changed wholesale server-side; re-fetch rather than
      // reconstruct locally.
      dispatch({ type: "review" });
      return;
    }

    if (msg.type === "mediaChanged") {
      apply(msg as Actions);
      // The deck just swapped under us -- the daily refresh, the stills
      // push, or a season-rotation re-deck. Counts, totals, and the
      // current card all derive from ledger x media, so re-pull the
      // ledger or the two silently diverge (audit 17 H7).
      if (useZustandStore.getState().room?.joined) {
        dispatch({ type: "review" });
      }
      return;
    }

    if (msg.type === "leaveRoomSuccess") {
      // Explicit leave forgets the remembered room: the user
      // deliberately left, so neither a reconnect nor the next page
      // load should pull them back in.
      clearStoredRoom();
      apply(msg as Actions);
      const newUrl = new URL(location.href);
      newUrl.searchParams.delete("roomName");
      history.replaceState(null, document.title, newUrl.href);
      return;
    }

    apply(msg as Actions);
  }, { signal });
};
