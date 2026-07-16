import { useEffect, useRef, useState } from "react";
import type { Media } from "../../../../../types/reely";
import { AnimeLinks } from "../atoms/AnimeLinks";
import { useStore } from "../../store";
import { useSeason } from "../../hooks/useSeason";
import { metaLine } from "../../utils/metaLine";
import { posterSrc } from "../../utils/poster";
import styles from "./DeckDetails.module.css";

interface DeckDetailsProps {
  media: Media;
}

interface MediaTile {
  key: string;
  kind: "pv" | "hero" | "still";
  // Proxied /api/poster path for still tiles.
  src?: string;
}

// Strip cap (the owner's call, seventh live pass): one video plus at most
// ten images -- the hero counts, so up to nine stills. The strip is a
// plain horizontal scroller; no overflow stacking.
const MAX_IMAGE_TILES = 10;
// How long an unmuted embed gets to report "playing" before we assume
// the browser's autoplay policy blocked it and fall back to muted.
const AUTOPLAY_GRACE_MS = 2500;
// How long every IMAGE tile stays up -- in normal rotation or after a
// tap -- with the progress bar counting it down. Must match the CSS
// cour-hold animation. Video ignores this: it plays to the end.
const IMAGE_HOLD_MS = 7000;

/**
 * A title's full detail block: the Steam-style media box (with the
 * whole PV state machine -- one-shot autoplay round, blocked-autoplay
 * fallback, command-channel unmute, ended/error signals over the
 * IFrame-API postMessage channel), the thumb strip, title block,
 * synopsis, and AniList/MAL links.
 *
 * Extracted from DeckSheet for the desktop split (docs/DESKTOP.md):
 * mobile mounts it inside the sheet only while open (which is also the
 * closed-sheet-can't-play-audio guarantee); desktop mounts it
 * permanently in the right pane. All per-title state resets when the
 * media prop advances underneath.
 */
