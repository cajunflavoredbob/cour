// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canShareFiles, shareOrDownload } from '../../web/app/src/utils/shareFile';

const blob = new Blob(['png'], { type: 'image/png' });
let clicked: HTMLAnchorElement[];

const stubNavigator = (share?: (data: ShareData) => Promise<void>) =>
  vi.stubGlobal(
    'navigator',
    share ? { canShare: (d: ShareData) => !!d.files?.length, share: vi.fn(share) } : {},
  );

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  URL.createObjectURL = vi.fn(() => 'blob:card');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shareOrDownload', () => {
  it('saves a download where the browser cannot share files', async () => {
    vi.useFakeTimers();
    stubNavigator();
    expect(await shareOrDownload(blob, 'card.png', 'title')).toBe('downloaded');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('card.png');
    expect(clicked[0].getAttribute('href')).toBe('blob:card');
    expect(clicked[0].isConnected).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card');
  });

  it('hands the PNG to the share sheet where it can', async () => {
    stubNavigator(async () => {});
    expect(await shareOrDownload(blob, 'card.png', 'cour standings')).toBe('shared');
    const data = (navigator.share as ReturnType<typeof vi.fn>).mock.calls[0][0] as ShareData;
    expect(data.title).toBe('cour standings');
    expect(data.files?.[0].name).toBe('card.png');
    expect(data.files?.[0].type).toBe('image/png');
    expect(clicked).toHaveLength(0);
  });

  it('stops when the user cancels the share sheet', async () => {
    stubNavigator(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(await shareOrDownload(blob, 'card.png', 'title')).toBe('cancelled');
    expect(clicked).toHaveLength(0);
  });

  it('falls back to a download when the share is refused, and logs why', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNavigator(async () => {
      throw new DOMException('no user activation', 'NotAllowedError');
    });
    expect(await shareOrDownload(blob, 'card.png', 'title')).toBe('downloaded');
    expect(clicked).toHaveLength(1);
    expect(warned).toHaveBeenCalledWith('Share refused; saving the image instead', expect.any(DOMException));
  });
});

describe('canShareFiles', () => {
  it('is false without the share API', () => {
    stubNavigator();
    expect(canShareFiles()).toBe(false);
  });

  it('is true when the browser accepts image files', () => {
    stubNavigator(async () => {});
    expect(canShareFiles()).toBe(true);
  });

  it('is false when the check itself throws', () => {
    vi.stubGlobal('navigator', {
      canShare: () => {
        throw new TypeError('bad data');
      },
    });
    expect(canShareFiles()).toBe(false);
  });
});
