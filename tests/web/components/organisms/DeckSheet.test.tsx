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

vi.mock('../../../../web/app/src/components/molecules/VerdictRow', () => ({
  VerdictRow: ({ titleId, remaining }: { titleId: number; remaining: number }) => (
    <div data-testid="verdict-row" data-title-id={titleId} data-remaining={remaining} />
  ),
}));
vi.mock('../../../../web/app/src/components/atoms/AnimeLinks', () => ({
  AnimeLinks: () => <div data-testid="anime-links" />,
}));

import { DeckSheet } from '../../../../web/app/src/components/organisms/DeckSheet';
import { makeMedia } from '../../../helpers';

const withTrailer = makeMedia({
  id: '101',
  anilistId: 101,
  title: 'Iron Bloom',
  titleRomaji: 'Tetsu no Hana',
  description: 'A long synopsis.',
  posterUrl: '/api/poster/0/101/0',
  trailer: { site: 'youtube', id: 'pv-abc' },
});
const withStills = makeMedia({
  id: '103',
  anilistId: 103,
  title: 'Enriched Show',
  posterUrl: '/api/poster/0/103/0',
  trailer: { site: 'youtube', id: 'pv-x' },
  screenshotUrls: [
    '/api/poster/0/103/1',
    '/api/poster/0/103/2',
    '/api/poster/0/103/3',
    '/api/poster/0/103/4',
    '/api/poster/0/103/5',
  ],
});
const imagesOnly = makeMedia({
  id: '104',
  anilistId: 104,
  title: 'No Trailer Show',
  posterUrl: '/api/poster/0/104/0',
  screenshotUrls: ['/api/poster/0/104/1', '/api/poster/0/104/2'],
});

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([{ soundPref: false, ...slice }, dispatch]);
};

const handle = () =>
  document.querySelector('[data-test-handle="sheet-handle"]') as HTMLElement;
const openSheet = () => fireEvent.click(handle());

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DeckSheet', () => {
  it('starts closed: chrome (handle + verdict row) visible, content unmounted', () => {
    render(<DeckSheet media={withTrailer} remaining={12} />);
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    const row = screen.getByTestId('verdict-row');
    expect(row.getAttribute('data-title-id')).toBe('101');
    expect(row.getAttribute('data-remaining')).toBe('12');
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.queryByText('A long synopsis.')).toBeNull();
  });

  it('tap on the handle toggles the sheet open and closed', () => {
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    expect(handle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('A long synopsis.')).toBeDefined();
    openSheet();
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    // Closed sheet unmounts the PV -- no audio can survive a close.
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('Escape closes an open sheet', () => {
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handle().getAttribute('aria-expanded')).toBe('false');
  });

  it('drag up on the handle past the commit threshold opens; a short drag springs back', () => {
    // Travel range = mocked 400px panel minus the 62px handle = 338.
    const offsetSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(400);
    render(<DeckSheet media={withTrailer} remaining={12} />);
    // Short drag (60px of 338 -- under the 25% commit): springs back.
    fireEvent.pointerDown(handle(), { clientY: 800, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 740, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: 740, pointerId: 1 });
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    // Long drag (300px): commits open.
    fireEvent.pointerDown(handle(), { clientY: 800, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: 500, pointerId: 1 });
    expect(handle().getAttribute('aria-expanded')).toBe('true');
    // Drag down past the threshold closes again.
    fireEvent.pointerDown(handle(), { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 550, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: 550, pointerId: 1 });
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    offsetSpy.mockRestore();
  });

  it('the panel tracks the finger during a drag, handle leading', () => {
    const offsetSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(400);
    const { container } = render(<DeckSheet media={withTrailer} remaining={12} />);
    const panel = container.querySelector('[class*="panel"]') as HTMLElement;
    fireEvent.pointerDown(handle(), { clientY: 800, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 700, pointerId: 1 });
    // 100px up from fully-closed (range 338) -> translateY(238px), 1:1.
    expect(panel.style.transform).toBe('translateY(238px)');
    fireEvent.pointerCancel(handle(), { pointerId: 1 });
    offsetSpy.mockRestore();
  });

  it('the verdict row is static chrome outside the sliding panel', () => {
    const { container } = render(<DeckSheet media={withTrailer} remaining={12} />);
    const panel = container.querySelector('[class*="panel"]') as HTMLElement;
    const row = screen.getByTestId('verdict-row');
    // The row lives in the chrome, not the panel -- it never translates.
    expect(panel.contains(row)).toBe(false);
    // The handle IS inside the panel -- it rides up with the sheet.
    expect(panel.contains(handle())).toBe(true);
  });
});

