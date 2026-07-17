import { useEffect, useMemo, useRef, useState } from "react";
import type { Media, VerdictValue } from "../../../../../types/reely";
import { AccountMenu } from "../organisms/AccountMenu";
import { AppHeader } from "../organisms/AppHeader";
import { LedgerStalled } from "./LedgerStalled";
import { Loading } from "./Loading";
import { DeckDetails } from "../organisms/DeckDetails";
import { DeckSheet } from "../organisms/DeckSheet";
import { VerdictRow } from "../molecules/VerdictRow";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { useStore } from "../../store";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import { posterSrc } from "../../utils/poster";
import { metaLine } from "../../utils/metaLine";
import styles from "./Deck.module.css";

// Keyboard verdicts (desktop only): a deliberate keypress is a button
// in spirit -- the guide's "buttons, not gestures, decide" is about
// commitment being explicit, not about the input device.
const KEY_VERDICTS: Record<string, VerdictValue> = {
  k: "like",
  p: "dislike",
  u: "skip",
};

/**
 * The deck. Mobile (design section 03): full-bleed poster, overlay top
 * bar, info block, and the collapsed sheet lip with the verdict row.
 * Desktop (docs/DESKTOP.md): a two-pane stage -- poster card left,
 * DeckDetails + verdict row right, no sheet (the details are always
 * visible). Both share the current-card computation and the exit flair.
 *
 * Current card = the first title in the room's (popularity-ordered) deck
 * without a verdict in the ledger; the progress chip is verdict count
 * over deck size. Both derive from store.review, fetched on room join
 * and updated per verdictSuccess.
 */
