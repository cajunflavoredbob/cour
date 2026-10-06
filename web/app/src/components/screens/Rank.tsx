import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import type { Media, RankingStanding } from "../../../../../types/reely";
import { AppHeader } from "../organisms/AppHeader";
import { MobileHeader } from "../organisms/MobileHeader";
import { DialogScrim } from "../molecules/DialogScrim";
import { PillTabs, tabPanelProps } from "../molecules/PillTabs";
import { DeckDetails } from "../organisms/DeckDetails";
import { SharePreview } from "../organisms/SharePreview";
import { Loading } from "./Loading";
import { useBackStep } from "../../hooks/useBackStep";
import { useDragReorder } from "../../hooks/useDragReorder";
import { useStandingsCardImage } from "../../hooks/useStandingsCardImage";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { usePageVisible } from "../../hooks/usePageVisible";
import { useStore } from "../../store";
import { roomOffline } from "../../store/offline";
import { draftOf, keepDraft, keepPlace, placeKey, placeOf } from "../../utils/drafts";
import { focusLost, overlayOpen, swallowSecondClick } from "../../utils/overlay";
import { posterSrc } from "../../utils/poster";
import { getRerankTold, setRerankTold } from "../../utils/prefs";
import { reconcileOrder } from "../../utils/rankOrder";
import { useSeason } from "../../hooks/useSeason";
import { buildStandingsCard, listOf } from "../../utils/standingsCard";
import {
  groupTopPicks,
  KEPT_WORDS,
  RANK_POINTS,
  rankedByText,
  rankingsIn,
  rerankedByText,
  rerankOpen,
  standingsFinal,
} from "../../utils/standingsText";
import styles from "./Rank.module.css";

// The scoring, as the editors state it.
const TOP_SCORE = `TOP ${RANK_POINTS.length} SCORE ${RANK_POINTS.join(" · ")}`;

// Standings show the top 5 by default (the scoring positions); the rest
// hide behind a reveal.
const STANDINGS_PREVIEW = 5;

// The re-rank round's opening toast lets the revealed standings land
// first, and waits as long again while a dialog or menu is open.
const ARRIVAL_TOAST_DELAY_MS = 1500;

/**
 * The post-lock screen (0.13.0): ranking IS the scoring. Before
 * submission it's the ordering editor over YOUR liked titles (dislikes
 * and skips are discarded); after, it's the live combined standings,
 * updated the moment any member's ranking lands (server push).
 *
 * Once every ranking is in and two or more shows were kept by everyone,
 * tabs over the list add a second view: the standings over just those
 * shows (All kept), and an optional one-shot re-rank of them. The head
 * above the tabs, and All picks, stay the room's result.
 *
 * Desktop (docs/DESKTOP.md): every state is a rail beside a main column.
 * The editors put the headline, point legend and submit in the rail; the
 * standings put the head and everyone's #1 there, with the tabs and the
 * elevated list (#1 hero, medal ranks) in the main column.
 */
interface RankScreenProps {
  /** The lock ceremony just handed over: the editor's heading takes focus. */
  fromLock?: boolean;
  onFocusTaken?: () => void;
}

