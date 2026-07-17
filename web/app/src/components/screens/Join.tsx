import { useState } from "react";
import styles from "./Join.module.css";
import { AuthBackground } from "../atoms/AuthBackground";
import { CourMark } from "../atoms/CourMark";
import { Layout } from "../layout/Layout";
import { useStore } from "../../store";
import { getStoredName, getStoredRoom } from "../../utils/prefs";
import { useSeason } from "../../hooks/useSeason";

/**
 * The join form (0.12.0: reely's model, cour's clothes). A name and a
 * room -- no password, no account. Both fields remember themselves; a
 * ?roomName link pre-fills the room. Rendered by the home route whenever
 * there's no joined room.
 */
export const JoinScreen = () => {
  const [{ error, joinError, connectionStatus }, dispatch] = useStore([
    "error",
    "joinError",
    "connectionStatus",
  ]);
  const [name, setName] = useState(() => getStoredName() ?? "");
  const [roomName, setRoomName] = useState(() => {
    const fromUrl = new URLSearchParams(location.search).get("roomName");
    return fromUrl ?? getStoredRoom() ?? "";
  });

  const { season, year } = useSeason();
  const canSubmit =
    name.trim().length > 0 &&
    roomName.trim().length > 0 &&
    connectionStatus === "connected";

  const roomErrorText =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : undefined;
  const errorText = joinError ?? roomErrorText;

  const submit = () => {
    if (!canSubmit) return;
    // chooseRoom persists the typed room AND revokes any ?roomName deep
    // link (audit v1.2.0 #4: the URL's room used to silently beat an
    // edited field); login persists the name via its dispatch
    // side-effect, and loginSuccess auto-joins the chosen room.
    dispatch({ type: "chooseRoom", payload: { roomName: roomName.trim().toLowerCase() } });
    dispatch({ type: "login", payload: { userName: name.trim() } });
  };

  return (
    <Layout hideLogo className={styles.screen}>
      <AuthBackground />
      <div className={styles.inner}>
        <header className={styles.topBar}>
          <span className={styles.seasonLabel}>
            {season} {year}
          </span>
        </header>

        <div className={styles.spacer} />

        {/* The stylized wordmark (style guide: "the mark IS the c") --
            mark at ~0.9x the word's cap height, optically centered on
            the x-height, 2px gap, heavier dots (r=5) as the c's
            counter. Auth masthead is exactly its sanctioned home. */}
        <div className={styles.logotype} translate="no" role="img" aria-label="cour">
          <CourMark size={52} dotRadius={5} />
          <span className={styles.logotypeWord} aria-hidden="true">our</span>
        </div>
        <h1 className={styles.headline}>the season is waiting.</h1>
        <p className={styles.subline}>a name and a room. that&apos;s it.</p>

        {/* No `submitted` gate (audit 17 M8): the auto-rejoin's errors
            land on a FRESH mount of this form -- a second device claiming
            the same stored name used to arrive at a join form with no
            message at all. Any join/login error present in the store is
            the reason the user is looking at this screen; show it. */}
        {errorText && (
          <div className={styles.errorBox} role="alert">{errorText}</div>
        )}

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="join-name">
              Your name
            </label>
            <input
              id="join-name"
              className={styles.input}
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="join-room">
              Room name
            </label>
            <input
              id="join-room"
              className={styles.input}
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={64}
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
            />
          </div>

          <button type="submit" className={styles.ctaButton} disabled={!canSubmit}>
            {connectionStatus === "connected" ? "open the room" : "connecting\u2026"}
          </button>
        </form>

        <p className={styles.footer}>SHARE THE ROOM NAME TO PICK TOGETHER</p>
      </div>
    </Layout>
  );
};
