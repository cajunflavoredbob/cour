// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));
vi.mock('../../../../web/app/src/components/screens/Review', () => ({
  ReviewScreen: () => <div data-testid="review-screen" />,
}));
vi.mock('../../../../web/app/src/components/screens/Join', () => ({
  JoinScreen: () => <div data-testid="join-screen" />,
}));
vi.mock('../../../../web/app/src/components/screens/Rank', () => ({
  RankScreen: () => <div data-testid="rank-screen" />,
}));

import { HomeScreen } from '../../../../web/app/src/components/screens/Home';

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([{ ...slice }, dispatch]);
};

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('HomeScreen (review-or-join)', () => {
  it('renders the seasonal review when a room is joined and the ledger is in', () => {
    withState({
      room: { name: 'couch-coop', joined: true },
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, lockedAt: null, total: 3 },
    });
    render(<HomeScreen />);
    expect(screen.getByTestId('review-screen')).toBeDefined();
    expect(screen.queryByTestId('join-screen')).toBeNull();
  });

  it('renders the join form without a room', () => {
    withState({});
    render(<HomeScreen />);
    expect(screen.getByTestId('join-screen')).toBeDefined();
  });

  it('renders the rank screen once locked in', () => {
    withState({
      room: { name: 'couch-coop', joined: true },
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, lockedAt: 111, total: 3 },
    });
    render(<HomeScreen />);
    expect(screen.getByTestId('rank-screen')).toBeDefined();
    expect(screen.queryByTestId('review-screen')).toBeNull();
  });

  it('locked + viewLockedReview shows the read-only ledger peek (audit 17 UX 6)', () => {
    withState({
      room: { name: 'couch-coop', joined: true },
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, members: [], lockedAt: 111, total: 3 },
      viewLockedReview: true,
    });
    render(<HomeScreen />);
    expect(screen.getByTestId('review-screen')).toBeDefined();
    expect(screen.queryByTestId('rank-screen')).toBeNull();
  });

  it('swaps the pulse for the retry affordance once the ledger stalls (audit v1.2.0 #5)', () => {
    withState({ room: { name: 'couch-coop', joined: true }, ledgerStalled: true });
    render(<HomeScreen />);
    expect(screen.getByText("couldn't load your season.")).toBeDefined();
    expect(document.querySelector('[data-test-handle="ledger-retry"]')).not.toBeNull();
  });

  it('holds on the loading pulse while the ledger is still loading', () => {
    // Joined but no review yet: the join form here read as "logged out"
    // to a joined user (audit 17 H5) -- the wordmark pulse holds instead.
    withState({ room: { name: 'couch-coop', joined: true } });
    render(<HomeScreen />);
    expect(screen.queryByTestId('join-screen')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();
  });
});
