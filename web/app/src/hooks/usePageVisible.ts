import { useEffect, useState } from "react";

/** Whether the page is in view: false while its tab is hidden or the window minimized. */
export const usePageVisible = (): boolean => {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
};
