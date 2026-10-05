// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
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
      room: { name: 'couch-coop', displayName: 'Couch-Coop', joined: true, media },
      review: lockedReview,
      results: { submittedCount: 0, memberCount: 2, mySubmitted: false, myRanking: [], standings: [] },
      ...slice,
    },
    dispatch,
  ]);
};

const stubDesktop = (matches: boolean) => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
};

// Give rows deterministic vertical geometry so the drag math resolves
// (jsdom returns zero rects otherwise). Each row is 60px tall, stacked
// by its live DOM order so a reorder is reflected on the next move.
const stubRowGeometry = () =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const parent = this.parentElement;
    const idx = parent ? Array.from(parent.children).indexOf(this) : 0;
    return {
      top: idx * 60,
      bottom: idx * 60 + 60,
      height: 60,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: idx * 60,
      toJSON: () => ({}),
    } as DOMRect;
  });

beforeEach(() => {
  forgetDrafts();
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  stubDesktop(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RankScreen desktop editor', () => {
  it('renders the rail (headline + point legend + submit) and the list in the main column', () => {
    const { container } = render(<RankScreen />);
    const rail = container.querySelector('[class*="rail"]') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.textContent).toContain('rank your keeps.');
    // The point legend lives in the rail: the five scoring slots, then the rest.
    expect([...(rail.querySelector('[class*="legend"]') as HTMLElement).querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '#112 PTS',
      '#29 PTS',
      '#36 PTS',
      '#43 PTS',
      '#51 PTS',
      '#6+0 PTS',
    ]);
    expect(rail.querySelector('[data-test-handle="submit-rankings"]')).not.toBeNull();
    // The sortable list is in the main column with grab handles.
    expect(container.querySelectorAll('[data-rank-row]').length).toBe(2);
    expect(container.querySelector('[class*="grip"]')).not.toBeNull();
  });

  it('up/down buttons still reorder (the accessible path)', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByLabelText('Move Second Show up'));
    const titles = screen.getAllByText(/Iron Bloom|Second Show/).map((el) => el.textContent);
    expect(titles[0]).toBe('Second Show');
  });

  describe('drag to reorder', () => {
    // Rows are 60px tall (stubRowGeometry): row 1 spans 60-120, midline 90.
    // Moves and releases are dispatched on the window, not the pressed row.
    const rows = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-rank-row]')) as HTMLElement[];
    const titles = (container: HTMLElement) =>
      rows(container).map((r) => r.querySelector('[class*="rowTitle"]')?.textContent);
    const press = (el: Element, clientY: number, pointerType = 'mouse') =>
      fireEvent.pointerDown(el, { pointerId: 1, pointerType, button: 0, buttons: 1, clientX: 20, clientY });
    const move = (clientY: number, buttons = 1, pointerType = 'mouse') =>
      fireEvent.pointerMove(window, { pointerId: 1, pointerType, buttons, clientX: 20, clientY });
    const lift = (clientY: number, pointerType = 'mouse') =>
      fireEvent.pointerUp(document.body, { pointerId: 1, pointerType, button: 0, buttons: 0, clientX: 20, clientY });
    const titleOf = (row: HTMLElement) => row.querySelector('[class*="rowTitle"]') as HTMLElement;
    const gripOf = (row: HTMLElement) => row.querySelector('[data-drag-handle]') as HTMLElement;

    beforeEach(() => {
      stubRowGeometry();
    });

    it('a mouse drags a row from anywhere in it, not just the grip', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(100);
      lift(100);
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
    });

    it('the grip still drags with a mouse', () => {
      const { container } = render(<RankScreen />);
      press(gripOf(rows(container)[0]), 30);
      move(100);
      lift(100);
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
    });

    it('marks the row and the list while dragging, and clears both on release anywhere', () => {
      const { container } = render(<RankScreen />);
      const list = container.querySelector('[data-reordering]') as HTMLElement;
      press(titleOf(rows(container)[0]), 30);
      move(100);
      expect(rows(container)[1].getAttribute('data-dragging')).toBe('true');
      expect(list.getAttribute('data-reordering')).toBe('true');
      lift(100);
      expect(rows(container).some((r) => r.getAttribute('data-dragging') === 'true')).toBe(false);
      expect(list.getAttribute('data-reordering')).toBe('false');
    });

    it('a finished drag does not follow the pointer afterwards', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(100);
      lift(100);
      move(10, 0);
      move(10, 1);
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
    });

    it('a move with no button down ends a drag whose release never arrived', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(100);
      move(100, 0);
      expect(rows(container).some((r) => r.getAttribute('data-dragging') === 'true')).toBe(false);
      move(10, 1);
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
    });

    it('grabbing below a midline and nudging does not move the row', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 50);
      move(58);
      lift(58);
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('a click without travel never marks a drag', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(32);
      expect(rows(container).some((r) => r.getAttribute('data-dragging') === 'true')).toBe(false);
      lift(32);
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('Escape cancels the drag and restores the order', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(100);
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
      move(100);
      lift(100);
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('touch on a row body does not drag, so the list can scroll', () => {
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30, 'touch');
      move(100, 1, 'touch');
      lift(100, 'touch');
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('touch drags from the grip', () => {
      const { container } = render(<RankScreen />);
      press(gripOf(rows(container)[0]), 30, 'touch');
      move(100, 1, 'touch');
      lift(100, 'touch');
      expect(titles(container)).toEqual(['Second Show', 'Iron Bloom']);
    });

    it('a press on the move buttons does not start a drag', () => {
      const { container } = render(<RankScreen />);
      press(screen.getByLabelText('Move Second Show up'), 70);
      move(0);
      lift(0);
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('the editor is frozen during the submit ceremony', () => {
      withState({ finalizing: { kind: 'submit', startedAt: Date.now() } });
      const { container } = render(<RankScreen />);
      press(titleOf(rows(container)[0]), 30);
      move(100);
      lift(100);
      expect(titles(container)).toEqual(['Iron Bloom', 'Second Show']);
    });

    it('unmounting mid-drag removes every window listener the drag added', () => {
      const { container, unmount } = render(<RankScreen />);
      const added = vi.spyOn(window, 'addEventListener');
      const removed = vi.spyOn(window, 'removeEventListener');
      press(titleOf(rows(container)[0]), 30);
      move(100);
      unmount();
      const capture = (opts: unknown) =>
        opts === true || (typeof opts === 'object' && opts !== null && (opts as AddEventListenerOptions).capture === true);
      expect(added).toHaveBeenCalled();
      for (const [type, fn, opts] of added.mock.calls) {
        expect(removed.mock.calls.some(([t, f, o]) => t === type && f === fn && capture(o) === capture(opts))).toBe(true);
      }
    });
  });

  it('submits the drag-produced order through the dialog', () => {
    stubRowGeometry();
    const { container } = render(<RankScreen />);
    const title = container.querySelector('[data-rank-row] [class*="rowTitle"]') as HTMLElement;
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientY: 100 });
    fireEvent.pointerUp(document.body, { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 100 });
    fireEvent.click(screen.getByText('Submit rankings'));
    fireEvent.click(screen.getByText('This is my final ranking'));
    fireEvent.click(document.querySelector('[data-test-handle="confirm-submit"]') as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'submitRankings',
      payload: { rankedTitleIds: [102, 101] },
    });
  });
});

