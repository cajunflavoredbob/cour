/**
 * Reconcile the rank editor's working order against the member's current
 * liked titles.
 *
 * The liked set can change while the editor is open: the server refreshes a
 * season's list daily for its first four weeks, and the ledger is re-pulled
 * whenever the deck swaps. The editor must follow it, or a title removed
 * upstream stays in the order and the server rejects the submit (it checks
 * for an exact permutation of the member's likes in the CURRENT deck).
 *
 * Rules:
 *   - the member's own relative ordering of every still-liked title is kept;
 *   - titles no longer liked, or no longer in the deck, are dropped;
 *   - newly liked titles are appended at the bottom, in ledger order, since
 *     nobody has ranked them yet;
 *   - when nothing changed, the SAME array is returned, so a ledger re-pull
 *     that altered nothing does not re-render the list.
 *
 * An empty `current` adopts `liked` wholesale: that is the first-load case,
 * where the ledger arrives after the screen mounts.
 */
export const reconcileOrder = (current: number[], liked: number[]): number[] => {
  if (current.length === 0) return liked;
  const likedSet = new Set(liked);
  const currentSet = new Set(current);
  const kept = current.filter((id) => likedSet.has(id));
  const added = liked.filter((id) => !currentSet.has(id));
  if (kept.length === current.length && added.length === 0) return current;
  return [...kept, ...added];
};

interface RowSpan {
  top: number;
  bottom: number;
}

const midline = (row: RowSpan) => (row.top + row.bottom) / 2;

/**
 * The slot a dragged row belongs in for a pointer at `y`, given every row's
 * vertical extent in current order. The row passes a neighbor once the
 * pointer crosses that neighbor's midline.
 */
export const dragTargetIndex = (rows: readonly RowSpan[], from: number, y: number): number => {
  let to = from;
  while (to + 1 < rows.length && y > midline(rows[to + 1])) to++;
  if (to !== from) return to;
  while (to > 0 && y < midline(rows[to - 1])) to--;
  return to;
};

/** `order` with the item at `from` moved to `to`. */
export const moveItem = <T>(order: readonly T[], from: number, to: number): T[] => {
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};