export const DeckScreen = () => {
  const [{ room, review, deckScope, connectionStatus, ledgerStalled }, dispatch] = useStore([
    "room",
    "review",
    "deckScope",
    "connectionStatus",
    "ledgerStalled",
  ]);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const verdictedIds = useMemo(
    () => new Set((review?.verdicts ?? []).map((v) => v.titleId)),
    [review],
  );

  const deck: Media[] = room?.media ?? [];
  const mediaById = useMemo(() => {
    const map = new Map<number, Media>();
    for (const m of deck) {
      if (m.anilistId != null) map.set(m.anilistId, m);
    }
    return map;
  }, [deck]);
  // Scoped re-review (0.10.0): the deck shows the scope's current title
  // instead of the season flow; verdicting advances the scope and its
  // end lands back on the review page (reducer-owned).
  const scopedMedia = deckScope
    ? mediaById.get(deckScope.titleIds[deckScope.position])
    : undefined;
  const mainFlow = useMemo(
    () => deck.find((m) => m.anilistId != null && !verdictedIds.has(m.anilistId)),
    [deck, verdictedIds],
  );
  const current = deckScope ? scopedMedia : mainFlow;

  // Poster preload (audit 17 UX 9): the incoming card's image used to
  // start downloading only at crossfade time. Warm the next unverdicted
  // title's poster so every advance lands inside the dissolve.
  const nextUp = useMemo(() => {
    if (deckScope) {
      const nextId = deckScope.titleIds[deckScope.position + 1];
      return nextId != null ? mediaById.get(nextId) : undefined;
    }
    let seenCurrent = false;
    for (const m of deck) {
      if (m.anilistId == null || verdictedIds.has(m.anilistId)) continue;
      if (seenCurrent) return m;
      if (m.anilistId === current?.anilistId) seenCurrent = true;
    }
    return undefined;
  }, [deck, verdictedIds, deckScope, mediaById, current]);
  useEffect(() => {
    const url = nextUp?.posterUrl;
    if (!url) return;
    const img = new Image();
    img.src = posterSrc(url) ?? url;
  }, [nextUp]);

  // A scoped title can vanish from room.media (filter change mid-pass);
  // bail back to the review page rather than render nothing.
  useEffect(() => {
    if (deckScope && !scopedMedia) dispatch({ type: "exitDeckScope" });
  }, [deckScope, scopedMedia, dispatch]);

  // Card-exit flair (style guide 07 + a verdict-colored wash): when a
  // verdict advances the deck, the outgoing poster stays mounted for a
  // beat -- fading and settling down -- with a brief pulse in the
  // verdict's color (accent for like, clay for dislike, nothing for
  // skip: a skip should feel like a shrug). The incoming card's
  // fade-in runs underneath for a true crossfade.
  const [exiting, setExiting] = useState<{ media: Media; verdict: VerdictValue } | null>(null);
  const prevCardRef = useRef<Media | undefined>(undefined);
  useEffect(() => {
    const prev = prevCardRef.current;
    prevCardRef.current = current;
    if (!prev || !current || prev.anilistId === current.anilistId) return;
    const verdict = review?.verdicts.find((v) => v.titleId === prev.anilistId)?.verdict;
    // No ledger entry for the outgoing card = the advance wasn't a
    // verdict (scope navigation, filter change) -- no ceremony.
    if (!verdict) return;
    setExiting({ media: prev, verdict });
    // Must outlast the .exitLayer dissolve (460ms) or it unmounts
    // mid-animation and snaps.
    const timer = setTimeout(() => setExiting(null), 500);
    return () => clearTimeout(timer);
  }, [current, review]);

  // Keyboard verdicts (desktop only). Ignored while an input/textarea/
  // contentEditable has focus, or with a modifier held (browser
  // shortcuts win).
  const currentId = current?.anilistId;
  const connected = connectionStatus === "connected";
  useEffect(() => {
    // `connected`: keyboard verdicts disable while disconnected, same as
    // the button row -- a parked verdict fires before the auto-rejoin
    // completes and is lost to "Set your name first." (audit 17 M7).
    if (!isDesktop || currentId == null || !connected) return;
    const onKey = (e: KeyboardEvent) => {
      // OS key-repeat: a held key fires one keydown per repeat tick, and
      // each success advances the card -- a two-second hold would verdict
      // a chunk of the season (audit 17 H6). One verdict per press.
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      const verdict = KEY_VERDICTS[e.key.toLowerCase()];
      if (!verdict) return;
      e.preventDefault();
      dispatch({ type: "verdict", payload: { titleId: currentId, verdict } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, currentId, connected, dispatch]);

  // Hook: must run before the early return below.
  const { season } = useSeason();

  if (!room) {
    // Not a dead end (audit 17): hand the user the way back to the join
    // form instead of a bare sentence.
    return (
      <div className={styles.emptyScreen}>
        <h1 className={styles.emptyHeadline}>you are not in a room.</h1>
        <button
          type="button"
          className={styles.emptyCta}
          onClick={() => dispatch({ type: "navigate", payload: { route: "home" } })}
          data-test-handle="to-join"
        >
          join a room
        </button>
      </div>
    );
  }

  // The ledger hasn't arrived yet (post-join fetch in flight or being
  // retried). Rendering live verdict buttons here shows the season's
  // FIRST card to a user who may be mid-pass or finished, and a tap
  // silently overwrites the verdict they already recorded (audit 17 H5).
  // Hold the deck until the ledger exists.
  if (!review) return ledgerStalled ? <LedgerStalled /> : <Loading />;

  const total = review.total;
  const done = verdictedIds.size;
  const kanji = SEASON_THEMES[season].kanji;

  // (Momentary blank while the exit effect fires.)
  if (deckScope && !scopedMedia) return <div />;

  if (!current) {
    // Deck exhausted (or filters emptied it). The review screen is where
    // lock-in lives; keep this state quiet until then. (Centered column
    // -- works on both mobile and desktop unchanged.) Locked users get
    // honest copy: their picks are in, the standings are the destination
    // (audit 17 H4 -- "time to lock in" was a lie weeks after they did).
    const locked = review.lockedAt != null;
    return (
      <div className={styles.emptyScreen}>
        <p className={styles.emptyKicker}>{done} / {total}</p>
        {locked ? (
          <>
            <h1 className={styles.emptyHeadline}>that&apos;s a wrap on the season.</h1>
            <p className={styles.emptyText}>your picks are locked in.</p>
            <button
              type="button"
              className={styles.emptyCta}
              onClick={() => dispatch({ type: "navigate", payload: { route: "home" } })}
              data-test-handle="to-standings"
            >
              see the standings
            </button>
          </>
        ) : (
          <>
            <h1 className={styles.emptyHeadline}>that&apos;s the whole season.</h1>
            <p className={styles.emptyText}>time to look over your picks and lock in.</p>
            <button
              type="button"
              className={styles.emptyCta}
              onClick={() => dispatch({ type: "navigate", payload: { route: "home" } })}
              data-test-handle="to-review"
            >
              see your review
            </button>
          </>
        )}
        <div className={styles.emptyAvatar}>
          <AccountMenu />
        </div>
      </div>
    );
  }

  const poster = posterSrc(current.posterUrl);
  const currentVerdict = review?.verdicts.find((v) => v.titleId === current.anilistId)?.verdict;

  // Progress chip / scope-back control -- shared content, styled per
  // layout by its container.
  const progressControl = deckScope ? (
    <button
      type="button"
      className={isDesktop ? styles.deskBackChip : styles.backChip}
      onClick={() => dispatch({ type: "exitDeckScope" })}
      data-test-handle="scope-back"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {deckScope.titleIds.length > 1 ? (
        <span>
          {deckScope.position + 1}{" "}
          <span className={styles.progressTotal}>/ {deckScope.titleIds.length}</span>
        </span>
      ) : (
        <span>REVIEW</span>
      )}
    </button>
  ) : (
    <span className={isDesktop ? styles.deskProgressChip : styles.progressChip}>
      {done} <span className={styles.progressTotal}>/ {total}</span>
    </span>
  );

  const roomStack = (
    <div className={styles.roomStack}>
      <span className={styles.roomLabel}>{room.displayName ?? room.name}</span>
      <span className={styles.wordRow}>
        <span className={styles.word} translate="no">cour</span>
        <span className={styles.kanjiChip} aria-hidden="true">{kanji}</span>
      </span>
    </div>
  );

  // ── Desktop: two-pane stage (docs/DESKTOP.md) ──
  if (isDesktop) {
    return (
      <div className={styles.deskScreen}>
        <AppHeader leading={progressControl} roomLabel={room.displayName ?? room.name} />

        <div className={styles.stage}>
          <div className={styles.posterPane}>
            {poster && (
              <img
                key={current.id}
                className={styles.poster}
                src={poster}
                alt=""
                draggable={false}
              />
            )}
            {exiting?.media.posterUrl && (
              <div
                key={exiting.media.id}
                className={styles.exitLayer}
                data-verdict={exiting.verdict}
                aria-hidden="true"
                data-test-handle="card-exit"
              >
                <img className={styles.exitPoster} src={posterSrc(exiting.media.posterUrl)} alt="" />
                <div className={styles.exitWash} />
              </div>
            )}
          </div>

          <div className={styles.detailPane}>
            <div className={styles.detailScroll}>
              <DeckDetails media={current} />
            </div>
            <div className={styles.verdictDock}>
              <VerdictRow
                titleId={current.anilistId as number}
                remaining={total - done}
                allowSkipAll={!deckScope}
                currentVerdict={currentVerdict}
              />
              <p className={styles.kbdHint} aria-hidden="true">
                <span><kbd>P</kbd> pass</span>
                <span><kbd>U</kbd> unsure</span>
                <span><kbd>K</kbd> keep</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Mobile: full-bleed poster + bottom sheet (design section 03) ──
  return (
    <div className={styles.screen}>
      {poster && (
        <img
          key={current.id}
          className={styles.poster}
          src={poster}
          alt=""
          draggable={false}
        />
      )}
      <div className={styles.scrim} />

      {exiting?.media.posterUrl && (
        <div
          key={exiting.media.id}
          className={styles.exitLayer}
          data-verdict={exiting.verdict}
          aria-hidden="true"
          data-test-handle="card-exit"
        >
          <img
            className={styles.exitPoster}
            src={posterSrc(exiting.media.posterUrl)}
            alt=""
          />
          <div className={styles.exitWash} />
        </div>
      )}

      <header className={styles.topBar}>
        {progressControl}
        {roomStack}
        <div className={styles.topActions}>
          <AccountMenu />
        </div>
      </header>

      <div className={styles.infoBlock} key={`info-${current.id}`}>
        {current.genres.length > 0 && (
          <div className={styles.genreRow}>
            {current.genres.slice(0, 3).map((g) => (
              <span key={g} className={styles.genreTag}>{g}</span>
            ))}
          </div>
        )}
        <h1 className={styles.title}>{current.title}</h1>
        {current.titleRomaji && (
          <p className={styles.romaji}>{current.titleRomaji}</p>
        )}
        <p className={styles.metaLine}>{metaLine(current, season)}</p>
      </div>

      <DeckSheet
        media={current}
        remaining={total - done}
        allowSkipAll={!deckScope}
        currentVerdict={currentVerdict}
      />
    </div>
  );
};
