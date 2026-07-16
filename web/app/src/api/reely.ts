import type {
  VerdictRequest,
  ClientMessage,
  CreateRoomRequest,
  JoinRoomRequest,
  ServerMessage,
} from "../../../../types/reely";

const API_URL = (() => {
  const url = new URL(location.href);
  url.pathname = `${document.body.dataset.rootPath ?? ""}/api/ws`;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = ""; // don't carry over page query params into the WS URL
  return url.href;
})();

type FilterClientMessageByType<
  A extends ClientMessage,
  ClientMessageType extends string,
> = A extends { type: ClientMessageType } ? A : never;

// A connection must stay open this long before it counts as "healthy" and
// resets the reconnect backoff. Shorter than this and a server that accepts
// the handshake then immediately closes (crash loop) would reconnect at the
// base delay forever -- the backoff would never escalate.
const STABLE_CONNECTION_MS = 10_000;

// How long a request (login, joinRoom, ...) waits for its server reply before
// giving up. Without it a dropped reply hangs the request promise -- and the
// UI -- permanently.
const REQUEST_TIMEOUT_MS = 15_000;

export class ReelyClient extends EventTarget {
  ws!: WebSocket;
  reconnectionAttempts = 0;
  private stableConnectionTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    super();
    this.connect();
  }

  private connect() {
    if (this.ws) {
      this.ws.removeEventListener("message", this.handleMessage);
      this.ws.removeEventListener("open", this.handleOpen);
      this.ws.removeEventListener("close", this.handleClose);
      this.ws.removeEventListener("error", this.handleError);
    }

    this.ws = new WebSocket(API_URL);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose, { once: true });
    this.ws.addEventListener("open", this.handleOpen, { once: true });
    this.ws.addEventListener("error", this.handleError);
  }

  private handleMessage = (e: MessageEvent<string>) => {
    try {
      // Shape-guard before treating the parsed value as a ClientMessage
      // (audit 13 #311). The prior code parsed + cast, then accessed
      // `msg.type` -- which TypeErrors on non-object JSON literals (null,
      // numbers, strings) and silently no-ops on object literals without
      // a `type` field. Falling through to the catch worked by accident;
      // surface the bad-frame case explicitly so a buggy server can't
      // ship something the dispatcher would mis-handle.
      const parsed: unknown = JSON.parse(e.data);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        console.warn("reely WS: dropping frame with unexpected shape", parsed);
        return;
      }
      const msg = parsed as ClientMessage;
      this.dispatchEvent(new MessageEvent(msg.type, { data: msg }));
      this.dispatchEvent(new MessageEvent("message", { data: msg }));
    } catch (err) {
      console.error(err);
    }
  };

  waitForConnected = () => {
    if (this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(true);
    }

    // Wait on the client's own "connected" event, not the current socket's
    // "open". If waitForConnected is called while the socket is CLOSING/CLOSED
    // (the gap between handleClose and the scheduled reconnect), connect()
    // swaps in a brand-new socket -- an "open" listener bound to the dead one
    // would never fire. "connected" is dispatched by handleOpen regardless of
    // which underlying socket opened, so it survives reconnects.
    return new Promise((resolve) => {
      this.addEventListener("connected", () => resolve(true), { once: true });
    });
  };

  private handleOpen = () => {
    this.dispatchEvent(new Event("connected"));
    // Reset the backoff counter only after the connection proves stable.
    // Resetting on every `open` let an accept-then-close crash loop reconnect
    // at the base delay indefinitely -- the thundering herd the backoff is
    // meant to prevent.
    clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = setTimeout(() => {
      this.reconnectionAttempts = 0;
    }, STABLE_CONNECTION_MS);
  };

  // Socket errors were previously swallowed entirely. Reconnection is driven
  // by the close handler; this just makes the error visible.
  private handleError = (event: Event) => {
    console.warn("reely WebSocket error", event);
  };

  private handleClose = () => {
    // The connection didn't survive to "stable"; keep the backoff counter so
    // a crash loop escalates the delay.
    clearTimeout(this.stableConnectionTimer);
    this.dispatchEvent(new Event("disconnected"));

    // Capped exponential backoff with jitter. Base 500ms, doubling per attempt
    // up to a 30s ceiling, plus up to 1s of random jitter. The old schedule
    // (attempts * 1000, starting at 0) reconnected instantly then grew
    // linearly and uncapped -- it hammered a down server and made every
    // client retry in lockstep (thundering herd) after a restart.
    const base = Math.min(30_000, 500 * 2 ** this.reconnectionAttempts);
    const delay = base + Math.random() * 1_000;
    setTimeout(() => this.connect(), delay);

    this.reconnectionAttempts += 1;
  };

  // Wait for any one of several message types, with shared cleanup. A naive
  // Promise.race of per-type {once:true} listeners would leak the unfired
  // listener forever, which accumulates across reconnect cycles and can fire
  // on later unrelated messages with the same type.
  //
  // Rejects after REQUEST_TIMEOUT_MS so a dropped server reply (handler crash,
  // lost message) surfaces as an error instead of hanging the caller -- and
  // the UI -- forever. The cleanup runs on the timeout path too, so no
  // listener leaks.
  //
  // `match` correlates a response to a specific request. Without it the first
  // message of a matching TYPE resolves the promise -- fine when one request
  // of that type is in flight, but for overlapping same-type requests
  // (verdicts correlate on titleId) the wrong response could resolve the
  // wrong waiter. A non-matching message is ignored; the waiter keeps
  // listening (and is still bounded by the timeout).
  waitForAnyMessage = <K extends ClientMessage["type"]>(
    types: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
  ): Promise<FilterClientMessageByType<ClientMessage, K>> => {
    return new Promise((resolve, reject) => {
      const handlers = new Map<K, EventListener>();
      let timer: ReturnType<typeof setTimeout>;
      let closeHandler: EventListener | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        for (const [type, handler] of handlers) {
          this.removeEventListener(type, handler);
        }
        handlers.clear();
        if (closeHandler) {
          this.removeEventListener("disconnected", closeHandler);
          closeHandler = undefined;
        }
      };
      for (const type of types) {
        const handler: EventListener = (e) => {
          if (e instanceof MessageEvent) {
            if (match && !match(e.data)) return; // not our response; keep waiting
            cleanup();
            resolve(e.data);
          }
        };
        handlers.set(type, handler);
        this.addEventListener(type, handler);
      }
      // Reject promptly if the socket closes mid-wait (audit 13 #312).
      // Without this, a caller (login, joinRoom, etc.) blocks until
      // REQUEST_TIMEOUT_MS (15s) on every reconnect-mid-request, freezing
      // the UI on a reply that the new socket will never get. The close
      // path's caller can decide whether to retry or surface a toast.
      closeHandler = () => {
        cleanup();
        reject(new Error(`Socket closed waiting for a server reply (${types.join(" / ")})`));
      };
      this.addEventListener("disconnected", closeHandler);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for a server reply (${types.join(" / ")})`));
      }, REQUEST_TIMEOUT_MS);
    });
  };

  // Three-step request pattern: wait for the socket OPEN, send the
  // outbound message, then await the matching reply. Audit 15 #390
  // consolidated eight nearly-identical request methods behind this
  // single helper.
  // Each caller dropped from a 5-line boilerplate to a single
  // this.request(...) delegating call; the shared correctness
  // invariant (open-socket gate before send, close-event rejection
  // mid-wait, 15s timeout) lives in one place now.
  private async request<K extends ClientMessage["type"]>(
    msg: ServerMessage,
    replyTypes: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
  ): Promise<FilterClientMessageByType<ClientMessage, K>> {
    // Bound the wait-for-open phase (audit 16 #450). waitForConnected
    // never rejects on its own, so a request dispatched during an outage
    // used to park forever with no per-request feedback -- each Login
    // click queued another send that fired whenever the socket finally
    // reconnected, possibly minutes later. Racing against the same
    // REQUEST_TIMEOUT_MS the reply phase uses routes the failure into
    // the caller's existing catch (toast). The {once} "connected"
    // listener waitForConnected registered stays behind on timeout;
    // it resolves an unreferenced promise later, which is harmless.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.waitForConnected(),
        new Promise((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error(`Not connected to the server (waited ${REQUEST_TIMEOUT_MS}ms)`)),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(connectTimer);
    }
    this.sendMessage(msg);
    return await this.waitForAnyMessage(replyTypes, match);
  }

  // ── Verdict flow (0.7.0 deck) ──

  verdict = async (payload: VerdictRequest) =>
    this.request({ type: "verdict", payload }, ["verdictSuccess", "verdictError"], (msg) =>
      // Correlate on titleId: fast taps can put several verdicts in
      // flight; each waiter resolves on its OWN title's reply (the same
      // key-correlation pattern).
      msg.type === "verdictSuccess" ? msg.payload.titleId === payload.titleId : true,
    );

  review = async () =>
    this.request({ type: "review" }, ["reviewSuccess", "reviewError"]);

  skipRemaining = async () =>
    this.request({ type: "skipRemaining" }, ["skipRemainingSuccess", "skipRemainingError"]);

  lockIn = async () =>
    this.request({ type: "lockIn" }, ["lockInSuccess", "lockInError"]);

  submitRankings = async (payload: { rankedTitleIds: number[] }) =>
    this.request({ type: "submitRankings", payload }, [
      "submitRankingsSuccess",
      "submitRankingsError",
    ]);

  // Was the one request sent raw through the socket (audit 17 H8): a
  // dropped reply left the rank screen's editor-vs-standings gate
  // guessing forever. The helper gives it the same open-socket wait,
  // timeout, and close-event rejection every other request has.
  results = async () =>
    this.request({ type: "results" }, ["resultsSuccess", "resultsError"]);

  // Fire-and-forget login left a lost loginSuccess stranding the
  // wordmark pulse forever once the 5s loading escape was cleared on
  // connect (audit 17 M8) -- the request timeout gives the store a
  // rejection to route on.
  login = async (payload: { userName: string }) =>
    this.request({ type: "login", payload }, ["loginSuccess", "loginError"]);

  joinRoom = async (joinRoomRequest: JoinRoomRequest) =>
    this.request(
      { type: "joinRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "joinRoomError"],
    );

  // The server takes one of two paths internally; we race all four possible
  // outcomes so callers can await a definitive resolution.
  joinOrCreateRoom = async (joinRoomRequest: JoinRoomRequest) =>
    this.request(
      { type: "joinOrCreateRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "createRoomSuccess", "joinRoomError", "createRoomError"],
    );

  // Wait for an open socket before sending (request helper does this): a
  // sendMessage on a non-OPEN socket would be dropped and leave the awaited
  // reply unresolved forever if this is called mid-reconnect.
  leaveRoom = async () =>
    this.request({ type: "leaveRoom" }, ["leaveRoomSuccess", "leaveRoomError"]);

  createRoom = async (createRoomRequest: CreateRoomRequest) =>
    this.request(
      { type: "createRoom", payload: createRoomRequest },
      ["createRoomSuccess", "createRoomError"],
    );





  sendMessage(msg: ServerMessage) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      // Sends while disconnected are dropped: every remaining message type
      // is request/response (the caller times out and retries) or purely
      // advisory. The swipe-era offline rate queue died with the 0.4.0
      // teardown; verdicts (0.5.0) get their own persistence semantics
      // server-side.
      console.warn(`Dropped "${msg.type}" message: WebSocket not open`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }
}