describe('RankScreen desktop standings', () => {
  const standings = {
    submittedCount: 2,
    memberCount: 2,
    mySubmitted: true,
    myRanking: [101, 102],
    standings: [
      { titleId: 101, points: 21, bestRank: 1, rankedBy: 2, rank: 1 },
      { titleId: 102, points: 12, bestRank: 2, rankedBy: 1, rank: 2 },
    ],
  };

  it('shows only the top 5 by default, with a reveal for the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      titleId: 101 + i,
      points: 20 - i,
      bestRank: 1,
      rankedBy: 1,
      rank: i + 1,
    }));
    withState({
      results: { submittedCount: 2, memberCount: 2, mySubmitted: true, myRanking: [], standings: many },
    });
    const { container } = render(<RankScreen />);
    // Top 5 visible; ranks 6 and 7 hidden.
    expect(container.querySelectorAll('[data-rank]').length).toBe(5);
    const reveal = document.querySelector('[data-test-handle="standings-reveal"]') as HTMLElement;
    expect(reveal.textContent).toContain('SHOW ALL 7');
    fireEvent.click(reveal);
    expect(container.querySelectorAll('[data-rank]').length).toBe(7);
    expect(reveal.textContent).toContain('SHOW TOP 5');
  });

  it("shows the everyone's-#1 strip with each member's name + pick", () => {
    withState({
      results: {
        ...standings,
        topPicks: [
          { userName: 'user1', titleId: 102 },
          { userName: 'user6', titleId: 101 },
        ],
      },
    });
    render(<RankScreen />);
    expect(screen.getByText("EVERYONE'S #1")).toBeDefined();
    const picks = document.querySelectorAll('[data-test-handle="top-pick"]');
    expect(picks.length).toBe(2);
    // Names shown (a title that isn't #1 in the standings still appears
    // here -- Second Show is user1's #1 but rank 2 overall).
    expect(screen.getByText('user1')).toBeDefined();
    expect(screen.getByText('user6')).toBeDefined();
    expect(picks[0].textContent).toContain('Second Show');
  });

  it('offers the standings as an image', () => {
    withState({ results: standings });
    render(<RankScreen />);
    expect(document.querySelector('[data-test-handle="share-standings"]')?.textContent).toBe('SHARE THE STANDINGS →');
  });

  it('offers no image while there are no standings yet', () => {
    withState({ results: { ...standings, standings: [] } });
    render(<RankScreen />);
    expect(document.querySelector('[data-test-handle="share-standings"]')).toBeNull();
  });

  it('renders the elevated list with #1 as the hero row', () => {
    withState({ results: standings });
    const { container } = render(<RankScreen />);
    expect(screen.getByText('summer standings.')).toBeDefined();
    const heroRow = container.querySelector('[data-hero="true"]') as HTMLElement;
    expect(heroRow).not.toBeNull();
    expect(heroRow.textContent).toContain('Iron Bloom');
    expect(heroRow.textContent).toContain('21 PTS');
    // #2 is not a hero row.
    const rows = container.querySelectorAll('[data-rank]');
    expect(rows[1].getAttribute('data-hero')).not.toBe('true');
    expect(screen.queryByText('Submit rankings')).toBeNull();
  });
});
