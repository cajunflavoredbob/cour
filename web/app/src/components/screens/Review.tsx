import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Media, VerdictValue } from "../../../../../types/reely";
import { AppHeader } from "../organisms/AppHeader";
import { MobileHeader } from "../organisms/MobileHeader";
import { DialogScrim } from "../molecules/DialogScrim";
import { PillTabs, tabId, tabPanelProps } from "../molecules/PillTabs";
import { useBackStep } from "../../hooks/useBackStep";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { useDispatch, useStore } from "../../store";
import { roomOffline } from "../../store/offline";
import { useSeason } from "../../hooks/useSeason";
import { placeKey, placeOf } from "../../utils/drafts";
import { focusLost, swallowSecondClick } from "../../utils/overlay";
import { rerankOpen } from "../../utils/standingsText";
import { posterSrc } from "../../utils/poster";
import styles from "./Review.module.css";

// Rows shown per pile on a phone before the SHOW ALL reveal.
const ROWS_BEFORE_OVERFLOW = 12;

const NO_IDS: ReadonlySet<number> = new Set();
const NO_ORDER: readonly number[] = [];

const NEXT_VERDICT: Record<VerdictValue, VerdictValue> = {
  like: "dislike",
  dislike: "skip",
  skip: "like",
};

const PILE_LABELS: Record<VerdictValue, string> = {
  like: "Kept",
  dislike: "Passed",
  skip: "Unsure",
};

/**
 * The seasonal review (design section 07): the post-login home. Ledger of
 * verdicts in three piles, tap-to-change verdict pills (skips get
 * re-targeted here, accidental presses get fixed), the resume banner back
 * into the deck, and the lock bar. Scores tally once every member locks.
 *
 * Desktop (docs/DESKTOP.md 0.15.0): a sticky left rail (status + the
 * lock-in action) beside a wider ledger column. Mobile keeps the single
 * stack with the lock bar as a sticky footer. The pieces are computed
 * once and placed per layout.
 */
