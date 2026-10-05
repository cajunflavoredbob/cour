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
  DeckDetails: () => <div data-testid="deck-details" />,
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

// Two members, both submitted: 101 and 103 are shared, 102 is user1's alone.
const standings = [
  { titleId: 103, points: 18, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
  { titleId: 101, points: 18, bestRank: 2, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 2 },
  { titleId: 102, points: 12, bestRank: 1, rankedBy: 1, rankedByNames: ['user1'], rank: 3 },
];
const refined = (over = {}) => ({
  sharedTitleIds: [103, 101],
  refinedCount: 0,
  myRefined: false,
  myOrder: [101, 103],
  standings: [
    { titleId: 101, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
    { titleId: 103, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 2 },
  ],
  topPicks: [
    { userName: 'user1', titleId: 101 },
    { userName: 'user2', titleId: 103 },
  ],
  ...over,
});
const results = (over = {}) => ({
  submittedCount: 2,
  memberCount: 2,
  members: [],
  mySubmitted: true,
  myRanking: [102, 101, 103],
  standings,
  topPicks: [
    { userName: 'user1', titleId: 102 },
    { userName: 'user2', titleId: 103 },
  ],
  refined: refined(),
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      connectionStatus: 'connected',
      room: { name: 'couch-coop', joined: true, media },
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, lockedAt: 1, total: 3 },
      results: results(),
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

const handle = (name: string) => document.querySelector(`[data-test-handle="${name}"]`) as HTMLButtonElement | null;
const rowTitles = () => [...document.querySelectorAll('[data-test-handle="standing-details"] [class*="rowTitle"]')].map((el) => el.textContent);

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  stubDesktop(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RankScreen refine round', () => {
  it('offers no shared view until the round opens', () => {
    withState({ results: results({ refined: undefined }) });
    render(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(rowTitles()).toEqual(['Third Show', 'Iron Bloom', 'Second Show']);
  });

  it('opens on all picks, with the shared shows one tab away', () => {
    render(<RankScreen />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['All picks 3', 'true'],
      ['Shared shows 2', 'false'],
    ]);
    expect(screen.getByText("EVERYONE'S #1")).toBeDefined();
    fireEvent.click(tabs[1]);
    expect(rowTitles()).toEqual(['Iron Bloom', 'Third Show']);
    expect(screen.getByText(/SHOWS EVERYONE KEPT · 0 OF 2 REFINED/)).toBeDefined();
    expect(screen.getByText("EVERYONE'S SHARED #1")).toBeDefined();
    // Every member ranked every shared show: no names on the rows.
    expect(screen.queryByText(/RANKED BY/)).toBeNull();
    expect(screen.getAllByText('21 PTS')).toHaveLength(2);
  });

  it('refines the shared shows through the no-turning-back dialog', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    fireEvent.click(handle('open-refine') as HTMLElement);
    expect(screen.getByText('refine your order.')).toBeDefined();
    // Seeded with this member's order over the shared shows.
    expect(screen.getAllByText(/Iron Bloom|Third Show/).map((el) => el.textContent)).toEqual(['Iron Bloom', 'Third Show']);
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect(screen.getByText(/the all-picks standings stay the room's result/)).toBeDefined();
    const confirm = handle('confirm-refine') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText('This is my refined order'));
    fireEvent.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: { kind: 'refine' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'submitRefinedRankings', payload: { rankedTitleIds: [103, 101] } });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submitRankings' }));
  });

  it('goes back to the standings without submitting', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    fireEvent.click(handle('open-refine') as HTMLElement);
    fireEvent.click(handle('refine-back') as HTMLElement);
    expect(screen.queryByText('refine your order.')).toBeNull();
    expect(screen.getByText(/SHOWS EVERYONE KEPT/)).toBeDefined();
  });

  it('holds the refine editor through the ceremony, then ends it after the 3s floor', () => {
    withState({
      results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }),
      finalizing: { kind: 'refine', startedAt: Date.now() },
    });
    render(<RankScreen />);
    const btn = handle('submit-refine') as HTMLButtonElement;
    expect(btn.textContent).toContain('Submitting');
    expect(btn.disabled).toBe(true);
    expect((handle('refine-back') as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'finalizing', payload: null });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });

  it('keeps the ceremony going until the refine is acknowledged', () => {
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    render(<RankScreen />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });

  it('says so once this member has refined, and offers no second refine', () => {
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    expect(screen.getByText(/1 OF 2 REFINED · YOURS IS IN/)).toBeDefined();
    expect(handle('open-refine')).toBeNull();
  });

  it('says ALL once every member has refined', () => {
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 2 }) }) });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    expect(screen.getByText(/ALL 2 REFINED/)).toBeDefined();
  });

  it('has nothing to refine with one shared show', () => {
    withState({
      results: results({
        refined: refined({
          sharedTitleIds: [103],
          myOrder: [103],
          standings: [{ titleId: 103, points: 24, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 }],
        }),
      }),
    });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 1'));
    expect(screen.getByText('only one show in common, so there is nothing to refine.')).toBeDefined();
    expect(handle('open-refine')).toBeNull();
  });

  it('says when no show is shared', () => {
    withState({
      results: results({ refined: refined({ sharedTitleIds: [], myOrder: [], standings: [], topPicks: [] }) }),
    });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 0'));
    expect(screen.getByText('no shows in common this season.')).toBeDefined();
    expect(handle('open-refine')).toBeNull();
  });

  it('disables the refine while disconnected', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    expect((handle('open-refine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to all picks when the round closes', () => {
    withState();
    const { rerender } = render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    withState({ results: results({ refined: undefined, memberCount: 3, submittedCount: 2 }) });
    rerender(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(rowTitles()).toEqual(['Third Show', 'Iron Bloom', 'Second Show']);
  });
});

describe('RankScreen refine round lifecycle', () => {
  const openEditor = () => {
    fireEvent.click(screen.getByText('Shared shows 2'));
    fireEvent.click(handle('open-refine') as HTMLElement);
  };

  it('closes the editor when the round closes, and does not reopen it by itself', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    expect(screen.getByText('refine your order.')).toBeDefined();
    withState({ results: results({ refined: undefined, memberCount: 3, submittedCount: 2 }) });
    rerender(<RankScreen />);
    expect(screen.queryByText('refine your order.')).toBeNull();
    withState({ results: results({ memberCount: 3, submittedCount: 3 }) });
    rerender(<RankScreen />);
    expect(screen.queryByText('refine your order.')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('closes an open refine dialog when the round closes', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect(handle('confirm-refine')).not.toBeNull();
    withState({ results: results({ refined: undefined, memberCount: 3, submittedCount: 2 }) });
    rerender(<RankScreen />);
    expect(handle('confirm-refine')).toBeNull();
  });

  it('ends a refine ceremony whose round closed', () => {
    withState({
      results: results({ refined: undefined, memberCount: 3, submittedCount: 2 }),
      finalizing: { kind: 'refine', startedAt: Date.now() },
    });
    render(<RankScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });

  it('closes the editor once the refine is in and the ceremony is over', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    rerender(<RankScreen />);
    expect(screen.queryByText('refine your order.')).toBeNull();
    expect(screen.getByText(/1 OF 2 REFINED · YOURS IS IN/)).toBeDefined();
  });

  it('follows a change in the shared shows while refining', () => {
    withState({
      results: results({
        refined: refined({ sharedTitleIds: [103, 101, 102], myOrder: [101, 102, 103] }),
      }),
    });
    const { rerender } = render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 3'));
    fireEvent.click(handle('open-refine') as HTMLElement);
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    // Second Show is no longer shared.
    withState({ results: results({ refined: refined({ sharedTitleIds: [103, 101], myOrder: [101, 103] }) }) });
    rerender(<RankScreen />);
    expect(screen.getAllByText(/Iron Bloom|Second Show|Third Show/).map((el) => el.textContent)).toEqual([
      'Iron Bloom',
      'Third Show',
    ]);
  });

  it('moves focus into the editor and back to the shared tab', () => {
    render(<RankScreen />);
    openEditor();
    expect(document.activeElement?.textContent).toBe('refine your order.');
    fireEvent.click(handle('refine-back') as HTMLElement);
    expect(document.activeElement?.textContent).toBe('Shared shows 2');
  });

  it('shows the shared #1s, not the all-picks ones', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    expect([...document.querySelectorAll('[data-test-handle="top-pick"]')].map((el) => el.textContent)).toEqual([
      'user1Iron Bloom',
      'user2Third Show',
    ]);
  });

  it('counts the shared rows in the reveal', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      titleId: 200 + i, points: 30 - i, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: i + 1,
    }));
    withState({
      results: results({
        refined: refined({ sharedTitleIds: many.map((m) => m.titleId), myOrder: many.map((m) => m.titleId), standings: many }),
      }),
    });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 7'));
    expect(handle('standings-reveal')?.textContent).toBe('SHOW ALL 7 →');
  });

  it('says nothing about a single show when none are shared', () => {
    withState({
      results: results({ refined: refined({ sharedTitleIds: [], myOrder: [], standings: [], topPicks: [] }) }),
    });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 0'));
    expect(screen.queryByText(/only one show in common/)).toBeNull();
  });

  it('freezes the refine list while the ceremony runs', () => {
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    render(<RankScreen />);
    const moves = screen.getAllByLabelText(/^Move /) as HTMLButtonElement[];
    expect(moves).toHaveLength(4);
    for (const btn of moves) expect(btn.disabled).toBe(true);
  });

  it('disables the refine submit when the connection drops', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    withState({ connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    expect((handle('submit-refine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('re-opens the confirm dialog unticked', () => {
    render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    fireEvent.click(screen.getByText('This is my refined order'));
    fireEvent.click(screen.getByText('Keep ordering'));
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect((handle('confirm-refine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not confirm while offline', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    fireEvent.click(screen.getByText('This is my refined order'));
    withState({ connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    const confirm = handle('confirm-refine') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submitRefinedRankings' }));
  });
});

describe('RankScreen refine round on desktop', () => {
  beforeEach(() => stubDesktop(true));

  it('shows the shared standings with the #1 hero row', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    const hero = document.querySelector('[data-hero="true"]');
    expect(hero?.textContent).toContain('Iron Bloom');
  });

  it('refines in the rail layout, the legend beside the list', () => {
    render(<RankScreen />);
    fireEvent.click(screen.getByText('Shared shows 2'));
    fireEvent.click(handle('open-refine') as HTMLElement);
    const rail = document.querySelector('[class*="rail"]') as HTMLElement;
    expect(rail.textContent).toContain('refine your order.');
    expect(rail.querySelector('[data-test-handle="submit-refine"]')).not.toBeNull();
    expect(rail.textContent).toContain('#6+');
  });
});
