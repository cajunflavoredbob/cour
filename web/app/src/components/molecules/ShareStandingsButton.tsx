import { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch } from "../../store";
import { canShareFiles, shareOrDownload } from "../../utils/shareFile";
import { renderStandingsCard } from "../../utils/renderStandingsCard";
import { cardFilename, type StandingsCardData } from "../../utils/standingsCard";
import styles from "./ShareStandingsButton.module.css";

// Delay before the card renders in the background, after the screen paints.
const PRERENDER_DELAY_MS = 400;

type Phase = "idle" | "making" | "sharing";

/**
 * Shares the standings as an image card, or saves it where the browser
 * can't share files. The card is rendered ahead of the tap. While busy the
 * button stays focusable and ignores taps.
 */
export const ShareStandingsButton = ({ card }: { card: StandingsCardData }) => {
  const dispatch = useDispatch();
  const [phase, setPhase] = useState<Phase>("idle");
  const busy = useRef(false);
  const sharing = useMemo(() => canShareFiles(), []);
  const ready = useRef<{ card: StandingsCardData; blob: Promise<Blob> } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const blob = renderStandingsCard(card);
      ready.current = { card, blob };
      blob.catch((err) => {
        console.warn("Standings card render failed", err);
        if (ready.current?.card === card) ready.current = null;
      });
    }, PRERENDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [card]);

  const onClick = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("making");
    try {
      const blob = await (ready.current?.card === card ? ready.current.blob : renderStandingsCard(card));
      setPhase("sharing");
      await shareOrDownload(blob, cardFilename(card), `cour ${card.season.toLowerCase()} ${card.year} standings`);
    } catch (err) {
      console.error("Standings card share failed", err);
      ready.current = null;
      dispatch({
        type: "addToast",
        payload: {
          id: `standings-card-${Date.now()}`,
          message: "Couldn't make the image. Please try again.",
          appearance: "Failure",
          showTimeMs: 5000,
        },
      });
    } finally {
      busy.current = false;
      setPhase("idle");
    }
  };

  const label =
    phase === "making"
      ? "MAKING IMAGE…"
      : phase === "sharing"
        ? sharing
          ? "SHARING…"
          : "SAVING…"
        : sharing
          ? "SHARE IMAGE"
          : "SAVE IMAGE";

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      aria-disabled={phase !== "idle"}
      data-test-handle="share-standings"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d={sharing ? "M8 10V2M5 5l3-3 3 3M3 8v5h10V8" : "M8 2v8M5 7l3 3 3-3M3 13h10"}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </button>
  );
};
