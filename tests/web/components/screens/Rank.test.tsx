// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));
vi.mock('../../../../web/app/src/components/organisms/DeckDetails', () => ({
  DeckDetails: ({ media }: { media: { anilistId?: number } }) => (
    <div data-testid="deck-details" data-title-id={media.anilistId} />
  ),
}));

vi.mock('../../../../web/app/src/components/organisms/AccountMenu', () => ({
  AccountMenu: () => <div data-testid="account-menu" />,
}));

import { RankScreen } from '../../../../web/app/src/components/screens/Rank';
import { forgetDrafts } from '../../../../web/app/src/utils/drafts';
import { makeMedia } from '../../../helpers';

const media = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom' }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];

const lockedReview = {
  verdicts: [
    { titleId: 101, verdict: 'like' as const, updatedAt: 1 },
    { titleId: 102, verdict: 'like' as const, updatedAt: 2 },
    { titleId: 103, verdict: 'dislike' as const, updatedAt: 3 },
  ],
  counts: { like: 2, dislike: 1, skip: 0 },
  lockedAt: 111,
  total: 3,
};

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      connectionStatus: 'connected',
      room: { name: 'couch-coop', joined: true, media },
      review: lockedReview,
      results: {
        submittedCount: 0,
        memberCount: 2,
        mySubmitted: false,
        myRanking: [],
        standings: [],
      },
      ...slice,
    },
    dispatch,
  ]);
};

beforeEach(() => {
  forgetDrafts();
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  // Nodes a test put on the page itself, left by a failed assertion,
  // would hold later tests under a dialog or menu.
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('RankScreen results gate (audit 17 H8)', () => {
  it('holds on the loading pulse until the results payload arrives', () => {
    // Without the gate the live editor rendered to already-submitted
    // users while results was in flight (or its reply lost); a re-submit
    // then earned "already submitted" and their edits vanished.
    withState({ results: undefined });
    render(<RankScreen />);
    expect(screen.queryByText('rank your keeps.')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined(); // wordmark pulse
    expect(dispatch).toHaveBeenCalledWith({ type: 'results' });
  });

  const resultsAsks = () => dispatch.mock.calls.filter(([a]) => a.type === 'results').length;

  it('asks for the results once the room is rejoined, and again after a rejoin that still has none', () => {
    withState({ results: undefined, rejoining: true });
    const { rerender } = render(<RankScreen />);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(resultsAsks()).toBe(0);
    withState({ results: undefined });
    rerender(<RankScreen />);
    expect(resultsAsks()).toBe(1);
    withState({ results: undefined, connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    withState({ results: undefined });
    rerender(<RankScreen />);
    expect(resultsAsks()).toBe(2);
  });

  it('leaves a refetch after a rejoin to the store when results are on screen', () => {
    const { rerender } = render(<RankScreen />);
    expect(resultsAsks()).toBe(1);
    withState({ connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    withState();
    rerender(<RankScreen />);
    expect(resultsAsks()).toBe(1);
  });

  it('keeps asking for results every 20s, but only while connected', () => {
    withState({ results: undefined, connectionStatus: 'connecting' });
    const { rerender } = render(<RankScreen />);
    dispatch.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'results' });
    withState({ results: undefined, connectionStatus: 'connected' });
    rerender(<RankScreen />);
    dispatch.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(dispatch).toHaveBeenCalledWith({ type: 'results' });
  });
});

describe('RankScreen editor (before submitting)', () => {
  it('fetches results on mount and lists ONLY the likes, with point values', () => {
    render(<RankScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'results' });
    expect(screen.getByText('rank your keeps.')).toBeDefined();
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.getByText('Second Show')).toBeDefined();
    // The dislike never ranks.
    expect(screen.queryByText('Third Show')).toBeNull();
    expect(screen.getByText('12 PTS')).toBeDefined();
    expect(screen.getByText('9 PTS')).toBeDefined();
  });

  it('reorders with the move buttons', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByLabelText('Move Second Show up'));
    const titles = screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent);
    expect(titles[0]).toBe('Second Show');
  });

  it('keeps the order across a trip away from the screen', () => {
    const first = render(<RankScreen />);
    fireEvent.click(screen.getByLabelText('Move Second Show up'));
    first.unmount();
    render(<RankScreen />);
    const titles = screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent);
    expect(titles).toEqual(['Second Show', 'Iron Bloom']);
  });

  it('submits through the no-turning-back dialog, in the chosen order', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByLabelText('Move Second Show up'));
    fireEvent.click(screen.getByText('Submit rankings'));
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'submitRankings' }),
    );
    expect(screen.getByText('no turning back.')).toBeDefined();
    const confirm = document.querySelector('[data-test-handle="confirm-submit"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText('This is my final ranking'));
    fireEvent.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'submitRankings',
      payload: { rankedTitleIds: [102, 101] },
    });
  });

  it('states the scoring and the ranking confirm in the screen\'s own verb', () => {
    render(<RankScreen />);
    expect(screen.getByText('TOP 5 SCORE 12 · 9 · 6 · 3 · 1 · PASSED AND UNSURE ARE DISCARDED')).toBeDefined();
    fireEvent.click(screen.getByText('Submit rankings'));
    expect(
      screen.getByText("This submits your final ranking and reveals the standings. You can't change it after this."),
    ).toBeDefined();
    expect(screen.getByText('Keep ranking')).toBeDefined();
  });

  it('keeps keyboard focus on a move button that reaches the end of the list', () => {
    render(<RankScreen />);
    const down = screen.getByLabelText('Move Iron Bloom down');
    down.focus();
    fireEvent.click(down);
    const moved = screen.getByLabelText('Move Iron Bloom down');
    expect(moved.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(moved);
    // At the end, the button is a no-op.
    fireEvent.click(moved);
    expect(screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent)).toEqual(['Second Show', 'Iron Bloom']);
  });

  it('keeps a move button that reaches the top focusable, and inert', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByLabelText('Move Second Show up'));
    const up = screen.getByLabelText('Move Second Show up') as HTMLButtonElement;
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(up.disabled).toBe(false);
    fireEvent.click(up);
    expect(screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent)).toEqual(['Second Show', 'Iron Bloom']);
  });
});