export const ReviewScreen = () => {
  const [{ user, room, review, results, members, connectionStatus, rejoining, finalizing, reviewView }] = useStore([
    "user",
    "room",
    "review",
    "results",
    "members",
    "connectionStatus",
    "rejoining",
    "finalizing",
    "reviewView",
  ]);
  const dispatch = useDispatch();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const pile = reviewView?.pile ?? "like";
  const showAll = reviewView?.showAll ?? false;
  // Desktop scrolls the ledger list itself; mobile scrolls the page.
  const ledgerRef = useRef<HTMLUListElement>(null);
  const savedScroll = reviewView?.scroll;
  const savedFocus = reviewView?.focusId;
  const ledgerShown = room != null && review != null;
  // Lock-in is FINAL (0.12.0: no admin unlock exists anymore), so the
  // button opens a no-take-backsies dialog gated on an explicit
  // checkbox.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  // Rows whose pill changed their verdict here keep their place in this
  // pile until the pile changes: a tap cycles the pill, the row stays put.
  // The pile keeps the order it opened with, too: a refetch (the server
  // sorts by last change) must not move the row just changed.
  const pileIds = (p: VerdictValue): readonly number[] =>
    (review?.verdicts ?? []).filter((v) => v.verdict === p).map((v) => v.titleId);
  const [held, setHeld] = useState<{ pile: VerdictValue; ids: ReadonlySet<number>; order: readonly number[] }>(
    () => ({ pile, ids: NO_IDS, order: pileIds(pile) }),
  );
  const heldIds = held.pile === pile ? held.ids : NO_IDS;
  const pileOrder = held.pile === pile ? held.order : NO_ORDER;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is the pile's as it opened, read only when the pile changes.
  useEffect(() => {
    setHeld((h) => (h.pile === pile ? h : { pile, ids: NO_IDS, order: pileIds(pile) }));
  }, [pile]);

  const mediaById = useMemo(() => {
    const map = new Map<number, Media>();
    for (const m of room?.media ?? []) {
      if (m.anilistId != null) map.set(m.anilistId, m);
    }
    return map;
  }, [room]);

  const verdictedIds = useMemo(
    () => new Set((review?.verdicts ?? []).map((v) => v.titleId)),
    [review],
  );

  // Hook: must run before the early return below.
  const { season, year } = useSeason();
  const offline = roomOffline({ connectionStatus, rejoining });
  const lockingIn = finalizing?.kind === "lock";
  // The read-only peek of a locked review: Back returns to the standings.
  const peeking = review?.lockedAt != null && !lockingIn;
  useBackStep(peeking, () => dispatch({ type: "viewLockedReview", payload: { open: false } }));
  // Opened from the standings' menu, the peek's heading takes the focus
  // the menu item took with it.
  const headlineRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (peeking && focusLost()) headlineRef.current?.focus();
  }, [peeking]);

  // The lock confirm lives only while a lock is still possible: a deck
  // that grew while it was open (the daily refresh) takes it away, and
  // the next title takes the focus its disabled opener cannot.
  const lockable =
    review != null &&
    review.lockedAt == null &&
    review.verdicts.length >= review.total &&
    !(room?.media ?? []).some((m) => m.anilistId != null && !verdictedIds.has(m.anilistId));
  const confirmLive = confirmOpen && lockable;
  const resumeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirmOpen || confirmLive) return;
    setConfirmOpen(false);
    if (focusLost()) {
      resumeRef.current?.focus();
    }
  }, [confirmOpen, confirmLive]);

  // The lock-in ceremony holds "Locking in..." for a MINIMUM of 3s (the
  // owner's spec, audit v1.2.0 #9) even when the ack lands faster; the
  // clear also gates HomeScreen's flip to the standings.
  const ackedAt = review?.lockedAt ?? null;
  const finalizingStartedAt = finalizing?.startedAt;
  const dispatchStable = dispatch;
  useEffect(() => {
    if (finalizing?.kind !== "lock" || ackedAt == null || finalizingStartedAt == null) return;
    const remaining = Math.max(0, finalizingStartedAt + 3000 - Date.now());
    const timer = setTimeout(
      () => dispatchStable({ type: "finalizing", payload: null }),
      remaining,
    );
    return () => clearTimeout(timer);
  }, [finalizing?.kind, ackedAt, finalizingStartedAt, dispatchStable]);

  // Back from the deck: put the ledger where the trip began, once. An
  // offset from the other layout belongs to a different scroller.
  useLayoutEffect(() => {
    const ledger = ledgerRef.current;
    if (!savedScroll || !ledgerShown || !ledger) return;
    if (savedScroll.desktop === isDesktop) {
      if (isDesktop) ledger.scrollTop = savedScroll.top;
      else window.scrollTo(0, savedScroll.top);
    }
    // Focus goes back to the row the trip began from, or to the pile's tab.
    if (focusLost()) {
      const row = savedFocus == null ? null : ledger.querySelector<HTMLElement>(`[data-title-id="${savedFocus}"]`);
      (row ?? document.getElementById(tabId("piles", pile)))?.focus({ preventScroll: true });
    }
    dispatch({ type: "reviewView", payload: { pile, showAll } });
  }, [savedScroll, savedFocus, ledgerShown, isDesktop, pile, showAll, dispatch]);

  if (!room || !review) return null;

  const total = review.total;
  const done = review.verdicts.length;
  const remaining = total - done;
  const locked = review.lockedAt != null;
  // The ledger holds still through the lock ceremony, as Rank's lists do.
  const frozen = locked || lockingIn;
  const roomName = room.displayName ?? room.name;

  const memberStates = members ?? review.members ?? [];
  const lockedCount = memberStates.filter((m) => m.locked).length;

  const nextUp = (room.media ?? []).find(
    (m) => m.anilistId != null && !verdictedIds.has(m.anilistId),
  );

  const place = new Map(pileOrder.map((id, i) => [id, i]));
  const pileRows = review.verdicts
    .filter((v) => v.verdict === pile || heldIds.has(v.titleId))
    .map((v) => ({ ...v, media: mediaById.get(v.titleId) }))
    // Rows new to the pile go after, in the ledger's order.
    .sort((a, b) => (place.get(a.titleId) ?? Number.POSITIVE_INFINITY) - (place.get(b.titleId) ?? Number.POSITIVE_INFINITY));
  // The rows still in the pile, for the way through them on the deck.
  const inPile = pileRows.filter((r) => r.verdict === pile);
  // Desktop scrolls the ledger internally, so there's no reason to
  // truncate -- show every row. Mobile keeps the "SHOW ALL" reveal.
  const visibleRows = isDesktop || showAll ? pileRows : pileRows.slice(0, ROWS_BEFORE_OVERFLOW);
  const overflow = pileRows.length - visibleRows.length;

  // A re-review on the deck, noting where the ledger was for the return.
  const openOnDeck = (titleIds: number[], focusId?: number) => {
    const top = isDesktop ? (ledgerRef.current?.scrollTop ?? 0) : window.scrollY;
    dispatch({
      type: "enterDeckScope",
      payload: { titleIds, position: 0, from: { pile, showAll, scroll: { top, desktop: isDesktop }, focusId } },
    });
  };

  // ── Pieces (placed differently per layout) ──

  const headlineBlock = (
    <div className={styles.headlineBlock}>
      <h1 className={styles.headline} ref={headlineRef} tabIndex={-1}>
        your {season.toLowerCase()} review.
      </h1>
      <p className={styles.contextLine}>
        {done} / {total} VERDICTS
        {/* Room pulse (audit 17 UX 3): pre-lock the room used to be
            opaque. Live via roomPulse pushes; seeded by the review
            payload. */}
        {memberStates.length > 1 &&
          ` · ${lockedCount} OF ${memberStates.length} LOCKED`}
      </p>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label="Verdicts"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className={styles.progressFill} style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );

  const resumeBannerEl = nextUp && !locked && (
    <button
      ref={resumeRef}
      type="button"
      className={styles.resumeBanner}
      onClick={() => dispatch({ type: "navigate", payload: { route: "room" } })}
      data-test-handle="resume-deck"
    >
      <span className={styles.resumeThumb}>
        {nextUp.posterUrl && (
          <img className={styles.resumeThumbImg} src={posterSrc(nextUp.posterUrl)} alt="" />
        )}
      </span>
      <span className={styles.resumeText}>
        <span className={styles.resumeTitle}>keep picking</span>
        <span className={styles.resumeMeta}>
          {remaining} {remaining === 1 ? "TITLE" : "TITLES"} LEFT &middot; NEXT: {nextUp.title.toUpperCase()}
        </span>
      </span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={styles.resumeArrow}>
        <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  const pileTabsEl = (
    <PillTabs
      label="Piles"
      idPrefix="piles"
      className={styles.pileTabs}
      tabs={(Object.keys(PILE_LABELS) as VerdictValue[]).map((v) => ({
        id: v,
        label: `${PILE_LABELS[v]} ${review.counts[v]}`,
      }))}
      active={pile}
      onSelect={(v) => dispatch({ type: "reviewView", payload: { pile: v, showAll: false } })}
    />
  );

  const pileReviewEl = inPile.length > 0 && !frozen && (
    <button
      type="button"
      className={styles.pileReviewBtn}
      onClick={(e) => {
        if (e.detail > 1) return;
        swallowSecondClick();
        openOnDeck(inPile.map((r) => r.titleId));
      }}
      data-test-handle="review-pile"
    >
      {inPile.length === 1 ? "REVIEW 1" : `REVIEW ALL ${inPile.length}`} {PILE_LABELS[pile].toUpperCase()}{" "}
      <span aria-hidden="true">&rarr;</span>
    </button>
  );

  const ledgerEl = (
    <ul className={styles.rows} ref={ledgerRef}>
      {visibleRows.length === 0 && (
        <li className={styles.emptyPile}>nothing {PILE_LABELS[pile].toLowerCase()} yet</li>
      )}
      {visibleRows.map((row) => (
        <li key={row.titleId} className={styles.row}>
          {/* Tapping the row re-opens JUST this title on the deck --
              a one-element scope; verdicting (or backing out) lands
              right back here, on the same pile. The pill keeps its
              quick tap-to-cycle. */}
          <button
            type="button"
            className={styles.rowMain}
            disabled={frozen}
            // The second click of a double-click on a dialog button above
            // ("Not yet") opens nothing.
            onClick={(e) => {
              if (e.detail > 1) return;
              openOnDeck([row.titleId], row.titleId);
            }}
            data-title-id={row.titleId}
          >
            <span className={styles.rowThumb}>
              {row.media?.posterUrl && (
                <img className={styles.rowThumbImg} src={posterSrc(row.media.posterUrl)} alt="" />
              )}
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{row.media?.title ?? `#${row.titleId}`}</span>
              {row.media?.format && (
                <span className={styles.rowMeta}>
                  {row.media.format}{row.media.episodes != null ? ` · ${row.media.episodes} EP` : ""}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className={styles.verdictPill}
            data-verdict={row.verdict}
            data-offline={offline && !locked}
            disabled={frozen || offline}
            onClick={() => {
              setHeld((h) =>
                h.pile === pile
                  ? { ...h, ids: new Set(h.ids).add(row.titleId) }
                  : { pile, ids: new Set([row.titleId]), order: pileIds(pile) },
              );
              dispatch({
                type: "verdict",
                payload: { titleId: row.titleId, verdict: NEXT_VERDICT[row.verdict] },
              });
            }}
          >
            {row.verdict === "like" ? "KEPT" : row.verdict === "dislike" ? "PASSED" : "UNSURE"}
          </button>
        </li>
      ))}
      {overflow > 0 && (
        <li>
          <button
            type="button"
            className={styles.overflowBtn}
            onClick={() => dispatch({ type: "reviewView", payload: { pile, showAll: true } })}
          >
            SHOW ALL {pileRows.length}
          </button>
        </li>
      )}
    </ul>
  );

  // The peek goes back to the screen it came from: the standings, or an
  // editor still open there (the re-rank one only while it can still take
  // my order).
  const rerankWaits =
    rerankOpen(results) && placeOf(placeKey(user?.userName, room.name, season, year))?.refining === true;
  const backLabel =
    results?.mySubmitted === false ? "back to ranking" : rerankWaits ? "back to re-ranking" : "back to standings";

  // The lock ceremony, said aloud: its button goes disabled under focus.
  const lockNote = (
    <p className={styles.srOnly} role="status">
      {lockingIn ? "Locking in your season…" : ""}
    </p>
  );

  const lockControls = locked && !lockingIn ? (
    // Read-only peek after lock-in (audit 17 UX 6): the way back to the
    // standings, in the slot the lock button occupied.
    <>
      <button
        type="button"
        className={styles.lockBtn}
        onClick={() => dispatch({ type: "viewLockedReview", payload: { open: false } })}
        data-test-handle="back-to-standings"
      >
        {backLabel}
      </button>
      <p className={styles.lockCaption}>LOCKED IN · THIS LEDGER IS READ-ONLY</p>
    </>
  ) : (
    <>
      <button
        type="button"
        className={styles.lockBtn}
        // A title the ledger has yet to hear about (the deck just grew)
        // holds the lock as well.
        disabled={!lockable || offline || lockingIn}
        onClick={() => {
          setConfirmChecked(false);
          setConfirmOpen(true);
        }}
        data-test-handle="lock-in"
      >
        {lockingIn
          ? "locking in\u2026"
          : remaining > 0
            ? `lock in · ${remaining} to go`
            : "lock in"}
      </button>
      <p className={styles.lockCaption}>NEXT: RANK YOUR KEEPS · PASSED AND UNSURE ARE DISCARDED</p>
    </>
  );

  const confirmDialogEl = confirmLive && (
    <DialogScrim
      label="Lock in your season"
      onDismiss={() => setConfirmOpen(false)}
      backdropClassName={styles.confirmBackdrop}
      dialogClassName={styles.confirmDialog}
    >
        <h2 className={styles.confirmTitle}>no take-backsies.</h2>
        <p className={styles.confirmText}>
          Locking in is final. Next you&apos;ll rank your keeps: that&apos;s
          what scores the season. Passed and unsure picks are discarded.
        </p>
        <label className={styles.confirmCheckRow}>
          <input
            type="checkbox"
            className={styles.confirmCheckbox}
            checked={confirmChecked}
            onChange={(e) => setConfirmChecked(e.target.checked)}
          />
          <span>I&apos;m ready to lock in my season</span>
        </label>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.confirmCancel}
            onClick={() => setConfirmOpen(false)}
          >
            not yet
          </button>
          <button
            type="button"
            className={styles.confirmLock}
            disabled={!confirmChecked || offline}
            onClick={() => {
              setConfirmOpen(false);
              dispatch({ type: "finalizing", payload: { kind: "lock" } });
              dispatch({ type: "lockIn" });
            }}
            data-test-handle="confirm-lock"
          >
            lock it in
          </button>
        </div>
    </DialogScrim>
  );

  // ── Desktop: rail + main ──
  if (isDesktop) {
    return (
      <div className={styles.deskScreen}>
        <AppHeader roomLabel={roomName} />
        <div className={styles.deskBody}>
          <aside className={styles.rail}>
            {headlineBlock}
            {resumeBannerEl}
            <div className={styles.railLock}>{lockControls}</div>
          </aside>
          <div className={styles.main}>
            {pileTabsEl}
            <div {...tabPanelProps("piles", pile)} className={styles.pilePanel}>
              {pileReviewEl}
              {ledgerEl}
            </div>
          </div>
        </div>
        {lockNote}
        {confirmDialogEl}
      </div>
    );
  }

  // ── Mobile: single stack, lock bar as sticky footer ──
  return (
    <div className={styles.screen}>
      <MobileHeader roomLabel={roomName} className={styles.topBar} />

      {headlineBlock}
      {resumeBannerEl}
      {pileTabsEl}
      <div {...tabPanelProps("piles", pile)} className={styles.pilePanel}>
        {pileReviewEl}
        {ledgerEl}
      </div>

      <footer className={styles.lockBar}>{lockControls}</footer>

      {lockNote}
      {confirmDialogEl}
    </div>
  );
};
