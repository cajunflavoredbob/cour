import { useEffect, useMemo, useRef, useState } from "react";
import type { Media } from "../../../../../types/reely";
import { AccountMenu } from "../organisms/AccountMenu";
import { AppHeader } from "../organisms/AppHeader";
import { DialogScrim } from "../molecules/DialogScrim";
import { DeckDetails } from "../organisms/DeckDetails";
import { Loading } from "./Loading";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { useStore } from "../../store";
import { posterSrc } from "../../utils/poster";
import { useSeason } from "../../hooks/useSeason";
import styles from "./Rank.module.css";

// The couple-profile point values, shown next to the top five slots so
// the stakes of the ordering are visible while ranking.
const RANK_POINTS = [12, 9, 6, 3, 1];

// Standings show the top 5 by default (the scoring positions); the rest
// hide behind a reveal.
const STANDINGS_PREVIEW = 5;

/**
 * The post-lock screen (0.13.0): ranking IS the scoring. Before
 * submission it's the ordering editor over YOUR liked titles (dislikes
 * and skips are discarded); after, it's the live combined standings,
 * updated the moment any member's ranking lands (server push).
 *
 * Desktop (docs/DESKTOP.md 0.15.0): the editor gets a rail (headline +
 * point legend + submit) beside the sortable list, with pointer
 * drag-to-reorder (up/down buttons retained for keyboard/touch); the
 * standings get the elevated-list treatment (#1 hero, medal ranks).
 */
