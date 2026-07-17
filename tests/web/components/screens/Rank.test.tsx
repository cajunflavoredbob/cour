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
vi.mock('../../../../web/app/src/components/organisms/DeckDetails', () => ({
  DeckDetails: ({ media }: { media: { anilistId?: number } }) => (
    <div data-testid="deck-details" data-title-id={media.anilistId} />
  ),
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
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-05T12:00:00'));
});

afterEach(() => {
  cleanup();
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
});

describe('RankScreen audit v1.2.0 additions', () => {
  it('Submit disables while disconnected (#8)', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<RankScreen />);
    const btn = document.querySelector('[data-test-handle="submit-rankings"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

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
        { userName: 'girlfriend', locked: true, submitted: false },
      ],
    });
    render(<RankScreen />);
    expect(screen.getByText(/UPDATES LIVE · WAITING ON GIRLFRIEND/)).toBeDefined();
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