describe('RankScreen drag auto-scroll on a phone', () => {
  // The page scrolls. Rows are 60px tall from y=500; the sticky submit bar
  // covers y=640 to the bottom of the 768px window.
  const BAR_TOP = 640;
  let frames: FrameRequestCallback[];

  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'FOOTER') return rect(BAR_TOP, 768 - BAR_TOP);
      if (this.tagName === 'UL') return rect(500, 120);
      if (this.dataset.reorderId) return rect(500 + Array.from(this.parentElement?.children ?? []).indexOf(this) * 60, 60);
      return rect(0, 0);
    });
    document.documentElement.scrollTop = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dragTo = (container: HTMLElement, clientY: number) => {
    (container.querySelector('footer') as HTMLElement).style.position = 'sticky';
    const grip = container.querySelector('[data-reorder-id] [data-drag-handle]') as HTMLElement;
    fireEvent.pointerDown(grip, { pointerId: 1, pointerType: 'touch', button: 0, buttons: 1, clientX: 20, clientY: 530 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 20, clientY });
    frames.shift()?.(0);
  };

  it('scrolls while a row is held just above the submit bar', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 10);
    expect(document.documentElement.scrollTop).toBeGreaterThan(0);
  });

  it('ignores a small wobble from a press already inside the zone', () => {
    const { container } = render(<RankScreen />);
    (container.querySelector('footer') as HTMLElement).style.position = 'sticky';
    const grip = container.querySelectorAll('[data-reorder-id] [data-drag-handle]')[1] as HTMLElement;
    fireEvent.pointerDown(grip, { pointerId: 1, pointerType: 'touch', button: 0, buttons: 1, clientX: 20, clientY: 610 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 20, clientY: 615 });
    frames.shift()?.(0);
    expect(document.documentElement.scrollTop).toBe(0);
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 20, clientY: 625 });
    frames.shift()?.(0);
    expect(document.documentElement.scrollTop).toBeGreaterThan(0);
  });

  it('does not scroll while the row is held clear of the bar', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('starts the top zone below the safe-area inset', () => {
    // jsdom cannot resolve env(), so the hook's hidden probe reads a 47px top inset.
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
      (el as HTMLElement).style.visibility === 'hidden'
        ? ({ paddingTop: '47px', paddingBottom: '0px' } as unknown as CSSStyleDeclaration)
        : real.call(window, el),
    );
    document.documentElement.scrollTop = 500;
    const { container } = render(<RankScreen />);
    dragTo(container, 70);
    expect(document.documentElement.scrollTop).toBeLessThan(500);
  });

  it('marks the page while a row is dragged, and clears it on release', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch', button: 0, buttons: 0, clientX: 20, clientY: BAR_TOP - 60 });
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(false);
  });

  it('clears the page mark when unmounted mid-drag', () => {
    const { container, unmount } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    unmount();
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(false);
  });

  it('ends the drag when its list leaves the page', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    const list = (container.querySelector('[data-reorder-id]') as HTMLElement).parentElement as HTMLElement;
    const [parent, next] = [list.parentNode as Node, list.nextSibling];
    list.remove();
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 20, clientY: BAR_TOP - 30 });
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(false);
    parent.insertBefore(list, next);
  });

  it('ends the drag on the next frame when its list leaves the page', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    const list = (container.querySelector('[data-reorder-id]') as HTMLElement).parentElement as HTMLElement;
    const [parent, next] = [list.parentNode as Node, list.nextSibling];
    list.remove();
    frames.shift()?.(0);
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(false);
    parent.insertBefore(list, next);
  });

  it('ends the drag on a scroll when its list leaves the page', () => {
    const { container } = render(<RankScreen />);
    dragTo(container, BAR_TOP - 60);
    const list = (container.querySelector('[data-reorder-id]') as HTMLElement).parentElement as HTMLElement;
    const [parent, next] = [list.parentNode as Node, list.nextSibling];
    list.remove();
    fireEvent.scroll(window);
    expect(document.documentElement.hasAttribute('data-reordering')).toBe(false);
    parent.insertBefore(list, next);
  });

  it('unmounting mid-drag removes every window listener the drag added', () => {
    const { container, unmount } = render(<RankScreen />);
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    dragTo(container, BAR_TOP - 60);
    unmount();
    const capture = (opts: unknown) =>
      opts === true || (typeof opts === 'object' && opts !== null && (opts as AddEventListenerOptions).capture === true);
    expect(added).toHaveBeenCalled();
    for (const [type, fn, opts] of added.mock.calls) {
      expect(removed.mock.calls.some(([t, f, o]) => t === type && f === fn && capture(o) === capture(opts))).toBe(true);
    }
  });
});

