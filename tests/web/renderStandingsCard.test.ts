// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_USUAL_HEIGHT, renderStandingsCard } from '../../web/app/src/utils/renderStandingsCard';
import type { StandingsCardData } from '../../web/app/src/utils/standingsCard';

// jsdom has no canvas: a 2D context that records the text drawn and measures
// 10px per character. jsdom never loads images, so posters never settle.
const fakeContext = (canvas: HTMLCanvasElement) => {
  const noop = () => {};
  return {
    canvas,
    drawn: [] as string[],
    // Where each text went, and each rectangle filled.
    at: [] as Array<[string, number, number]>,
    rects: [] as Array<[number, number, number, number]>,
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
    fillText(text: string, x: number, y: number) {
      this.drawn.push(text);
      this.at.push([text, x, y]);
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
    fillRect(x: number, y: number, w: number, h: number) {
      this.rects.push([x, y, w, h]);
    },
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
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
    });
    // Each poster loads as soon as it is asked for.
    const loads = vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement) {
      Promise.resolve().then(() => this.onload?.(new Event('load')));
    });
    try {
      expect((await renderStandingsCard(card())).complete).toBe(true);
      expect(loads).toHaveBeenCalledTimes(5);
    } finally {
      loads.mockRestore();
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('takes the usual height, the placeholder\'s, for a full card with a runner title on two lines', async () => {
    const standings = card().standings.map((s) => (s.rank === 2 ? { ...s, title: 'A Runner Title On Two Lines' } : s));
    await drawnText(card({ standings }));
    expect(contexts[0].canvas.height).toBe(CARD_USUAL_HEIGHT);
  });

  it('draws a shared #1 side by side, each show with its own title and points', async () => {
    const tied = card({
      standings: [{ ...standing(101, 1), points: 21 }, { ...standing(102, 1), points: 21 }, standing(103, 3), standing(104, 4)],
    });
    const drawn = await drawnText(tied);
    expect(drawn).toContain('TIED FOR NO. 1');
    expect(drawn).not.toContain('NO. 1');
    expect(drawn.filter((t) => t === '21')).toHaveLength(2);
    expect(drawn).toEqual(expect.arrayContaining(['3', '4']));
    // Each tied show once, at the top, and not again in the strip.
    expect(drawn.filter((t) => t === 'Show 101')).toHaveLength(1);
    expect(drawn.filter((t) => t === 'Show 102')).toHaveLength(1);
  });

  it('names a three-way tie, and wraps a wider one to a second row', async () => {
    const three = card({ standings: [101, 102, 103, 104, 105].map((id, i) => standing(id, i < 3 ? 1 : i + 1)) });
    const drawn3 = await drawnText(three);
    expect(drawn3).toContain('3-WAY TIE FOR NO. 1');
    // The rest of the top five still gets its row.
    expect(drawn3).toEqual(expect.arrayContaining(['Show 104', 'Show 105', '4', '5']));
    contexts = [];
    const four = card({ standings: [101, 102, 103, 104].map((id) => standing(id, 1)) });
    const drawn4 = await drawnText(four);
    expect(drawn4).toContain('4-WAY TIE FOR NO. 1');
    expect(drawn4).toEqual(expect.arrayContaining(['Show 101', 'Show 102', 'Show 103', 'Show 104']));
  });

  it('counts every show sharing first place, more than the card holds', async () => {
    const drawn = await drawnText(card({ standings: [101, 102, 103, 104, 105, 106].map((id) => standing(id, 1)), firstPlaceCount: 7 }));
    expect(drawn).toContain('7-WAY TIE FOR NO. 1');
  });

  it('wraps a strip of more than four shows onto another row of the same size', async () => {
    const six = card({ standings: [standing(101, 1), ...[102, 103, 104, 105, 106, 107].map((id) => standing(id, 2))] });
    await drawnText(six);
    const numerals = contexts[0].at.filter(([t]) => t === '2');
    expect(numerals).toHaveLength(6);
    const [first, , , , fifth, sixth] = numerals;
    // The fifth starts the next row where the first started its own, a
    // whole poster and its caption lower.
    expect(fifth[1]).toBe(first[1]);
    expect(fifth[2] - first[2]).toBeGreaterThanOrEqual(300 + 44);
    expect(sixth[1] - fifth[1]).toBe(numerals[1][1] - first[1]);
    // The footer clears the second row.
    const lastPoints = Math.max(...contexts[0].at.filter(([t]) => t.endsWith(' PTS')).map(([, , y]) => y));
    const footer = contexts[0].at.find(([t]) => t.includes('RANKINGS IN'));
    expect(footer?.[2]).toBeGreaterThan(lastPoints);
  });

  it('notes the shows within the top five it has no room for', async () => {
    const drawn = await drawnText(card({ hiddenCount: 1 }));
    expect(drawn).toContain('+1 MORE IN THE TOP 5');
    contexts = [];
    expect(await drawnText(card())).not.toContain('+1 MORE IN THE TOP 5');
  });

  it('fills the backdrop of a shared #1 to a whole pixel', async () => {
    const tied = card({
      standings: [{ ...standing(101, 1), title: 'A title long enough to wrap onto lines' }, standing(102, 1), standing(103, 3)],
    });
    await drawnText(tied);
    // The backdrop's fills: full width from the top, shorter than the card.
    const height = contexts[0].canvas.height;
    const backdrop = contexts[0].rects.filter(([x, y, w, h]) => x === 0 && y === 0 && w === 1080 && h < height);
    expect(backdrop.length).toBeGreaterThanOrEqual(2);
    for (const [, , , h] of backdrop) expect(Number.isInteger(h)).toBe(true);
  });

  it('numbers a shared place lower down on each show', async () => {
    const drawn = await drawnText(card({ standings: [standing(101, 1), standing(102, 2), standing(103, 2), standing(104, 4)] }));
    expect(drawn.filter((t) => t === '2')).toHaveLength(2);
    expect(drawn).toContain('NO. 1');
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
