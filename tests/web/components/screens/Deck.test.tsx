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

// Heavy children sentinel'd -- each has its own coverage; this file is
// the deck's own orchestration (card selection, chrome, drawer gate).
vi.mock('../../../../web/app/src/components/organisms/AccountMenu', () => ({
  AccountMenu: () => <div data-testid="account-menu" />,
}));
vi.mock('../../../../web/app/src/components/organisms/DeckSheet', () => ({
  DeckSheet: ({ media, remaining, allowSkipAll, currentVerdict }: { media: { anilistId?: number }; remaining: number; allowSkipAll?: boolean; currentVerdict?: string }) => (
    <div
      data-testid="deck-sheet"
      data-title-id={media.anilistId}
      data-remaining={remaining}
      data-allow-skip-all={String(allowSkipAll)}
      data-current-verdict={currentVerdict ?? ''}
    />
  ),
}));

import { DeckScreen } from '../../../../web/app/src/components/screens/Deck';
import { makeMedia } from '../../../helpers';

const auth = { userName: 'user1', role: 'user' as const, soundPref: false };

const deckMedia = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom', titleRomaji: 'Tetsu no Hana', format: 'TV', episodes: 24, studio: 'Komorebi Works', year: 2026, genres: ['Action', 'Drama', 'Fantasy', 'Extra'], posterUrl: '/api/poster/0/101/0' }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];

const review = (verdicted: number[]) => ({
  verdicts: verdicted.map((titleId) => ({ titleId, verdict: 'like' as const, updatedAt: 1 })),
  counts: { like: verdicted.length, dislike: 0, skip: 0 },
  lockedAt: null,
  total: 3,
});

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      room: { name: 'couch-club', displayName: 'Couch-Club', joined: true, media: deckMedia },
      connectionStatus: 'connected',
      review: review([]),
      auth,
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

describe('DeckScreen', () => {
  it('the main flow passes no current verdict (unverdicted by definition)', () => {
    render(<DeckScreen />);
    expect(screen.getByTestId('deck-sheet').getAttribute('data-current-verdict')).toBe('');
  });

  it('shows the first unverdicted title with its full info block', () => {
    render(<DeckScreen />);
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.getByText('Tetsu no Hana')).toBeDefined();
    expect(screen.getByText('TV · 24 EP · SUMMER 2026 · KOMOREBI WORKS')).toBeDefined();
    // Genre chips cap at 3 on the deck.
    expect(screen.getByText('Action')).toBeDefined();
    expect(screen.queryByText('Extra')).toBeNull();
    // The sheet targets the current card and knows the remainder.
    const sheet = screen.getByTestId('deck-sheet');
    expect(sheet.getAttribute('data-title-id')).toBe('101');
    expect(sheet.getAttribute('data-remaining')).toBe('3');
  });

  it('advances to the next unverdicted title as the ledger grows', () => {
    withState({ review: review([101]) });
    render(<DeckScreen />);
    expect(screen.getByText('Second Show')).toBeDefined();
    expect(screen.queryByText('Iron Bloom')).toBeNull();
  });

  it('renders the progress chip as verdicts / total', () => {
    withState({ review: review([101, 102]) });
    render(<DeckScreen />);
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('/ 3')).toBeDefined();
  });

  it('shows the room label and season kanji in the top bar', () => {
    render(<DeckScreen />);
    expect(screen.getByText('Couch-Club')).toBeDefined();
    expect(screen.getByText('夏')).toBeDefined(); // summer
  });

  it('shows the exhausted state when every title has a verdict', () => {
    withState({ review: review([101, 102, 103]) });
    render(<DeckScreen />);
    expect(screen.getByText("that's the whole season.")).toBeDefined();
    expect(screen.getByText('3 / 3')).toBeDefined();
    expect(screen.queryByTestId('deck-sheet')).toBeNull();
  });

  it('renders the not-in-a-room guard with a way back to the join form', () => {
    withState({ room: undefined, review: undefined });
    render(<DeckScreen />);
    expect(screen.getByText('you are not in a room.')).toBeDefined();
    // Not a dead end anymore (audit 17): the CTA routes home.
    fireEvent.click(screen.getByText('join a room'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'home' } });
  });

  it('holds the deck behind the ledger: no verdict UI before review arrives (audit 17 H5)', () => {
    // In the pre-ledger window the deck used to show the season's FIRST
    // card with live buttons; a tap silently overwrote a verdict the
    // user recorded in an earlier session.
    withState({ review: undefined });
    render(<DeckScreen />);
    expect(screen.queryByTestId('deck-sheet')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined(); // wordmark pulse
  });

  it('exhausted state is lock-aware: locked users are not told to lock in (audit 17 H4)', () => {
    withState({ review: { ...review([101, 102, 103]), lockedAt: 12345 } });
    render(<DeckScreen />);
    expect(screen.getByText("that's a wrap on the season.")).toBeDefined();
    expect(screen.getByText('your picks are locked in.')).toBeDefined();
    expect(screen.queryByText('time to look over your picks and lock in.')).toBeNull();
    expect(document.querySelector('[data-test-handle="to-standings"]')).not.toBeNull();
  });
});

