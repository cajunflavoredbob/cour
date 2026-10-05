import { useEffect, useMemo, useState } from "react";
import type { Media } from "../../../../../types/reely";
import { AccountMenu } from "../organisms/AccountMenu";
import { AppHeader } from "../organisms/AppHeader";
import { DialogScrim } from "../molecules/DialogScrim";
import { ShareStandingsButton } from "../molecules/ShareStandingsButton";
import { DeckDetails } from "../organisms/DeckDetails";
import { Loading } from "./Loading";
import { useDragReorder } from "../../hooks/useDragReorder";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { useStore } from "../../store";
import { posterSrc } from "../../utils/poster";
import { reconcileOrder } from "../../utils/rankOrder";
import { useSeason } from "../../hooks/useSeason";
import { SEASON_THEMES } from "../../utils/season";
import { buildStandingsCard } from "../../utils/standingsCard";
import { rankedByText, rankingsIn, standingsFinal } from "../../utils/standingsText";
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
 * point legend + submit) beside the sortable list; the standings get the
 * elevated-list treatment (#1 hero, medal ranks).
 */
export const RankScreen = () => {
  const [{ room, review, results, members, connectionStatus, finalizing }, dispatch] = useStore([
    "room",
    "review",
    "results",
    "members",
    "connectionStatus",
    "finalizing",
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

  // Up/down buttons are the keyboard path.
  const { listRef, draggingId, onPointerDown: onRowPointerDown } = useDragReorder(order, setOrder);

  useEffect(() => {
    dispatch({ type: "results" });
  }, [dispatch]);

  // While the payload hasn't arrived, keep asking at a pace slower than
  // the request timeout (15s) so attempts never stack. The screen holds
  // on the loading pulse below until it lands (audit 17 H8) -- rendering
  // the live editor before mySubmitted is known showed it to already-
  // submitted users, whose re-submit then ate their edits.
  // Only while connected: a tick queued across an outage would reach the
  // server before the reconnect rejoins the room.
  useEffect(() => {
    if (results || connectionStatus !== "connected") return;
    const timer = setInterval(() => dispatch({ type: "results" }), 20_000);
    return () => clearInterval(timer);
  }, [dispatch, results, connectionStatus]);

  // The ledger can arrive after mount (review fetch on join), and it can
  // CHANGE while this screen is open: the season refreshes daily for its
  // first four weeks, and a refresh that drops or adds a title re-pulls the
  // ledger (createStore, on mediaChanged). Seeding the order once would keep
  // a removed title in it, and the server rejects any submit that is not
  // exactly the member's likes in the current deck. reconcileOrder keeps
  // the member's own ordering and follows the change.
  useEffect(() => {
    setOrder((current) => reconcileOrder(current, likedIds));
  }, [likedIds]);

  // Hooks: must run before the early return below.
  const { season, year } = useSeason();
  const roomName = room ? (room.displayName ?? room.name) : "";
  const standingsCard = useMemo(
    () => (results && room ? buildStandingsCard({ results, season, year, roomName, mediaById }) : null),
    [results, room, roomName, season, year, mediaById],
  );
  const offline = connectionStatus !== "connected";
  const submitting = finalizing?.kind === "submit";
  const kanji = SEASON_THEMES[season].kanji;

  // Reconnect staleness is healed by the store, not here: createStore's
  // joinRoomSuccess handler refetches results after a rejoin lands (a
  // refetch fired on the raw reconnect would race the rejoin and error
  // server-side with "Join a room first").

  // Minimum-3s "Submitting..." ceremony (the owner's spec, audit v1.2.0
  // #9): the editor holds until BOTH the ack (mySubmitted) and the 3s
  // floor have passed.
  const acked = results?.mySubmitted === true;
  const finalizingStartedAt = finalizing?.startedAt;
  useEffect(() => {
    if (finalizing?.kind !== "submit" || !acked || finalizingStartedAt == null) return;
    const remaining = Math.max(0, finalizingStartedAt + 3000 - Date.now());
    const timer = setTimeout(
      () => dispatch({ type: "finalizing", payload: null }),
      remaining,
    );
    return () => clearTimeout(timer);
  }, [finalizing?.kind, acked, finalizingStartedAt, dispatch]);

  if (!room) return <div />;

  // Editor-vs-standings can't be decided without the payload; hold.
  if (!results) return <Loading />;

  // The editor holds through the submit ceremony so the standings never
  // flash in early.
  const submitted = results.mySubmitted && !submitting;

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
      <ul className={styles.rows} ref={listRef} data-reordering={draggingId != null}>
        {order.map((titleId, i) => (
          <li
            key={titleId}
            className={styles.row}
            data-rank-row
            data-reorder-id={titleId}
            data-dragging={draggingId === titleId}
            // No dragging during the submit ceremony.
            onPointerDown={submitting ? undefined : (e) => onRowPointerDown(e, titleId)}
          >
            <span
              className={styles.grip}
              aria-hidden="true"
              data-drag-handle
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <span className={styles.rankSlot}>
              <span className={styles.rankNumber}>{i + 1}</span>
              {i < RANK_POINTS.length && (
                <span className={styles.rankPoints}>{RANK_POINTS[i]} PTS</span>
              )}
            </span>
            <span className={styles.rowThumb}>
              {posterOf(titleId) && (
                <img className={styles.rowThumbImg} src={posterOf(titleId)} alt="" draggable={false} />
              )}
            </span>
            <span className={styles.rowTitle}>{titleOf(titleId)}</span>
            <span className={styles.moveButtons} data-no-drag>
              <button
                type="button"
                className={styles.moveBtn}
                aria-label={`Move ${titleOf(titleId)} up`}
                disabled={i === 0 || submitting}
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
                disabled={i === order.length - 1 || submitting}
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
        disabled={offline || submitting}
        onClick={() => {
          setConfirmChecked(false);
          setConfirmOpen(true);
        }}
        data-test-handle="submit-rankings"
      >
        {submitting ? "Submitting\u2026" : "Submit rankings"}
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

  // FINAL once every member has submitted; otherwise live, naming who is pending.
  const memberStates = members ?? results.members ?? [];
  const waitingOn = memberStates.filter((m) => !m.submitted).map((m) => m.userName);
  const isFinal = standingsFinal(results.submittedCount, results.memberCount);
  const standingsHeadline = (
    <>
      <h1 className={styles.headline}>{season.toLowerCase()} standings.</h1>
      <p className={styles.contextLine}>
        {`${rankingsIn(results.submittedCount, results.memberCount)} · ${isFinal ? "FINAL" : "UPDATES LIVE"}`}
        {!isFinal && waitingOn.length > 0 &&
          ` · WAITING ON ${waitingOn.map((n) => n.toUpperCase()).join(", ")}`}
      </p>
      {standingsCard && results.standings.length > 0 && (
        <div className={styles.shareRow}>
          <ShareStandingsButton card={standingsCard} />
        </div>
      )}
    </>
  );

  const allStandings = results?.standings ?? [];
  const visibleStandings = showAllStandings
    ? allStandings
    : allStandings.slice(0, STANDINGS_PREVIEW);

  // " · RANKED BY ..." after a row's points, or nothing.
  const rankedBySuffix = (names: readonly string[] | undefined, count: number) => {
    const text = rankedByText(names, count);
    return text ? ` · ${text}` : "";
  };

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
                {/* Who ranked it: names instead of an anonymous count. */}
                {rankedBySuffix(standing.rankedByNames, standing.rankedBy)}
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
              dispatch({ type: "finalizing", payload: { kind: "submit" } });
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
        {/* Mobile parity with the deck/review headers (audit v1.2.0
            low): season kanji + room name were missing here. */}
        <div className={styles.roomStack}>
          <span className={styles.roomLabel}>{roomName}</span>
          <span className={styles.wordRow}>
            <span className={styles.word} translate="no">cour</span>
            <span className={styles.kanjiChip} aria-hidden="true">{kanji}</span>
          </span>
        </div>
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
