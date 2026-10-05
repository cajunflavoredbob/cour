// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CardImageState } from '../../../../web/app/src/hooks/useStandingsCardImage';
import type { StandingsCardData } from '../../../../web/app/src/utils/standingsCard';

const { shareMock, downloadMock, canShareMock } = vi.hoisted(() => ({
  shareMock: vi.fn(),
  downloadMock: vi.fn(),
  canShareMock: vi.fn(),
}));
vi.mock('../../../../web/app/src/utils/shareFile', () => ({
  canShareFiles: canShareMock,
  shareImage: shareMock,
  downloadImage: downloadMock,
}));

import { SharePreview } from '../../../../web/app/src/components/organisms/SharePreview';

const card = (over: Partial<StandingsCardData> = {}): StandingsCardData => ({
  season: 'FALL',
  year: 2026,
  roomName: 'Couch-Coop',
  submittedCount: 2,
  memberCount: 2,
  standings: [{ titleId: 101, rank: 1, title: 'Iron Bloom', points: 21, rankedBy: 2, rankedByNames: ['user1', 'user2'] }],
  topPicks: [{ titleId: 101, userName: 'user1', title: 'Iron Bloom' }],
  ...over,
});
const blob = new Blob(['png'], { type: 'image/png' });
const ready = (over: Partial<CardImageState> = {}): CardImageState => ({
  image: { blob, url: 'data:image/png;base64,AAAA', width: 1080, height: 889, complete: true },
  making: false,
  failed: false,
  retry: vi.fn(),
  refresh: vi.fn(),
  ...over,
});
// A newer image, as after a push changed the standings.
const newer = () =>
  ready({
    image: {
      blob: new Blob(['png2'], { type: 'image/png' }),
      url: 'data:image/png;base64,BBBB',
      width: 1080,
      height: 1321,
      complete: true,
    },
  });

// A mouse (fine pointer) or a touch screen.
let finePointer = false;
const stubPointer = () =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('pointer: fine') ? finePointer : false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));

let onClose: Mock<() => void>;
const preview = (state = ready(), c = card(), allPicks = false, waitingOn: string[] = []) => (
  <SharePreview card={c} image={state} allPicks={allPicks} waitingOn={waitingOn} onClose={onClose} />
);
const show = (state = ready(), c = card(), allPicks = false, waitingOn: string[] = []) =>
  render(preview(state, c, allPicks, waitingOn));
