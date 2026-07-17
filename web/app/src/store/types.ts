import type { Toast } from "../components/atoms/Toast";
import type { Routes } from "../types";
import type {
  AppConfig,
  RankingResults,
  ReviewPayload,
  RoomMemberState,
  ClientMessage,
  CreateRoomError,
  Filter,
  JoinRoomError,
  Media,
  ServerMessage,
  User,
} from "../../../../types/reely";

// Action vocabulary (audit 12 #214 documentation):
//
//   ClientActions ............... actions dispatched FROM the UI (a button
//                                 click, a setLocale, a leaveRoom). Includes
//                                 the local-only `addToast`/`removeToast`/
//                                 `navigate` and the full `ServerMessage`
//                                 union (which the WS layer forwards to the
//                                 server). `Dispatch` -- the function `useDispatch`
//                                 hands out -- only accepts these.
//
//   Actions ..................... the wider union the REDUCER handles. Adds
//                                 the WS-driven server pushes (`ClientMessage`,
//                                 i.e. `loginSuccess`, `match`, ...) plus the
//                                 store's own internal transitions
//                                 (`updateConnectionStatus`, `setUser`) that
//                                 createStore.ts's `apply()` helper drives.
//
// In short: components dispatch ClientActions; the reducer processes Actions.
// `apply()` is internal-only and bridges WS messages + connection state into
// the reducer without exposing them on the public `Dispatch`.
// A re-review pass launched from the review page (0.10.0): the deck
// renders THESE titles instead of the main unverdicted flow. A single
// row tap is a one-element scope; "review this list" is a whole pile,
// snapshotted at entry so re-verdicts don't reshuffle it mid-cycle.
export interface DeckScope {
  titleIds: number[];
  position: number;
}

export type ClientActions =
  | { type: "addToast"; payload: Toast }
  | { type: "removeToast"; payload: Toast }
  | { type: "navigate"; payload: { route: Routes } }
  | { type: "enterDeckScope"; payload: DeckScope }
  | { type: "exitDeckScope" }
  // Local-only since 0.12.0: autoplay preference lives in localStorage,
  // not on a server account.
  | { type: "soundPref"; payload: { enabled: boolean } }
  // View the (read-only) review ledger after lock-in -- the standings
  // are the locked default; this opens/closes the peek (audit 17 UX 6).
  | { type: "viewLockedReview"; payload: { open: boolean } }
  // First-login tutorial overlay (audit 17): opened by createStore when
  // no localStorage seen-flag exists; closed by its own CTA.
  | { type: "tutorial"; payload: { open: boolean } }
  // The join form's explicit room choice (audit v1.2.0 #4): persists the
  // typed room AND revokes any ?roomName deep link, so what the user
  // typed always beats what the URL carried.
  | { type: "chooseRoom"; payload: { roomName: string } }
  | ServerMessage;

export type Actions =
  | {
    type: "updateConnectionStatus";
    payload: Store["connectionStatus"];
  }
  | { type: "setUser"; payload: User }
  // Store-creation seed: local prefs hydrated into state.
  | { type: "hydratePrefs"; payload: { soundPref: boolean } }
  // Ledger fetch retries exhausted (audit v1.2.0 #5): Home/Deck swap the
  // infinite pulse for a retry affordance.
  | { type: "ledgerStalled"; payload: { stalled: boolean } }
  // Season rotation observed via the config frame (audit v1.2.0 #6):
  // clears season-scoped state and announces the reset.
  | { type: "seasonRotated"; payload: { season: string } }
  | ClientActions
  | ClientMessage;

export type Dispatch = (action: ClientActions) => void;

export interface Store {
  connectionStatus: "connecting" | "connected" | "disconnected";
  route: Routes;
  // Room-flow errors (create/join), shown on the join form.
  error?: CreateRoomError | JoinRoomError;
  // Login (name-claim) errors, shown on the join form too.
  joinError?: string;
  // Autoplay-PVs-with-sound, hydrated from localStorage (0.12.0).
  soundPref?: boolean;
  // The current room's verdict ledger for this user (0.7.0): fetched via
  // `review` on deck mount, updated locally on every verdictSuccess. The
  // deck derives its current card (first unverdicted title) and the
  // progress chip (verdict count / total) from this.
  review?: ReviewPayload;
  // Post-lock ranking state (0.13.0): combined standings + own
  // submission. Fetched on the rank screen's mount and PUSHED by the
  // server whenever any member submits, so standings update live.
  results?: RankingResults;
  // Active re-review pass (0.10.0). Set -> the deck is scoped: verdicts
  // advance through titleIds only, and the end (or back) returns to the
  // review page instead of the main deck flow.
  deckScope?: DeckScope;
  // Live per-member lock/submit state (audit 17 UX 3/7/11): seeded by
  // review/results payloads, updated by roomPulse pushes.
  members?: RoomMemberState[];
  // Post-lock review peek: HomeScreen shows the ledger instead of the
  // standings while true.
  viewLockedReview?: boolean;
  // First-login tutorial overlay.
  tutorialOpen?: boolean;
  // Review fetch retries exhausted; a retry affordance renders.
  ledgerStalled?: boolean;

  toasts: Toast[];
  config?: AppConfig;
  user?: User;
  room?: {
    // Canonical (lowercased, allowlist-stripped). Used for URL parameter,
    // share link, Map key on server.
    name: string;
    // Display form (case preserved). Used for UI rendering. Falls back to
    // `name` when undefined (e.g. before the success message lands).
    displayName?: string;
    joined: boolean;
    media?: Media[];
    users?: User[];
    activeFilters?: Filter[];
  };

  // Per-Store monotonic toast counter (audit 13 #328 lineage). The
  // mediaVersion sibling died with CardStack in the 0.4.0 teardown.
  // INVARIANT: never reset within a Store's lifetime.
  toastCounter: number;
}
