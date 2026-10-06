import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { ReelyClient } from "../api/reely";
import type { ClientMessage } from "../../../../types/reely";
import { reducer, initialState } from "./reducer";
import type { Actions, ClientActions, Dispatch, Store } from "./types";
import { replaceUrl } from "../utils/backSteps";
import { applySeasonTheme } from "../utils/season";
import {
  clearStoredRoom,
  getStoredName,
  getStoredRoom,
  getStoredSoundPref,
  getStoredTutorialSeen,
  getTabJoining,
  getTabName,
  getTabRoom,
  setStoredName,
  setStoredRoom,
  setStoredSoundPref,
  setTabJoining,
  setTabName,
  setTabRoom,
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
    case "submitRefinedRankings": return client.submitRefinedRankings(msg.payload);
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
    case "reviewView":
    case "soundPref":
    case "viewLockedReview":
    case "tutorial":
    case "chooseRoom":
    case "finalizing":
    case "rejoinOverdue":
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

// Names match as the server matches them: A to Z in either case, nothing
// else folded.
const foldAscii = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameName = (a: string, b: string) => foldAscii(a) === foldAscii(b);

// Timeout toasts mint their id here instead of in the reducer's
// toastCounter path; a bare Date.now() collided when two requests timed
// out in the same millisecond (both toasts then shared a React key and
// dismissed together), so a monotonic sequence disambiguates.
let timeoutToastSeq = 0;

export const createStore = () => {
  if (!client) client = new ReelyClient();
  // Tear down any listeners from a prior createStore call (HMR cycle).
  listenerController?.abort();
  listenerController = new AbortController();
  const { signal } = listenerController;
  // Set while a reconnect re-claims the tab's own name.
  let reclaiming = false;
  // This tab's own member and room (the last it landed in), which the
  // tab's session storage keeps across a reload, and a name and room
  // chosen that the server has yet to take. The shared storage holds
  // whichever tab chose last, so it only starts a new tab; a refused typed
  // name takes its room back with it.
  const tabName = getTabName();
  let sessionRoom = tabName === undefined ? undefined : getTabRoom();
  const setSessionRoom = (roomName: string | undefined) => {
    sessionRoom = roomName;
    setTabRoom(roomName);
  };
  let chosenName: string | undefined;
  // A room the tab was still joining when it reloaded is still its choice.
  let chosenRoom = tabName === undefined ? undefined : getTabJoining();
  // The member this tab logs in as on a (re)connect: a typed name still in
  // flight, else the one it already is, else the stored one.
  const ownName = () => chosenName ?? useZustandStore.getState().user?.userName ?? tabName ?? getStoredName();

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
        result.catch((err: unknown) => {
          // A request dropped by a back/forward-cache suspension gets no toast,
          // retry or loading escape: the reconnect on restore logs in and
          // fetches again.
          const suspended = (err as { suspended?: boolean } | null)?.suspended === true;
          if (!suspended) {
            set((state) =>
              reducer(state, {
                type: "addToast",
                payload: {
                  id: `request-timeout-${++timeoutToastSeq}`,
                  message: "The server isn't responding. Please try again.",
                  appearance: "Failure",
                  showTimeMs: 5000,
                },
              }),
            );
          }
          // A review fetch can die CLIENT-side too (15s timeout, reply
          // lost mid-reconnect) -- the reviewError frame path never runs
          // then, and Home/Deck held the pulse forever (audit v1.2.0 #5).
          if (action.type === "review" && !suspended) {
            scheduleReviewRetry();
          }
          // A lock/submit that never got an answer must not stick on its
          // in-flight ceremony forever -- the timeout toast plus a
          // re-armed button is the honest state (audit v1.2.0 #9).
          if (action.type === "lockIn" || action.type === "submitRankings" || action.type === "submitRefinedRankings") {
            set((state) => reducer(state, { type: "finalizing", payload: null }));
          }
          // A login that never got an answer must not strand the wordmark
          // pulse: the 5s loading escape was already cleared on connect
          // (audit 17 M8). Fall back to the join form so the user can act.
          // The cold-load auto-rejoin holds the loading route too (see
          // loginSuccess), so its lost reply needs the same escape.
          if ((action.type === "login" || action.type === "joinOrCreateRoom") && !suspended) {
            set((state) =>
              state.route === "loading"
                ? reducer(state, { type: "navigate", payload: { route: "home" } })
                : state,
            );
            // A rejoin unanswered on a live socket may still land (a slow
            // server); meanwhile Leave room opens, so a lost answer is not
            // a dead end. A drop mid-rejoin is left to the next reconnect.
            set((state) =>
              state.rejoining && state.connectionStatus === "connected"
                ? reducer(state, { type: "rejoinOverdue" })
                : state,
            );
          }
        });
      }

      // Local prefs persist at dispatch time (0.12.0).
      if (action.type === "soundPref") {
        setStoredSoundPref(action.payload.enabled);
      }
      if (action.type === "login" && !reclaiming) {
        setStoredName(action.payload.userName);
        chosenName = action.payload.userName;
      }
      if (action.type === "chooseRoom") {
        // The typed room beats the ?roomName deep link (audit v1.2.0 #4):
        // before this, pendingRoomJoin silently won and the user landed
        // in the URL's room, with their edit rewritten under them.
        setStoredRoom(action.payload.roomName);
        chosenRoom = action.payload.roomName;
        pendingRoomJoin = null;
        lockoutHandoff = false;
        // On a reload as well.
        const url = new URL(location.href);
        url.searchParams.delete("roomName");
        replaceUrl(url.href);
      }
      if (action.type === "joinOrCreateRoom" || action.type === "joinRoom" || action.type === "createRoom") {
        chosenRoom = action.payload.roomName;
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
  // Set when pendingRoomJoin holds a lifted lockout's room rather than the
  // page's link: a refused login takes that room back.
  let lockoutHandoff = false;
  // Leaves in flight that only take the server out of a join the screen
  // gave up: their answers forget nothing and change no screen.
  let resyncLeaves = 0;
  // Whether loginSuccess has answered on the CURRENT socket. Reset by the
  // connected handler, set by the loginSuccess handler. Distinguishes "a
  // rejoin is already coming from the login path" from "nothing else will
  // rejoin", which is what the lockout rejoin needs and what `user` could
  // not tell it.
  let loginSettledThisSocket = false;

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
      // The stall affordance renders on Home/Deck only. A cold-load
      // auto-rejoin holds the "loading" route until the ledger routes
      // (see loginSuccess), so an exhausted budget there must land the
      // user somewhere the retry button exists instead of a pulse that
      // never resolves.
      if (useZustandStore.getState().route === "loading") {
        apply({ type: "navigate", payload: { route: "home" } });
      }
      return;
    }
    reviewRetries += 1;
    clearTimeout(reviewRetryTimer);
    reviewRetryTimer = setTimeout(() => {
      const s = useZustandStore.getState();
      // A rejoin in flight fetches the ledger itself once it lands.
      if (s.room?.joined && !s.review && !s.rejoining) dispatch({ type: "review" });
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
    // Fresh socket: the login for THIS connection has not answered yet,
    // so the lockout rejoin below must hand its room to the login path
    // instead of dispatching its own. Reset here rather than testing
    // `user`, which is written once on the first loginSuccess and never
    // cleared, so it is always set by the time a lockout can exist (every
    // room error the lockout raises sits behind a login check server
    // side). Gating on it made that branch unreachable.
    loginSettledThisSocket = false;
    // Clear the 5s loading-escape timer: we're connected; the config /
    // resume handlers below route the user explicitly.
    clearTimeout(loadingEscapeTimer);

    // Auto-login (0.12.0): every (re)connect re-claims this tab's member,
    // and loginSuccess below decides whether a room rejoin follows. No name
    // at all -> the join form (home fallback).
    const relogin = ownName();
    if (relogin) {
      // Storage keeps the name the member last chose, in whichever tab.
      reclaiming = true;
      try {
        dispatch({ type: "login", payload: { userName: relogin } });
      } finally {
        reclaiming = false;
      }
    }
  }, { signal });

  client.addEventListener("disconnected", (e) => {
    // A disconnect while the page sits in the back/forward cache reads as
    // connecting, with no failure toast, and drops a pending review retry:
    // the reconnect on restore fetches the ledger again.
    const { suspended } = (e as CustomEvent<{ suspended?: boolean } | null>).detail ?? {};
    if (suspended) clearTimeout(reviewRetryTimer);
    // Leave answers only come back on the socket that asked.
    resyncLeaves = 0;
    apply({ type: "updateConnectionStatus", payload: suspended ? "connecting" : "disconnected" });
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
      // Read BEFORE apply(): the reducer's config case clears exactly this
      // error, so after the frame lands there is no way to tell a lockout
      // recovery from any other rotation.
      const wasLockedOut =
        useZustandStore.getState().error?.name === "ProviderDownError";
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
          // Clear the season-scoped slices, and say why, for anyone who is
          // about to be IN a room under the new season. That includes the
          // locked-out cohort: the refusal that locked them out already
          // ended their room, but the reaper just wiped their picks too,
          // and the "everyone's picks were reset" notice is for them as
          // much as anyone.
          if (state.room?.joined || wasLockedOut) {
            apply({ type: "seasonRotated", payload: { season: msg.payload.season } });
          }
          if (state.room?.joined) {
            // A rejoin in flight fetches the ledger once it lands; a
            // request sent before then is refused.
            if (!state.rejoining) dispatch({ type: "review" });
          } else if (wasLockedOut) {
            // Locked out by the provider-down refusal, and a season just
            // landed. The refusal copy promises access restores
            // automatically, so make that true rather than leaving the
            // user on the join form guessing when to click.
            //
            // A rotation is not the ONLY edge that lifts the lockout:
            // clearProvisionalIfSettled can clear it with no rotation at
            // all (a corrected clock), and that edge broadcasts no config
            // frame, so it does not reach here. Those users still click
            // once. This covers the common case, not every case.
            //
            // The joinRoomError that raised this lockout also set room:
            // undefined, so the room is the one this tab chose or was in.
            // Storage may hold another tab's room by now.
            const rejoin = chosenRoom ?? sessionRoom;
            if (rejoin) {
              // Hand the room to the loginSuccess rejoin instead of
              // dispatching here when a login is still in flight. On a
              // FRESH socket the config frame arrives first (the server
              // sends it from the Client constructor) and loginSuccess
              // follows with its own rejoin, so dispatching here too put
              // two identical joinOrCreateRoom frames on one connection.
              // pendingRoomJoin is the existing one-shot handoff slot. A
              // typed name in flight answers first as well: refused, it
              // takes its room back.
              if (ownName() && (!loginSettledThisSocket || chosenName !== undefined)) {
                pendingRoomJoin = rejoin;
                lockoutHandoff = true;
              } else {
                dispatch({ type: "joinOrCreateRoom", payload: { roomName: rejoin } });
              }
            }
          }
        }
      }
      // First frame routing: only while still on the loading screen, so a
      // reconnect can't yank an active user off their screen. With a
      // name to claim the connected handler already dispatched login; stay
      // on loading until it answers. Without one, home shows the join
      // form.
      const state = useZustandStore.getState();
      if (state.route === "loading" && !ownName()) {
        apply({ type: "navigate", payload: { route: "home" } });
      }
      return;
    }

    if (msg.type === "loginSuccess") {
      // This connection's login has answered, so from here on the lockout
      // rejoin above dispatches for itself rather than handing off.
      loginSettledThisSocket = true;
      // A new tab's first login may take the remembered room; after that
      // the tab goes back to its own.
      const firstLogin = useZustandStore.getState().user == null;
      const previous = useZustandStore.getState().user?.userName ?? tabName;
      apply(msg as Actions);
      chosenName = undefined;
      setTabName(msg.payload.userName);
      // A different member starts without the last one's room, or its link.
      if (previous !== undefined && previous !== msg.payload.userName) {
        setSessionRoom(undefined);
        const url = new URL(location.href);
        url.searchParams.delete("roomName");
        replaceUrl(url.href);
      }
      // Rooms are permanent and membership durable (0.12.0), so every
      // login -- cold start or reconnect -- simply rejoins the ?roomName
      // deep link or the remembered room. No rejoin window: there is no
      // "dead room" to protect against anymore.
      const route = useZustandStore.getState().route;
      const newTab = firstLogin && tabName === undefined;
      const rejoin = pendingRoomJoin ?? chosenRoom ?? sessionRoom ?? (newTab ? getStoredRoom() : undefined);
      pendingRoomJoin = null;
      lockoutHandoff = false;
      // This page speaks for the tab now, a page restored from the
      // back/forward cache included: its own room, and one it is joining,
      // which a reload heads for until it lands.
      setTabRoom(sessionRoom);
      setTabJoining(rejoin !== sessionRoom ? rejoin : undefined);
      if (rejoin) {
        dispatch({ type: "joinOrCreateRoom", payload: { roomName: rejoin } });
      }
      // With a rejoin in flight, hold the loading screen instead of
      // flashing the join form for the beat until the ledger routes
      // (reviewSuccess -> deck or home). Loading can't strand: a join
      // failure lands on home via joinRoomError's reducer case, and a
      // lost reply lands there via the request-timeout fallback below.
      if (route === "loading" && !rejoin) {
        apply({ type: "navigate", payload: { route: "home" } });
      }
      return;
    }

    if (msg.type === "loginError") {
      // A bad stored name (or a name-switch refusal) lands on the join
      // form with the message. A refused typed name takes its room back,
      // and a lifted lockout's room handed to its login with it. A second
      // login of the tab's own member, refused while its join is in flight
      // (a double submit), keeps the room that member is joining.
      const member = useZustandStore.getState().user?.userName ?? tabName;
      const ownRetry = member !== undefined && chosenName !== undefined && sameName(chosenName, member);
      chosenName = undefined;
      chosenRoom = ownRetry ? getTabJoining() : undefined;
      if (lockoutHandoff) pendingRoomJoin = null;
      lockoutHandoff = false;
      apply(msg as Actions);
      apply({ type: "navigate", payload: { route: "home" } });
      return;
    }

    // For room events, apply the message first (which adopts the server's
    // canonical roomName when present), then read post-update state for the URL.
    if (msg.type === "joinRoomSuccess" || msg.type === "createRoomSuccess") {
      // A join the screen already gave up (a leave, a refused or unanswered
      // rejoin) that the server answered anyway: leave, rather than be in a
      // room the screen does not show.
      if (!useZustandStore.getState().room) {
        resyncLeaves += 1;
        dispatch({ type: "leaveRoom" });
        return;
      }
      // A reconnect rejoin (room already joined) keeps the current route;
      // only a fresh join routes, and only once the ledger arrives. A rejoin
      // before that ledger arrives keeps the landing pending.
      const freshJoin = useZustandStore.getState().room?.joined !== true;
      routeOnNextReview = routeOnNextReview || freshJoin;
      // First-run tutorial: one page, once per browser, shown when the
      // user first lands IN a room. Not on loginSuccess -- that arrives
      // while the join form is still on screen and read as popping up
      // "before logging in" (the owner's 1.1.0 feedback). Fresh joins
      // only, so a mid-session reconnect can't interrupt with it.
      if (freshJoin && !getStoredTutorialSeen()) {
        apply({ type: "tutorial", payload: { open: true } });
      }
      apply(msg as Actions);
      const roomName = useZustandStore.getState().room?.name;
      if (roomName) {
        // Storage remembers where a tab lands when that is somewhere new (a
        // room typed, linked or left for), beside the tab's own member. A
        // tab getting back into its own room leaves it alone, since another
        // tab of this browser may have stored its own since.
        if (sessionRoom !== roomName) {
          const me = useZustandStore.getState().user?.userName;
          if (me) setStoredName(me);
          setStoredRoom(roomName);
        }
        setSessionRoom(roomName);
        setTabJoining(undefined);
        chosenRoom = undefined;
        const newUrl = new URL(location.href);
        newUrl.searchParams.set("roomName", roomName);
        replaceUrl(newUrl.href);
      }
      // The deck needs the verdict ledger (progress chip, current card,
      // resume point) -- fetch it as part of entering the room.
      dispatch({ type: "review" });
      // Reconnect rejoin with a results payload already on screen: the
      // resultsSuccess broadcasts missed during the outage never replay,
      // so refetch NOW -- after the join, because the server's results
      // handler requires this connection's room and a refetch fired on
      // the raw "connected" event would land pre-rejoin and error with
      // "Join a room first". This also heals the lost-submit-ack trap:
      // the refreshed payload carries mySubmitted=true, replacing an
      // editor whose resubmit the server would refuse.
      if (useZustandStore.getState().results) {
        dispatch({ type: "results" });
      }
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
      // A ledger refused after the screen left its room says nothing new.
      if (!useZustandStore.getState().room?.joined) return;
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

    if (msg.type === "submitRankingsError" || msg.type === "submitRefinedRankingsError") {
      apply(msg as Actions);
      // The refusal may mean the server accepted an EARLIER submit whose
      // ack was lost (AlreadySubmitted after a reconnect re-armed the
      // editor), or that the room changed under a refine: refetch results
      // so the screen shows what the server holds.
      dispatch({ type: "results" });
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

    // NOT_JOINED answers an explicit leave the server had already made.
    if (msg.type === "leaveRoomSuccess" || (msg.type === "leaveRoomError" && msg.payload?.errorType === "NOT_JOINED")) {
      if (resyncLeaves > 0) {
        resyncLeaves -= 1;
        return;
      }
      setSessionRoom(undefined);
      setTabJoining(undefined);
      chosenRoom = undefined;
      // Explicit leave forgets the remembered room: the user
      // deliberately left, so neither a reconnect nor the next page
      // load should pull them back in.
      clearStoredRoom();
      // A late ledger for the room just left must not navigate.
      routeOnNextReview = false;
      apply(msg as Actions);
      const newUrl = new URL(location.href);
      newUrl.searchParams.delete("roomName");
      replaceUrl(newUrl.href);
      return;
    }

    if (msg.type === "joinRoomError" || msg.type === "createRoomError") {
      // A refused join leaves no landing pending.
      routeOnNextReview = false;
    }

    apply(msg as Actions);
  }, { signal });
};
