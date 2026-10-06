// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// A reload on a step's entry: the page starts two entries above its own,
// left by the last session. The module takes them off before its first
// steps go on.
const entries: unknown[] = [null, { courDepth: 1 }, { courDepth: 2 }];
let index = 2;
const fakeHistory = {
  scrollRestoration: 'auto',
  get state() {
    return entries[index];
  },
  pushState: vi.fn((state: unknown) => {
    entries.splice(index + 1, entries.length, state);
    index += 1;
  }),
  replaceState: vi.fn((state: unknown) => {
    entries[index] = state;
  }),
  go: vi.fn((delta: number) => {
    index += delta;
  }),
};
vi.stubGlobal('history', fakeHistory);

describe('back steps after a reload', () => {
  it("takes the last session's entries off before this session's steps go on", async () => {
    const { openStep } = await import('../../web/app/src/utils/backSteps');
    // The app restores its own scroll.
    expect(fakeHistory.scrollRestoration).toBe('manual');
    expect(fakeHistory.go).toHaveBeenCalledWith(-2);
    // The deck and the tutorial open while the traversal is still on its way.
    const deck = vi.fn();
    const tutorial = vi.fn();
    openStep(deck);
    openStep(tutorial, 'overlay');
    expect(fakeHistory.pushState).not.toHaveBeenCalled();
    // The traversal lands on the page's own entry: their entries go on,
    // numbered from it.
    window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
    expect(entries).toEqual([null, { courDepth: 1 }, { courDepth: 2 }]);
    expect(index).toBe(2);
    // Back closes the tutorial, then the deck.
    index -= 1;
    window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
    expect(tutorial).toHaveBeenCalledTimes(1);
    expect(deck).not.toHaveBeenCalled();
    index -= 1;
    window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
    expect(deck).toHaveBeenCalledTimes(1);
  });
});
