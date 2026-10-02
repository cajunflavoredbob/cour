import { describe, expect, it } from 'vitest';
import { reconcileOrder } from '../../web/app/src/utils/rankOrder';

// The rank editor's working order must follow the member's liked set when it
// changes under an open screen, which happens whenever a season's daily
// refresh in its first four weeks adds or drops a title.
describe('reconcileOrder', () => {
  it('adopts the liked set wholesale on first load', () => {
    expect(reconcileOrder([], [3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('returns the SAME array when nothing changed', () => {
    // Identity, not just equality: a ledger re-pull that altered nothing
    // must not re-render the list under an in-progress drag.
    const current = [2, 3, 1];
    expect(reconcileOrder(current, [1, 2, 3])).toBe(current);
  });

  it("keeps the member's own ordering for titles still liked", () => {
    // The member dragged 3 to the top. A refresh that changes nothing
    // about their likes must not snap the list back to ledger order.
    expect(reconcileOrder([3, 1, 2], [1, 2, 3])).toEqual([3, 1, 2]);
  });

  it('drops a title removed upstream, keeping the rest in place', () => {
    // Title 1 left the deck, so the server's likes-in-deck set is {2, 3},
    // and an order still holding 1 is not a permutation of it.
    expect(reconcileOrder([3, 1, 2], [2, 3])).toEqual([3, 2]);
  });

  it('appends a newly liked title at the bottom', () => {
    expect(reconcileOrder([3, 1, 2], [1, 2, 3, 4])).toEqual([3, 1, 2, 4]);
  });

  it('handles a removal and an addition in the same refresh', () => {
    expect(reconcileOrder([3, 1, 2], [2, 3, 5])).toEqual([3, 2, 5]);
  });

  it('appends several new titles in ledger order', () => {
    expect(reconcileOrder([1], [9, 1, 7])).toEqual([1, 9, 7]);
  });

  it('empties out when every liked title is gone', () => {
    expect(reconcileOrder([1, 2], [])).toEqual([]);
  });

  it('always produces exactly a permutation of the liked set', () => {
    // The server's acceptance condition, checked directly across a spread of
    // shapes, since that is the property the reconciliation exists to hold.
    const cases: Array<[number[], number[]]> = [
      [[1, 2, 3], [3, 2, 1]],
      [[4, 5, 6], [6, 7]],
      [[1], [2, 3, 4]],
      [[9, 8, 7, 6], [6, 9]],
      [[], [1, 2]],
    ];
    for (const [current, liked] of cases) {
      const out = reconcileOrder(current, liked);
      expect([...out].sort((a, b) => a - b)).toEqual([...liked].sort((a, b) => a - b));
      expect(new Set(out).size).toBe(out.length);
    }
  });
});
