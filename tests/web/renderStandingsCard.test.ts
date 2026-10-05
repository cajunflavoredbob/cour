// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStandingsCard } from '../../web/app/src/utils/renderStandingsCard';
import type { StandingsCardData } from '../../web/app/src/utils/standingsCard';

// jsdom has no canvas: a 2D context that records the text drawn and measures
// 10px per character. jsdom never loads images, so posters never settle.
const fakeContext = (canvas: HTMLCanvasElement) => {
  const noop = () => {};
  return {
    canvas,
    drawn: [] as string[],
    font: '',
    letterSpacing: '0px',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    globalAlpha: 1,
    imageSmoothingQuality: 'low',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillText(text: string) {
      this.drawn.push(text);
    },
    beginPath: noop,
    moveTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    rect: noop,
    clip: noop,
    save: noop,
    restore: noop,
    fillRect: noop,
    strokeRect: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
  };
};

let contexts: ReturnType<typeof fakeContext>[];

const standing = (titleId: number, rank: number) => ({
  titleId,
  rank,
  title: `Show ${titleId}`,
  points: 30 - rank * 3,
  rankedBy: 2,
  rankedByNames: ['user1', 'user2'],
  poster: `/api/poster/${titleId}`,
});

const card = (overrides: Partial<StandingsCardData> = {}): StandingsCardData => ({
  season: 'FALL',
  year: 2026,
  roomName: 'Couch-Coop',
  submittedCount: 2,
  memberCount: 2,
  standings: [101, 102, 103, 104, 105].map((id, i) => standing(id, i + 1)),
  topPicks: [{ titleId: 101, userName: 'user1', title: 'Show 101' }],
  ...overrides,
});

// Renders past the asset deadline and returns what the card drew.
const drawnText = async (d: StandingsCardData) => {
  const done = renderStandingsCard(d);
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  return contexts[0].drawn;
};

beforeEach(() => {
  contexts = [];
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const ctx = fakeContext(this);
    contexts.push(ctx);
    return ctx;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
    callback(new Blob(['png'], { type: 'image/png' }));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('renderStandingsCard', () => {
  it('draws without posters that never load, once the deadline passes', async () => {
    let finished = false;
    const done = renderStandingsCard(card()).then((rendered) => {
      finished = true;
      return rendered;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { blob, complete } = await done;
    expect(blob.type).toBe('image/png');
    expect(complete).toBe(false);
    expect(contexts[0].drawn).toEqual(expect.arrayContaining(['NO. 1', 'Show 101', 'ALL 2 RANKINGS IN · FINAL']));
  });

  it('is complete when every font and poster made it', async () => {
    const noPosters = card().standings.map((s) => ({ ...s, poster: undefined }));
    expect((await renderStandingsCard(card({ standings: noPosters }))).complete).toBe(true);
  });

  it('labels the strip with the scoring positions', async () => {
    expect(await drawnText(card())).toContain('THE REST OF THE TOP 5');
  });

  it("keeps the #1 on a runner's tag for a long name", async () => {
    const drawn = await drawnText(card({ topPicks: [{ titleId: 102, userName: 'elevenchars', title: 'Show 102' }] }));
    const tag = drawn.find((text) => text.startsWith('ELEVEN')) ?? '';
    expect(tag).toMatch(/^ELEVEN.*'S #1$/);
    // Fits the 200px runner poster less its inset and the pill's padding.
    expect(tag.length * 10).toBeLessThanOrEqual(200 - 20 - 24);
  });

  it('accounts for every pick that missed the card', async () => {
    const long = 'A Title Long Enough To Fill Most Of One Line Of The Card';
    const drawn = await drawnText(
      card({ topPicks: [106, 107, 108, 109, 110].map((titleId, i) => ({ titleId, userName: `user${i + 1}`, title: long })) }),
    );
    const rows = drawn.filter((text) => text.includes("'S #1 · "));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^USER1'S #1 · /);
    expect(rows[1]).toMatch(/^USER2'S #1 · .*\+3 MORE$/);
  });

  it('waits for the other fonts when one fails to load', async () => {
    let release = () => {};
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => (++loads === 1 ? Promise.reject(new Error('404')) : late), ready: Promise.resolve() },
    });
    try {
      let finished = false;
      const noPosters = card().standings.map((s) => ({ ...s, poster: undefined }));
      const done = renderStandingsCard(card({ standings: noPosters })).then((rendered) => {
        finished = true;
        return rendered;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(finished).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect((await done).complete).toBe(false);
      expect(finished).toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('draws in fallback fonts if the card fonts never load, and says it did', async () => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => new Promise(() => {}), ready: new Promise(() => {}) },
    });
    try {
      expect(await drawnText(card())).toContain('NO. 1');
      const noPosters = card().standings.map((s) => ({ ...s, poster: undefined }));
      const done = renderStandingsCard(card({ standings: noPosters }));
      await vi.advanceTimersByTimeAsync(3000);
      expect((await done).complete).toBe(false);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });
});
