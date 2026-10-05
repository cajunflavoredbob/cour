// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { StandingsCardData } from '../../web/app/src/utils/standingsCard';

const { renderMock, sizes } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  sizes: new WeakMap<Blob, { width: number; height: number }>(),
}));
vi.mock('../../web/app/src/utils/renderStandingsCard', () => ({ renderStandingsCard: renderMock }));
// jsdom's blob reads run on timers the fake clock does not drive; the real
// readers are covered in shareFile.test.ts.
vi.mock('../../web/app/src/utils/shareFile', () => ({
  imageDataUrl: async () => 'data:image/png;base64,AAAA',
  pngSize: async (blob: Blob) => sizes.get(blob) ?? { width: 0, height: 0 },
}));

import { useStandingsCardImage } from '../../web/app/src/hooks/useStandingsCardImage';

// A stand-in render: a PNG of a given size, drawn with or without every asset.
const pngOf = (width: number, height: number, complete = true) => {
  const blob = new Blob(['png'], { type: 'image/png' });
  sizes.set(blob, { width, height });
  return { blob, complete };
};

const card = (over: Partial<StandingsCardData> = {}): StandingsCardData => ({
  season: 'FALL',
  year: 2026,
  roomName: 'Couch-Coop',
  submittedCount: 2,
  memberCount: 2,
  standings: [{ titleId: 101, rank: 1, title: 'Iron Bloom', points: 21, rankedBy: 2, rankedByNames: ['user1', 'user2'] }],
  topPicks: [],
  ...over,
});

// Lets the queued render, the data: URL read and the header read settle.
const settle = async (ms = 400) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  renderMock.mockReset().mockImplementation(async () => pngOf(1080, 1321));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useStandingsCardImage', () => {
  it('makes nothing while the standings are off screen', async () => {
    const { result } = renderHook(() => useStandingsCardImage(null));
    await settle(2000);
    expect(renderMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ image: null, making: false, failed: false });
  });

  it('makes the image in the background, with its size and a data: URL', async () => {
    const { result } = renderHook(() => useStandingsCardImage(card()));
    expect(result.current).toMatchObject({ image: null, making: true });
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(result.current.making).toBe(false);
    expect(result.current.image).toMatchObject({ width: 1080, height: 1321, complete: true });
    expect(result.current.image?.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('does not make it again for the same standings in a fresh object', async () => {
    const { result, rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    await settle();
    rerender({ c: card() });
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(result.current.making).toBe(false);
  });

  it('keeps the last image on screen while a changed card is made', async () => {
    const { result, rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    await settle();
    const first = result.current.image;
    renderMock.mockImplementation(async () => pngOf(1080, 889));
    rerender({ c: card({ submittedCount: 1 }) });
    expect(result.current).toMatchObject({ making: true });
    expect(result.current.image).toBe(first);
    await settle();
    expect(result.current.making).toBe(false);
    expect(result.current.image).toMatchObject({ height: 889 });
  });

  it('reports a failed render, and tries again on retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMock.mockRejectedValueOnce(new Error('no canvas'));
    const { result } = renderHook(() => useStandingsCardImage(card()));
    await settle();
    expect(result.current).toMatchObject({ image: null, making: false, failed: true });
    act(() => result.current.retry());
    expect(result.current).toMatchObject({ making: true, failed: false });
    await settle();
    expect(result.current.failed).toBe(false);
    expect(result.current.image).toMatchObject({ width: 1080 });
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it('drops the result of a render whose card changed under it', async () => {
    let release = (_: ReturnType<typeof pngOf>) => {};
    renderMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof pngOf>>((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    await settle();
    renderMock.mockImplementation(async () => pngOf(1080, 1405));
    rerender({ c: card({ roomName: 'Movie-Night' }) });
    await settle();
    expect(result.current.image).toMatchObject({ height: 1405 });
    await act(async () => {
      release(pngOf(1080, 1321));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.image).toMatchObject({ height: 1405 });
  });

  it('waits for idle time where the browser offers it', async () => {
    const idle = vi.fn((cb: () => void) => setTimeout(cb, 50) as unknown as number);
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    renderHook(() => useStandingsCardImage(card()));
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 });
    await settle(50);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('drops a queued render the card changed under', async () => {
    const { rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    rerender({ c: card({ roomName: 'Movie-Night' }) });
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0][0]).toMatchObject({ roomName: 'Movie-Night' });
  });

  it('drops a render queued for idle time the card changed under', async () => {
    const idle = vi.fn((cb: () => void) => setTimeout(cb, 50) as unknown as number);
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', (handle: number) => clearTimeout(handle));
    const { rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    rerender({ c: card({ roomName: 'Movie-Night' }) });
    await settle(50);
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0][0]).toMatchObject({ roomName: 'Movie-Night' });
  });

  it('shows the render as under way, not failed, when the card comes back to one that failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMock.mockRejectedValueOnce(new Error('no canvas'));
    const { result, rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    await settle();
    expect(result.current.failed).toBe(true);
    renderMock.mockImplementation(() => new Promise(() => {}));
    rerender({ c: card({ roomName: 'Movie-Night' }) });
    rerender({ c: card() });
    await settle();
    expect(result.current).toMatchObject({ making: true, failed: false });
  });

  it('makes an image that drew without a poster again on refresh, keeping it up meanwhile', async () => {
    renderMock.mockImplementation(async () => pngOf(1080, 1321, false));
    const { result } = renderHook(() => useStandingsCardImage(card()));
    await settle();
    const first = result.current.image;
    expect(first).toMatchObject({ complete: false });
    renderMock.mockImplementation(async () => pngOf(1080, 1321));
    act(() => result.current.refresh());
    expect(result.current.making).toBe(true);
    expect(result.current.image).toBe(first);
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ making: false, image: { complete: true } });
  });

  it('leaves a render already under way alone on refresh', async () => {
    renderMock.mockImplementation(async () => pngOf(1080, 1321, false));
    const { result, rerender } = renderHook(({ c }) => useStandingsCardImage(c), { initialProps: { c: card() } });
    await settle();
    renderMock.mockImplementation(() => new Promise(() => {}));
    rerender({ c: card({ submittedCount: 1 }) });
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(2);
    act(() => result.current.refresh());
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a complete image alone on refresh', async () => {
    const { result } = renderHook(() => useStandingsCardImage(card()));
    await settle();
    act(() => result.current.refresh());
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(result.current.making).toBe(false);
  });
});
