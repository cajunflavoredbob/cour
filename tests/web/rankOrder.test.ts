import { describe, expect, it } from 'vitest';
import { dragTargetIndex, moveItem, reconcileOrder } from '../../web/app/src/utils/rankOrder';

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

// Three 60px rows: midlines at 30, 90, 150.
const rows = [
  { top: 0, bottom: 60 },
  { top: 60, bottom: 120 },
  { top: 120, bottom: 180 },
];

describe('dragTargetIndex', () => {
  it('stays put while the pointer is inside its own row', () => {
    expect(dragTargetIndex(rows, 1, 61)).toBe(1);
    expect(dragTargetIndex(rows, 1, 119)).toBe(1);
  });

  it('does not shift a row grabbed below its midline', () => {
    expect(dragTargetIndex(rows, 0, 55)).toBe(0);
    expect(dragTargetIndex(rows, 0, 59)).toBe(0);
  });

  it("passes the next row only once the pointer crosses that row's midline", () => {
    expect(dragTargetIndex(rows, 0, 90)).toBe(0);
    expect(dragTargetIndex(rows, 0, 91)).toBe(1);
  });

  it('passes several rows in one move', () => {
    expect(dragTargetIndex(rows, 0, 151)).toBe(2);
    expect(dragTargetIndex(rows, 2, 29)).toBe(0);
  });

  it('moves up across the previous midline', () => {
    expect(dragTargetIndex(rows, 2, 90)).toBe(2);
    expect(dragTargetIndex(rows, 2, 89)).toBe(1);
  });

  it('clamps past either end of the list', () => {
    expect(dragTargetIndex(rows, 1, 10_000)).toBe(2);
    expect(dragTargetIndex(rows, 1, -500)).toBe(0);
  });

  it('does not swap rows of unequal height back and forth', () => {
    // A (40px) passes B (80px, midline 80) at y=85...
    expect(dragTargetIndex([{ top: 0, bottom: 40 }, { top: 40, bottom: 120 }], 0, 85)).toBe(1);
    // ...and with B now on top (midline 40), the same y keeps A below it.
    expect(dragTargetIndex([{ top: 0, bottom: 80 }, { top: 80, bottom: 120 }], 1, 85)).toBe(1);
    expect(dragTargetIndex([{ top: 0, bottom: 80 }, { top: 80, bottom: 120 }], 1, 39)).toBe(0);
  });

  it('handles a single row', () => {
    expect(dragTargetIndex([{ top: 0, bottom: 60 }], 0, 500)).toBe(0);
  });
});

describe('moveItem', () => {
  it('moves an item down and up', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3]);
  });

  it('leaves the input untouched', () => {
    const order = [1, 2, 3];
    moveItem(order, 0, 2);
    expect(order).toEqual([1, 2, 3]);
  });
});
