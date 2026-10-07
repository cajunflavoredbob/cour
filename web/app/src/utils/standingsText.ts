// What the standings say and how they score, for the screens that show
// them and the share card.
import type { RankingResults } from "../../../../types/reely";

/** Points for a ranking's top places, #1 first, as the server scores them. */
export const RANK_POINTS: readonly number[] = [12, 9, 6, 3, 1];

/** The re-rank round is open to me: two or more shows everyone kept, my order not in yet. */
export const rerankOpen = (results: RankingResults | undefined): boolean => {
  const round = results?.refined;
  return round != null && round.sharedTitleIds.length >= 2 && !round.myRefined;
};

/** How the shows every member kept are named, in a room of any size. */
export const KEPT_WORDS = { tab: "All kept", phrase: "everyone kept", rankings: "All rankings" } as const;

/** Whether every member has submitted, so the standings are final. */
export const standingsFinal = (submittedCount: number, memberCount: number): boolean =>
  memberCount > 0 && submittedCount >= memberCount;

/** "ALL 3 RANKINGS IN", "1 OF 3 RANKINGS IN", or "1 RANKING IN" for a room of one. */
export const rankingsIn = (submittedCount: number, memberCount: number): string => {
  const noun = memberCount === 1 ? "RANKING" : "RANKINGS";
  if (!standingsFinal(submittedCount, memberCount)) return `${submittedCount} OF ${memberCount} ${noun} IN`;
  return memberCount === 1 ? `1 ${noun} IN` : `ALL ${memberCount} ${noun} IN`;
};

/** "RE-RANKED BY USER1 + USER2", or "" while nobody has. */
export const rerankedByText = (names: readonly string[]): string =>
  names.length > 0 ? `RE-RANKED BY ${names.map((n) => n.toUpperCase()).join(" + ")}` : "";

/** "RANKED BY USER1 + USER2", a count when the names are missing, or "" for a single ranker. */
export const rankedByText = (names: readonly string[] | undefined, rankedBy: number): string =>
  names?.length
    ? `RANKED BY ${names.map((n) => n.toUpperCase()).join(" + ")}`
    : rankedBy > 1
      ? `RANKED BY ${rankedBy}`
      : "";

/** Each member's #1 grouped by show, in the order the shows first appear. */
export const groupTopPicks = (
  picks: readonly { userName: string; titleId: number }[],
): { titleId: number; names: string[] }[] => {
  const groups = new Map<number, string[]>();
  for (const pick of picks) {
    const names = groups.get(pick.titleId);
    if (names) names.push(pick.userName);
    else groups.set(pick.titleId, [pick.userName]);
  }
  return [...groups].map(([titleId, names]) => ({ titleId, names }));
};

// English collation for every viewer, so a shared place lists the same
// way in any browser language.
const byTitle = new Intl.Collator("en", { sensitivity: "base" }).compare;

/** Standings with the shows of each shared place in title order, A to Z. */
export const orderTies = <T extends { rank: number; titleId: number }>(
  rows: readonly T[],
  titleOf: (titleId: number) => string,
): T[] => [...rows].sort((a, b) => a.rank - b.rank || byTitle(titleOf(a.titleId), titleOf(b.titleId)));