export const RankScreen = () => {
  const [{ room, review, results, members }, dispatch] = useStore([
    "room",
    "review",
    "results",
    "members",
  ]);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const mediaById = useMemo(() => {
    const map = new Map<number, Media>();
    for (const m of room?.media ?? []) {
      if (m.anilistId != null) map.set(m.anilistId, m);
    }
    return map;
  }, [room]);

  // My likes in ledger order -- the editor's starting order.
  const likedIds = useMemo(
    () =>
      (review?.verdicts ?? [])
        .filter((v) => v.verdict === "like")
        .map((v) => v.titleId),
    [review],
  );

  const [order, setOrder] = useState<number[]>(likedIds);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [showAllStandings, setShowAllStandings] = useState(false);
  // Standings row -> read-only details drawer (audit 17 UX 4): post-lock
  // there was no way to see a synopsis/PV exactly when the group decides
  // what to watch.
  const [detailTitleId, setDetailTitleId] = useState<number | null>(null);

  // Pointer drag-to-reorder (desktop). Up/down buttons remain the
  // keyboard + touch path.
  const dragIdRef = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    dispatch({ type: "results" });
  }, [dispatch]);

  // While the payload hasn't arrived, keep asking at a pace slower than
  // the request timeout (15s) so attempts never stack. The screen holds
  // on the loading pulse below until it lands (audit 17 H8) -- rendering
  // the live editor before mySubmitted is known showed it to already-
  // submitted users, whose re-submit then ate their edits.
  useEffect(() => {
    if (results) return;
    const timer = setInterval(() => dispatch({ type: "results" }), 20_000);
    return () => clearInterval(timer);
  }, [dispatch, results]);

  // The ledger can arrive after mount (review fetch on join); adopt it
  // once as the starting order if the user hasn't submitted.
  useEffect(() => {
    setOrder((current) => (current.length === 0 ? likedIds : current));
  }, [likedIds]);

  // Hook: must run before the early return below.
  const { season } = useSeason();

  if (!room) return <div />;

  // Editor-vs-standings can't be decided without the payload; hold.
  if (!results) return <Loading />;

  const submitted = results.mySubmitted;
  const roomName = room.displayName ?? room.name;

  const move = (index: number, delta: number) => {
    setOrder((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const titleOf = (titleId: number) => mediaById.get(titleId)?.title ?? `#${titleId}`;
  const posterOf = (titleId: number) => {
    const url = mediaById.get(titleId)?.posterUrl;
    return url ? posterSrc(url) : undefined;
  };

  const onDragStart = (e: React.PointerEvent, id: number) => {
    if (!isDesktop || e.button !== 0) return;
    if ((e.target as Element).closest("[data-move]")) return;
    // Stop the browser's click-drag text selection during a reorder.
    e.preventDefault();
    dragIdRef.current = id;
    setDraggingId(id);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const id = dragIdRef.current;
    if (id == null || !listRef.current) return;
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-rank-row]"));
    let target = rows.findIndex((r) => {
      const rect = r.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    if (target === -1) target = rows.length - 1;
    setOrder((cur) => {
      const from = cur.indexOf(id);
      if (from === -1 || from === target) return cur;
      const next = [...cur];
      next.splice(from, 1);
      next.splice(target, 0, id);
      return next;
    });
  };

  const onDragEnd = () => {
    dragIdRef.current = null;
    setDraggingId(null);
  };

  // ── Editor pieces ──

  const editorHeadline = (
    <>
      <h1 className={styles.headline}>rank your keeps.</h1>
      <p className={styles.contextLine}>
        TOP 5 SCORE 12 &middot; 9 &middot; 6 &middot; 3 &middot; 1 &middot; PASSED
        AND UNSURE ARE DISCARDED
      </p>
    </>
  );

  const editorList =
    order.length === 0 ? (
      <p className={styles.emptyNote}>
        you kept nothing this season. bold. submit to sit this one out.
      </p>
    ) : (
      <ul className={styles.rows} ref={listRef}>
        {order.map((titleId, i) => (
          <li
            key={titleId}
            className={styles.row}
            data-rank-row
            data-dragging={draggingId === titleId}
            onPointerDown={(e) => onDragStart(e, titleId)}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            {isDesktop && (
              <span className={styles.grip} aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
            )}
            <span className={styles.rankSlot}>
              <span className={styles.rankNumber}>{i + 1}</span>
              {i < RANK_POINTS.length && (
                <span className={styles.rankPoints}>{RANK_POINTS[i]} PTS</span>
              )}
            </span>
            <span className={styles.rowThumb}>
              {posterOf(titleId) && (
                <img className={styles.rowThumbImg} src={posterOf(titleId)} alt="" />
              )}
            </span>
            <span className={styles.rowTitle}>{titleOf(titleId)}</span>
            <span className={styles.moveButtons} data-move>
              <button
                type="button"
                className={styles.moveBtn}
                aria-label={`Move ${titleOf(titleId)} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 10 4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.moveBtn}
                aria-label={`Move ${titleOf(titleId)} down`}
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </span>
          </li>
        ))}
      </ul>
    );

  const submitControls = (
    <>
      <button
        type="button"
        className={styles.submitBtn}
        onClick={() => {
          setConfirmChecked(false);
          setConfirmOpen(true);
        }}
        data-test-handle="submit-rankings"
      >
        Submit rankings
      </button>
      <p className={styles.submitCaption}>STANDINGS COMBINE ONCE RANKINGS COME IN</p>
    </>
  );

  const pointLegend = (
    <ul className={styles.legend} aria-hidden="true">
      {RANK_POINTS.map((pts, i) => (
        <li key={pts} className={styles.legendRow}>
          <span className={styles.legendRank}>#{i + 1}</span>
          <span className={styles.legendPts}>{pts} PTS</span>
        </li>
      ))}
      <li className={styles.legendRow} data-rest>
        <span className={styles.legendRank}>#6+</span>
        <span className={styles.legendPts}>0 PTS</span>
      </li>
    </ul>
  );

  // ── Standings pieces ──

  // FINAL vs live (audit 17 UX 11): the season's conclusion used to be
  // the silent absence of "UPDATES LIVE". Waiting names ride the shared
  // member-state payload.
  const memberStates = members ?? results.members ?? [];
  const waitingOn = memberStates.filter((m) => !m.submitted).map((m) => m.userName);
  const isFinal = results.memberCount > 0 && results.submittedCount >= results.memberCount;
  const standingsHeadline = (
    <>
      <h1 className={styles.headline}>{season.toLowerCase()} standings.</h1>
      <p className={styles.contextLine}>
        {isFinal
          ? `ALL ${results.memberCount} RANKINGS IN · FINAL`
          : `${results.submittedCount} OF ${results.memberCount} RANKINGS IN · UPDATES LIVE`}
        {!isFinal && waitingOn.length > 0 &&
          ` · WAITING ON ${waitingOn.map((n) => n.toUpperCase()).join(", ")}`}
      </p>
    </>
  );

  const allStandings = results?.standings ?? [];
  const visibleStandings = showAllStandings
    ? allStandings
    : allStandings.slice(0, STANDINGS_PREVIEW);

  const standingsList = (desktop: boolean) => (
    <ul
      className={desktop ? styles.standingsRows : styles.rows}
      key={desktop ? results?.submittedCount : undefined}
    >
      {visibleStandings.map((standing) => (
        <li
          key={standing.titleId}
          className={styles.row}
          data-rank={standing.rank}
          data-hero={desktop && standing.rank === 1}
        >
          {/* The whole row opens the read-only details drawer (UX 4). */}
          <button
            type="button"
            className={styles.rowOpen}
            onClick={() => setDetailTitleId(standing.titleId)}
            data-test-handle="standing-details"
          >
            <span className={styles.standingRank}>{standing.rank}</span>
            <span className={styles.rowThumb}>
              {posterOf(standing.titleId) && (
                <img className={styles.rowThumbImg} src={posterOf(standing.titleId)} alt="" />
              )}
            </span>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{titleOf(standing.titleId)}</span>
              <span className={styles.rowMeta}>
                {standing.points} PTS
                {/* Who ranked it (UX 7): names instead of an anonymous count. */}
                {standing.rankedByNames?.length
                  ? ` · RANKED BY ${standing.rankedByNames.map((n) => n.toUpperCase()).join(" + ")}`
                  : standing.rankedBy > 1
                    ? ` · RANKED BY ${standing.rankedBy}`
                    : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
      {allStandings.length === 0 && (
        <li className={styles.emptyNote}>no rankings yet</li>
      )}
    </ul>
  );

  // "Everyone's #1" -- each submitted member's top pick, regardless of
  // where it lands in the combined standings (the owner's ask).
  const topPicksEl = (results?.topPicks ?? []).length > 0 && (
    <div className={styles.topPicks}>
      <p className={styles.topPicksLabel}>EVERYONE&apos;S #1</p>
      <div className={styles.topPicksRow}>
        {(results?.topPicks ?? []).map((pick) => (
          <div key={pick.userName} className={styles.pickCard} data-test-handle="top-pick">
            <span className={styles.pickPoster}>
              {posterOf(pick.titleId) && (
                <img className={styles.pickPosterImg} src={posterOf(pick.titleId)} alt="" />
              )}
            </span>
            <span className={styles.pickName}>{pick.userName}</span>
            <span className={styles.pickTitle}>{titleOf(pick.titleId)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const standingsRevealEl = allStandings.length > STANDINGS_PREVIEW && (
    <button
      type="button"
      className={styles.showAllBtn}
      onClick={() => setShowAllStandings((v) => !v)}
      data-test-handle="standings-reveal"
    >
      {showAllStandings ? "SHOW TOP 5" : `SHOW ALL ${allStandings.length} →`}
    </button>
  );

  const detailMedia = detailTitleId != null ? mediaById.get(detailTitleId) : undefined;
  const detailDialogEl = detailMedia && (
    <DialogScrim
      label={detailMedia.title}
      onDismiss={() => setDetailTitleId(null)}
      backdropClassName={styles.detailBackdrop}
      dialogClassName={styles.detailDialog}
    >
      <DeckDetails media={detailMedia} />
    </DialogScrim>
  );

  const confirmDialogEl = confirmOpen && (
    <DialogScrim
      label="Submit your rankings"
      onDismiss={() => setConfirmOpen(false)}
      backdropClassName={styles.confirmBackdrop}
      dialogClassName={styles.confirmDialog}
    >
        <h2 className={styles.confirmTitle}>no turning back.</h2>
        <p className={styles.confirmText}>
          This submits your final ranking and reveals the standings.
          You can&apos;t reorder after this.
        </p>
        <label className={styles.confirmCheckRow}>
          <input
            type="checkbox"
            className={styles.confirmCheckbox}
            checked={confirmChecked}
            onChange={(e) => setConfirmChecked(e.target.checked)}
          />
          <span>This is my final ranking</span>
        </label>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.confirmCancel}
            onClick={() => setConfirmOpen(false)}
          >
            Keep ordering
          </button>
          <button
            type="button"
            className={styles.confirmSubmit}
            disabled={!confirmChecked}
            onClick={() => {
              setConfirmOpen(false);
              dispatch({ type: "submitRankings", payload: { rankedTitleIds: order } });
            }}
            data-test-handle="confirm-submit"
          >
            Submit
          </button>
        </div>
    </DialogScrim>
  );

  // ── Desktop ──
  if (isDesktop) {
    return (
      <div className={styles.deskScreen}>
        <AppHeader roomLabel={roomName} />
        {submitted ? (
          <div className={styles.standingsBody}>
            <div className={styles.standingsHead}>{standingsHeadline}</div>
            {topPicksEl}
            {standingsList(true)}
            {standingsRevealEl}
          </div>
        ) : (
          <div className={styles.deskBody}>
            <aside className={styles.rail}>
              {editorHeadline}
              {pointLegend}
              <div className={styles.railSubmit}>{submitControls}</div>
            </aside>
            <div className={styles.main}>{editorList}</div>
          </div>
        )}
        {confirmDialogEl}
        {detailDialogEl}
      </div>
    );
  }

  // ── Mobile ──
  return (
    <div className={styles.screen}>
      <header className={styles.topBar}>
        <span className={styles.wordRow}>
          <span className={styles.word} translate="no">cour</span>
        </span>
        <AccountMenu />
      </header>

      {!submitted ? (
        <>
          {editorHeadline}
          {editorList}
          <footer className={styles.submitBar}>{submitControls}</footer>
        </>
      ) : (
        <>
          {standingsHeadline}
          {topPicksEl}
          {standingsList(false)}
          {standingsRevealEl}
        </>
      )}

      {confirmDialogEl}
      {detailDialogEl}
    </div>
  );
};
