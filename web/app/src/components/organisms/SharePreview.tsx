import { useMemo, useRef, useState } from "react";
import type { CardImageState } from "../../hooks/useStandingsCardImage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { CARD_USUAL_HEIGHT, CARD_WIDTH } from "../../utils/renderStandingsCard";
import { canShareFiles, downloadImage, shareImage } from "../../utils/shareFile";
import {
  cardAltText,
  cardFilename,
  listOf,
  type StandingsCardData,
  statusLine,
} from "../../utils/standingsCard";
import { standingsFinal, VIEW_NAMES } from "../../utils/standingsText";
import { DialogScrim } from "../molecules/DialogScrim";
import styles from "./SharePreview.module.css";

// A mouse or trackpad: right-click menus, downloads to a folder.
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

// A second save this soon is the same double-click, not a second copy.
const SAVE_REPEAT_MS = 1000;

// An empty frame in the card's usual shape, while there is no image.
const PLACEHOLDER_SRC = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_USUAL_HEIGHT}"/>`,
)}`;

interface SharePreviewProps {
  card: StandingsCardData;
  image: CardImageState;
  // The standings offer another view, so say which one the image shows.
  nameView: boolean;
  // Members whose ranking is still out.
  waitingOn: readonly string[];
  onClose: () => void;
}

/**
 * Shows the exact image before it leaves, then offers the one action this
 * browser can really do: the system share sheet on a phone that can share
 * files, a download everywhere else. The image is already made, so the
 * share runs inside the tap.
 */
export const SharePreview = ({ card, image: state, nameView, waitingOn, onClose }: SharePreviewProps) => {
  const finePointer = useMediaQuery(FINE_POINTER_QUERY);
  const canShare = useMemo(() => canShareFiles(), []);
  // The share sheet is open.
  const [sharing, setSharing] = useState(false);
  // This browser refused a share, so it gets the download from then on.
  const [refused, setRefused] = useState(false);
  // What happened to which image: a newer image starts with a clean caption.
  const [last, setLast] = useState<{ outcome: "downloaded" | "refused"; blob: Blob } | null>(null);
  const { image, making, failed, retry } = state;
  const ready = image != null && !making && !failed;
  const outcome = last && last.blob === image?.blob ? last.outcome : null;
  const filename = cardFilename(card);
  const final = standingsFinal(card.submittedCount, card.memberCount);
  const offerShare = canShare && !finePointer && !refused;

  const share = async () => {
    if (!image) return;
    setSharing(true);
    try {
      const result = await shareImage(image.blob, filename, `cour ${card.season.toLowerCase()} ${card.year} standings`);
      if (result === "shared") {
        onClose();
        return;
      }
    } catch (err) {
      console.warn("Share refused", err);
      setRefused(true);
      setLast({ outcome: "refused", blob: image.blob });
    }
    setSharing(false);
  };

  const lastSaveAt = useRef(Number.NEGATIVE_INFINITY);
  const download = () => {
    if (!image || performance.now() - lastSaveAt.current < SAVE_REPEAT_MS) return;
    lastSaveAt.current = performance.now();
    downloadImage(image.blob, filename);
    setLast({ outcome: "downloaded", blob: image.blob });
  };

  const primary = failed
    ? { label: "try again", run: retry }
    : offerShare
      ? { label: "share", run: () => void share() }
      : { label: "save image", run: download };
  const busy = !failed && (!ready || sharing);

  const caption = failed
    ? { tone: "error", text: "COULDN'T MAKE THE IMAGE" }
    : !ready
      ? { tone: "quiet", text: image ? "UPDATING THE IMAGE…" : "MAKING THE IMAGE…" }
      : outcome === "refused"
        ? { tone: "error", text: "COULDN'T SHARE · SAVE IT INSTEAD" }
        : outcome === "downloaded"
          ? { tone: "quiet", text: "CHECK YOUR DOWNLOADS" }
          : { tone: "quiet", text: "", spoken: "Image ready." };
  const missing =
    waitingOn.length === 0
      ? "Not every ranking is in yet."
      : `${listOf(waitingOn)} ${waitingOn.length === 1 ? "hasn't" : "haven't"} ranked yet.`;

  return (
    <DialogScrim
      label="Share the standings"
      alert={false}
      onDismiss={onClose}
      backdropClassName={styles.backdrop}
      dialogClassName={final ? styles.dialog : `${styles.dialog} ${styles.live}`}
    >
      <h2 className={styles.title}>share the standings.</h2>
      <p className={styles.context}>
        {nameView && `${VIEW_NAMES.all.toUpperCase()} · `}
        {statusLine(card)}
      </p>
      {!final && (
        <p className={styles.text}>
          {missing} Once it&apos;s sent, the image won&apos;t change.
        </p>
      )}
      {image && !failed ? (
        <img
          className={styles.image}
          src={image.url}
          width={image.width}
          height={image.height}
          alt={cardAltText(card)}
        />
      ) : (
        <img className={styles.image} src={PLACEHOLDER_SRC} alt="" data-state={failed ? "failed" : "making"} />
      )}
      <div className={styles.footer}>
        <div className={styles.actions}>
          <button type="button" className={styles.close} onClick={onClose}>
            close
          </button>
          <button
            type="button"
            className={styles.primary}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) primary.run();
            }}
            data-test-handle="share-primary"
          >
            {primary.label}
          </button>
        </div>
        <p className={styles.caption} role="status" data-tone={caption.tone}>
          {caption.text}
          {caption.spoken && <span className={styles.srOnly}>{caption.spoken}</span>}
        </p>
      </div>
    </DialogScrim>
  );
};
