// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canShareFiles,
  downloadImage,
  imageDataUrl,
  pngSize,
  shareImage,
} from '../../web/app/src/utils/shareFile';

const blob = new Blob(['png'], { type: 'image/png' });
let clicked: HTMLAnchorElement[];

const stubNavigator = (share?: (data: ShareData) => Promise<void>) =>
  vi.stubGlobal(
    'navigator',
    share ? { canShare: (d: ShareData) => !!d.files?.length, share: vi.fn(share) } : {},
  );

// A PNG header: signature, IHDR length and type, then width and height.
const pngOf = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
};

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

describe('shareImage', () => {
  it('hands the PNG to the share sheet', async () => {
    stubNavigator(async () => {});
    expect(await shareImage(blob, 'card.png', 'cour standings')).toBe('shared');
    const data = (navigator.share as ReturnType<typeof vi.fn>).mock.calls[0][0] as ShareData;
    expect(data.title).toBe('cour standings');
    expect(data.files?.[0].name).toBe('card.png');
    expect(data.files?.[0].type).toBe('image/png');
    expect(clicked).toHaveLength(0);
  });

  it('reports a cancelled share sheet as a cancel, not an error', async () => {
    stubNavigator(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(await shareImage(blob, 'card.png', 'title')).toBe('cancelled');
  });

  it('throws when the share is refused, and never downloads by itself', async () => {
    stubNavigator(async () => {
      throw new DOMException('no user activation', 'NotAllowedError');
    });
    await expect(shareImage(blob, 'card.png', 'title')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(clicked).toHaveLength(0);
  });
});

describe('downloadImage', () => {
  it('starts a download through a detached link and frees the URL later', () => {
    vi.useFakeTimers();
    downloadImage(blob, 'card.png');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('card.png');
    expect(clicked[0].getAttribute('href')).toBe('blob:card');
    expect(clicked[0].isConnected).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:card');
  });
});

describe('imageDataUrl', () => {
  it('reads the image as a data: URL', async () => {
    expect(await imageDataUrl(blob)).toBe(`data:image/png;base64,${btoa('png')}`);
  });
});

describe('pngSize', () => {
  it('reads the size from the PNG header', async () => {
    expect(await pngSize(pngOf(1080, 1321))).toEqual({ width: 1080, height: 1321 });
    expect(await pngSize(pngOf(1080, 889))).toEqual({ width: 1080, height: 889 });
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

  it('is false when the probe throws', () => {
    vi.stubGlobal('navigator', {
      canShare: () => {
        throw new TypeError('bad');
      },
    });
    expect(canShareFiles()).toBe(false);
  });
});
