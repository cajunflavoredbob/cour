import { useState } from "react";
import { AvatarButton } from "../atoms/AvatarButton";
import { DialogScrim } from "../molecules/DialogScrim";
import { useEscape } from "../../hooks/useEscape";
import { useDispatch, useStore } from "../../store";
import styles from "./AccountMenu.module.css";

/**
 * The account popover: a speech bubble hanging off the avatar. Your name,
 * the autoplay toggle, and (in a room) quick nav -- a "keep going" jump
 * back to the next unrated title when the deck is unfinished, a link to
 * the review ledger, a room-share, and Leave room. Identity is just the
 * name you typed on the join form; leaving lands back there.
 */
export const AccountMenu = () => {
  const [{ user, soundPref, room, review, route }] = useStore([
    "user",
    "soundPref",
    "room",
    "review",
    "route",
  ]);
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);
  // Share-link fallback dialog (audit 17 UX 5): navigator.clipboard is
  // undefined on plain-HTTP LAN -- the primary deployment -- so the old
  // fallback was an unselectable toast that vanished in 8 seconds.
  const [shareLink, setShareLink] = useState<string | null>(null);

  const close = () => setOpen(false);
  useEscape(close, open);

  if (!user) return null;

  // Injected into the HTML shell at request time (data-version on <body>).
  const version = document.body.dataset.version;
  const inRoom = room?.joined ?? false;
  const locked = review?.lockedAt != null;
  const remaining = (review?.total ?? 0) - (review?.verdicts.length ?? 0);
  const onDeck = route === "room";
  // "Keep going" jumps to the deck, whose main flow is the first title
  // without a verdict -- so it drops you on the next unrated one. Only
  // worth showing when the deck is unfinished and you're not on it.
  const showKeepGoing = inRoom && !locked && remaining > 0 && !onDeck;
  // A way back to the review ledger from the deck (even mid-deck).
  const showReview = inRoom && !locked && onDeck;
  // After lock-in the ledger is a read-only peek off the standings
  // (audit 17 UX 6); before, it became unreachable forever.
  const showLockedReview = inRoom && locked;

  const navigate = (r: "home" | "room") => {
    dispatch({ type: "navigate", payload: { route: r } });
    close();
  };

  const shareRoom = async () => {
    // A join link: ?roomName pre-fills the room on the join form (the
    // invitee still types their own name). Uses the display name for a
    // friendly pre-fill; the join lowercases it to the same room.
    const url = new URL(location.href);
    url.pathname = `${document.body.dataset.rootPath ?? ""}/`;
    url.search = `?roomName=${encodeURIComponent(room?.displayName ?? room?.name ?? "")}`;
    url.hash = "";
    const link = url.href;
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(link);
        dispatch({
          type: "addToast",
          payload: { id: `share-${Date.now()}`, message: "Room link copied", showTimeMs: 3000, appearance: "Success" },
        });
      } catch {
        // Clipboard write refused (permissions) -- dialog to copy by hand.
        setShareLink(link);
      }
    } else {
      // No clipboard API (insecure context, i.e. plain-HTTP LAN) -- a
      // select-on-focus dialog instead of a vanishing toast.
      setShareLink(link);
    }
    close();
  };

  return (
    <div className={styles.anchor}>
      <AvatarButton userName={user.userName} onClick={() => setOpen((o) => !o)} />
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: transparent outside-tap catcher; Esc is the keyboard path. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: transparent outside-tap catcher; Esc is the keyboard path. */}
          <div className={styles.scrim} onClick={close} />
          <div className={styles.bubble} role="menu" aria-label="Account">
            <div className={styles.caret} aria-hidden="true" />

            <div className={styles.header}>
              <span className={styles.headerName}>{user.userName}</span>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel}>Autoplay PVs with sound</span>
              <button
                type="button"
                className={styles.togglePill}
                role="switch"
                aria-checked={soundPref ?? false}
                aria-label="Autoplay PVs with sound"
                data-on={soundPref ?? false}
                onClick={() =>
                  dispatch({ type: "soundPref", payload: { enabled: !soundPref } })
                }
              >
                <span className={styles.toggleKnob} />
              </button>
            </div>

            {showKeepGoing && (
              <button
                type="button"
                className={styles.keepGoing}
                onClick={() => navigate("room")}
                data-test-handle="menu-keep-going"
              >
                Keep going <span className={styles.keepGoingCount}>&middot; {remaining} left</span>
              </button>
            )}

            {showReview && (
              <button
                type="button"
                className={styles.rowButton}
                onClick={() => navigate("home")}
                data-test-handle="menu-review"
              >
                See your review
              </button>
            )}

            {showLockedReview && (
              <button
                type="button"
                className={styles.rowButton}
                onClick={() => {
                  dispatch({ type: "viewLockedReview", payload: { open: true } });
                  navigate("home");
                }}
                data-test-handle="menu-locked-review"
              >
                See your review
              </button>
            )}

            {inRoom && (
              <button
                type="button"
                className={styles.rowButton}
                onClick={shareRoom}
                data-test-handle="menu-share"
              >
                Share room
              </button>
            )}

            {inRoom && (
              <button
                type="button"
                className={styles.logoutButton}
                onClick={() => {
                  dispatch({ type: "leaveRoom" });
                  close();
                }}
              >
                Leave room
              </button>
            )}

            {version && (
              <p className={styles.version} data-test-handle="menu-version">
                v{version}
              </p>
            )}
          </div>
        </>
      )}
      {shareLink && (
        <DialogScrim
          label="Share this room"
          onDismiss={() => setShareLink(null)}
          backdropClassName={styles.shareBackdrop}
          dialogClassName={styles.shareDialog}
        >
          <h2 className={styles.shareTitle}>share this room</h2>
          <p className={styles.shareText}>
            Copy the link below -- it pre-fills the room on the join form.
          </p>
          <input
            className={styles.shareInput}
            type="text"
            readOnly
            value={shareLink}
            onFocus={(e) => e.target.select()}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists solely to hand over this value; focusing + selecting it IS the interaction.
            autoFocus
            data-test-handle="share-link-input"
          />
          <button
            type="button"
            className={styles.shareClose}
            onClick={() => setShareLink(null)}
          >
            Done
          </button>
        </DialogScrim>
      )}
    </div>
  );
};
