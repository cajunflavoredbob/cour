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

// Desktop mounts these directly (no sheet); sentinel them -- each has
// its own suite. This file is the desktop stage's orchestration.
vi.mock('../../../../web/app/src/components/organisms/AccountMenu', () => ({
  AccountMenu: () => <div data-testid="account-menu" />,
}));
vi.mock('../../../../web/app/src/components/organisms/DeckDetails', () => ({
  DeckDetails: ({ media }: { media: { anilistId?: number } }) => (
    <div data-testid="deck-details" data-title-id={media.anilistId} />
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/DeckSheet', () => ({
  DeckSheet: () => <div data-testid="deck-sheet" />,
}));
vi.mock('../../../../web/app/src/components/molecules/VerdictRow', () => ({
  VerdictRow: ({ titleId, remaining }: { titleId: number; remaining: number }) => (
    <div data-testid="verdict-row" data-title-id={titleId} data-remaining={remaining} />
  ),
}));

import { DeckScreen } from '../../../../web/app/src/components/screens/Deck';
import { makeMedia } from '../../../helpers';

const deckMedia = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom', posterUrl: '/api/poster/0/101/0' }),
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
      auth: { userName: 'user1', role: 'user', soundPref: false },
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

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  stubDesktop(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DeckScreen desktop stage', () => {
  it('renders the two-pane stage: details + verdict row, no sheet', () => {
    render(<DeckScreen />);
    expect(screen.getByTestId('deck-details').getAttribute('data-title-id')).toBe('101');
    expect(screen.getByTestId('verdict-row').getAttribute('data-title-id')).toBe('101');
    expect(screen.queryByTestId('deck-sheet')).toBeNull();
  });

  it('shows the poster as a contained card in the poster pane', () => {
    const { container } = render(<DeckScreen />);
    const img = container.querySelector('img[src="/api/poster/0/101/0"]');
    expect(img).not.toBeNull();
  });

  it('renders the keyboard hint', () => {
    render(<DeckScreen />);
    expect(screen.getByText('keep')).toBeDefined();
    expect(screen.getByText('unsure')).toBeDefined();
    expect(screen.getByText('pass')).toBeDefined();
  });

  it('K / P / U keys dispatch the matching verdict for the current title', () => {
    render(<DeckScreen />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'verdict', payload: { titleId: 101, verdict: 'like' } });
    fireEvent.keyDown(window, { key: 'u' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'verdict', payload: { titleId: 101, verdict: 'skip' } });
    fireEvent.keyDown(window, { key: 'p' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'verdict', payload: { titleId: 101, verdict: 'dislike' } });
  });

  it('ignores verdict keys while an input is focused', () => {
    render(<DeckScreen />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(window, { key: 'k' });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verdict' }),
    );
    input.remove();
  });

  it('ignores verdict keys held with a modifier (browser shortcuts win)', () => {
    render(<DeckScreen />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verdict' }),
    );
  });

  it('ignores OS key auto-repeat: one verdict per deliberate press (audit 17 H6)', () => {
    render(<DeckScreen />);
    fireEvent.keyDown(window, { key: 'k' });
    // A held key fires keydown with repeat=true per OS repeat tick;
    // each one used to verdict-and-advance a card.
    fireEvent.keyDown(window, { key: 'k', repeat: true });
    fireEvent.keyDown(window, { key: 'k', repeat: true });
    const verdicts = dispatch.mock.calls.filter(([a]) => a.type === 'verdict');
    expect(verdicts).toHaveLength(1);
  });

  it('does NOT bind verdict keys while disconnected (audit 17 M7)', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<DeckScreen />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verdict' }),
    );
  });

  it('does NOT bind verdict keys on mobile (no matchMedia match)', () => {
    stubDesktop(false);
    render(<DeckScreen />);
    // Mobile renders the sheet, not the two-pane stage.
    expect(screen.getByTestId('deck-sheet')).toBeDefined();
    fireEvent.keyDown(window, { key: 'k' });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'verdict' }),
    );
  });

  it('the scope-back control still routes out of a re-review pass', () => {
    withState({
      review: review([101]),
      deckScope: { titleIds: [101], position: 0 },
    });
    render(<DeckScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="scope-back"]') as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({ type: 'exitDeckScope' });
  });
});
