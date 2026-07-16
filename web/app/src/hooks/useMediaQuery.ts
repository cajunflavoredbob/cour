import { useEffect, useState } from "react";

/**
 * Reactive media-query match. Used where a breakpoint must change the
 * COMPONENT TREE (the desktop deck stage mounts different structure);
 * plain CSS media queries handle everything that is just styling.
 * jsdom has no matchMedia -- the guard makes tests default to false
 * (mobile) unless they stub it.
 */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mql = matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
};

/** The one desktop breakpoint (docs/DESKTOP.md). */
export const DESKTOP_QUERY = "(min-width: 900px)";