const primary = () => document.querySelector('[data-test-handle="share-primary"]') as HTMLButtonElement;
const caption = () => screen.getByRole('status').textContent;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  finePointer = false;
  stubPointer();
  canShareMock.mockReset().mockReturnValue(true);
  shareMock.mockReset().mockResolvedValue('shared');
  downloadMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SharePreview', () => {
  it('is a plain dialog showing the exact image, described in words', () => {
    show();
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Share the standings');
    expect(screen.getByText('share the standings.')).toBeDefined();
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.getAttribute('width')).toBe('1080');
    expect(img.getAttribute('height')).toBe('889');
    expect(img.alt).toContain('Standings card for Couch-Coop, fall 2026.');
  });

  it("repeats the card's status, and says which standings once the refine round is open", () => {
    show(ready(), card(), true);
    expect(screen.getByText('ALL PICKS · ALL 2 RANKINGS IN · FINAL')).toBeDefined();
    expect(screen.queryByText(/standings so far/)).toBeNull();
  });

  it('warns that live standings are a snapshot, naming who is still out', () => {
    show(ready(), card({ submittedCount: 1 }), false, ['user2']);
    expect(screen.getByText('1 OF 2 RANKINGS IN · SO FAR')).toBeDefined();
    expect(screen.getByText("user2 hasn't ranked yet. Once it's sent, the image won't change.")).toBeDefined();
  });

  it('names everyone still out, or says so plainly when nobody is named', () => {
    const live = card({ submittedCount: 1, memberCount: 3 });
    const { unmount } = show(ready(), live, false, ['user2', 'user3']);
    expect(screen.getByText("user2 and user3 haven't ranked yet. Once it's sent, the image won't change.")).toBeDefined();
    unmount();
    show(ready(), live);
    expect(screen.getByText("Not every ranking is in yet. Once it's sent, the image won't change.")).toBeDefined();
  });

  it('shares from a touch screen that can share, and closes once shared', async () => {
    show();
    expect(primary().textContent).toBe('Share');
    expect(caption()).toBe('OR PRESS AND HOLD THE IMAGE');
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(shareMock).toHaveBeenCalledWith(blob, 'cour-fall-2026-couch-coop.png', 'cour fall 2026 standings');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('stays open when the share sheet is cancelled', async () => {
    shareMock.mockResolvedValue('cancelled');
    show();
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(primary().textContent).toBe('Share');
    expect(primary().getAttribute('aria-disabled')).toBe('false');
  });

  it('offers a download instead when the share is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    shareMock.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    show();
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(caption()).toBe("SHARING DIDN'T WORK · SAVE IT INSTEAD");
    expect(primary().textContent).toBe('Save image');
    fireEvent.click(primary());
    expect(downloadMock).toHaveBeenCalledWith(blob, 'cour-fall-2026-couch-coop.png');
  });

  it('saves with a mouse, and points to the downloads without claiming the file arrived', () => {
    finePointer = true;
    show();
    expect(primary().textContent).toBe('Save image');
    expect(caption()).toBe('OR RIGHT-CLICK THE IMAGE TO COPY IT');
    fireEvent.click(primary());
    expect(downloadMock).toHaveBeenCalledWith(blob, 'cour-fall-2026-couch-coop.png');
    expect(caption()).toBe('CHECK YOUR DOWNLOADS');
    expect(shareMock).not.toHaveBeenCalled();
  });

  it('saves on a touch screen that cannot share files', () => {
    canShareMock.mockReturnValue(false);
    show();
    expect(primary().textContent).toBe('Save image');
    expect(caption()).toBe('OR PRESS AND HOLD THE IMAGE');
  });

  it('holds the action while the image is made', () => {
    show(ready({ image: null, making: true }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('img[data-state="making"]')).not.toBeNull();
    expect(primary().getAttribute('aria-disabled')).toBe('true');
    expect(caption()).toBe('MAKING THE IMAGE…');
    fireEvent.click(primary());
    expect(shareMock).not.toHaveBeenCalled();
  });

  it('keeps the old image up while a newer one is made, without sending it', () => {
    show(ready({ making: true }));
    expect(screen.getByRole('img')).toBeDefined();
    expect(caption()).toBe('UPDATING THE IMAGE…');
    fireEvent.click(primary());
    expect(shareMock).not.toHaveBeenCalled();
  });

  it('says so when the image could not be made, and tries again', () => {
    const state = ready({ image: null, failed: true });
    show(state);
    expect(caption()).toBe("COULDN'T MAKE THE IMAGE");
    expect(document.querySelector('img[data-state="failed"]')).not.toBeNull();
    expect(primary().textContent).toBe('Try again');
    fireEvent.click(primary());
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it('keeps offering the download once a share was refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    shareMock.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    show();
    await act(async () => {
      fireEvent.click(primary());
    });
    fireEvent.click(primary());
    expect(primary().textContent).toBe('Save image');
    fireEvent.click(primary());
    expect(downloadMock).toHaveBeenCalledTimes(2);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it('takes one share at a time while the share sheet is open', async () => {
    shareMock.mockReturnValue(new Promise(() => {}));
    show();
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(primary().getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it('does not claim a newer image was downloaded', () => {
    finePointer = true;
    const view = show();
    fireEvent.click(primary());
    expect(caption()).toBe('CHECK YOUR DOWNLOADS');
    view.rerender(preview(ready({ making: true })));
    expect(caption()).toBe('UPDATING THE IMAGE…');
    view.rerender(preview(newer()));
    expect(caption()).toBe('OR RIGHT-CLICK THE IMAGE TO COPY IT');
    expect(primary().textContent).toBe('Save image');
  });

  it('ties the refusal caption to its image, and still saves the newer one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    shareMock.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const view = show();
    await act(async () => {
      fireEvent.click(primary());
    });
    view.rerender(preview(newer()));
    expect(caption()).toBe('OR PRESS AND HOLD THE IMAGE');
    expect(primary().textContent).toBe('Save image');
  });

  it('closes with Close or Escape', () => {
    show();
    fireEvent.click(screen.getByText('Close'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
