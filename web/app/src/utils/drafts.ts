// What the rank screen keeps across a trip away from it (the review peek):
// the editors' drafts and where the standings stood, keyed by member, room
// and season, until the page reloads.
const drafts = new Map<string, number[]>();

export interface StandingsPlace {
  view: "all" | "shared";
  /** Each view's SHOW ALL reveal. */
  showAll: Record<"all" | "shared", boolean>;
  /** The re-rank editor was open. */
  refining: boolean;
}

const places = new Map<string, StandingsPlace>();

/** The key drafts and places are kept under: member, room and season. */
export const placeKey = (userName: string | undefined, roomName: string | undefined, season: string, year: number): string =>
  `${userName ?? ""}:${roomName ?? ""}:${season}:${year}`;

export const draftOf = (key: string): number[] | undefined => drafts.get(key);

export const keepDraft = (key: string, order: number[]): void => {
  drafts.set(key, order);
};

export const placeOf = (key: string): StandingsPlace | undefined => places.get(key);

export const keepPlace = (key: string, place: StandingsPlace): void => {
  places.set(key, place);
};

/** Forgets every draft and place. */
export const forgetDrafts = (): void => {
  drafts.clear();
  places.clear();
};