describe('DeckSheet media box', () => {
  it('without the autoplay setting the video is passive: no autoplay, bar up, sound ready', () => {
    vi.useFakeTimers();
    const { container } = render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.src).toContain('youtube-nocookie.com/embed/pv-abc');
    // No autoplay, but unmuted -- a native play tap carries audio.
    expect(frame.src).toContain('autoplay=0');
    expect(frame.src).toContain('mute=0');
    expect(screen.queryByText('TAP FOR SOUND')).toBeNull();
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    // Untouched, it rotates on like any image tile.
    act(() => vi.advanceTimersByTime(7100));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('the autoplay setting buys exactly ONE automatic play per card', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    const { container } = render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    // First arrival: the automatic round.
    expect((document.querySelector('iframe') as HTMLIFrameElement).src).toContain('autoplay=1');
    // Video ends -> rotation resumes -> hero for 7s -> back to the PV...
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'onStateChange', info: 0 }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    expect(document.querySelector('iframe')).toBeNull();
    act(() => vi.advanceTimersByTime(7100));
    // ...which is now passive: no second autoplay, bar running.
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.src).toContain('autoplay=0');
    expect(frame.src).toContain('mute=0');
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
  });

  it('TAP FOR SOUND (blocked auto round) unmutes in place -- no reload', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    // Autoplay blocked -> muted fallback + chip.
    act(() => vi.advanceTimersByTime(2600));
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    const srcBefore = frame.src;
    const postSpy = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    fireEvent.click(screen.getByText('TAP FOR SOUND'));
    // Same embed src (a change would reload and restart the video);
    // the unmute rides the IFrame-API command channel instead.
    expect((document.querySelector('iframe') as HTMLIFrameElement).src).toBe(srcBefore);
    const sent = postSpy.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes('"unMute"'))).toBe(true);
    expect(sent.some((m) => m.includes('"setVolume"'))).toBe(true);
    expect(screen.queryByText('TAP FOR SOUND')).toBeNull();
  });

  it('starts unmuted when the account autoplay-with-sound pref is on', () => {
    withState({ soundPref: true });
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.src).toContain('mute=0');
    expect(screen.queryByText('TAP FOR SOUND')).toBeNull();
  });

  it('the automatic round parks the rotation until the video ends', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    act(() => vi.advanceTimersByTime(10_000));
    expect(document.querySelector('iframe')).not.toBeNull();
    expect(screen.getByLabelText('Trailer').getAttribute('data-active')).toBe('true');
  });

  it("resumes the cycle when the player reports the video ended (Steam behavior)", () => {
    vi.useFakeTimers();
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    // Rotation is parked on the PV; the ended event (state 0) via the
    // IFrame-API postMessage protocol advances and resumes it.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'onStateChange', info: 0 }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
    // ... and the 7s cycle is running again.
    act(() => vi.advanceTimersByTime(7100));
    expect(screen.getAllByLabelText('Screenshot')[0].getAttribute('data-active')).toBe('true');
  });

  it('the infoDelivery playerState shape also counts as ended', () => {
    vi.useFakeTimers();
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 0 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
  });

  it('ignores player states other than ended, and non-player messages', () => {
    vi.useFakeTimers();
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          // state 1 = playing: must NOT advance.
          data: JSON.stringify({ event: 'onStateChange', info: 1 }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          // playing, not ended
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'onStateChange', info: 0 }),
          origin: 'https://evil.example.com',
        }),
      );
    });
    expect(screen.getByLabelText('Trailer').getAttribute('data-active')).toBe('true');
  });

  it('falls back to muted + chip when unmuted autoplay never starts (blocked)', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    // soundPref ON: starts unmuted, no chip.
    expect((document.querySelector('iframe') as HTMLIFrameElement).src).toContain('mute=0');
    expect(screen.queryByText('TAP FOR SOUND')).toBeNull();
    // No playing state within the grace period -> muted fallback + chip.
    act(() => vi.advanceTimersByTime(2600));
    expect((document.querySelector('iframe') as HTMLIFrameElement).src).toContain('mute=1');
    expect(screen.getByText('TAP FOR SOUND')).toBeDefined();
  });

  it('stays unmuted when the player reports playing within the grace period', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    act(() => vi.advanceTimersByTime(2600));
    expect((document.querySelector('iframe') as HTMLIFrameElement).src).toContain('mute=0');
    expect(screen.queryByText('TAP FOR SOUND')).toBeNull();
  });

  it('the PV embed opts into the IFrame API for the ended signal', () => {
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.src).toContain('enablejsapi=1');
  });

  it('auto-advances image tiles every 7s, progress bar riding along', () => {
    vi.useFakeTimers();
    const { container } = render(<DeckSheet media={imagesOnly} remaining={12} />);
    openSheet();
    // The bar shows during NORMAL rotation, not just after a tap.
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    // hero -> still 1 after 7s. (act: the timer fires real setState.)
    act(() => vi.advanceTimersByTime(7100));
    expect(screen.getAllByLabelText('Screenshot')[0].getAttribute('data-active')).toBe('true');
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    // ... -> still 2 -> back to hero, never a PV (there is none).
    // (Separate advances: each tile's timer is scheduled by the effect
    // that runs after the previous one fires.)
    act(() => vi.advanceTimersByTime(7100));
    act(() => vi.advanceTimersByTime(7100));
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
  });

  it('a tap buys the image a full fresh 7s hold', () => {
    vi.useFakeTimers();
    render(<DeckSheet media={imagesOnly} remaining={12} />);
    openSheet();
    // 5s into the hero's hold, tap still 1: its clock starts at zero.
    act(() => vi.advanceTimersByTime(5000));
    fireEvent.click(screen.getAllByLabelText('Screenshot')[0]);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getAllByLabelText('Screenshot')[0].getAttribute('data-active')).toBe('true');
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getAllByLabelText('Screenshot')[1].getAttribute('data-active')).toBe('true');
  });

  it('a user-played passive video dismisses the bar, parks with audio, pauses hand back', () => {
    vi.useFakeTimers();
    const { container } = render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    // Passive video: bar counting.
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    // The user taps the native player -> playing state arrives.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    // Bar dismissed; rotation parked while it plays (audio rides the
    // unmuted passive embed).
    expect(container.querySelector('[class*="holdBar"]')).toBeNull();
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByLabelText('Trailer').getAttribute('data-active')).toBe('true');
    // Pausing hands the tile back to the rotation.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 2 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(7100));
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
  });

  it('renders a flat strip -- every tile visible, capped at 1 video + 10 images', () => {
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    // pv + hero + 5 stills = all 7 tiles in the strip, no stacking.
    expect(screen.getAllByLabelText('Screenshot')).toHaveLength(5);
    const capped = makeMedia({
      id: '105',
      anilistId: 105,
      title: 'Gallery Show',
      posterUrl: '/api/poster/0/105/0',
      trailer: { site: 'youtube', id: 'pv-cap' },
      screenshotUrls: Array.from({ length: 14 }, (_, i) => `/api/poster/0/105/${i + 1}`),
    });
    cleanup();
    withState();
    render(<DeckSheet media={capped} remaining={12} />);
    openSheet();
    // Hero counts as an image: 9 stills + hero = 10 images, + the PV.
    expect(screen.getAllByLabelText('Screenshot')).toHaveLength(9);
  });

  it('a player error swaps the embed for the watch-on-YouTube card, on the 7s clock', () => {
    vi.useFakeTimers();
    withState({ soundPref: true });
    const { container } = render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    // Auto round parked on the PV... then the player reports an error
    // (embedding disabled, deleted video, etc).
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'onError', info: 150 }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    // Embed gone, card up, direct link out, and the 7s bar is running
    // (an errored video is an ordinary rotation citizen).
    expect(document.querySelector('iframe')).toBeNull();
    const link = screen.getByText('Watch directly on YouTube') as HTMLAnchorElement;
    expect(link.href).toBe('https://www.youtube.com/watch?v=pv-x');
    expect(container.querySelector('[class*="holdBar"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(7100));
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
  });

  it('a double-reported ended (both message shapes) advances only once', () => {
    withState({ soundPref: true });
    render(<DeckSheet media={withStills} remaining={12} />);
    openSheet();
    // YouTube reports ended through onStateChange AND infoDelivery;
    // the first image after the video must not get skipped.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'onStateChange', info: 0 }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 0 } }),
          origin: 'https://www.youtube-nocookie.com',
        }),
      );
    });
    expect(screen.getByLabelText('Cover art').getAttribute('data-active')).toBe('true');
  });

  it('renders title, romaji, synopsis, and links in the panel', () => {
    render(<DeckSheet media={withTrailer} remaining={12} />);
    openSheet();
    expect(screen.getByText('Iron Bloom')).toBeDefined();
    expect(screen.getByText('Tetsu no Hana')).toBeDefined();
    expect(screen.getByText('A long synopsis.')).toBeDefined();
    expect(screen.getByTestId('anime-links')).toBeDefined();
  });
});
