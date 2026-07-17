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

import { ReviewScreen } from '../../../../web/app/src/components/screens/Review';
import { makeMedia } from '../../../helpers';

const media = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom', format: 'TV', episodes: 24 }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];

const reviewState = (over: Partial<{
  verdicts: Array<{ titleId: number; verdict: 'like' | 'dislike' | 'skip'; updatedAt: number }>;
  lockedAt: number | null;
}> = {}) => {
  const verdicts = over.verdicts ?? [
    { titleId: 101, verdict: 'like' as const, updatedAt: 1 },
    { titleId: 102, verdict: 'skip' as const, updatedAt: 2 },
  ];
  const counts = { like: 0, dislike: 0, skip: 0 };
  for (const v of verdicts) counts[v.verdict] += 1;
  return { verdicts, counts, lockedAt: over.lockedAt ?? null, total: 3 };
};

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      connectionStatus: 'connected',
      room: { name: 'couch-club', displayName: 'Couch-Club', joined: true, media },
      review: reviewState(),
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReviewScreen desktop (rail + main)', () => {
  it('renders the rail with headline, progress, and the lock control, plus the ledger', () => {
    const { container } = render(<ReviewScreen />);
    expect(container.querySelector('[class*="rail"]')).not.toBeNull();
    expect(container.querySelector('[class*="main"]')).not.toBeNull();
    expect(screen.getByText('your summer review')).toBeDefined();
    // The lock control lives in the rail, not a sticky footer.
    const rail = container.querySelector('[class*="rail"]') as HTMLElement;
    expect(rail.querySelector('[data-test-handle="lock-in"]')).not.toBeNull();
    // The pile tabs + ledger live in the main column.
    const main = container.querySelector('[class*="main"]') as HTMLElement;
    expect(main.textContent).toContain('Kept');
    expect(main.textContent).toContain('Iron Bloom');
  });

  it('the shared AppHeader carries the room label', () => {
    const { container } = render(<ReviewScreen />);
    // AppHeader renders the room label muted after the kanji.
    expect(container.textContent).toContain('Couch-Club');
    expect(screen.getByTestId('account-menu')).toBeDefined();
  });

  it('lock-in still opens the confirm dialog (from the rail)', () => {
    withState({
      review: reviewState({
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 102, verdict: 'skip', updatedAt: 2 },
          { titleId: 103, verdict: 'dislike', updatedAt: 3 },
        ],
      }),
    });
    render(<ReviewScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="lock-in"]') as HTMLElement);
    expect(screen.getByText('no take-backsies.')).toBeDefined();
  });

  it('tap-to-change verdict pill works in the desktop ledger', () => {
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('KEPT'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'dislike' },
    });
  });

  it('shows every ledger row on desktop -- no "+N MORE" truncation', () => {
    const manyLikes = Array.from({ length: 15 }, (_, i) => ({
      titleId: 200 + i,
      verdict: 'like' as const,
      updatedAt: i,
    }));
    withState({ review: { ...reviewState({ verdicts: manyLikes }), total: 15 } });
    const { container } = render(<ReviewScreen />);
    // 15 rows all present; no overflow reveal.
    const main = container.querySelector('[class*="main"]') as HTMLElement;
    expect(main.querySelectorAll('li[class*="row"]').length).toBe(15);
    expect(screen.queryByText(/MORE/)).toBeNull();
  });

  it('falls back to the mobile stack (sticky footer) below 900px', () => {
    stubDesktop(false);
    const { container } = render(<ReviewScreen />);
    expect(container.querySelector('[class*="rail"]')).toBeNull();
    expect(container.querySelector('[class*="lockBar"]')).not.toBeNull();
  });
});
