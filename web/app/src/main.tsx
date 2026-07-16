import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./fonts.css";
import "./main.css";

import { HomeScreen } from "./components/screens/Home";
import { DeckScreen } from "./components/screens/Deck";
import { Loading } from "./components/screens/Loading";
import { ToastList } from "./components/atoms/Toast";
import { Tutorial } from "./components/organisms/Tutorial";
import { ConfigScreen } from "./components/screens/Config";
import type { Routes } from "./types";
import { createStore, useSelector, useDispatch } from "./store";
import { applySeasonTheme, servedSeason } from "./utils/season";

// Point the accent tokens at the served broadcast season before first
// paint (0.3.0) -- otherwise the summer-indigo CSS fallback flashes for a
// frame in other seasons. Local best guess only; the config frame's
// season re-applies over this the moment the socket delivers it.
applySeasonTheme(servedSeason(new Date()).season);

// Initialize the WS client and wire up the Zustand store before rendering
createStore();

// Route-to-component table. Hoisted out of the component body so it isn't
// reconstructed every render. `Record<Routes, ...>` guarantees a key for
// every Routes union member, so the lookup `ROUTES[route]` is total -- the
// fallback `<p>No route for ...</p>` branch the prior code carried was
// unreachable per the type system (audit 9 #119).
const ROUTES: Record<Routes, () => JSX.Element> = {
  loading: Loading,
  home: HomeScreen,
  room: DeckScreen,
  config: ConfigScreen,
};

const App = () => {
  const { route = "loading", toasts, tutorialOpen } = useSelector([
    "route",
    "toasts",
    "tutorialOpen",
  ]);

  const dispatch = useDispatch();

  const CurrentComponent = ROUTES[route];

  return (
    <>
      <CurrentComponent />
      {/* First-login one-pager (audit 17): overlays whatever screen the
          login landed on; any dismissal marks it seen. */}
      {tutorialOpen && <Tutorial />}
      <ToastList
        toasts={toasts}
        removeToast={(toast) =>
          dispatch({ type: "removeToast", payload: toast })}
      />
    </>
  );
};

// The #app mount-point is in index.html; React 18's createRoot crashes
// loudly if it's missing. The non-null assertion is the right type-
// system shape: a missing #app means a build/template misconfiguration
// (not a runtime condition to defend against).
// biome-ignore lint/style/noNonNullAssertion: bootstrap mount-point invariant from index.html.
createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// `--vh` JS shim removed in 0.4.6 (audit 10 #171). CSS `dvh` (dynamic
// viewport height) is supported across every browser reely targets
// (Safari 15.4+, Chrome 108+, Firefox 101+; all 3+ years old) and
// updates automatically as the mobile address bar collapses / expands,
// which is exactly what the JS was emulating with a resize listener +
// `setProperty('--vh', ...)`. Consumers in CSS now use `100dvh` / `Nvh`
// directly (see main.css, Layout.module.css, Card.module.css,
// CardStack.module.css).

window.addEventListener("keyup", (e) => {
  if (e.key === "Tab") {
    document.body.classList.add("show-focus-ring");
  }
});

window.addEventListener("mouseup", () => {
  document.body.classList.remove("show-focus-ring");
});
