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

const auth = { userName: 'user1', role: 'user' as const, soundPref: false };

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
  return {
    verdicts,
    counts,
    lockedAt: over.lockedAt ?? null,
    total: 3,
  };
};

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      connectionStatus: 'connected',
      room: { name: 'couch-club', displayName: 'Couch-Club', joined: true, media },
      review: reviewState(),
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

describe('ReviewScreen (design section 07)', () => {
  it('renders the headline, context line, and progress', () => {
    render(<ReviewScreen />);
    expect(screen.getByText('your summer review')).toBeDefined();
    expect(screen.getByText(/COUCH-CLUB · 2 \/ 3 VERDICTS/)).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('resume banner names the next unverdicted title and routes to the deck', () => {
    render(<ReviewScreen />);
    expect(screen.getByText(/1 TITLES LEFT · NEXT: THIRD SHOW/)).toBeDefined();
    fireEvent.click(screen.getByText('Keep picking'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'room' } });
  });

  it('pile tabs carry counts and switch the visible ledger', () => {
    render(<ReviewScreen />);
    expect(screen.getByText('Kept 1')).toBeDefined();
    expect(screen.getByText('Unsure 1')).toBeDefined();
    // Liked pile is the default: Iron Bloom row shows.
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.queryByText('Second Show')).toBeNull();
    fireEvent.click(screen.getByText('Unsure 1'));
    expect(screen.getByText('Second Show')).toBeDefined();
    expect(screen.queryByText('Iron Bloom')).toBeNull();
  });

  it('tapping a verdict pill cycles the verdict via the normal UPSERT', () => {
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('KEPT'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'dislike' },
    });
    fireEvent.click(screen.getByText('Unsure 1'));
    fireEvent.click(screen.getByText('UNSURE'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 102, verdict: 'like' },
    });
  });

  it('lock bar is disabled with a countdown until every title has a verdict', () => {
    render(<ReviewScreen />);
    const lock = screen.getByText(/Lock in · 1 to go/).closest('button') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
    fireEvent.click(lock);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'lockIn' });
    expect(screen.getByText(/RANK YOUR KEEPS/)).toBeDefined();
  });

  it('lock bar goes accent + live when the ledger is complete', () => {
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
    const lock = screen.getByText('Lock in').closest('button') as HTMLButtonElement;
    expect(lock.disabled).toBe(false);
    // 0.12.0: the button opens the no-take-backsies dialog; lockIn only
    // fires after the explicit checkbox + confirm.
    fireEvent.click(lock);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'lockIn' });
    expect(screen.getByText('no take-backsies.')).toBeDefined();
    const confirm = document.querySelector('[data-test-handle="confirm-lock"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText("I'm ready to lock in my season"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({ type: 'lockIn' });
    // Complete ledger also means no resume banner.
    expect(screen.queryByText('Keep picking')).toBeNull();
  });

  it('shows the room pulse when member state is known (audit 17 UX 3)', () => {
    withState({
      members: [
        { userName: 'user1', locked: true, submitted: false },
        { userName: 'girlfriend', locked: false, submitted: false },
      ],
    });
    render(<ReviewScreen />);
    expect(screen.getByText(/1 OF 2 LOCKED/)).toBeDefined();
  });

  it('pills and lock-in disable while disconnected (audit v1.2.0 #8)', () => {
    withState({ connectionStatus: 'disconnected', review: reviewState() });
    render(<ReviewScreen />);
    const pill = document.querySelector('[class*="verdictPill"]') as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    const lock = document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
  });

  it('confirming lock-in starts the min-3s ceremony (audit v1.2.0 #9)', () => {
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
    fireEvent.click(screen.getByText("I'm ready to lock in my season"));
    fireEvent.click(document.querySelector('[data-test-handle="confirm-lock"]') as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: { kind: 'lock' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'lockIn' });
  });

  it('shows "Locking in..." disabled while the ceremony runs', () => {
    withState({
      review: reviewState(),
      finalizing: { kind: 'lock', startedAt: Date.now() },
    });
    render(<ReviewScreen />);
    const lock = document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
    expect(lock.textContent).toContain('Locking in');
  });

  it('the locked peek offers a way back to the standings (audit 17 UX 6)', () => {
    withState({ review: { ...reviewState(), lockedAt: 12345 } });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('Back to standings'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'viewLockedReview',
      payload: { open: false },
    });
  });

  it('after lock-in the pills disable and the bar reads Locked in', () => {
    withState({
      review: reviewState({
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 102, verdict: 'skip', updatedAt: 2 },
          { titleId: 103, verdict: 'dislike', updatedAt: 3 },
        ],
        lockedAt: 12345,
      }),
    });
    render(<ReviewScreen />);
    expect(screen.getByText('Back to standings')).toBeDefined();
    const pill = screen.getByText('KEPT') as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });

  it('collapses a long pile behind a +N MORE reveal', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      titleId: 200 + i,
      verdict: 'like' as const,
      updatedAt: i,
    }));
    withState({ review: { ...reviewState({ verdicts: many }), total: 20 } });
    render(<ReviewScreen />);
    expect(screen.getByText('+3 MORE')).toBeDefined();
    fireEvent.click(screen.getByText('+3 MORE'));
    expect(screen.queryByText('+3 MORE')).toBeNull();
  });
});

describe('ReviewScreen re-review passes (0.10.0)', () => {
  it('tapping a row opens a single-title scope', () => {
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('Iron Bloom'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'enterDeckScope',
      payload: { titleIds: [101], position: 0 },
    });
  });

  it('REVIEW ALL opens the visible pile as a scope, in row order', () => {
    withState({
      review: reviewState({
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 103, verdict: 'like', updatedAt: 2 },
          { titleId: 102, verdict: 'skip', updatedAt: 3 },
        ],
      }),
    });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText(/REVIEW ALL 2 KEPT/));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'enterDeckScope',
      payload: { titleIds: [101, 103], position: 0 },
    });
  });

  it('locked rooms get neither row navigation nor the pile CTA', () => {
    withState({
      review: reviewState({
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 102, verdict: 'skip', updatedAt: 2 },
          { titleId: 103, verdict: 'dislike', updatedAt: 3 },
        ],
        lockedAt: 12345,
      }),
    });
    render(<ReviewScreen />);
    expect(screen.queryByText(/REVIEW ALL/)).toBeNull();
    const rowBtn = screen.getByText('Iron Bloom').closest('button') as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    fireEvent.click(rowBtn);
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'enterDeckScope' }),
    );
  });
});
