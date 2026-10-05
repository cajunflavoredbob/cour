// Standings wording shared by the Rank screen and the share card.

/** Whether every member has submitted, so the standings are final. */
export const standingsFinal = (submittedCount: number, memberCount: number): boolean =>
  memberCount > 0 && submittedCount >= memberCount;

/** "ALL 3 RANKINGS IN", "1 OF 3 RANKINGS IN", or "1 RANKING IN" for a room of one. */
export const rankingsIn = (submittedCount: number, memberCount: number): string => {
  const noun = memberCount === 1 ? "RANKING" : "RANKINGS";
  if (!standingsFinal(submittedCount, memberCount)) return `${submittedCount} OF ${memberCount} ${noun} IN`;
  return memberCount === 1 ? `1 ${noun} IN` : `ALL ${memberCount} ${noun} IN`;
};

/** "1 OF 2 REFINED", or "ALL 2 REFINED" once every member has refined. */
export const refinedIn = (refinedCount: number, memberCount: number): string =>
  memberCount > 0 && refinedCount >= memberCount
    ? `ALL ${memberCount} REFINED`
    : `${refinedCount} OF ${memberCount} REFINED`;

/** "RANKED BY USER1 + USER2", a count when the names are missing, or "" for a single ranker. */
export const rankedByText = (names: readonly string[] | undefined, rankedBy: number): string =>
  names?.length
    ? `RANKED BY ${names.map((n) => n.toUpperCase()).join(" + ")}`
    : rankedBy > 1
      ? `RANKED BY ${rankedBy}`
      : "";
