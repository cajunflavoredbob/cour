import { useCallback, useEffect, useRef, useState } from "react";
import { renderStandingsCard } from "../utils/renderStandingsCard";
import { imageDataUrl, pngSize } from "../utils/shareFile";
import { cardSignature, type StandingsCardData } from "../utils/standingsCard";

export interface CardImage {
  blob: Blob;
  // A data: URL for the preview.
  url: string;
  width: number;
  height: number;
  // False when a font or poster missed the deadline and the card drew without it.
  complete: boolean;
}

export interface CardImageState {
  // The latest image made. It stays while a newer one renders.
  image: CardImage | null;
  // The image for the current standings is still being made.
  making: boolean;
  // Making the image for the current standings failed.
  failed: boolean;
  // Makes the image again after a failed render.
  retry: () => void;
  // Makes the image again if the current one drew without a font or poster.
  refresh: () => void;
}

// Where requestIdleCallback is missing, the render waits this long instead.
const FALLBACK_DELAY_MS = 400;
// The longest the render waits for idle time.
const IDLE_TIMEOUT_MS = 1500;

/**
 * Makes the standings card in idle time while `card` is set (pass null
 * while the standings are off screen). One render per distinct card
 * content: a fresh object with the same standings does not re-render.
 */
export const useStandingsCardImage = (card: StandingsCardData | null): CardImageState => {
  const signature = card ? cardSignature(card) : null;
  const cardRef = useRef(card);
  cardRef.current = card;
  const [image, setImage] = useState<CardImage | null>(null);
  // The card content the image shows, and the content whose render failed.
  const [madeFor, setMadeFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs a render on retry.
  useEffect(() => {
    if (signature == null || signature === madeFor) return;
    let stale = false;
    const run = () => {
      const current = cardRef.current;
      if (!current) return;
      setFailedFor((last) => (last === signature ? null : last));
      renderStandingsCard(current)
        .then(async ({ blob, complete }) => {
          const [url, size] = await Promise.all([imageDataUrl(blob), pngSize(blob)]);
          if (stale) return;
          setImage({ blob, url, complete, ...size });
          setMadeFor(signature);
          setFailedFor(null);
        })
        .catch((err) => {
          if (stale) return;
          console.warn("Standings card render failed", err);
          setFailedFor(signature);
        });
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      return () => {
        stale = true;
        cancelIdleCallback(handle);
      };
    }
    const timer = setTimeout(run, FALLBACK_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [signature, madeFor, attempt]);

  // The current image stays up while the new one renders.
  const retry = useCallback(() => {
    setMadeFor(null);
    setFailedFor(null);
    setAttempt((n) => n + 1);
  }, []);

  const failed = signature != null && failedFor === signature;
  const making = signature != null && signature !== madeFor && !failed;
  const refresh = () => {
    if (image && !image.complete && !making && !failed) retry();
  };
  return { image, making, failed, retry, refresh };
};