export const RankScreen = ({ fromLock = false, onFocusTaken }: RankScreenProps = {}) => {
  const [{ user, room, review, results, members, connectionStatus, rejoining, finalizing }, dispatch] = useStore([
    "user",
    "room",
    "review",
    "results",
    "members",
    "connectionStatus",
    "rejoining",
    "finalizing",
  ]);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const pageVisible = usePageVisible();
  const { season, year } = useSeason();
  // Per member, room and season: a shared device keeps each member's own.
  const draftKey = placeKey(user?.userName, room?.name, season, year);
  // Coming back to the screen this page session (the review peek) rather
  // than arriving for the first time.
  const returning = useRef(placeOf(draftKey) != null);

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

  const [order, setOrder] = useState<number[]>(() => draftOf(`rank:${draftKey}`) ?? likedIds);
  // Which one-shot submit the confirm dialog is asking about.
  const [confirmFor, setConfirmFor] = useState<"submit" | "refine" | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  // Each view's SHOW ALL reveal.
  const [showAll, setShowAll] = useState(() => placeOf(draftKey)?.showAll ?? { all: false, shared: false });
  // Standings row -> read-only details drawer (audit 17 UX 4): post-lock
  // there was no way to see a synopsis/PV exactly when the group decides
  // what to watch.
  const [detailTitleId, setDetailTitleId] = useState<number | null>(null);
  // The refine round: which standings show, and the open re-rank.
  const [standingsView, setStandingsView] = useState<"all" | "shared">(() => placeOf(draftKey)?.view ?? "all");
  const [refining, setRefining] = useState(() => placeOf(draftKey)?.refining ?? false);
  const [refineOrder, setRefineOrder] = useState<number[]>(() => draftOf(`rerank:${draftKey}`) ?? []);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    keepDraft(`rank:${draftKey}`, order);
  }, [draftKey, order]);
  useEffect(() => {
    keepDraft(`rerank:${draftKey}`, refineOrder);
  }, [draftKey, refineOrder]);

  // Up/down buttons are the keyboard path.
  const rankDrag = useDragReorder(order, setOrder);
  const refineDrag = useDragReorder(refineOrder, setRefineOrder);

  // Room actions wait for the rejoin after a dropped socket: the server
  // refuses them until it lands.
  const offline = roomOffline({ connectionStatus, rejoining });

  // Fetched on arrival, after any rejoin, and again after a rejoin that
  // still has none (the store refetches results already on screen).
  const resultsAsked = useRef(false);
  const resultsMissing = results == null;
  useEffect(() => {
    if (offline || (resultsAsked.current && !resultsMissing)) return;
    resultsAsked.current = true;
    dispatch({ type: "results" });
  }, [dispatch, offline, resultsMissing]);

  // While the payload hasn't arrived, keep asking at a pace slower than
  // the request timeout (15s) so attempts never stack. The screen holds
  // on the loading pulse below until it lands (audit 17 H8) -- rendering
  // the live editor before mySubmitted is known showed it to already-
  // submitted users, whose re-submit then ate their edits.
  useEffect(() => {
    if (results || offline) return;
    const timer = setInterval(() => dispatch({ type: "results" }), 20_000);
    return () => clearInterval(timer);
  }, [dispatch, results, offline]);

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
  const roomName = room ? (room.displayName ?? room.name) : "";
  const standingsCard = useMemo(
    () => (results && room ? buildStandingsCard({ results, season, year, roomName, mediaById }) : null),
    [results, room, roomName, season, year, mediaById],
  );
  const submitting = finalizing?.kind === "submit";
  const refineSubmitting = finalizing?.kind === "refine";
  const mySubmitted = results?.mySubmitted === true;
  // The editor holds through the submit ceremony so the standings never
  // flash in early.
  const rankingDone = mySubmitted && !submitting;
  const round = results?.refined;
  const sharedCount = round?.sharedTitleIds.length ?? 0;
  // The second view exists only with at least two shows to compare.
  const tabsShown = round != null && sharedCount >= 2;
  const myRefined = round?.myRefined === true;
  const canRerank = rerankOpen(results);
  // The re-rank editor holds through its own ceremony, as the ranking's does.
  const editingRefine = round != null && ((refining && canRerank) || refineSubmitting);
  // Back closes the re-rank editor, as its STANDINGS chip does; not while
  // its order is being sent, when the step stays.
  useBackStep(editingRefine, () => {
    if (refineSubmitting) return false;
    setRefining(false);
  });
  // Where the standings stood, for a trip away from the screen.
  useEffect(() => {
    keepPlace(draftKey, { view: standingsView, showAll, refining: editingRefine });
  }, [draftKey, standingsView, showAll, editingRefine]);

  // The share image is made in the background only while the standings are
  // on screen, never behind an editor.
  const standingsShown = rankingDone && !editingRefine && (results?.standings.length ?? 0) > 0;
  const cardImage = useStandingsCardImage(standingsShown ? standingsCard : null);
  // Standings that leave the screen (a new season) take the preview with them.
  useEffect(() => {
    if (!standingsShown) setShareOpen(false);
  }, [standingsShown]);

  // Once per member, room and season, a toast says where the new view is,
  // while All picks is in view and a re-rank is still open to me. It waits
  // for the standings to settle and for any dialog to close, and counts as
  // said once the member finds the view first.
  const announce = standingsShown && canRerank && pageVisible && standingsView === "all";
  const arrivalToastId = `rerank-open-${draftKey}`;
  useEffect(() => {
    if (!announce || getRerankTold(draftKey)) return;
    let timer: ReturnType<typeof setTimeout>;
    const say = () => {
      // Nothing speaks over an open dialog or menu: the details, the share
      // preview, the account menu and its dialogs.
      if (overlayOpen()) {
        timer = setTimeout(say, ARRIVAL_TOAST_DELAY_MS);
        return;
      }
      setRerankTold(draftKey);
      dispatch({
        type: "addToast",
        payload: {
          id: arrivalToastId,
          appearance: "Success",
          showTimeMs: 6000,
          message: `${KEPT_WORDS.rankings} are in. Compare the ${sharedCount} shows ${KEPT_WORDS.phrase} in the ${KEPT_WORDS.tab} tab.`,
        },
      });
    };
    timer = setTimeout(say, ARRIVAL_TOAST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [announce, draftKey, arrivalToastId, sharedCount, dispatch]);
  const showView = (next: "all" | "shared") => {
    if (next === "shared") {
      setRerankTold(draftKey);
      dispatch({ type: "removeToast", payload: { id: arrivalToastId, message: "" } });
    }
    setStandingsView(next);
  };

  // A round that closes (a new member joined) while I'm on its view or in
  // its editor, on screen or away on the review peek, says why and hands
  // focus to the standings; from All picks it only moves the focus its tabs
  // held. The draft stays for a reopen.
  const roundOpen = round != null;
  const resultsIn = results != null;
  const wasOpen = useRef(roundOpen || standingsView === "shared" || refining);
  const standingsHeadRef = useRef<HTMLHeadingElement>(null);
  // The standings headline takes focus once the details dialog closes;
  // any other open dialog or menu keeps it. Arriving from another screen,
  // it is scrolled into view; a change in place leaves the scroll alone.
  const [headFocus, setHeadFocus] = useState<{ scroll: boolean } | null>(null);
  useEffect(() => {
    if (!resultsIn) return;
    const closed = wasOpen.current && !roundOpen;
    wasOpen.current = roundOpen;
    if (!closed) return;
    // The editor and its confirm open from All kept and keep the view there.
    if (standingsView !== "shared") {
      if (focusLost()) setHeadFocus({ scroll: false });
      return;
    }
    const joined = (members ?? results?.members ?? []).filter((m) => !m.submitted).map((m) => m.userName);
    if (joined.length > 0) {
      dispatch({
        type: "addToast",
        payload: {
          id: `rerank-closed-${joined.join("+")}`,
          showTimeMs: 6000,
          message: `${listOf(joined)} joined, so the standings are live again.`,
        },
      });
    }
    setHeadFocus({ scroll: false });
  }, [resultsIn, roundOpen, standingsView, members, results, dispatch]);
  // Without a second view (a closed round, or fewer than two shows left)
  // there is no re-rank, view or arrival toast to keep.
  useEffect(() => {
    if (!resultsIn || tabsShown) return;
    setRefining(false);
    setStandingsView("all");
    dispatch({ type: "removeToast", payload: { id: arrivalToastId, message: "" } });
  }, [resultsIn, tabsShown, arrivalToastId, dispatch]);
  // A re-rank ceremony cannot finish without its round.
  useEffect(() => {
    if (!roundOpen && refineSubmitting) dispatch({ type: "finalizing", payload: null });
  }, [roundOpen, refineSubmitting, dispatch]);
  // A confirm whose submit already landed (from another device, or an ack
  // that was lost) has nothing left to confirm. It leaves with its editor,
  // in the same render, so focus can follow the editor's own handoff.
  const confirmLive = confirmFor === "refine" ? canRerank : confirmFor === "submit" && !mySubmitted;
  useEffect(() => {
    if (confirmFor != null && !confirmLive) setConfirmFor(null);
  }, [confirmFor, confirmLive]);
  // The standings that replace the ranking editor (after the ceremony, or a
  // ranking that landed from elsewhere) take the focus the editor held.
  const wasRankingDone = useRef<boolean | null>(null);
  useEffect(() => {
    if (!results) return;
    const revealed = wasRankingDone.current === false && rankingDone;
    wasRankingDone.current = rankingDone;
    if (revealed && focusLost()) setHeadFocus({ scroll: true });
  }, [results, rankingDone]);
  // Said as this member's own order lands, not again when a closed round
  // reopens.
  const [orderLanded, setOrderLanded] = useState(false);
  const wasRefined = useRef<boolean | null>(null);
  useEffect(() => {
    if (!roundOpen) {
      setOrderLanded(false);
      return;
    }
    if (wasRefined.current === false && myRefined) setOrderLanded(true);
    wasRefined.current = myRefined;
  }, [roundOpen, myRefined]);
  useEffect(() => {
    if (!headFocus || detailTitleId != null) return;
    setHeadFocus(null);
    // Any other open dialog or menu gives focus back itself.
    if (overlayOpen()) return;
    standingsHeadRef.current?.focus({ preventScroll: !headFocus.scroll });
  }, [headFocus, detailTitleId]);
  // Coming back from the review peek, or straight from the lock ceremony,
  // the screen's heading takes the focus lost on the way. A re-rank editor
  // that comes back focuses its own heading.
  const editorHeadRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!(returning.current || fromLock) || !results) return;
    returning.current = false;
    // Arriving back, the standings start at the top of the page.
    window.scrollTo(0, 0);
    if (fromLock) onFocusTaken?.();
    if (!focusLost() || overlayOpen() || editingRefine) return;
    if (rankingDone) setHeadFocus({ scroll: true });
    else editorHeadRef.current?.focus();
  }, [fromLock, results, editingRefine, rankingDone, onFocusTaken]);

  // The re-rank order follows a change in the shows everyone kept (the
  // server takes exactly that set), keeping the member's own ordering. A
  // closed round leaves the draft alone.
  const myOrderKey = round?.myOrder.join(",") ?? "";
  useEffect(() => {
    if (myOrderKey === "") return;
    const mine = myOrderKey.split(",").map(Number);
    setRefineOrder((current) => reconcileOrder(current, mine));
  }, [myOrderKey]);

  // Focus follows the switch into the re-rank editor and back.
  const refineHeadRef = useRef<HTMLHeadingElement>(null);
  const sharedTabRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editingRefine === wasEditing.current) return;
    wasEditing.current = editingRefine;
    if (editingRefine) refineHeadRef.current?.focus();
    // Without the tab (too few shows left), the standings take it.
    else if (sharedTabRef.current) sharedTabRef.current.focus();
    else setHeadFocus({ scroll: false });
  }, [editingRefine]);

  // Reconnect staleness is healed by the store, not here: createStore's
  // joinRoomSuccess handler refetches results after a rejoin lands (a
  // refetch fired on the raw reconnect would race the rejoin and error
  // server-side with "Join a room first").

  // Minimum-3s "Submitting..." ceremony (the owner's spec, audit v1.2.0
  // #9) for both one-shot submits: the editor holds until BOTH the ack
  // (mySubmitted, or myRefined for a refine) and the 3s floor have passed.
  const acked = submitting ? mySubmitted : refineSubmitting && myRefined;
  const finalizingStartedAt = finalizing?.startedAt;
  useEffect(() => {
    if (!acked || finalizingStartedAt == null) return;
    const remaining = Math.max(0, finalizingStartedAt + 3000 - Date.now());
    const timer = setTimeout(
      () => dispatch({ type: "finalizing", payload: null }),
      remaining,
    );
    return () => clearTimeout(timer);
  }, [acked, finalizingStartedAt, dispatch]);

  if (!room) return <div />;

  // Editor-vs-standings can't be decided without the payload; hold.
  if (!results) return <Loading />;

  const view = tabsShown ? standingsView : "all";

  const moveIn = (setList: Dispatch<SetStateAction<number[]>>) => (index: number, delta: number) => {
    setList((current) => {
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

  // The draft carries over from an earlier visit.
  const openRefine = (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    swallowSecondClick();
    showView("shared");
    setRefining(true);
  };

  // ── Editor pieces (the ranking, and the re-rank of the shows everyone kept) ──

  const editorHeadline = (
    <>
      <h1 className={styles.headline} ref={editorHeadRef} tabIndex={-1}>
        rank your keeps.
      </h1>
      <p className={styles.contextLine}>{`${TOP_SCORE} · PASSED AND UNSURE ARE DISCARDED`}</p>
    </>
  );

  // The scoring that applies to this many shows.
  const scoringLine =
    sharedCount > RANK_POINTS.length ? TOP_SCORE : `SCORED ${RANK_POINTS.slice(0, sharedCount).join(" · ")}`;
  const refineHeadline = (
    <>
      <h1 className={styles.headline} ref={refineHeadRef} tabIndex={-1}>
        re-rank these {sharedCount}.
      </h1>
      <p className={styles.contextLine}>
        <span className={styles.keepTogether}>
          {`THE ${sharedCount} SHOWS ${KEPT_WORDS.phrase.toUpperCase()}`}
        </span>
        {" · "}
        <span className={styles.keepTogether}>{scoringLine}</span>
      </p>
    </>
  );
  // Where each show sat in this member's own ranking.
  const hadIt = (titleId: number) => {
    const at = results.myRanking.indexOf(titleId);
    return at >= 0 ? `YOU HAD IT #${at + 1}` : undefined;
  };

  // A sortable list: drag any row, or the up/down buttons.
  const orderList = (
    list: number[],
    setList: Dispatch<SetStateAction<number[]>>,
    drag: ReturnType<typeof useDragReorder>,
    frozen: boolean,
    metaOf?: (titleId: number) => string | undefined,
  ) => {
    const move = moveIn(setList);
    return (
      <ul className={styles.rows} ref={drag.listRef} data-reordering={drag.draggingId != null}>
        {list.map((titleId, i) => (
          <li
            key={titleId}
            className={styles.row}
            data-rank-row
            data-reorder-id={titleId}
            data-dragging={drag.draggingId === titleId}
            // No dragging during a submit ceremony.
            onPointerDown={frozen ? undefined : (e) => drag.onPointerDown(e, titleId)}
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
            {metaOf ? (
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{titleOf(titleId)}</span>
                <span className={styles.rowMeta}>{metaOf(titleId)}</span>
              </span>
            ) : (
              <span className={styles.rowTitle}>{titleOf(titleId)}</span>
            )}
            <span className={styles.moveButtons} data-no-drag>
              <button
                type="button"
                className={styles.moveBtn}
                aria-label={`Move ${titleOf(titleId)} up`}
                // The end of the list leaves the button focusable, so a
                // move into the top slot keeps keyboard focus here.
                aria-disabled={i === 0}
                disabled={frozen}
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
                aria-disabled={i === list.length - 1}
                disabled={frozen}
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
  };

  const editorList =
    order.length === 0 ? (
      <p className={styles.emptyNote}>
        you kept nothing this season. bold. submit to sit this one out.
      </p>
    ) : (
      orderList(order, setOrder, rankDrag, submitting)
    );

  const refineList = orderList(refineOrder, setRefineOrder, refineDrag, refineSubmitting, hadIt);

  const openConfirm = (kind: "submit" | "refine") => {
    setConfirmChecked(false);
    setConfirmFor(kind);
  };

  const submitControls = (
    <>
      <button
        type="button"
        className={styles.submitBtn}
        disabled={offline || submitting}
        // The second click of a double-click on the button that sat here
        // (the review peek's way back) opens nothing.
        onClick={(e) => {
          if (e.detail > 1) return;
          openConfirm("submit");
        }}
        data-test-handle="submit-rankings"
      >
        {submitting ? "submitting\u2026" : "submit rankings"}
      </button>
      <p className={styles.submitCaption}>STANDINGS COMBINE ONCE RANKINGS COME IN</p>
    </>
  );

  const refineControls = (
    <>
      <button
        type="button"
        className={styles.submitBtn}
        disabled={offline || refineSubmitting}
        onClick={(e) => {
          if (e.detail > 1) return;
          openConfirm("refine");
        }}
        data-test-handle="submit-refine"
      >
        {refineSubmitting ? "submitting\u2026" : "submit this order"}
      </button>
      <p className={styles.submitCaption}>OPTIONAL &middot; ONE SHOT &middot; THE RESULT WON&apos;T CHANGE</p>
    </>
  );

  // The way back from the re-rank: a header chip, as the deck's scoped trips.
  const backChip = (
    <button
      type="button"
      className={styles.backChip}
      disabled={refineSubmitting}
      onClick={() => setRefining(false)}
      aria-label="Back to standings"
      data-test-handle="refine-back"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>STANDINGS</span>
    </button>
  );

  // The scoring slots a list of `count` shows can fill, then the zero rest.
  const pointLegend = (count: number) => (
    <ul className={styles.legend} aria-hidden="true">
      {RANK_POINTS.slice(0, count).map((pts, i) => (
        <li key={pts} className={styles.legendRow}>
          <span className={styles.legendRank}>#{i + 1}</span>
          <span className={styles.legendPts}>{pts} PTS</span>
        </li>
      ))}
      {count > RANK_POINTS.length && (
        <li className={styles.legendRow} data-rest>
          <span className={styles.legendRank}>#{RANK_POINTS.length + 1}+</span>
          <span className={styles.legendPts}>0 PTS</span>
        </li>
      )}
    </ul>
  );

  // ── Standings pieces ──

  // FINAL once every member has submitted; otherwise live, naming who is pending.
  const memberStates = members ?? results.members ?? [];
  const waitingOn = memberStates.filter((m) => !m.submitted).map((m) => m.userName);
  const isFinal = standingsFinal(results.submittedCount, results.memberCount);
  // The room's result: it heads both views and never switches.
  const standingsHead = (
    <div className={styles.standingsHead}>
      <h1 className={styles.headline} ref={standingsHeadRef} tabIndex={-1}>
        {season.toLowerCase()} standings.
      </h1>
      <p className={styles.contextLine}>
        {`${rankingsIn(results.submittedCount, results.memberCount)} · ${isFinal ? "FINAL" : "UPDATES LIVE"}`}
        {!isFinal && waitingOn.length > 0 &&
          ` · WAITING ON ${waitingOn.map((n) => n.toUpperCase()).join(", ")}`}
      </p>
      {standingsShown && standingsCard && (
        <button
          type="button"
          className={styles.shareLink}
          onClick={(e) => {
            if (e.detail > 1) return;
            swallowSecondClick();
            cardImage.refresh();
            setShareOpen(true);
          }}
          data-test-handle="share-standings"
        >
          SHARE THE STANDINGS <span aria-hidden="true">&rarr;</span>
        </button>
      )}
    </div>
  );

  const allStandings = results.standings ?? [];
  const allRankOf = new Map(allStandings.map((s) => [s.titleId, s.rank]));

  // All picks, or the shows everyone kept, switched right above the list.
  const tabsEl = tabsShown && (
    <PillTabs
      label="Standings"
      idPrefix="standings"
      className={styles.viewTabs}
      tabs={[
        { id: "all", label: `All picks ${allStandings.length}`, testHandle: "standings-all" },
        {
          id: "shared",
          label: `${KEPT_WORDS.tab} ${sharedCount}`,
          testHandle: "standings-shared",
          ref: sharedTabRef,
        },
      ]}
      active={view}
      onSelect={showView}
    />
  );

  // Who has re-ranked, said as it happened, never as a count still to go.
  const rerankedBy = rerankedByText(memberStates.filter((m) => m.refined).map((m) => m.userName));
  const allKeptHead = view === "shared" && (
    <div className={styles.panelHead}>
      <p className={styles.sharedNote}>
        scored as if these {sharedCount} were all you kept. the room&apos;s result doesn&apos;t change.
      </p>
      <p className={styles.panelFacts} role="status">
        {rerankedBy}
      </p>
      {canRerank && (
        <button type="button" className={styles.refineBtn} onClick={openRefine} data-test-handle="open-refine">
          RE-RANK THESE {sharedCount} <span aria-hidden="true">&rarr;</span>
        </button>
      )}
    </div>
  );

  // " · RANKED BY ..." after a row's points, or nothing.
  const rankedBySuffix = (names: readonly string[] | undefined, count: number) => {
    const text = rankedByText(names, count);
    return text ? ` · ${text}` : "";
  };

  // All picks rows name who ranked them and carry the medals; the rows of
  // the second view are quiet and point back to the room's result.
  const standingsList = (desktop: boolean, rows: RankingStanding[], all: boolean, listKey: string) => {
    const visible = showAll[view] ? rows : rows.slice(0, STANDINGS_PREVIEW);
    return (
      <ul className={desktop ? styles.standingsRows : styles.rows} key={desktop ? listKey : undefined}>
        {visible.map((standing) => {
          const allRank = allRankOf.get(standing.titleId);
          return (
            <li
              key={standing.titleId}
              className={styles.row}
              data-rank={standing.rank}
              data-medal={all && standing.rank <= 3 ? standing.rank : undefined}
              data-hero={desktop && all && standing.rank === 1}
            >
              {/* The whole row opens the read-only details drawer (UX 4). */}
              <button
                type="button"
                className={styles.rowOpen}
                // The second click of a double-click (a dialog's Close above)
                // opens nothing.
                onClick={(e) => {
                  if (e.detail > 1) return;
                  setDetailTitleId(standing.titleId);
                }}
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
                    {all
                      ? rankedBySuffix(standing.rankedByNames, standing.rankedBy)
                      : allRank != null && ` · #${allRank} IN ALL PICKS`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className={styles.emptyNote}>{isFinal ? "nobody kept a show" : "no picks yet"}</li>
        )}
      </ul>
    );
  };

  // "Everyone's #1": each submitted member's top pick, regardless of where
  // it lands in the combined standings (the owner's ask). Members who put
  // the same show first share its poster.
  const topPicks = groupTopPicks(results.topPicks ?? []);
  const topPicksEl = topPicks.length > 0 && (
    <div className={styles.topPicks}>
      <p className={styles.topPicksLabel}>EVERYONE&apos;S #1</p>
      <div className={styles.topPicksRow}>
        {topPicks.map((pick) => (
          // A poster opens the show's details, as a standings row does.
          <button
            key={pick.titleId}
            type="button"
            className={styles.pickCard}
            onClick={(e) => {
              // The second click of a double-click (a dialog's Close above)
              // opens nothing.
              if (e.detail > 1) return;
              setDetailTitleId(pick.titleId);
            }}
            data-test-handle="top-pick"
          >
            <span className={styles.pickPoster}>
              {posterOf(pick.titleId) && (
                <img className={styles.pickPosterImg} src={posterOf(pick.titleId)} alt="" />
              )}
            </span>
            {/* The no-break space keeps each + with the name after it. */}
            <span className={styles.pickName}>{pick.names.join(" +\u00a0")}</span>
            <span className={styles.pickTitle}>{titleOf(pick.titleId)}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const standingsRevealEl = (rows: RankingStanding[]) =>
    rows.length > STANDINGS_PREVIEW && (
      <button
        type="button"
        className={styles.showAllBtn}
        onClick={() => setShowAll((open) => ({ ...open, [view]: !open[view] }))}
        data-test-handle="standings-reveal"
      >
        {showAll[view] ? `SHOW TOP ${STANDINGS_PREVIEW}` : `SHOW ALL ${rows.length}`}
      </button>
    );

  // What the tabs switch: the view's own head, its list and the reveal.
  const sharedView = view === "shared" && round != null;
  const viewRows = sharedView ? round.standings : allStandings;
  const standingsPanel = (desktop: boolean) => (
    <div className={styles.standingsPanel} {...(tabsShown ? tabPanelProps("standings", view) : {})}>
      {allKeptHead}
      {standingsList(
        desktop,
        viewRows,
        !sharedView,
        sharedView ? `shared-${round.refinedCount}` : `all-${results.submittedCount}`,
      )}
      {standingsRevealEl(viewRows)}
    </div>
  );

  const detailMedia = detailTitleId != null ? mediaById.get(detailTitleId) : undefined;
  const detailDialogEl = detailMedia && (
    <DialogScrim
      label={detailMedia.title}
      alert={false}
      onDismiss={() => setDetailTitleId(null)}
      backdropClassName={styles.detailBackdrop}
      dialogClassName={styles.detailDialog}
    >
      {/* Pinned to the top of the scrolling dialog, so the way out stays in view. */}
      <div className={styles.detailTop}>
        <button
          type="button"
          className={styles.detailClose}
          aria-label="Close"
          onClick={() => setDetailTitleId(null)}
          data-test-handle="detail-close"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <DeckDetails media={detailMedia} />
    </DialogScrim>
  );

  // The one-shot submits, said aloud: no focused control reports them.
  const submitNote = (
    <p className={styles.srOnly} role="status">
      {submitting
        ? "Submitting your ranking…"
        : refineSubmitting
          ? "Submitting your order…"
          : orderLanded && myRefined
            ? "Your order is in."
            : ""}
    </p>
  );

  const shareDialogEl = shareOpen && standingsShown && standingsCard && (
    <SharePreview
      card={standingsCard}
      image={cardImage}
      allPicks={tabsShown}
      waitingOn={waitingOn}
      onClose={() => setShareOpen(false)}
    />
  );

  const confirmIsRefine = confirmFor === "refine";
  const confirmDialogEl = confirmLive && (
    <DialogScrim
      label={
        confirmIsRefine ? `Submit your order for the shows ${KEPT_WORDS.phrase}` : "Submit your rankings"
      }
      onDismiss={() => setConfirmFor(null)}
      backdropClassName={styles.confirmBackdrop}
      dialogClassName={styles.confirmDialog}
    >
        <h2 className={styles.confirmTitle}>no turning back.</h2>
        <p className={styles.confirmText}>
          {confirmIsRefine
            ? `This sends your order for the ${sharedCount} shows ${KEPT_WORDS.phrase}. You can't change it after this, and the room's result doesn't change.`
            : "This submits your final ranking and reveals the standings. You can't change it after this."}
        </p>
        <label className={styles.confirmCheckRow}>
          <input
            type="checkbox"
            className={styles.confirmCheckbox}
            checked={confirmChecked}
            onChange={(e) => setConfirmChecked(e.target.checked)}
          />
          <span>{confirmIsRefine ? "This is my order" : "This is my final ranking"}</span>
        </label>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.confirmCancel}
            onClick={() => setConfirmFor(null)}
          >
            {confirmIsRefine ? "keep re-ranking" : "keep ranking"}
          </button>
          <button
            type="button"
            className={styles.confirmSubmit}
            disabled={!confirmChecked || offline}
            onClick={() => {
              setConfirmFor(null);
              if (confirmIsRefine) {
                dispatch({ type: "finalizing", payload: { kind: "refine" } });
                dispatch({ type: "submitRefinedRankings", payload: { rankedTitleIds: refineOrder } });
              } else {
                dispatch({ type: "finalizing", payload: { kind: "submit" } });
                dispatch({ type: "submitRankings", payload: { rankedTitleIds: order } });
              }
            }}
            data-test-handle={confirmIsRefine ? "confirm-refine" : "confirm-submit"}
          >
            submit
          </button>
        </div>
    </DialogScrim>
  );

  // ── Desktop ──
  if (isDesktop) {
    return (
      <div className={styles.deskScreen}>
        <AppHeader leading={editingRefine ? backChip : undefined} roomLabel={roomName} />
        {editingRefine ? (
          <div className={styles.deskBody}>
            <aside className={styles.rail}>
              {refineHeadline}
              {pointLegend(sharedCount)}
              <div className={styles.railSubmit}>{refineControls}</div>
            </aside>
            <div className={styles.main}>{refineList}</div>
          </div>
        ) : rankingDone ? (
          <div className={styles.deskBody}>
            <aside className={styles.rail}>
              {standingsHead}
              {topPicksEl}
            </aside>
            <div className={styles.main}>
              {tabsEl}
              {standingsPanel(true)}
            </div>
          </div>
        ) : (
          <div className={styles.deskBody}>
            <aside className={styles.rail}>
              {editorHeadline}
              {pointLegend(Number.POSITIVE_INFINITY)}
              <div className={styles.railSubmit}>{submitControls}</div>
            </aside>
            <div className={styles.main}>{editorList}</div>
          </div>
        )}
        {submitNote}
        {confirmDialogEl}
        {detailDialogEl}
        {shareDialogEl}
      </div>
    );
  }

  // ── Mobile ──
  return (
    <div className={styles.screen}>
      <MobileHeader leading={editingRefine ? backChip : undefined} roomLabel={roomName} className={styles.topBar} />

      {editingRefine ? (
        <>
          {refineHeadline}
          {refineList}
          <footer className={styles.submitBar}>{refineControls}</footer>
        </>
      ) : !rankingDone ? (
        <>
          {editorHeadline}
          {editorList}
          <footer className={styles.submitBar}>{submitControls}</footer>
        </>
      ) : (
        <>
          {standingsHead}
          {topPicksEl}
          {tabsEl}
          {standingsPanel(false)}
        </>
      )}

      {submitNote}
      {confirmDialogEl}
      {detailDialogEl}
      {shareDialogEl}
    </div>
  );
};
