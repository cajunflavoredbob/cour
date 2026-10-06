// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStep, replaceUrl } from '../../web/app/src/utils/backSteps';

// A history stand-in: a list of entry states and the current index. A
// traversal moves the index and fires popstate with the landed entry's
// state on the next task, as browsers do.
let entries: unknown[];
let index: number;
const fire = () => window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
const fakeHistory = {
  scrollRestoration: 'manual',
  get state() {
    return entries[index];
  },
  pushState: vi.fn((state: unknown) => {
    entries = [...entries.slice(0, index + 1), state];
    index += 1;
  }),
  replaceState: vi.fn((state: unknown) => {
    entries[index] = state;
  }),
  go: vi.fn((delta: number) => {
    index += delta;
    setTimeout(fire, 0);
  }),
};
const traverse = (delta: number) => {
  index += delta;
  fire();
};
const pressBack = () => traverse(-1);
// Lets the app's own pending close and traversal finish.
const settle = () => {
  vi.advanceTimersByTime(1);
  vi.advanceTimersByTime(1);
};

beforeEach(() => {
  entries = [null];
  index = 0;
  vi.stubGlobal('history', fakeHistory);
  vi.useFakeTimers();
  for (const fn of [fakeHistory.pushState, fakeHistory.replaceState, fakeHistory.go]) fn.mockClear();
});

afterEach(() => {
  settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('back steps', () => {
  it('holds one entry per open step, marked with its height, and Back closes it', () => {
    const onBack = vi.fn();
    openStep(onBack);
    expect(entries).toEqual([null, { courDepth: 1 }]);
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    settle();
    expect(fakeHistory.go).not.toHaveBeenCalled();
  });

  it('closes the top overlay first, even one opened before the screen under it', () => {
    const tutorial = vi.fn();
    const deck = vi.fn();
    openStep(tutorial, 'overlay');
    openStep(deck);
    pressBack();
    expect(tutorial).toHaveBeenCalledTimes(1);
    expect(deck).not.toHaveBeenCalled();
    pressBack();
    expect(deck).toHaveBeenCalledTimes(1);
  });

  it('closes the newest screen when no overlay is open', () => {
    const deck = vi.fn();
    const peek = vi.fn();
    openStep(deck);
    openStep(peek);
    pressBack();
    expect(peek).toHaveBeenCalledTimes(1);
    expect(deck).not.toHaveBeenCalled();
    pressBack();
    expect(deck).toHaveBeenCalledTimes(1);
  });

  it('takes the entry back off when the app closes a step itself', () => {
    const close = openStep(vi.fn());
    close();
    settle();
    expect(fakeHistory.go).toHaveBeenCalledWith(-1);
    expect(index).toBe(0);
  });

  it('after an older step closes in the app, Back closes only the step still open', () => {
    const closeTutorial = openStep(vi.fn(), 'overlay');
    const deck = vi.fn();
    openStep(deck);
    closeTutorial();
    settle();
    expect(index).toBe(1);
    const sheet = vi.fn();
    openStep(sheet, 'overlay');
    pressBack();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(deck).not.toHaveBeenCalled();
    pressBack();
    expect(deck).toHaveBeenCalledTimes(1);
  });

  it('a step closed and another opened in the same task leaves one entry for the new one', () => {
    const closeEditor = openStep(vi.fn());
    closeEditor();
    const peek = vi.fn();
    openStep(peek);
    settle();
    expect(index).toBe(1);
    const tutorial = vi.fn();
    openStep(tutorial, 'overlay');
    pressBack();
    expect(tutorial).toHaveBeenCalledTimes(1);
    expect(peek).not.toHaveBeenCalled();
  });

  it('takes several entries off in one traversal when steps close together', () => {
    const closeDeck = openStep(vi.fn());
    const closeDialog = openStep(vi.fn(), 'overlay');
    closeDialog();
    closeDeck();
    settle();
    expect(fakeHistory.go).toHaveBeenCalledTimes(1);
    expect(fakeHistory.go).toHaveBeenCalledWith(-2);
    expect(index).toBe(0);
  });

  it('a jump back several entries closes that many steps, top first', () => {
    const order: string[] = [];
    openStep(() => order.push('deck'));
    openStep(() => order.push('sheet'), 'overlay');
    traverse(-2);
    expect(order).toEqual(['sheet', 'deck']);
  });

  it('does not take a second entry for a step Back already closed', () => {
    let close = () => {};
    close = openStep(() => close());
    pressBack();
    settle();
    expect(fakeHistory.go).not.toHaveBeenCalled();
    expect(index).toBe(0);
  });

  it('keeps a step that refuses, with a new entry for the next Back', () => {
    let busy = true;
    const onBack = vi.fn(() => (busy ? false : undefined));
    openStep(onBack);
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(entries[index]).toEqual({ courDepth: 1 });
    busy = false;
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(index).toBe(0);
  });

  it('steps back off an entry Forward lands on with no step open', () => {
    const onBack = vi.fn();
    openStep(onBack);
    pressBack();
    traverse(1);
    settle();
    expect(fakeHistory.go).toHaveBeenCalledWith(-1);
    expect(index).toBe(0);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the step marker through a URL rewrite, and gives the landed entry the latest URL', () => {
    const onBack = vi.fn();
    openStep(onBack);
    replaceUrl('https://cour.example.com/?roomName=couch-club');
    expect(entries[1]).toEqual({ courDepth: 1 });
    expect(fakeHistory.replaceState).toHaveBeenLastCalledWith(
      { courDepth: 1 },
      document.title,
      'https://cour.example.com/?roomName=couch-club',
    );
    pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fakeHistory.replaceState).toHaveBeenLastCalledWith(null, document.title, 'https://cour.example.com/?roomName=couch-club');
  });
});
