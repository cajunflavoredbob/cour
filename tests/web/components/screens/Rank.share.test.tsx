// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { useStoreMock, renderMock } = vi.hoisted(() => ({ useStoreMock: vi.fn(), renderMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));
vi.mock('../../../../web/app/src/components/organisms/DeckDetails', () => ({ DeckDetails: () => <div /> }));
vi.mock('../../../../web/app/src/components/organisms/AccountMenu', () => ({ AccountMenu: () => <div /> }));
vi.mock('../../../../web/app/src/utils/renderStandingsCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderStandingsCard: renderMock,
}));
vi.mock('../../../../web/app/src/utils/shareFile', () => ({
  canShareFiles: () => false,
  shareImage: vi.fn(),
  downloadImage: vi.fn(),
  imageDataUrl: async () => 'data:image/png;base64,AAAA',
  pngSize: async () => ({ width: 1080, height: 1321 }),
}));

import { RankScreen } from '../../../../web/app/src/components/screens/Rank';
import { forgetDrafts } from '../../../../web/app/src/utils/drafts';
import { makeMedia } from '../../../helpers';

const media = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom' }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];
const standings = [
  { titleId: 101, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
  { titleId: 103, points: 21, bestRank: 1, rankedBy: 2, rankedByNames: ['user1', 'user2'], rank: 1 },
];
const results = (over = {}) => ({
  submittedCount: 2,
  memberCount: 2,
  members: [],
  mySubmitted: true,
  myRanking: [101, 103],
  standings,
  topPicks: [],
  ...over,
});
// An open re-rank round over both shows, so the tabs are on screen.
const round = (over = {}) => ({
  sharedTitleIds: [101, 103],
  refinedCount: 0,
  myRefined: false,
  myOrder: [101, 103],
  standings,
  topPicks: [],
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      connectionStatus: 'connected',
      room: { name: 'couch-coop', joined: true, media },
      review: {
        verdicts: [
          { titleId: 101, verdict: 'like', updatedAt: 1 },
          { titleId: 103, verdict: 'like', updatedAt: 2 },
        ],
        counts: { like: 2, dislike: 0, skip: 0 },
        lockedAt: 1,
        total: 3,
      },
      results: results(),
      ...slice,
    },
    dispatch,
  ]);
};

const link = () => document.querySelector('[data-test-handle="share-standings"]') as HTMLButtonElement | null;
const subtitle = () => screen.getByRole('dialog').querySelector('p')?.textContent;
const settle = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  forgetDrafts();
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  renderMock.mockReset().mockResolvedValue({ blob: new Blob(['png'], { type: 'image/png' }), complete: true });
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RankScreen sharing the standings', () => {
  it('offers a quiet link that names what it shares', () => {
    render(<RankScreen />);
    expect(link()?.textContent).toBe('SHARE THE STANDINGS →');
  });

  it('opens the preview from the link and returns focus to it on close', async () => {
    render(<RankScreen />);
    link()?.focus();
    fireEvent.click(link() as HTMLElement);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Share the standings');
    await settle(400);
    expect(screen.getByRole('img')).toBeDefined();
    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(link());
  });

  it('makes the image in the background while the standings are on screen', async () => {
    render(<RankScreen />);
    expect(renderMock).not.toHaveBeenCalled();
    await settle(400);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('makes nothing behind the ranking editor', async () => {
    withState({ results: results({ mySubmitted: false }) });
    render(<RankScreen />);
    await settle(2000);
    expect(renderMock).not.toHaveBeenCalled();
    expect(link()).toBeNull();
  });

  it('makes nothing behind the refine editor, and says which standings it shares', async () => {
    withState({
      results: results({
        refined: {
          sharedTitleIds: [101, 103],
          refinedCount: 0,
          myRefined: false,
          myOrder: [101, 103],
          standings,
          topPicks: [],
        },
      }),
    });
    render(<RankScreen />);
    fireEvent.click(screen.getByText('In common 2'));
    fireEvent.click(document.querySelector('[data-test-handle="open-refine"]') as HTMLElement);
    await settle(2000);
    expect(renderMock).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-test-handle="refine-back"]') as HTMLElement);
    fireEvent.click(link() as HTMLElement);
    expect(screen.getByText('OVERALL · ALL 2 RANKINGS IN · FINAL')).toBeDefined();
  });

  it('names Overall only while the tabs offer another view', () => {
    withState({
      results: results({
        refined: {
          sharedTitleIds: [101],
          refinedCount: 0,
          myRefined: false,
          myOrder: [101],
          standings: standings.slice(0, 1),
          topPicks: [],
        },
      }),
    });
    render(<RankScreen />);
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.click(link() as HTMLElement);
    expect(screen.getByRole('dialog').querySelector('p')?.textContent).toBe('ALL 2 RANKINGS IN · FINAL');
  });

  it('names Overall when the preview opens from the Overall tab', () => {
    withState({ results: results({ refined: round() }) });
    render(<RankScreen />);
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.click(link() as HTMLElement);
    expect(subtitle()).toBe('OVERALL · ALL 2 RANKINGS IN · FINAL');
  });

  it('names Overall once my own re-rank is in', () => {
    withState({ results: results({ refined: round({ myRefined: true, refinedCount: 1 }) }) });
    render(<RankScreen />);
    fireEvent.click(link() as HTMLElement);
    expect(subtitle()).toBe('OVERALL · ALL 2 RANKINGS IN · FINAL');
  });

  it('names Overall on desktop', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    withState({ results: results({ refined: round() }) });
    render(<RankScreen />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(link() as HTMLElement);
    expect(subtitle()).toBe('OVERALL · ALL 2 RANKINGS IN · FINAL');
  });

  it('does not make the image again when a push brings the same standings', async () => {
    const { rerender } = render(<RankScreen />);
    await settle(400);
    withState({ results: results() });
    rerender(<RankScreen />);
    await settle(2000);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('makes nothing during the submit ceremony, then makes the image', async () => {
    withState({ finalizing: { kind: 'submit', startedAt: Date.now() } });
    const { rerender } = render(<RankScreen />);
    await settle(2000);
    expect(renderMock).not.toHaveBeenCalled();
    expect(link()).toBeNull();
    withState();
    rerender(<RankScreen />);
    await settle(400);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('makes nothing and offers no link before there are standings', async () => {
    withState({ results: results({ standings: [] }) });
    render(<RankScreen />);
    await settle(2000);
    expect(renderMock).not.toHaveBeenCalled();
    expect(link()).toBeNull();
  });

  it('makes an image that drew without a poster again when the preview opens', async () => {
    renderMock.mockResolvedValueOnce({ blob: new Blob(['png'], { type: 'image/png' }), complete: false });
    render(<RankScreen />);
    await settle(400);
    expect(renderMock).toHaveBeenCalledTimes(1);
    fireEvent.click(link() as HTMLElement);
    await settle(400);
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it('closes the preview when the standings leave the screen, for good', async () => {
    const { rerender } = render(<RankScreen />);
    fireEvent.click(link() as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    withState({ results: results({ mySubmitted: false }) });
    rerender(<RankScreen />);
    expect(screen.queryByRole('dialog')).toBeNull();
    withState();
    rerender(<RankScreen />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