export const DeckDetails = ({ media }: DeckDetailsProps) => {
  const [{ soundPref }] = useStore(["soundPref"]);

  // Per-title media-box state; reset when the deck advances under us so
  // the next card starts from the design default (PV first, muted).
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  // Browsers block UNMUTED autoplay until they consider the user
  // engaged; when an unmuted embed fails to start within the grace
  // period we fall back to muted autoplay + the TAP FOR SOUND chip.
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  // Increments on every image-thumb tap so re-tapping the CURRENT tile
  // also restarts the 7s timer and the progress bar's CSS animation.
  const [imageHold, setImageHold] = useState(0);
  // Live playing/paused state from the player's event stream -- a
  // playing video parks the rotation and dismisses the progress bar.
  const [pvPlaying, setPvPlaying] = useState(false);
  // The player reported an error (deleted video, embedding disabled,
  // ...). The tile stays in rotation but renders the watch-on-YouTube
  // card instead of the embed.
  const [pvError, setPvError] = useState(false);
  const sawPlaying = useRef(false);
  // The autoplay setting buys ONE automatic play per card. After that
  // -- or with the setting off -- the video tile is a passive rotation
  // citizen: no autoplay, 7s bar, and a user tap on the player parks
  // it with audio (the passive embed loads unmuted).
  const autoplayUsed = useRef(false);
  const pvRoundRef = useRef<"auto" | "passive">("passive");
  const prevPvActive = useRef(false);
  // The embed's mute URL param. Changing it reloads the iframe, so it
  // only moves when a reload is intended: per-card initialization and
  // the blocked-autoplay fallback. Unmuting a RUNNING player goes over
  // the command channel instead -- a src swap would restart the video.
  const [embedMute, setEmbedMute] = useState(() => (soundPref ? 0 : 1));

  // The render-latch refs reset DURING render on a card change, not in
  // an effect. An effect runs AFTER the first render -- and on mount it
  // would clobber the just-set autoplay latch (the render-time latch
  // below sets autoplayUsed on the first PV; a mount effect resetting
  // it hands out a second free autoplay). This is the prop-derived
  // ref-reset pattern: adjust during render, keyed to the card.
  const cardRef = useRef(media.id);
  if (cardRef.current !== media.id) {
    cardRef.current = media.id;
    autoplayUsed.current = false;
    pvRoundRef.current = "passive";
    prevPvActive.current = false;
    sawPlaying.current = false;
  }

  // State resets (not refs) are safe in an effect: they don't race the
  // render latch, and setState during render would loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: media.id IS the reset trigger.
  useEffect(() => {
    setActive(0);
    setMuted(true);
    setAutoplayBlocked(false);
    setEmbedMute(soundPref ? 0 : 1);
    setImageHold(0);
    setPvPlaying(false);
    setPvError(false);
  }, [media.id]);

  const pvFrameRef = useRef<HTMLIFrameElement>(null);

  const pvUnmuted = (!muted || Boolean(soundPref)) && !autoplayBlocked;
  const poster = posterSrc(media.posterUrl);
  const { season } = useSeason();

  // PV first when one exists (design: "PV video leads"), hero cover
  // always as the fallback slot, TMDB stills after.
  const tiles: MediaTile[] = [
    ...(media.trailer?.site === "youtube" ? [{ key: "pv", kind: "pv" as const }] : []),
    { key: "hero", kind: "hero" as const },
    ...(media.screenshotUrls ?? []).slice(0, MAX_IMAGE_TILES - 1).map((src, i) => ({
      key: `still-${i}`,
      kind: "still" as const,
      src,
    })),
  ];
  const activeTile = tiles[active] ?? tiles[0];

  // Steam-style media rotation, one rule for everything: an image tile
  // -- rotation-served or tapped -- holds IMAGE_HOLD_MS behind the
  // progress bar, then advances. The video tile parks the rotation
  // (however it came up) and the player's ended event advances it. The
  // timeout is keyed per tile (active) and per tap (imageHold), so a
  // tap always buys a full fresh hold.
  const pvActive = activeTile?.kind === "pv";
  // Latch the video tile's round on ENTRY (render-time so the iframe
  // mounts with the right src): the first arrival with the autoplay
  // setting on is the one automatic play; everything after is passive.
  if (pvActive && !prevPvActive.current) {
    pvRoundRef.current =
      soundPref && !autoplayUsed.current ? "auto" : "passive";
    if (pvRoundRef.current === "auto") autoplayUsed.current = true;
  }
  prevPvActive.current = pvActive;
  const pvAuto = pvActive && pvRoundRef.current === "auto";
  // Parked: the rotation waits on the video -- during its one autoplay
  // round, or whenever the user set it playing. An errored video is
  // never parked: its watch-on-YouTube card rides the normal 7s hold.
  const pvParked = pvActive && !pvError && (pvAuto || pvPlaying);

  // biome-ignore lint/correctness/useExhaustiveDependencies: active + imageHold key the per-tile hold; tiles.length is stable per card.
  useEffect(() => {
    if (pvParked || tiles.length < 2) return;
    const timer = setTimeout(() => {
      setActive((i) => (i + 1) % tiles.length);
    }, IMAGE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [pvParked, active, imageHold, tiles.length]);

  // Leaving the video tile always clears its playing latch.
  useEffect(() => {
    if (!pvActive) setPvPlaying(false);
  }, [pvActive]);

  // The strip follows the cycler: the active thumb scrolls into view.
  const stripRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` drives WHICH thumb carries data-active; the DOM query can't declare it.
  useEffect(() => {
    stripRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [active]);

  // Autoplay watchdog: an embed that LOADED unmuted but never reports
  // playing within the grace period was blocked -- reload it muted.
  useEffect(() => {
    if (!pvAuto || pvError || embedMute !== 0) return;
    const watchdog = setTimeout(() => {
      if (!sawPlaying.current) {
        setAutoplayBlocked(true);
        setEmbedMute(1);
      }
    }, AUTOPLAY_GRACE_MS);
    return () => clearTimeout(watchdog);
  }, [pvAuto, pvError, embedMute]);

  // The "video ended" signal: the embed carries enablejsapi=1 and we run
  // the IFrame-API postMessage handshake by hand (no YouTube script).
  // After the `listening` handshake the player streams state events;
  // state 0 is ENDED -> un-pin and advance, which restarts the cycle.
  useEffect(() => {
    if (!pvActive) return;
    const frame = pvFrameRef.current;
    if (!frame) return;
    // The player reports ended through BOTH shapes (onStateChange AND
    // infoDelivery) -- without this latch the advance fired twice and
    // the cycle skipped the tile right after the video.
    let endedSeen = false;
    const onMessage = (e: MessageEvent) => {
      const fromPlayer =
        (frame.contentWindow != null && e.source === frame.contentWindow) ||
        e.origin === "https://www.youtube-nocookie.com";
      if (!fromPlayer) return;
      let data: unknown;
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const msg = data as {
        event?: string;
        info?: number | { playerState?: number };
      };
      // Deleted/private videos and embedding-disabled uploads surface
      // as onError (codes 2/5/100/101/150) -- flip the tile to the
      // watch-on-YouTube card.
      if (msg.event === "onError") {
        setPvError(true);
        setPvPlaying(false);
        return;
      }
      const state =
        msg.event === "onStateChange" && typeof msg.info === "number"
          ? msg.info
          : msg.event === "infoDelivery" && typeof msg.info === "object"
            ? msg.info?.playerState
            : undefined;
      // 1 = playing, 3 = buffering: playback is live -- parks the
      // rotation and dismisses the bar. 2 = paused hands it back.
      if (state === 1 || state === 3) {
        sawPlaying.current = true;
        setPvPlaying(true);
      } else if (state === 2) {
        setPvPlaying(false);
      }
      if (state === 0 && !endedSeen) {
        endedSeen = true;
        setPvPlaying(false);
        setActive((i) => (i + 1) % tiles.length);
      }
    };
    window.addEventListener("message", onMessage);
    // The player only emits events to windows that announced themselves;
    // repeat the handshake briefly (the embed may still be booting).
    const handshake = setInterval(() => {
      const target = frame.contentWindow;
      if (!target) return;
      target.postMessage(
        JSON.stringify({ event: "listening", id: "cour-pv", channel: "widget" }),
        "*",
      );
      // Without this command the player never emits onStateChange --
      // `listening` alone only buys the infoDelivery stream.
      for (const eventName of ["onStateChange", "onError"]) {
        target.postMessage(
          JSON.stringify({
            event: "command",
            func: "addEventListener",
            args: [eventName],
            id: "cour-pv",
            channel: "widget",
          }),
          "*",
        );
      }
    }, 500);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 5000);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
    };
  }, [pvActive, tiles.length]);

  return (
    <div className={styles.details}>
      <div className={styles.mediaBox} key={activeTile?.key ?? "empty"}>
        {activeTile?.kind === "pv" && media.trailer && pvError ? (
          <div className={styles.pvErrorCard}>
            {poster && (
              <img className={styles.pvErrorBg} src={poster} alt="" />
            )}
            <p className={styles.pvErrorText}>
              The preview hit an error here.
            </p>
            <a
              className={styles.pvErrorLink}
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(media.trailer.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Watch directly on YouTube
            </a>
          </div>
        ) : activeTile?.kind === "pv" && media.trailer ? (
          <>
            <iframe
              ref={pvFrameRef}
              className={styles.pvFrame}
              // Privacy-enhanced host; muted by default per the design.
              // soundPref ON starts unmuted -- the autoplay-with-sound
              // preference.
              src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(media.trailer.id)}?autoplay=${pvAuto ? 1 : 0}&mute=${pvAuto ? embedMute : 0}&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
              title={`${media.title} PV`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            {pvAuto && !pvUnmuted && (
              <button
                type="button"
                className={styles.soundChip}
                onClick={() => {
                  // Unmute the RUNNING player via the command channel --
                  // no src change, no reload, the video keeps its
                  // position.
                  const target = pvFrameRef.current?.contentWindow;
                  for (const cmd of [
                    { func: "unMute", args: [] as unknown[] },
                    { func: "setVolume", args: [100] as unknown[] },
                  ]) {
                    target?.postMessage(
                      JSON.stringify({
                        event: "command",
                        ...cmd,
                        id: "cour-pv",
                        channel: "widget",
                      }),
                      "*",
                    );
                  }
                  setMuted(false);
                  setAutoplayBlocked(false);
                }}
              >
                TAP FOR SOUND
              </button>
            )}
            <span className={styles.pvChip}>PV</span>
          </>
        ) : activeTile?.kind === "still" && activeTile.src ? (
          <img className={styles.heroImg} src={activeTile.src} alt="" />
        ) : (
          poster && <img className={styles.heroImg} src={poster} alt="" />
        )}
        {!pvParked && tiles.length > 1 && (
          <div className={styles.holdBar} aria-hidden="true">
            <div
              key={`${active}-${imageHold}-${pvPlaying}`}
              className={styles.holdFill}
            />
          </div>
        )}
      </div>

      {tiles.length > 1 && (
        <div className={styles.thumbStrip} ref={stripRef}>
          {tiles.map((tile, i) => (
            <button
              key={tile.key}
              type="button"
              className={styles.thumb}
              data-active={i === active}
              aria-label={
                tile.kind === "pv"
                  ? "Trailer"
                  : tile.kind === "still"
                    ? "Screenshot"
                    : "Cover art"
              }
              onClick={() => {
                setActive(i);
                // Images restart their 7s hold; the video parks the
                // rotation until it ends.
                if (tile.kind !== "pv") setImageHold((k) => k + 1);
              }}
            >
              {(tile.kind === "still" && tile.src ? tile.src : poster) && (
                <img
                  className={styles.thumbImg}
                  src={tile.kind === "still" && tile.src ? tile.src : (poster as string)}
                  alt=""
                />
              )}
              {tile.kind === "pv" && (
                <span className={styles.thumbPlay} aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M3.5 2.5v7l6-3.5-6-3.5Z" fill="currentColor" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className={styles.textBlock}>
        <h2 className={styles.title}>{media.title}</h2>
        {media.titleRomaji && <p className={styles.romaji}>{media.titleRomaji}</p>}
        <p className={styles.metaLine}>{metaLine(media, season)}</p>
        {media.genres.length > 0 && (
          <div className={styles.genreRow}>
            {media.genres.map((g) => (
              <span key={g} className={styles.genreTag}>{g}</span>
            ))}
          </div>
        )}
        {media.description && (
          <p className={styles.synopsis}>{media.description}</p>
        )}
        <AnimeLinks media={media} />
      </div>
    </div>
  );
};
