import { useEffect, useMemo, useState } from "react";
import type { Media, VerdictValue } from "../../../../../types/reely";
import { AccountMenu } from "../organisms/AccountMenu";
import { AppHeader } from "../organisms/AppHeader";
import { DialogScrim } from "../molecules/DialogScrim";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { useDispatch, useStore } from "../../store";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import { posterSrc } from "../../utils/poster";
import styles from "./Review.module.css";

// Rows shown per pile before the overflow reveal (design shows a
// truncated ledger with a "+9 MORE" marker).
const ROWS_BEFORE_OVERFLOW = 12;

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
  const [{ room, review, members, connectionStatus, finalizing }] = useStore([
    "room",
    "review",
    "members",
    "connectionStatus",
    "finalizing",
  ]);
  const dispatch = useDispatch();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [pile, setPile] = useState<VerdictValue>("like");
  const [showAll, setShowAll] = useState(false);
  // Lock-in is FINAL (0.12.0: no admin unlock exists anymore), so the
  // button opens a no-take-backsies dialog gated on an explicit
  // checkbox.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);

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
  const { season } = useSeason();
  const offline = connectionStatus !== "connected";
  const lockingIn = finalizing?.kind === "lock";

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

  if (!room || !review) return null;

  const total = review.total;
  const done = review.verdicts.length;
  const remaining = total - done;
  const locked = review.lockedAt != null;
  const kanji = SEASON_THEMES[season].kanji;
  const roomName = room.displayName ?? room.name;

  const memberStates = members ?? review.members ?? [];
  const lockedCount = memberStates.filter((m) => m.locked).length;

  const nextUp = (room.media ?? []).find(
    (m) => m.anilistId != null && !verdictedIds.has(m.anilistId),
  );

  const pileRows = review.verdicts
    .filter((v) => v.verdict === pile)
    .map((v) => ({ ...v, media: mediaById.get(v.titleId) }));
  // Desktop scrolls the ledger internally, so there's no reason to
  // truncate -- show every row. Mobile keeps the "+N MORE" reveal.
  const visibleRows = isDesktop || showAll ? pileRows : pileRows.slice(0, ROWS_BEFORE_OVERFLOW);
  const overflow = pileRows.length - visibleRows.length;

  // ── Pieces (placed differently per layout) ──

  const headlineBlock = (
    <div className={styles.headlineBlock}>
      <h1 className={styles.headline}>your {season.toLowerCase()} review</h1>
      <p className={styles.contextLine}>
        {roomName.toUpperCase()} &middot; {done} / {total} VERDICTS
        {/* Room pulse (audit 17 UX 3): pre-lock the room used to be
            opaque. Live via roomPulse pushes; seeded by the review
            payload. */}
        {memberStates.length > 1 &&
          ` · ${lockedCount} OF ${memberStates.length} LOCKED`}
      </p>
      <div className={styles.progressTrack} role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <div className={styles.progressFill} style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );

  const resumeBannerEl = nextUp && !locked && (
    <button
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
        <span className={styles.resumeTitle}>Keep picking</span>
        <span className={styles.resumeMeta}>
          {remaining} TITLES LEFT &middot; NEXT: {nextUp.title.toUpperCase()}
        </span>
      </span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={styles.resumeArrow}>
        <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  const pileTabsEl = (
    <div className={styles.pileTabs} role="tablist">
      {(Object.keys(PILE_LABELS) as VerdictValue[]).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={pile === v}
          className={styles.pileTab}
          data-active={pile === v}
          onClick={() => {
            setPile(v);
            setShowAll(false);
          }}
        >
          {PILE_LABELS[v]} {review.counts[v]}
        </button>
      ))}
    </div>
  );

  const pileReviewEl = pileRows.length > 0 && !locked && (
    <button
      type="button"
      className={styles.pileReviewBtn}
      onClick={() =>
        dispatch({
          type: "enterDeckScope",
          payload: { titleIds: pileRows.map((r) => r.titleId), position: 0 },
        })
      }
      data-test-handle="review-pile"
    >
      REVIEW ALL {pileRows.length} {PILE_LABELS[pile].toUpperCase()} &rarr;
    </button>
  );

  const ledgerEl = (
    <ul className={styles.rows}>
      {visibleRows.length === 0 && (
        <li className={styles.emptyPile}>nothing {PILE_LABELS[pile].toLowerCase()} yet</li>
      )}
      {visibleRows.map((row) => (
        <li key={row.titleId} className={styles.row}>
          {/* Tapping the row re-opens JUST this title on the deck --
              a one-element scope; verdicting (or backing out) lands
              right back here. The pill keeps its quick tap-to-cycle. */}
          <button
            type="button"
            className={styles.rowMain}
            disabled={locked}
            onClick={() =>
              dispatch({
                type: "enterDeckScope",
                payload: { titleIds: [row.titleId], position: 0 },
              })
            }
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
            disabled={locked || offline}
            onClick={() =>
              dispatch({
                type: "verdict",
                payload: { titleId: row.titleId, verdict: NEXT_VERDICT[row.verdict] },
              })
            }
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
            onClick={() => setShowAll(true)}
          >
            +{overflow} MORE
          </button>
        </li>
      )}
    </ul>
  );

  const lockControls = locked ? (
    // Read-only peek after lock-in (audit 17 UX 6): the way back to the
    // standings, in the slot the lock button occupied.
    <>
      <button
        type="button"
        className={styles.lockBtn}
        data-complete={true}
        onClick={() => dispatch({ type: "viewLockedReview", payload: { open: false } })}
        data-test-handle="back-to-standings"
      >
        Back to standings
      </button>
      <p className={styles.lockCaption}>LOCKED IN · THIS LEDGER IS READ-ONLY</p>
    </>
  ) : (
    <>
      <button
        type="button"
        className={styles.lockBtn}
        data-complete={remaining === 0 && !lockingIn}
        disabled={remaining > 0 || offline || lockingIn}
        onClick={() => {
          setConfirmChecked(false);
          setConfirmOpen(true);
        }}
        data-test-handle="lock-in"
      >
        {lockingIn
          ? "Locking in\u2026"
          : remaining > 0
            ? `Lock in · ${remaining} to go`
            : "Lock in"}
      </button>
      <p className={styles.lockCaption}>NEXT: RANK YOUR KEEPS · PASSED AND UNSURE ARE DISCARDED</p>
    </>
  );

  const confirmDialogEl = confirmOpen && (
    <DialogScrim
      label="Lock in your season"
      onDismiss={() => setConfirmOpen(false)}
      backdropClassName={styles.confirmBackdrop}
      dialogClassName={styles.confirmDialog}
    >
        <h2 className={styles.confirmTitle}>no take-backsies.</h2>
        <p className={styles.confirmText}>
          Locking in is final. Next you&apos;ll rank your keeps --
          that&apos;s what scores the season. Passed and unsure picks are
          discarded.
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
            Not yet
          </button>
          <button
            type="button"
            className={styles.confirmLock}
            disabled={!confirmChecked}
            onClick={() => {
              setConfirmOpen(false);
              dispatch({ type: "finalizing", payload: { kind: "lock" } });
              dispatch({ type: "lockIn" });
            }}
            data-test-handle="confirm-lock"
          >
            Lock it in
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
            {pileReviewEl}
            {ledgerEl}
          </div>
        </div>
        {confirmDialogEl}
      </div>
    );
  }

  // ── Mobile: single stack, lock bar as sticky footer ──
  return (
    <div className={styles.screen}>
      <header className={styles.topBar}>
        <span className={styles.wordRow}>
          <span className={styles.word} translate="no">cour</span>
          <span className={styles.kanjiChip} aria-hidden="true">{kanji}</span>
        </span>
        <AccountMenu />
      </header>

      {headlineBlock}
      {resumeBannerEl}
      {pileTabsEl}
      {pileReviewEl}
      {ledgerEl}

      <footer className={styles.lockBar}>{lockControls}</footer>

      {confirmDialogEl}
    </div>
  );
};
