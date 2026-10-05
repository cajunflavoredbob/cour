// Editor drafts that outlive a trip away from the rank screen (the review
// peek), keyed by editor, room and season, until the page reloads.
const drafts = new Map<string, number[]>();

export const draftOf = (key: string): number[] | undefined => drafts.get(key);

export const keepDraft = (key: string, order: number[]): void => {
  drafts.set(key, order);
};

/** Forgets every draft. */
export const forgetDrafts = (): void => {
  drafts.clear();
};
