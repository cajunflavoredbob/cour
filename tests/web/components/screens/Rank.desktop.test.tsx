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
    // The point legend lives in the rail.
    expect(rail.querySelector('[class*="legend"]')).not.toBeNull();
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

  it('pointer drag reorders: drag row #1 past #2', () => {
    stubRowGeometry();
    const { container } = render(<RankScreen />);
    const rows = () => Array.from(container.querySelectorAll('[data-rank-row]')) as HTMLElement[];
    // Order starts [Iron Bloom, Second Show].
    expect(rows()[0].textContent).toContain('Iron Bloom');
    const first = rows()[0];
    fireEvent.pointerDown(first, { clientY: 10, button: 0 });
    // Move below the second row's midpoint (row1 mid = 90).
    fireEvent.pointerMove(first, { clientY: 100 });
    fireEvent.pointerUp(first, { clientY: 100 });
    expect(rows()[0].textContent).toContain('Second Show');
  });

  it('a pointerdown on the move buttons does NOT start a drag', () => {
    stubRowGeometry();
    const { container } = render(<RankScreen />);
    const moveBtn = screen.getByLabelText('Move Second Show up');
    fireEvent.pointerDown(moveBtn, { clientY: 70, button: 0 });
    fireEvent.pointerMove(moveBtn, { clientY: 0 });
    fireEvent.pointerUp(moveBtn, { clientY: 0 });
    // Order unchanged by the (ignored) drag.
    const rows = Array.from(container.querySelectorAll('[data-rank-row]')) as HTMLElement[];
    expect(rows[0].textContent).toContain('Iron Bloom');
  });

  it('submits the drag-produced order through the dialog', () => {
    stubRowGeometry();
    const { container } = render(<RankScreen />);
    const first = container.querySelector('[data-rank-row]') as HTMLElement;
    fireEvent.pointerDown(first, { clientY: 10, button: 0 });
    fireEvent.pointerMove(first, { clientY: 100 });
    fireEvent.pointerUp(first, { clientY: 100 });
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
