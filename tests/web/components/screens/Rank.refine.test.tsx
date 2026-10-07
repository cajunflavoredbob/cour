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
// The share card never finishes here: these tests are about the views.
vi.mock('../../../../web/app/src/utils/renderStandingsCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderStandingsCard: () => new Promise(() => {}),
}));

import { RankScreen } from '../../../../web/app/src/components/screens/Rank';
import { forgetDrafts, placeKey, placeOf } from '../../../../web/app/src/utils/drafts';
import { makeMedia } from '../../../helpers';

const media = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom' }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];

// Two members, both submitted: 101 and 103 were kept by both, 102 is user1's alone.
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
    { titleId: 103, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
  ],
  ...over,
});
// Seven shows both members kept: more than the standings show before the reveal.
const seven = Array.from({ length: 7 }, (_, i) => ({
  titleId: 200 + i,
  points: 30 - i,
  bestRank: 1,
  rankedBy: 2,
  rankedByNames: ['user1', 'user2'],
  rank: i + 1,
}));
const sevenKept = () =>
  refined({ sharedTitleIds: seven.map((m) => m.titleId), myOrder: seven.map((m) => m.titleId), standings: seven });
const member = (userName: string, over = {}) => ({ userName, locked: true, submitted: true, refined: false, ...over });
const results = (over = {}) => ({
  submittedCount: 2,
  memberCount: 2,
  members: [member('user1'), member('user2')],
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
// user3 joined and has not ranked, so the round is closed.
const closed = () =>
  results({
    refined: undefined,
    memberCount: 3,
    submittedCount: 2,
    members: [member('user1'), member('user2'), member('user3', { submitted: false })],
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
const rowTitles = () =>
  [...document.querySelectorAll('[data-test-handle="standing-details"] [class*="rowTitle"]')].map((el) => el.textContent);
const rowMetas = () =>
  [...document.querySelectorAll('[data-test-handle="standing-details"] [class*="rowMeta"]')].map((el) => el.textContent);
const editorTitles = () =>
  [...document.querySelectorAll('[data-rank-row] [class*="rowTitle"]')].map((el) => el.textContent);
const toasts = () =>
  dispatch.mock.calls.filter(([a]) => a.type === 'addToast').map(([a]) => a.payload.message as string);
const notes = () => [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent).join('|');
const openInCommon = () => fireEvent.click(handle('standings-shared') as HTMLElement);
// The arrival toast waits for the revealed standings to settle.
const settle = () =>
  act(() => {
    vi.advanceTimersByTime(1500);
  });
const openEditor = () => {
  openInCommon();
  fireEvent.click(handle('open-refine') as HTMLElement);
};

beforeEach(() => {
  forgetDrafts();
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  stubDesktop(false);
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  // Nodes a test put on the page itself, left by a failed assertion,
  // would hold later tests under a dialog or menu.
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RankScreen re-rank round', () => {
  it('offers no second view until the round opens', () => {
    withState({ results: results({ refined: undefined }) });
    render(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(rowTitles()).toEqual(['Third Show', 'Iron Bloom', 'Second Show']);
  });

  it('opens on Overall, with In common one tab away under the head that stays the result', () => {
    render(<RankScreen />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Overall 3', 'true'],
      ['In common 2', 'false'],
    ]);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0].id);
    openInCommon();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1].id);
    expect(screen.getByText('fall standings.')).toBeDefined();
    expect(rowTitles()).toEqual(['Iron Bloom', 'Third Show']);
    expect(
      screen.getByText('the 2 shows everyone kept, scored only against each other, without changing the overall standings.'),
    ).toBeDefined();
    // Each row points back to its place overall instead of naming rankers.
    expect(screen.getByText('21 PTS · #2 OVERALL')).toBeDefined();
    expect(screen.getByText('21 PTS · #1 OVERALL')).toBeDefined();
    expect(screen.queryByText(/RANKED BY/)).toBeNull();
    expect(screen.queryByText(/RE-RANKED BY/)).toBeNull();
    // The strip stays the room's: each member's own #1.
    expect([...document.querySelectorAll('[data-test-handle="top-pick"]')].map((el) => el.textContent)).toEqual([
      'user1Second Show',
      'user2Third Show',
    ]);
  });

  it('keeps the medals on Overall, and the second view quiet', () => {
    render(<RankScreen />);
    expect(document.querySelector('[data-medal="1"]')?.textContent).toContain('Third Show');
    openInCommon();
    expect(document.querySelector('[data-medal]')).toBeNull();
  });

  it('tags In common rows with the place they share overall', () => {
    // Level overall; user2's re-rank split them in common.
    withState({
      results: results({
        standings: [
          { titleId: 101, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
          { titleId: 103, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
          { titleId: 102, points: 6, bestRank: 3, rankedBy: 1, rankedByNames: ['user1'], rank: 3 },
        ],
        refined: refined({
          refinedCount: 1,
          standings: [
            { titleId: 101, points: 24, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
            { titleId: 103, points: 18, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 2 },
          ],
        }),
      }),
    });
    render(<RankScreen />);
    openInCommon();
    expect(rowMetas()).toEqual(['24 PTS · #1 OVERALL', '18 PTS · #1 OVERALL']);
  });

  it('counts every show in each tab, past the five on show', () => {
    withState({ results: results({ standings: seven, refined: sevenKept() }) });
    render(<RankScreen />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overall 7', 'In common 7']);
  });

  it('moves between the tabs with the arrow keys', () => {
    render(<RankScreen />);
    const [all, kept] = screen.getAllByRole('tab');
    expect(all.tabIndex).toBe(0);
    expect(kept.tabIndex).toBe(-1);
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(kept.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(kept);
    fireEvent.keyDown(kept, { key: 'Home' });
    expect(all.getAttribute('aria-selected')).toBe('true');
  });

  it('says the same in a room of three or more', () => {
    withState({ results: results({ memberCount: 3, submittedCount: 3 }) });
    render(<RankScreen />);
    expect(screen.getByText('In common 2')).toBeDefined();
    openEditor();
    expect(screen.getByText('THE 2 SHOWS EVERYONE KEPT')).toBeDefined();
  });

  it("opens a show's details from everyone's #1", () => {
    render(<RankScreen />);
    expect(screen.queryByTestId('deck-details')).toBeNull();
    const picks = document.querySelectorAll('[data-test-handle="top-pick"]');
    fireEvent.click(picks[1] as HTMLElement);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Third Show');
    expect(screen.getByTestId('deck-details')).toBeDefined();
  });

  it('puts members with the same #1 under one poster', () => {
    withState({
      results: results({
        topPicks: [
          { userName: 'user1', titleId: 103 },
          { userName: 'user2', titleId: 103 },
        ],
      }),
    });
    render(<RankScreen />);
    expect([...document.querySelectorAll('[data-test-handle="top-pick"]')].map((el) => el.textContent)).toEqual([
      'user1 +\u00a0user2Third Show',
    ]);
  });

  it('re-ranks the shows through the no-turning-back dialog', () => {
    render(<RankScreen />);
    openEditor();
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
    expect(screen.getByText('THE 2 SHOWS EVERYONE KEPT')).toBeDefined();
    expect(screen.getByText('SCORED 12 · 9')).toBeDefined();
    expect(screen.getByText("OPTIONAL · ONE SHOT · THE RESULT WON'T CHANGE")).toBeDefined();
    // Seeded with this member's own order, each row saying where it was.
    expect(editorTitles()).toEqual(['Iron Bloom', 'Third Show']);
    expect(screen.getByText('YOU HAD IT #2')).toBeDefined();
    expect(screen.getByText('YOU HAD IT #3')).toBeDefined();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect(
      screen.getByText(
        "This sends your order for the 2 shows everyone kept. You can't change it after this, and the overall standings don't change.",
      ),
    ).toBeDefined();
    expect(screen.getByRole('alertdialog').getAttribute('aria-label')).toBe(
      'Submit your order for the shows everyone kept',
    );
    const confirm = handle('confirm-refine') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText('This is my order'));
    fireEvent.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: { kind: 'refine' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'submitRefinedRankings', payload: { rankedTitleIds: [103, 101] } });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submitRankings' }));
  });

  it('goes back to In common without submitting, and keeps the draft for next time', () => {
    render(<RankScreen />);
    openEditor();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    expect(handle('refine-back')?.getAttribute('aria-label')).toBe('Back to standings');
    fireEvent.click(handle('refine-back') as HTMLElement);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.click(handle('open-refine') as HTMLElement);
    expect(editorTitles()).toEqual(['Third Show', 'Iron Bloom']);
  });

  it('closes the re-rank editor on Back', () => {
    render(<RankScreen />);
    openEditor();
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
  });

  it('keeps the re-rank editor on Back while its order is being sent', () => {
    const view = render(<RankScreen />);
    openEditor();
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    view.rerender(<RankScreen />);
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
    // The send fails and the ceremony ends: the editor is still open, as
    // it was before Back.
    withState({});
    view.rerender(<RankScreen />);
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
  });

  it('scores only the slots the shows can fill', () => {
    withState({
      results: results({
        refined: refined({ sharedTitleIds: [101, 102, 103], myOrder: [102, 101, 103] }),
      }),
    });
    render(<RankScreen />);
    openEditor();
    expect(screen.getByText('SCORED 12 · 9 · 6')).toBeDefined();
  });

  it('holds the editor through the ceremony, then ends it after the 3s floor', () => {
    withState({
      results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }),
      finalizing: { kind: 'refine', startedAt: Date.now() },
    });
    render(<RankScreen />);
    const btn = handle('submit-refine') as HTMLButtonElement;
    expect(btn.textContent).toContain('submitting');
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

  it('keeps the ceremony going until the re-rank is acknowledged', () => {
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    render(<RankScreen />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });

  it('names who re-ranked, never a count still to go, and offers no second re-rank', () => {
    withState({
      results: results({
        members: [member('user1', { refined: true }), member('user2')],
        refined: refined({ myRefined: true, refinedCount: 1 }),
      }),
    });
    render(<RankScreen />);
    openInCommon();
    expect(screen.getByText('RE-RANKED BY USER1').getAttribute('role')).toBe('status');
    expect(screen.queryByText(/ OF 2/)).toBeNull();
    expect(handle('open-refine')).toBeNull();
  });

  it('still offers the re-rank to a member whose partner already did', () => {
    withState({
      results: results({
        members: [member('user1'), member('user2', { refined: true })],
        refined: refined({ refinedCount: 1 }),
      }),
    });
    render(<RankScreen />);
    openInCommon();
    expect(screen.getByText('RE-RANKED BY USER2')).toBeDefined();
    expect(handle('open-refine')?.textContent).toBe('RE-RANK THESE 2 →');
  });

  it('offers no second view, link or toast for one show kept by all, or none', () => {
    // Its own room: no earlier test has told it anything.
    const room = { name: 'one-show', joined: true, media };
    withState({
      room,
      results: results({
        refined: refined({
          sharedTitleIds: [103],
          myOrder: [103],
          standings: [{ titleId: 103, points: 24, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 }],
        }),
      }),
    });
    const { rerender } = render(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(handle('open-refine')).toBeNull();
    settle();
    expect(toasts()).toEqual([]);
    withState({ room, results: results({ refined: refined({ sharedTitleIds: [], myOrder: [], standings: [] }) }) });
    rerender(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    settle();
    expect(toasts()).toEqual([]);
  });

  it('opens the editor offline, and only the submit waits for the connection', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<RankScreen />);
    openEditor();
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    expect((handle('submit-refine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('scores a long list as the top 5, the rest at zero', () => {
    const ids = [201, 202, 203, 204, 205, 206, 207];
    withState({ results: results({ refined: refined({ sharedTitleIds: ids, myOrder: ids }) }) });
    stubDesktop(true);
    render(<RankScreen />);
    openEditor();
    expect(screen.getByText('TOP 5 SCORE 12 · 9 · 6 · 3 · 1')).toBeDefined();
    const legend = [...(document.querySelector('aside') as HTMLElement).querySelectorAll('li')].map((li) => li.textContent);
    expect(legend.at(-1)).toBe('#6+0 PTS');
  });

  it('lists a shared place of the second view A to Z, whatever order it arrives in', () => {
    const level = { points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 };
    withState({
      results: results({ refined: refined({ standings: [{ titleId: 103, ...level }, { titleId: 101, ...level }] }) }),
    });
    render(<RankScreen />);
    openInCommon();
    expect(rowTitles()).toEqual(['Iron Bloom', 'Third Show']);
    expect([...document.querySelectorAll('[data-rank]')].map((r) => r.getAttribute('data-rank'))).toEqual(['1', '1']);
  });

  it('gives medals to the top three of Overall only', () => {
    const four = [
      ...standings,
      { titleId: 104, points: 3, bestRank: 4, rankedBy: 1, rankedByNames: ['user1'], rank: 4 },
    ];
    withState({ results: results({ standings: four }) });
    render(<RankScreen />);
    const rows = [...document.querySelectorAll('[data-rank]')];
    expect(rows.map((r) => r.getAttribute('data-medal'))).toEqual(['1', '2', '3', null]);
  });

  it("keeps each member's draft to themselves", () => {
    withState({ user: { userName: 'user1' } });
    const first = render(<RankScreen />);
    openEditor();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    first.unmount();
    withState({ user: { userName: 'user2' } });
    render(<RankScreen />);
    openEditor();
    expect(editorTitles()).toEqual(['Iron Bloom', 'Third Show']);
  });

  it('remembers no open editor once the order is in', () => {
    const key = placeKey(undefined, 'couch-coop', 'FALL', 2026);
    const { rerender } = render(<RankScreen />);
    openEditor();
    expect(placeOf(key)?.refining).toBe(true);
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    rerender(<RankScreen />);
    expect(placeOf(key)?.refining).toBe(false);
  });

  it('comes back to the open editor and its draft after a trip away from the screen', () => {
    const first = render(<RankScreen />);
    openEditor();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    first.unmount();
    render(<RankScreen />);
    expect(editorTitles()).toEqual(['Third Show', 'Iron Bloom']);
  });

  it('comes back to In common with its reveal open after a trip away from the screen', () => {
    withState({
      results: results({
        refined: sevenKept(),
      }),
    });
    const first = render(<RankScreen />);
    openInCommon();
    fireEvent.click(handle('standings-reveal') as HTMLElement);
    first.unmount();
    render(<RankScreen />);
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(handle('standings-reveal')?.textContent).toBe('SHOW TOP 5');
  });

  it('starts at the top of the page on coming back, not on first arrival', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const first = render(<RankScreen />);
    expect(scrollTo).not.toHaveBeenCalled();
    first.unmount();
    render(<RankScreen />);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockRestore();
  });

  it('keeps each view its own reveal', () => {
    withState({
      results: results({
        standings: seven,
        refined: sevenKept(),
      }),
    });
    render(<RankScreen />);
    fireEvent.click(handle('standings-reveal') as HTMLElement);
    expect(handle('standings-reveal')?.textContent).toBe('SHOW TOP 5');
    openInCommon();
    expect(handle('standings-reveal')?.textContent).toBe('SHOW ALL 7');
    fireEvent.click(screen.getAllByRole('tab')[0]);
    expect(handle('standings-reveal')?.textContent).toBe('SHOW TOP 5');
  });

  it('hands focus to the standings heading on coming back to the screen', () => {
    const first = render(<RankScreen />);
    first.unmount();
    render(<RankScreen />);
    expect(document.activeElement?.textContent).toBe('fall standings.');
  });

  it('scrolls the heading into view on coming back, not when the round closes in place', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const first = render(<RankScreen />);
    first.unmount();
    const back = render(<RankScreen />);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
    openInCommon();
    (document.activeElement as HTMLElement).blur();
    withState({ results: closed() });
    back.rerender(<RankScreen />);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('keeps the scroll when the round closes under Overall', () => {
    const { rerender } = render(<RankScreen />);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(document.activeElement?.textContent).toBe('fall standings.');
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('brings the re-rank heading into view as the editor opens', () => {
    render(<RankScreen />);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    openEditor();
    expect(document.activeElement?.textContent).toBe('re-rank these 2.');
    expect(focus.mock.lastCall?.[0]?.preventScroll).not.toBe(true);
    focus.mockRestore();
  });

  it('takes focus on coming back only once, and not from under an open menu', () => {
    const first = render(<RankScreen />);
    first.unmount();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    const back = render(<RankScreen />);
    expect(document.activeElement).toBe(document.body);
    menu.remove();
    withState({ results: results() });
    back.rerender(<RankScreen />);
    expect(document.activeElement).toBe(document.body);
  });

  it('opens no confirm for the second click of a double-click on Submit this order', () => {
    render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement, { detail: 2 });
    expect(handle('confirm-refine')).toBeNull();
    fireEvent.click(handle('submit-refine') as HTMLElement, { detail: 1 });
    expect(handle('confirm-refine')).not.toBeNull();
  });

  it('opens details on a click, but not for the second click of a double-click', () => {
    render(<RankScreen />);
    const row = document.querySelector('[data-test-handle="standing-details"]') as HTMLElement;
    fireEvent.click(row, { detail: 2 });
    expect(screen.queryByTestId('deck-details')).toBeNull();
    fireEvent.click(row, { detail: 1 });
    expect(screen.getByTestId('deck-details')).toBeDefined();
  });

  it('counts the rows in the reveal', () => {
    withState({
      results: results({
        refined: sevenKept(),
      }),
    });
    render(<RankScreen />);
    openInCommon();
    expect(handle('standings-reveal')?.textContent).toBe('SHOW ALL 7');
    // Named by its words alone.
    expect(screen.getByRole('button', { name: 'SHOW ALL 7' })).toBe(handle('standings-reveal'));
  });
});

describe('RankScreen re-rank round opening and closing', () => {
  it('says once per member, room and season where the new view is, after the standings settle', () => {
    withState({ room: { name: 'told-once', joined: true, media }, user: { userName: 'user1' } });
    const { unmount } = render(<RankScreen />);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(toasts()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toasts()).toEqual(['All rankings are in. The In common tab compares the 2 shows everyone kept.']);
    unmount();
    render(<RankScreen />);
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('tells each member on a shared device', () => {
    const room = { name: 'told-per-member', joined: true, media };
    withState({ room, user: { userName: 'user1' } });
    const first = render(<RankScreen />);
    settle();
    first.unmount();
    withState({ room, user: { userName: 'user2' } });
    render(<RankScreen />);
    settle();
    expect(toasts()).toHaveLength(2);
  });

  it('takes the toast back once the member opens In common', () => {
    withState({ room: { name: 'told-and-acted', joined: true, media } });
    render(<RankScreen />);
    settle();
    const id = dispatch.mock.calls.find(([a]) => a.type === 'addToast')?.[0].payload.id;
    openInCommon();
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeToast', payload: { id, message: '' } });
  });

  it('tells nobody who already re-ranked, and waits out the submit ceremony', () => {
    const room = { name: 'told-after-ceremony', joined: true, media };
    withState({ room, results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    const { rerender } = render(<RankScreen />);
    settle();
    expect(toasts()).toEqual([]);
    withState({ room, finalizing: { kind: 'submit', startedAt: Date.now() } });
    rerender(<RankScreen />);
    settle();
    expect(toasts()).toEqual([]);
    withState({ room });
    rerender(<RankScreen />);
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('tells again in another room, or another season', () => {
    const room = { name: 'told-per-room', joined: true, media };
    withState({ room });
    const first = render(<RankScreen />);
    settle();
    first.unmount();
    withState({ room: { ...room, name: 'told-per-room-2' } });
    const second = render(<RankScreen />);
    settle();
    second.unmount();
    expect(toasts()).toHaveLength(2);
    vi.setSystemTime(new Date('2027-01-20T12:00:00'));
    withState({ room });
    render(<RankScreen />);
    settle();
    expect(toasts()).toHaveLength(3);
  });

  it('says the same in a room of three or more', () => {
    withState({ room: { name: 'told-three', joined: true, media }, results: results({ memberCount: 3, submittedCount: 3 }) });
    render(<RankScreen />);
    settle();
    expect(toasts()).toEqual(['All rankings are in. The In common tab compares the 2 shows everyone kept.']);
  });

  it('waits until the page is in view', () => {
    let state: DocumentVisibilityState = 'hidden';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    withState({ room: { name: 'told-when-visible', joined: true, media } });
    render(<RankScreen />);
    settle();
    expect(toasts()).toEqual([]);
    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    settle();
    expect(toasts()).toHaveLength(1);
    spy.mockRestore();
  });

  it('counts the view as found when the member opens In common before the toast', () => {
    withState({ room: { name: 'found-first', joined: true, media } });
    render(<RankScreen />);
    openInCommon();
    settle();
    fireEvent.click(handle('standings-all') as HTMLElement);
    settle();
    expect(toasts()).toEqual([]);
  });

  it('says nothing over an open dialog, and speaks once it closes', () => {
    withState({ room: { name: 'told-after-dialog', joined: true, media } });
    render(<RankScreen />);
    fireEvent.click(document.querySelector('[data-test-handle="standing-details"]') as HTMLElement);
    settle();
    expect(toasts()).toEqual([]);
    fireEvent.click(handle('detail-close') as HTMLElement);
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('waits out the share preview', () => {
    withState({ room: { name: 'told-after-share', joined: true, media } });
    render(<RankScreen />);
    fireEvent.click(handle('share-standings') as HTMLElement);
    settle();
    expect(toasts()).toEqual([]);
    fireEvent.click(screen.getByText('close'));
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('waits out the account menu', () => {
    withState({ room: { name: 'told-after-account-menu', joined: true, media } });
    render(<RankScreen />);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    settle();
    settle();
    expect(toasts()).toEqual([]);
    menu.remove();
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('waits out a dialog the screen does not own', () => {
    withState({ room: { name: 'told-after-menu', joined: true, media } });
    render(<RankScreen />);
    const other = document.createElement('div');
    other.setAttribute('aria-modal', 'true');
    document.body.append(other);
    settle();
    settle();
    expect(toasts()).toEqual([]);
    other.remove();
    settle();
    expect(toasts()).toHaveLength(1);
  });

  it('takes the toast back when the round closes', () => {
    withState({ room: { name: 'told-then-closed', joined: true, media } });
    const { rerender } = render(<RankScreen />);
    settle();
    const id = dispatch.mock.calls.find(([a]) => a.type === 'addToast')?.[0].payload.id;
    withState({ room: { name: 'told-then-closed', joined: true, media }, results: closed() });
    rerender(<RankScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeToast', payload: { id, message: '' } });
  });

  it('falls back to Overall when the round closes', () => {
    const { rerender } = render(<RankScreen />);
    openInCommon();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(rowTitles()).toEqual(['Third Show', 'Iron Bloom', 'Second Show']);
  });

  it('says why the view went away, and moves focus to the standings', () => {
    const { rerender } = render(<RankScreen />);
    dispatch.mockClear();
    openEditor();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(toasts()).toEqual(['user3 joined, so the standings are live again.']);
    expect(document.activeElement?.textContent).toBe('fall standings.');
  });

  it('says nothing to a member who was on Overall', () => {
    const { rerender } = render(<RankScreen />);
    dispatch.mockClear();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(toasts()).toEqual([]);
  });

  it('closes the editor when the round closes, keeps the draft, and does not reopen by itself', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    withState({ results: results({ memberCount: 3, submittedCount: 3 }) });
    rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    openEditor();
    expect(editorTitles()).toEqual(['Third Show', 'Iron Bloom']);
  });

  it('comes back to the open editor once the standings arrive', () => {
    const first = render(<RankScreen />);
    openEditor();
    first.unmount();
    withState({ results: undefined });
    const back = render(<RankScreen />);
    withState({ results: results() });
    back.rerender(<RankScreen />);
    expect(screen.getByText('re-rank these 2.')).toBeDefined();
  });

  it('drops a re-rank left open when the round closed while the screen was away', () => {
    const first = render(<RankScreen />);
    openEditor();
    first.unmount();
    withState({ results: closed() });
    const back = render(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    withState({ results: results({ memberCount: 3, submittedCount: 3 }) });
    back.rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('says why when the round closed while the screen was away on its view', () => {
    const first = render(<RankScreen />);
    openInCommon();
    first.unmount();
    dispatch.mockClear();
    withState({ results: closed() });
    render(<RankScreen />);
    expect(toasts()).toEqual(['user3 joined, so the standings are live again.']);
    expect(document.activeElement?.textContent).toBe('fall standings.');
  });

  it('says why when the closed round lands after the screen came back from the editor', () => {
    const first = render(<RankScreen />);
    openEditor();
    first.unmount();
    dispatch.mockClear();
    withState({ results: undefined });
    const back = render(<RankScreen />);
    withState({ results: closed() });
    back.rerender(<RankScreen />);
    expect(toasts()).toEqual(['user3 joined, so the standings are live again.']);
  });

  it('says nothing of a close found on coming back to Overall', () => {
    const first = render(<RankScreen />);
    first.unmount();
    dispatch.mockClear();
    withState({ results: closed() });
    render(<RankScreen />);
    expect(toasts()).toEqual([]);
  });

  it('drops it too when the closed round arrives after the screen opens', () => {
    const first = render(<RankScreen />);
    openEditor();
    first.unmount();
    withState({ results: undefined });
    const back = render(<RankScreen />);
    withState({ results: closed() });
    back.rerender(<RankScreen />);
    withState({ results: results({ memberCount: 3, submittedCount: 3 }) });
    back.rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('takes the toast back when the screen comes back to a closed round', () => {
    withState({ room: { name: 'told-then-away', joined: true, media } });
    const first = render(<RankScreen />);
    settle();
    const id = dispatch.mock.calls.find(([a]) => a.type === 'addToast')?.[0].payload.id;
    expect(id).toBeDefined();
    first.unmount();
    withState({ room: { name: 'told-then-away', joined: true, media }, results: closed() });
    render(<RankScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'removeToast', payload: { id, message: '' } });
  });

  it('closes the re-rank when fewer than two shows are left, focuses the standings, and does not reopen by itself', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const one = refined({
      sharedTitleIds: [103],
      myOrder: [103],
      standings: [{ titleId: 103, points: 24, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 }],
    });
    withState({ results: results({ refined: one }) });
    rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.activeElement?.textContent).toBe('fall standings.');
    // A change in place: the page stays where it is.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
    withState({ results: results() });
    rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('closes an open re-rank dialog when the round closes, then focuses the standings', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect(handle('confirm-refine')).not.toBeNull();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(handle('confirm-refine')).toBeNull();
    expect(document.activeElement?.textContent).toBe('fall standings.');
  });

  it('says why when the round closes under In common, outside the editor', () => {
    const { rerender } = render(<RankScreen />);
    openInCommon();
    dispatch.mockClear();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(toasts()).toEqual(['user3 joined, so the standings are live again.']);
  });

  it('ends the trip once the re-rank lands, so a later close on Overall says nothing', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    rerender(<RankScreen />);
    fireEvent.click(handle('standings-all') as HTMLElement);
    const link = handle('share-standings') as HTMLElement;
    link.focus();
    dispatch.mockClear();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(toasts()).toEqual([]);
    expect(document.activeElement).toBe(link);
  });

  it('moves focus to the standings when the tabs it was on go away, without a toast', () => {
    const { rerender } = render(<RankScreen />);
    (handle('standings-all') as HTMLElement).focus();
    dispatch.mockClear();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(toasts()).toEqual([]);
    expect(document.activeElement?.textContent).toBe('fall standings.');
  });

  it('waits for the details dialog before moving focus to the standings, and does it once', () => {
    const { rerender } = render(<RankScreen />);
    openInCommon();
    fireEvent.click(document.querySelectorAll('[data-test-handle="standing-details"]')[0] as HTMLElement);
    expect(screen.getByRole('dialog')).toBeDefined();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(document.activeElement?.textContent).not.toBe('fall standings.');
    fireEvent.click(handle('detail-close') as HTMLElement);
    expect(document.activeElement?.textContent).toBe('fall standings.');
    // A later dialog gives focus back to its own opener, not the headline.
    const row = document.querySelectorAll('[data-test-handle="standing-details"]')[1] as HTMLElement;
    row.focus();
    fireEvent.click(row);
    fireEvent.click(handle('detail-close') as HTMLElement);
    expect(document.activeElement).toBe(row);
  });

  it('leaves focus with an open share dialog, which gives it back itself', () => {
    const { rerender } = render(<RankScreen />);
    openInCommon();
    const link = handle('share-standings') as HTMLElement;
    link.focus();
    fireEvent.click(link);
    const close = screen.getByText('close');
    close.focus();
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(document.activeElement).toBe(link);
  });

  it('ends a re-rank ceremony whose round is closed', () => {
    withState({ results: closed(), finalizing: { kind: 'refine', startedAt: Date.now() } });
    render(<RankScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'finalizing', payload: null });
  });
});

describe('RankScreen re-rank editor and submit', () => {
  it('closes a re-rank confirm whose order already landed from elsewhere', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect(handle('confirm-refine')).not.toBeNull();
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    rerender(<RankScreen />);
    expect(handle('confirm-refine')).toBeNull();
    expect(document.activeElement).toBe(handle('standings-shared'));
    expect(notes()).toContain('Your order is in.');
  });

  it('says the order is going, then that it is in, and not again when a closed round reopens', () => {
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    const { rerender } = render(<RankScreen />);
    expect(notes()).toContain('Submitting your order…');
    const done = results({ refined: refined({ myRefined: true, refinedCount: 1 }) });
    withState({ results: done });
    rerender(<RankScreen />);
    expect(notes()).toContain('Your order is in.');
    withState({ results: closed() });
    rerender(<RankScreen />);
    expect(notes()).not.toContain('Your order is in.');
    withState({ results: done });
    rerender(<RankScreen />);
    expect(notes()).not.toContain('Your order is in.');
  });

  it('says nothing on arrival about an order already in', () => {
    withState({ results: results({ refined: refined({ myRefined: true, refinedCount: 1 }) }) });
    render(<RankScreen />);
    expect(notes()).not.toContain('Your order is in.');
  });

  it('closes the editor once the re-rank is in and the ceremony is over, focusing In common', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    expect(document.activeElement?.textContent).toBe('re-rank these 2.');
    withState({
      results: results({
        members: [member('user1', { refined: true }), member('user2')],
        refined: refined({ myRefined: true, refinedCount: 1 }),
      }),
    });
    rerender(<RankScreen />);
    expect(screen.queryByText('re-rank these 2.')).toBeNull();
    expect(screen.getByText('RE-RANKED BY USER1')).toBeDefined();
    expect(document.activeElement?.textContent).toBe('In common 2');
  });

  it('follows a change in the shows everyone kept while re-ranking', () => {
    withState({
      results: results({
        refined: refined({ sharedTitleIds: [103, 101, 102], myOrder: [101, 102, 103] }),
      }),
    });
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(screen.getByLabelText('Move Third Show up'));
    // Second Show is no longer kept by everyone.
    withState({ results: results({ refined: refined({ sharedTitleIds: [103, 101], myOrder: [101, 103] }) }) });
    rerender(<RankScreen />);
    expect(editorTitles()).toEqual(['Iron Bloom', 'Third Show']);
  });

  it('freezes the list while the ceremony runs', () => {
    withState({ finalizing: { kind: 'refine', startedAt: Date.now() } });
    render(<RankScreen />);
    const moves = screen.getAllByLabelText(/^Move /) as HTMLButtonElement[];
    expect(moves).toHaveLength(4);
    for (const btn of moves) expect(btn.disabled).toBe(true);
  });

  it('disables the submit when the connection drops', () => {
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
    fireEvent.click(screen.getByText('This is my order'));
    fireEvent.click(screen.getByText('keep re-ranking'));
    fireEvent.click(handle('submit-refine') as HTMLElement);
    expect((handle('confirm-refine') as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not confirm while offline', () => {
    const { rerender } = render(<RankScreen />);
    openEditor();
    fireEvent.click(handle('submit-refine') as HTMLElement);
    fireEvent.click(screen.getByText('This is my order'));
    withState({ connectionStatus: 'disconnected' });
    rerender(<RankScreen />);
    const confirm = handle('confirm-refine') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'submitRefinedRankings' }));
  });
});

describe('RankScreen re-rank round on desktop', () => {
  beforeEach(() => stubDesktop(true));

  it('keeps the head and everyone\'s #1 in the rail, the tabs and list in the main column', () => {
    render(<RankScreen />);
    const rail = document.querySelector('aside') as HTMLElement;
    expect(rail.textContent).toContain('fall standings.');
    expect(rail.textContent).toContain("EVERYONE'S #1");
    expect(rail.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('[data-hero="true"]')?.textContent).toContain('Third Show');
    openInCommon();
    expect(document.querySelector('[data-hero="true"]')).toBeNull();
    expect(document.querySelector('[data-medal]')).toBeNull();
  });

  it('re-ranks in the rail layout, the legend sized to the shows, the way back in the header', () => {
    render(<RankScreen />);
    openEditor();
    const rail = document.querySelector('aside') as HTMLElement;
    expect(rail.textContent).toContain('re-rank these 2.');
    expect(rail.querySelector('[data-test-handle="submit-refine"]')).not.toBeNull();
    expect([...rail.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['#112 PTS', '#29 PTS']);
    expect(document.querySelector('header [data-test-handle="refine-back"]')).not.toBeNull();
  });
});
