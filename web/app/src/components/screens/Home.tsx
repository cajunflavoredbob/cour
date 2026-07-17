import { JoinScreen } from "./Join";
import { LedgerStalled } from "./LedgerStalled";
import { Loading } from "./Loading";
import { RankScreen } from "./Rank";
import { ReviewScreen } from "./Review";
import { useStore } from "../../store";

/**
 * The home route: the join form until a room is joined; the seasonal
 * review while picking; the rank/standings screen once locked in
 * (0.13.0 -- lock-in flows straight into ranking).
 */
export const HomeScreen = () => {
  const [{ room, review, viewLockedReview, ledgerStalled, finalizing }] = useStore([
    "room",
    "review",
    "viewLockedReview",
    "ledgerStalled",
    "finalizing",
  ]);
  if (!room?.joined) return <JoinScreen />;
  // Joined but the ledger hasn't arrived (post-join fetch in flight or
  // retrying): a joined user shown the join form reads as logged out
  // (audit 17 H5) -- hold on the wordmark pulse instead.
  if (!review) return ledgerStalled ? <LedgerStalled /> : <Loading />;
  if (review.lockedAt == null) return <ReviewScreen />;
  // Hold the review screen through the minimum-3s "Locking in..."
  // ceremony (audit v1.2.0 #9) so the flip to standings never flashes.
  if (finalizing?.kind === "lock") return <ReviewScreen />;
  // Locked: standings are home, but "my review" stays reachable as a
  // read-only peek (audit 17 UX 6 -- the ledger used to become
  // unreachable forever the moment you locked).
  return viewLockedReview ? <ReviewScreen /> : <RankScreen />;
};
