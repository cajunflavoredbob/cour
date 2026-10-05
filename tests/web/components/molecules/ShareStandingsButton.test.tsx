// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StandingsCardData } from '../../../../web/app/src/utils/standingsCard';

let dispatch: ReturnType<typeof vi.fn>;
const { renderMock, shareMock, canShareMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  shareMock: vi.fn(),
  canShareMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: vi.fn(),
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));
vi.mock('../../../../web/app/src/utils/renderStandingsCard', () => ({
  renderStandingsCard: renderMock,
}));
vi.mock('../../../../web/app/src/utils/shareFile', () => ({
  canShareFiles: canShareMock,
  shareOrDownload: shareMock,
}));

import { ShareStandingsButton } from '../../../../web/app/src/components/molecules/ShareStandingsButton';

const card: StandingsCardData = {
  season: 'FALL',
  year: 2026,
  roomName: 'Couch-Coop',
  submittedCount: 2,
  memberCount: 2,
  standings: [{ titleId: 101, rank: 1, title: 'Iron Bloom', points: 21, rankedBy: 2, rankedByNames: ['user1', 'user2'] }],
  topPicks: [{ titleId: 101, userName: 'user1', title: 'Iron Bloom' }],
};
const blob = new Blob(['png'], { type: 'image/png' });
const button = () => screen.getByRole('button');
const pending = <T,>() => {
  let settle: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    settle = r;
  });
  return { promise, settle };
};

beforeEach(() => {
  dispatch = vi.fn();
  renderMock.mockReset().mockResolvedValue(blob);
  shareMock.mockReset().mockResolvedValue('downloaded');
  canShareMock.mockReset().mockReturnValue(false);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ShareStandingsButton', () => {
  it('offers SAVE IMAGE where the browser cannot share files', () => {
    render(<ShareStandingsButton card={card} />);
    expect(button().textContent).toBe('SAVE IMAGE');
  });

  it('offers SHARE IMAGE where it can', () => {
    canShareMock.mockReturnValue(true);
    render(<ShareStandingsButton card={card} />);
    expect(button().textContent).toBe('SHARE IMAGE');
  });

  it('renders the card ahead of the tap and shares that render', async () => {
    render(<ShareStandingsButton card={card} />);
    expect(renderMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledWith(blob, 'cour-fall-2026-couch-coop.png', 'cour fall 2026 standings');
  });

  it('renders on the tap when it comes before the background render', async () => {
    render(<ShareStandingsButton card={card} />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it('reads MAKING IMAGE… while the card renders', async () => {
    const render$ = pending<Blob>();
    renderMock.mockReturnValue(render$.promise);
    render(<ShareStandingsButton card={card} />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe('MAKING IMAGE…');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      render$.settle(blob);
    });
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it('reads SHARING… while the share sheet is open, then re-arms', async () => {
    canShareMock.mockReturnValue(true);
    const share$ = pending<string>();
    shareMock.mockReturnValue(share$.promise);
    render(<ShareStandingsButton card={card} />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe('SHARING…');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      share$.settle('shared');
    });
    expect(button().textContent).toBe('SHARE IMAGE');
    expect(button().getAttribute('aria-disabled')).toBe('false');
  });

  it('ignores taps while busy and stays focusable', async () => {
    const share$ = pending<string>();
    shareMock.mockReturnValue(share$.promise);
    render(<ShareStandingsButton card={card} />);
    button().focus();
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      fireEvent.click(button());
    });
    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(button().hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button());
    await act(async () => {
      share$.settle('downloaded');
    });
  });

  it('says so when the image cannot be made, logs why, and tries afresh next time', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMock.mockRejectedValue(new Error('no canvas'));
    render(<ShareStandingsButton card={card} />);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(warned).toHaveBeenCalledWith('Standings card render failed', expect.any(Error));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(shareMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith('Standings card share failed', expect.any(Error));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'addToast',
        payload: expect.objectContaining({ appearance: 'Failure', message: "Couldn't make the image. Please try again." }),
      }),
    );
    expect(button().getAttribute('aria-disabled')).toBe('false');
    renderMock.mockResolvedValue(blob);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(shareMock).toHaveBeenCalledWith(blob, 'cour-fall-2026-couch-coop.png', 'cour fall 2026 standings');
  });
});