describe('DeckScreen scoped re-review (0.10.0)', () => {
  it('renders the scoped title instead of the season flow, skip-all off', () => {
    // Main flow would show 103 (first unverdicted); the scope pins 101.
    withState({
      review: review([101, 102]),
      deckScope: { titleIds: [101], position: 0 },
    });
    render(<DeckScreen />);
    const sheet = screen.getByTestId('deck-sheet');
    expect(sheet.getAttribute('data-title-id')).toBe('101');
    expect(sheet.getAttribute('data-allow-skip-all')).toBe('false');
    // The ledger's existing verdict rides along for the halo.
    expect(sheet.getAttribute('data-current-verdict')).toBe('like');
    // Single-row scope: the back chip reads REVIEW.
    expect(screen.getByText('REVIEW')).toBeDefined();
  });

  it('a pile scope shows its own position chip and a working back control', () => {
    withState({
      review: review([101, 102]),
      deckScope: { titleIds: [101, 102], position: 1 },
    });
    render(<DeckScreen />);
    expect(screen.getByTestId('deck-sheet').getAttribute('data-title-id')).toBe('102');
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('/ 2')).toBeDefined();
    fireEvent.click(
      document.querySelector('[data-test-handle="scope-back"]') as HTMLElement,
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'exitDeckScope' });
  });

  it('a scoped title missing from the room media bails back to review', () => {
    withState({
      review: review([]),
      deckScope: { titleIds: [999], position: 0 },
    });
    render(<DeckScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'exitDeckScope' });
    expect(screen.queryByTestId('deck-sheet')).toBeNull();
  });

  it('a fully-verdicted deck still renders a scoped pass (no exhausted state)', () => {
    withState({
      review: review([101, 102, 103]),
      deckScope: { titleIds: [102], position: 0 },
    });
    render(<DeckScreen />);
    expect(screen.queryByText("that's the whole season.")).toBeNull();
    expect(screen.getByTestId('deck-sheet').getAttribute('data-title-id')).toBe('102');
  });
});

describe('card-exit flair', () => {
  it('a verdict advance mounts the exiting card with its verdict wash', () => {
    const { rerender } = render(<DeckScreen />);
    expect(document.querySelector('[data-test-handle="card-exit"]')).toBeNull();
    // The ledger gains 101=like -> the deck advances to 102; the
    // outgoing card exits under a like-colored wash.
    withState({ review: review([101]) });
    rerender(<DeckScreen />);
    const exit = document.querySelector('[data-test-handle="card-exit"]') as HTMLElement;
    expect(exit).not.toBeNull();
    expect(exit.getAttribute('data-verdict')).toBe('like');
    // ...and unmounts once the animation window passes.
    act(() => vi.advanceTimersByTime(600));
    expect(document.querySelector('[data-test-handle="card-exit"]')).toBeNull();
  });
});