describe('RankScreen submit guards', () => {
  it('Submit disables while disconnected (#8)', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<RankScreen />);
    const btn = document.querySelector('[data-test-handle="submit-rankings"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Submit waits for the room to be rejoined after a reconnect', () => {
    withState({ rejoining: true });
    render(<RankScreen />);
    const btn = document.querySelector('[data-test-handle="submit-rankings"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('will not confirm a ranking while offline', () => {
    const { rerender } = render(<RankScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="submit-rankings"]') as HTMLElement);
    fireEvent.click(screen.getByText('This is my final ranking'));
    withState({ connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    expect((document.querySelector('[data-test-handle="confirm-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens no confirm for the second click of a double-click on Submit rankings', () => {
    render(<RankScreen />);
    const submit = document.querySelector('[data-test-handle="submit-rankings"]') as HTMLElement;
    fireEvent.click(submit, { detail: 2 });
    expect(screen.queryByText('no turning back.')).toBeNull();
    fireEvent.click(submit, { detail: 1 });
    expect(screen.getByText('no turning back.')).toBeDefined();
  });

  it('closes a ranking confirm whose ranking already landed from elsewhere, and hands focus to the standings', () => {
    const { rerender } = render(<RankScreen />);
    fireEvent.click(screen.getByText('Submit rankings'));
    expect(screen.getByText('no turning back.')).toBeDefined();
    withState({
      results: { submittedCount: 1, memberCount: 2, mySubmitted: true, myRanking: [101, 102], standings: [], members: [] },
    });
    rerender(<RankScreen />);
    expect(screen.queryByText('no turning back.')).toBeNull();
    expect(document.activeElement?.textContent).toBe('summer standings.');
  });

  it('does not bring back a confirm whose ranking landed', () => {
    const { rerender } = render(<RankScreen />);
    fireEvent.click(screen.getByText('Submit rankings'));
    withState({
      results: { submittedCount: 1, memberCount: 2, mySubmitted: true, myRanking: [101, 102], standings: [], members: [] },
    });
    rerender(<RankScreen />);
    withState();
    rerender(<RankScreen />);
    expect(screen.getByText('rank your keeps.')).toBeDefined();
    expect(screen.queryByText('no turning back.')).toBeNull();
  });
});

describe('RankScreen submit ceremony', () => {
  it('confirming submit starts the ceremony and the editor holds despite the ack (#9)', () => {
    withState({
      results: {
        submittedCount: 1, memberCount: 2, mySubmitted: true,
        myRanking: [101], standings: [], members: [],
      },
      finalizing: { kind: 'submit', startedAt: Date.now() },
    });
    render(<RankScreen />);
    // mySubmitted is true, but the ceremony holds the editor: the
    // standings must not flash in before the 3s floor.
    const btn = document.querySelector('[data-test-handle="submit-rankings"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Submitting');
  });

  it('ends the ceremony once the ack is in and the 3s floor has passed', () => {
    withState({
      results: {
        submittedCount: 1, memberCount: 2, mySubmitted: true,
        myRanking: [101], standings: [], members: [],
      },
      finalizing: { kind: 'submit', startedAt: Date.now() },
    });
    render(<RankScreen />);
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'finalizing', payload: null });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });

  it('hands focus to the revealed standings when the ceremony ends', () => {
    const submitted = {
      submittedCount: 1,
      memberCount: 2,
      mySubmitted: true,
      myRanking: [101, 102],
      standings: [{ titleId: 101, points: 12, bestRank: 1, rankedBy: 1, rankedByNames: ['user1'], rank: 1 }],
      members: [],
    };
    withState({ results: submitted, finalizing: { kind: 'submit', startedAt: Date.now() } });
    const { rerender } = render(<RankScreen />);
    expect([...document.querySelectorAll('[role="status"]')].map((el) => el.textContent)).toContain(
      'Submitting your ranking…',
    );
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    withState({ results: submitted, finalizing: null });
    rerender(<RankScreen />);
    expect(document.activeElement?.textContent).toBe('summer standings.');
    // The standings arrive in place of the editor: scrolled into view.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
    focus.mockRestore();
  });

  it('leaves an open menu alone when the ceremony ends', () => {
    const submitted = { submittedCount: 1, memberCount: 2, mySubmitted: true, myRanking: [101, 102], standings: [], members: [] };
    withState({ results: submitted, finalizing: { kind: 'submit', startedAt: Date.now() } });
    const { rerender } = render(<RankScreen />);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    withState({ results: submitted, finalizing: null });
    rerender(<RankScreen />);
    expect(document.activeElement).toBe(document.body);
    menu.remove();
  });

  it('leaves focus where the member moved it during the ceremony', () => {
    const submitted = { submittedCount: 1, memberCount: 2, mySubmitted: true, myRanking: [101, 102], standings: [], members: [] };
    withState({ results: submitted, finalizing: { kind: 'submit', startedAt: Date.now() } });
    const { rerender } = render(<RankScreen />);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    withState({ results: submitted, finalizing: null });
    rerender(<RankScreen />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe('RankScreen focus on arrival', () => {
  it('hands focus to the editor heading on coming back to the screen, scrolling it into view', () => {
    const first = render(<RankScreen />);
    first.unmount();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<RankScreen />);
    expect(document.activeElement?.textContent).toBe('rank your keeps.');
    expect(focus).toHaveBeenLastCalledWith();
  });

  it('takes no focus from under an open menu on coming back to the editor', () => {
    const first = render(<RankScreen />);
    first.unmount();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    render(<RankScreen />);
    expect(document.activeElement).toBe(document.body);
  });

  it('hands focus to the editor heading as the lock ceremony hands over', () => {
    const onFocusTaken = vi.fn();
    render(<RankScreen fromLock onFocusTaken={onFocusTaken} />);
    expect(document.activeElement?.textContent).toBe('rank your keeps.');
    expect(onFocusTaken).toHaveBeenCalled();
  });

  it('leaves focus alone on a first arrival', () => {
    render(<RankScreen />);
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when the standings first load', () => {
    withState({ results: undefined });
    const { rerender } = render(<RankScreen />);
    withState({
      results: { submittedCount: 1, memberCount: 2, mySubmitted: true, myRanking: [101, 102], standings: [], members: [] },
    });
    rerender(<RankScreen />);
    expect(screen.getByText('summer standings.')).toBeDefined();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('RankScreen standings (after submitting)', () => {
  const standings = {
    submittedCount: 1,
    memberCount: 2,
    mySubmitted: true,
    myRanking: [101, 102],
    standings: [
      { titleId: 101, points: 12, bestRank: 1, rankedBy: 1, rank: 1 },
      { titleId: 102, points: 9, bestRank: 2, rankedBy: 1, rank: 2 },
    ],
  };

  it('shows the combined standings with progress + live note', () => {
    withState({ results: standings });
    render(<RankScreen />);
    expect(screen.getByText('summer standings.')).toBeDefined();
    expect(screen.getByText(/1 OF 2 RANKINGS IN · UPDATES LIVE/)).toBeDefined();
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.getByText('12 PTS')).toBeDefined();
    // No editor, no submit button.
    expect(screen.queryByText('Submit rankings')).toBeNull();
  });

  it('says so when the rankings in kept nothing', () => {
    withState({ results: { ...standings, standings: [] } });
    const { rerender } = render(<RankScreen />);
    expect(screen.getByText('no picks yet')).toBeDefined();
    withState({ results: { ...standings, standings: [], submittedCount: 2 } });
    rerender(<RankScreen />);
    expect(screen.getByText('nobody kept a show')).toBeDefined();
  });

  it('says FINAL for a room of one in the singular', () => {
    withState({
      results: {
        ...standings,
        submittedCount: 1,
        memberCount: 1,
        standings: [{ titleId: 101, points: 12, bestRank: 1, rankedBy: 1, rankedByNames: ['user1'], rank: 1 }],
      },
    });
    render(<RankScreen />);
    expect(screen.getByText(/1 RANKING IN · FINAL/)).toBeDefined();
    expect(screen.getByText(/12 PTS · RANKED BY USER1/)).toBeDefined();
  });

  it('says FINAL once everyone is in, and names the rankers (audit 17 UX 7/11)', () => {
    withState({
      results: {
        ...standings,
        submittedCount: 2,
        standings: [
          {
            titleId: 101, points: 21, bestRank: 1, rankedBy: 2,
            rankedByNames: ['user1', 'user2'], rank: 1,
          },
        ],
      },
    });
    render(<RankScreen />);
    expect(screen.getByText(/ALL 2 RANKINGS IN · FINAL/)).toBeDefined();
    expect(screen.queryByText(/UPDATES LIVE/)).toBeNull();
    expect(screen.getByText(/21 PTS · RANKED BY USER1 \+ USER2/)).toBeDefined();
  });

  it('names who the room is waiting on before the standings are final (audit 17 UX 11)', () => {
    withState({
      results: standings,
      members: [
        { userName: 'user1', locked: true, submitted: true },
        { userName: 'user2', locked: true, submitted: false },
      ],
    });
    render(<RankScreen />);
    expect(screen.getByText(/UPDATES LIVE · WAITING ON USER2/)).toBeDefined();
  });

  it('a standings row opens the read-only details drawer (audit 17 UX 4)', () => {
    withState({ results: standings });
    render(<RankScreen />);
    expect(screen.queryByTestId('deck-details')).toBeNull();
    fireEvent.click(
      document.querySelector('[data-test-handle="standing-details"]') as HTMLElement,
    );
    expect(screen.getByTestId('deck-details').getAttribute('data-title-id')).toBe('101');
  });

  it('the details drawer is a plain dialog with a way out', () => {
    withState({ results: standings });
    render(<RankScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="standing-details"]') as HTMLElement);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Iron Bloom');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('deck-details')).toBeNull();
  });

  it('the submit confirm stays an alert dialog', () => {
    render(<RankScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="submit-rankings"]') as HTMLElement);
    expect(screen.getByRole('alertdialog').getAttribute('aria-label')).toBe('Submit your rankings');
  });

  it('re-renders when a fresh push replaces the standings (live update)', () => {
    withState({ results: standings });
    const { rerender } = render(<RankScreen />);
    withState({
      results: {
        ...standings,
        submittedCount: 2,
        standings: [
          { titleId: 102, points: 21, bestRank: 1, rankedBy: 2, rank: 1 },
          { titleId: 101, points: 12, bestRank: 1, rankedBy: 1, rank: 2 },
        ],
      },
    });
    rerender(<RankScreen />);
    const rows = screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent);
    expect(rows[0]).toBe('Second Show');
  });
});
