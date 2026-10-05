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
import { forgetDrafts, keepPlace, placeKey } from '../../../../web/app/src/utils/drafts';
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
  forgetDrafts();
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
    expect(screen.getByText('your summer review.')).toBeDefined();
    expect(screen.getByText(/COUCH-CLUB · 2 \/ 3 VERDICTS/)).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('resume banner names the next unverdicted title and routes to the deck', () => {
    render(<ReviewScreen />);
    expect(screen.getByText(/1 TITLE LEFT · NEXT: THIRD SHOW/)).toBeDefined();
    fireEvent.click(screen.getByText('keep picking'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'room' } });
  });

  it('pile tabs carry counts and pick the pile to show', () => {
    render(<ReviewScreen />);
    expect(screen.getByText('Kept 1')).toBeDefined();
    expect(screen.getByText('Unsure 1')).toBeDefined();
    // Liked pile is the default: Iron Bloom row shows.
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.queryByText('Second Show')).toBeNull();
    fireEvent.click(screen.getByText('Unsure 1'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'skip', showAll: false } });
  });

  it('pile tabs are one tab stop that labels the ledger panel, moved with the arrows', () => {
    render(<ReviewScreen />);
    const tabs = screen.getAllByRole('tab');
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Piles');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    expect(panel.textContent).toContain('Iron Bloom');
    // Kept, Passed, Unsure: the arrow moves to Passed.
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'dislike', showAll: false } });
  });

  it('switching piles folds the SHOW ALL reveal back up', () => {
    withState({ reviewView: { pile: 'like', showAll: true } });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('Unsure 1'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'skip', showAll: false } });
  });

  it('shows the pile the store holds', () => {
    withState({ reviewView: { pile: 'skip', showAll: false } });
    render(<ReviewScreen />);
    expect(screen.getByText('Second Show')).toBeDefined();
    expect(screen.queryByText('Iron Bloom')).toBeNull();
    expect(screen.getByText('Unsure 1').getAttribute('aria-selected')).toBe('true');
  });

  it('tapping a verdict pill cycles the verdict via the normal UPSERT', () => {
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('KEPT'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'dislike' },
    });
    cleanup();
    withState({ reviewView: { pile: 'skip', showAll: false } });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('UNSURE'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 102, verdict: 'like' },
    });
  });

  it('lock bar is disabled with a countdown until every title has a verdict', () => {
    render(<ReviewScreen />);
    const lock = screen.getByText(/lock in · 1 to go/).closest('button') as HTMLButtonElement;
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
    const lock = screen.getByText('lock in').closest('button') as HTMLButtonElement;
    expect(lock.disabled).toBe(false);
    // 0.12.0: the button opens the no-take-backsies dialog; lockIn only
    // fires after the explicit checkbox + confirm.
    fireEvent.click(lock);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'lockIn' });
    expect(screen.getByText('no take-backsies.')).toBeDefined();
    expect(document.body.textContent).toContain(
      "Locking in is final. Next you'll rank your keeps: that's what scores the season. Passed and unsure picks are discarded.",
    );
    const confirm = document.querySelector('[data-test-handle="confirm-lock"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText("I'm ready to lock in my season"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({ type: 'lockIn' });
    // Complete ledger also means no resume banner.
    expect(screen.queryByText('keep picking')).toBeNull();
  });

  it('shows the room pulse when member state is known (audit 17 UX 3)', () => {
    withState({
      members: [
        { userName: 'user1', locked: true, submitted: false },
        { userName: 'user2', locked: false, submitted: false },
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
    // Offline reads as unavailable; a locked ledger keeps its verdict colors.
    expect(pill.getAttribute('data-offline')).toBe('true');
    const lock = document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
  });

  it('holds the pills, lock-in and its confirm until the rejoin lands', () => {
    const decided = reviewState({
      verdicts: [
        { titleId: 101, verdict: 'like', updatedAt: 1 },
        { titleId: 102, verdict: 'skip', updatedAt: 2 },
        { titleId: 103, verdict: 'dislike', updatedAt: 3 },
      ],
    });
    withState({ review: decided });
    const { rerender } = render(<ReviewScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="lock-in"]') as HTMLElement);
    fireEvent.click(screen.getByText("I'm ready to lock in my season"));
    withState({ review: decided, rejoining: true });
    rerender(<ReviewScreen />);
    expect((document.querySelector('[class*="verdictPill"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement).disabled).toBe(true);
    const confirm = document.querySelector('[data-test-handle="confirm-lock"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'lockIn' });
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

  it('shows "locking in..." disabled while the ceremony runs', () => {
    withState({
      review: reviewState(),
      finalizing: { kind: 'lock', startedAt: Date.now() },
    });
    render(<ReviewScreen />);
    const lock = document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
    expect(lock.textContent).toContain('locking in');
  });

  it('the locked peek offers a way back to the standings (audit 17 UX 6)', () => {
    withState({ review: { ...reviewState(), lockedAt: 12345 } });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('back to standings'));
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
    expect(screen.getByText('back to standings')).toBeDefined();
    const pill = screen.getByText('KEPT') as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(pill.getAttribute('data-offline')).toBe('false');
  });

  it('collapses a long pile behind a SHOW ALL reveal', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      titleId: 200 + i,
      verdict: 'like' as const,
      updatedAt: i,
    }));
    withState({ review: { ...reviewState({ verdicts: many }), total: 20 } });
    render(<ReviewScreen />);
    expect(screen.getByText('SHOW ALL 15')).toBeDefined();
    expect(document.querySelectorAll('li[class*="row"]')).toHaveLength(12);
    fireEvent.click(screen.getByText('SHOW ALL 15'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'like', showAll: true } });
    cleanup();
    withState({
      review: { ...reviewState({ verdicts: many }), total: 20 },
      reviewView: { pile: 'like', showAll: true },
    });
    render(<ReviewScreen />);
    expect(screen.queryByText('SHOW ALL 15')).toBeNull();
    expect(document.querySelectorAll('li[class*="row"]')).toHaveLength(15);
  });
});

describe('ReviewScreen lock-in hold and handoffs', () => {
  const decided = () =>
    reviewState({
      verdicts: [
        { titleId: 101, verdict: 'like', updatedAt: 1 },
        { titleId: 102, verdict: 'skip', updatedAt: 2 },
        { titleId: 103, verdict: 'dislike', updatedAt: 3 },
      ],
    });

  it('holds the ledger still through the lock ceremony, and says so aloud', () => {
    withState({ review: decided(), finalizing: { kind: 'lock', startedAt: Date.now() } });
    render(<ReviewScreen />);
    const rows = [...document.querySelectorAll('[data-title-id]')] as HTMLButtonElement[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.disabled)).toBe(true);
    expect((document.querySelector('[class*="verdictPill"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-test-handle="review-pile"]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Locking in your season…');
  });

  it('closes the lock confirm when the deck grows under it, handing focus to the next title', () => {
    withState({ review: decided() });
    const { rerender } = render(<ReviewScreen />);
    const lockIn = document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement;
    lockIn.focus();
    fireEvent.click(lockIn);
    expect(document.querySelector('[data-test-handle="confirm-lock"]')).not.toBeNull();
    // The new title lands before the ledger that counts it.
    const grown = [...media, makeMedia({ id: '104', anilistId: 104, title: 'Fourth Show' })];
    const room = { name: 'couch-club', displayName: 'Couch-Club', joined: true, media: grown };
    withState({ review: decided(), room });
    rerender(<ReviewScreen />);
    expect(document.querySelector('[data-test-handle="confirm-lock"]')).toBeNull();
    expect((document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement).disabled).toBe(true);
    const resume = document.querySelector('[data-test-handle="resume-deck"]');
    expect(document.activeElement).toBe(resume);
    withState({ review: { ...decided(), total: 4 }, room });
    rerender(<ReviewScreen />);
    expect(document.activeElement).toBe(resume);
  });

  it('leaves the focus a closing lock confirm gave back to its opener', () => {
    withState({ review: decided() });
    const { rerender } = render(<ReviewScreen />);
    // The control focused as the confirm opened gets the focus back.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    fireEvent.click(document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement);
    expect(document.activeElement).not.toBe(elsewhere);
    const grown = [...media, makeMedia({ id: '104', anilistId: 104, title: 'Fourth Show' })];
    withState({ review: decided(), room: { name: 'couch-club', displayName: 'Couch-Club', joined: true, media: grown } });
    rerender(<ReviewScreen />);
    expect(document.querySelector('[data-test-handle="confirm-lock"]')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("reads the peek's way back from this member's own place", () => {
    const peek = { ...decided(), lockedAt: 1 };
    const results = { mySubmitted: true, refined: { sharedTitleIds: [101, 102], myRefined: false } };
    keepPlace(placeKey('user2', 'couch-club', 'SUMMER', 2026), { view: 'shared', showAll: { all: false, shared: false }, refining: true });
    withState({ user: { userName: 'user1' }, review: peek, results });
    const { rerender } = render(<ReviewScreen />);
    const back = () => document.querySelector('[data-test-handle="back-to-standings"]')?.textContent;
    expect(back()).toBe('back to standings');
    keepPlace(placeKey('user1', 'couch-club', 'SUMMER', 2026), { view: 'shared', showAll: { all: false, shared: false }, refining: true });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to re-ranking');
  });

  it('holds Lock in while a title lacks a verdict', () => {
    withState({ review: { ...decided(), total: 4 } });
    render(<ReviewScreen />);
    expect((document.querySelector('[data-test-handle="lock-in"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names where the peek goes back to', () => {
    const peek = { ...decided(), lockedAt: 1 };
    const back = () => document.querySelector('[data-test-handle="back-to-standings"]')?.textContent;
    const round = (over = {}) => ({ sharedTitleIds: [101, 102], myRefined: false, ...over });
    withState({ review: peek, results: { mySubmitted: false } });
    const { rerender } = render(<ReviewScreen />);
    expect(back()).toBe('back to ranking');
    withState({ review: peek, results: { mySubmitted: true, refined: round() } });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to standings');
    keepPlace(placeKey(undefined, 'couch-club', 'SUMMER', 2026), { view: 'shared', showAll: { all: false, shared: false }, refining: true });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to re-ranking');
    // The round closed, or my order landed, while I was here.
    withState({ review: peek, results: { mySubmitted: true } });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to standings');
    withState({ review: peek, results: { mySubmitted: true, refined: round({ myRefined: true }) } });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to standings');
    // An order that landed during its ceremony goes back to the standings.
    withState({ review: peek, results: { mySubmitted: true, refined: round({ myRefined: true }) }, finalizing: { kind: 'refine', startedAt: 1 } });
    rerender(<ReviewScreen />);
    expect(back()).toBe('back to standings');
  });

  it('opens no deck trip for the second click of a double-click on a row', () => {
    render(<ReviewScreen />);
    const row = document.querySelector('[data-title-id="101"]') as HTMLElement;
    fireEvent.click(row, { detail: 2 });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'enterDeckScope' }));
    fireEvent.click(row, { detail: 1 });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'enterDeckScope' }));
  });

  it('puts focus back on the row the deck trip began from', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    withState({ reviewView: { pile: 'like', showAll: false, scroll: { top: 0, desktop: false }, focusId: 101 } });
    render(<ReviewScreen />);
    expect(document.activeElement).toBe(document.querySelector('[data-title-id="101"]'));
  });

  it('leaves focus where it is when it was not lost on the way back', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    withState({ reviewView: { pile: 'like', showAll: false, scroll: { top: 0, desktop: false }, focusId: 101 } });
    render(<ReviewScreen />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('puts focus on the pile tab after a pass over the whole pile', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    withState({ reviewView: { pile: 'like', showAll: false, scroll: { top: 0, desktop: false } } });
    render(<ReviewScreen />);
    expect(document.activeElement?.id).toBe('piles-tab-like');
  });
});

describe('ReviewScreen re-review passes (0.10.0)', () => {
  it('tapping a row opens a single-title scope', () => {
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('Iron Bloom'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'enterDeckScope',
      payload: {
        titleIds: [101],
        position: 0,
        from: { pile: 'like', showAll: false, scroll: { top: 0, desktop: false }, focusId: 101 },
      },
    });
  });

  it('carries the pile, reveal and page scroll to the deck in one action', () => {
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(340);
    withState({ reviewView: { pile: 'skip', showAll: true } });
    render(<ReviewScreen />);
    fireEvent.click(screen.getByText('Second Show'));
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      {
        type: 'enterDeckScope',
        payload: {
          titleIds: [102],
          position: 0,
          from: { pile: 'skip', showAll: true, scroll: { top: 340, desktop: false }, focusId: 102 },
        },
      },
    ]);
  });

  it('scrolls the page back to where the deck trip began, once', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    withState({ reviewView: { pile: 'skip', showAll: true, scroll: { top: 340, desktop: false } } });
    render(<ReviewScreen />);
    expect(scrollTo).toHaveBeenCalledWith(0, 340);
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'skip', showAll: true } });
  });

  it('drops a scroll saved in the desktop layout instead of applying it to the page', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    withState({ reviewView: { pile: 'skip', showAll: false, scroll: { top: 120, desktop: true } } });
    render(<ReviewScreen />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'reviewView', payload: { pile: 'skip', showAll: false } });
  });

  it('leaves the scroll alone without a saved position', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    withState({ reviewView: { pile: 'skip', showAll: false } });
    render(<ReviewScreen />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
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
      payload: {
        titleIds: [101, 103],
        position: 0,
        from: { pile: 'like', showAll: false, scroll: { top: 0, desktop: false } },
      },
    });
  });

  it('names a pile of one without "all"', () => {
    withState({
      review: reviewState({
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 102, verdict: 'skip', updatedAt: 2 },
        ],
      }),
    });
    render(<ReviewScreen />);
    expect(document.querySelector('[data-test-handle="review-pile"]')?.textContent).toBe('REVIEW 1 KEPT →');
    expect(screen.getByRole('button', { name: 'REVIEW 1 KEPT' })).toBeDefined();
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
    expect(document.querySelector('[data-test-handle="review-pile"]')).toBeNull();
    const rowBtn = screen.getByText('Iron Bloom').closest('button') as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    fireEvent.click(rowBtn);
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'enterDeckScope' }),
    );
  });
});
