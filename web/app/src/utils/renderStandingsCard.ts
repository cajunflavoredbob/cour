import { type CourSeason, SEASON_THEMES } from "./season";
import {
  CARD_STANDINGS,
  fitText,
  offCardPicks,
  pickLines,
  pickNames,
  pickTag,
  type StandingsCardData,
  statusLine,
  wrapText,
} from "./standingsCard";
import { rankedByText } from "./standingsText";

/** The card's width; its height follows what it holds. */
export const CARD_WIDTH = 1080;
/** A full card's usual height, a runner title on two lines: the shape a placeholder takes. */
export const CARD_USUAL_HEIGHT = 1321;
const PAD = 80;
const FRAME_INSET = 36;
const HERO_W = 330;
const HERO_H = 495;
// Widest runner poster; the strip narrows them if more have to fit.
const RUNNER_W = 200;
const RUNNER_GAP = 40;
// How long the render waits on fonts and posters before drawing without them.
const ASSET_TIMEOUT_MS = 3000;

interface Theme {
  bg0: string;
  bg2: string;
  text0: string;
  text1: string;
  text2: string;
  text3: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentBright: string;
  accentSoft: string;
  display: string;
  ui: string;
  mono: string;
  kanji: string;
}

interface Ink {
  font: string;
  color: string;
  spacing?: string;
  align?: CanvasTextAlign;
}

const readTheme = (season: CourSeason): Theme => {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const { kanji, accent, accentBright, accentSoft } = SEASON_THEMES[season];
  return {
    bg0: token("--cour-bg-0"),
    bg2: token("--cour-bg-2"),
    text0: token("--cour-text-0"),
    text1: token("--cour-text-1"),
    text2: token("--cour-text-2"),
    text3: token("--cour-text-3"),
    line: token("--cour-line"),
    lineStrong: token("--cour-line-strong"),
    accent,
    accentBright,
    accentSoft,
    display: token("--cour-font-display"),
    ui: token("--cour-font-ui"),
    mono: token("--cour-font-mono"),
    kanji,
  };
};

const loadImage = (src: string | undefined): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

// `promise`'s value, or `fallback` if it rejects or has not settled within `ms`.
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

// Draws `img` cropped to cover the box, the way object-fit: cover does.
const drawCover = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
) => {
  const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
};

// A heavily softened copy of the poster: shrunk to a few pixels, then scaled
// back up.
const softened = (img: HTMLImageElement): HTMLCanvasElement => {
  const small = document.createElement("canvas");
  small.width = 24;
  small.height = 36;
  const ctx = small.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    drawCover(ctx, img, 0, 0, small.width, small.height);
  }
  return small;
};

/** Draws the card top to bottom and returns its height; with `paint` off it only measures. */
const drawCard = (
  ctx: CanvasRenderingContext2D,
  d: StandingsCardData,
  t: Theme,
  images: Map<string, HTMLImageElement | null>,
  paint: boolean,
): number => {
  const font = {
    display: (px: number, weight = 600) => `${weight} ${px}px ${t.display}`,
    title: (px: number) => `600 ${px}px ${t.ui}`,
    mono: (px: number) => `500 ${px}px ${t.mono}`,
  };
  const measure = (f: string, spacing = "0px") => (value: string) => {
    ctx.font = f;
    ctx.letterSpacing = spacing;
    const width = ctx.measureText(value).width;
    ctx.letterSpacing = "0px";
    return width;
  };
  const text = (value: string, x: number, y: number, ink: Ink) => {
    if (!paint) return;
    ctx.font = ink.font;
    ctx.letterSpacing = ink.spacing ?? "0px";
    ctx.fillStyle = ink.color;
    ctx.textAlign = ink.align ?? "left";
    ctx.fillText(value, x, y);
    ctx.letterSpacing = "0px";
    ctx.textAlign = "left";
  };
  const imageOf = (src: string | undefined) => (src ? (images.get(src) ?? null) : null);
  const poster = (src: string | undefined, x: number, y: number, w: number, h: number, r: number) => {
    if (!paint) return;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 18;
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = t.bg2;
    ctx.fill();
    ctx.restore();
    const img = imageOf(src);
    if (!img) return;
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    drawCover(ctx, img, x, y, w, h);
    ctx.restore();
  };
  // A solid accent pill holding a label already fitted by pickTag.
  const tagFont = font.mono(17);
  const tagMeasure = measure(tagFont, "0.08em");
  const tag = (label: string, x: number, y: number) => {
    if (!paint) return;
    roundRect(ctx, x, y, tagMeasure(label) + 24, 32, 16);
    ctx.fillStyle = t.accent;
    ctx.fill();
    text(label, x + 12, y + 22, { font: tagFont, color: t.bg0, spacing: "0.08em" });
  };

  const [hero, ...rest] = d.standings;

  // Header layout; painted after the backdrop.
  const top = PAD + 4;
  const wordW = measure(font.display(40))("cour");
  const kanjiW = measure(font.display(22))(t.kanji);
  const chipX = PAD + wordW + 14;
  const chipW = kanjiW + 20;
  const roomX = chipX + chipW + 18;
  const seasonLabel = `${d.season} ${d.year}`;
  const seasonW = measure(font.mono(20), "0.18em")(seasonLabel);
  const room = fitText(measure(font.mono(20), "0.14em"), `· ${d.roomName.toUpperCase()}`, CARD_WIDTH - PAD - seasonW - 32 - roomX);

  // #1: the cover.
  const heroTop = top + 92;
  const textX = PAD + HERO_W + 52;
  const textW = CARD_WIDTH - PAD - textX;
  let heroBottom = heroTop + HERO_H;
  if (hero) {
    const titleLines = wrapText(measure(font.display(60)), hero.title, textW, 3);
    const ranked = wrapText(measure(font.mono(20), "0.08em"), rankedByText(hero.rankedByNames, hero.rankedBy), textW, 2);
    const heroTag = pickTag(tagMeasure, pickNames(d, hero.titleId), textW - 24);
    // Baselines, measured down from the top of the text block.
    const titleBase = (i: number) => 92 + i * 70;
    const pointsBase = titleBase(titleLines.length - 1) + 112;
    const rankedBase = (i: number) => pointsBase + 46 + i * 30;
    const tagTop = (ranked.length ? rankedBase(ranked.length - 1) : pointsBase) + 26;
    const textH = heroTag ? tagTop + 32 : ranked.length ? rankedBase(ranked.length - 1) + 8 : pointsBase + 8;
    const textTop = heroTop + Math.max(0, (HERO_H - textH) / 2);
    heroBottom = Math.max(heroBottom, textTop + textH);

    const heroImg = imageOf(hero.poster);
    if (paint) {
      // Backdrop: the #1 poster, softened, tinted, fading into the card.
      const backH = heroBottom + 90;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, CARD_WIDTH, backH);
      ctx.clip();
      if (heroImg) {
        ctx.imageSmoothingQuality = "high";
        ctx.globalAlpha = 0.5;
        drawCover(ctx, softened(heroImg), -60, -60, CARD_WIDTH + 120, backH + 120);
      }
      ctx.restore();
      ctx.fillStyle = t.accentSoft;
      ctx.fillRect(0, 0, CARD_WIDTH, backH);
      const fade = ctx.createLinearGradient(0, 0, 0, backH);
      fade.addColorStop(0, "rgba(0, 0, 0, 0.42)");
      fade.addColorStop(0.6, "rgba(0, 0, 0, 0.55)");
      fade.addColorStop(1, t.bg0);
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, CARD_WIDTH, backH);
    }

    poster(hero.poster, PAD, heroTop, HERO_W, HERO_H, 18);
    text("NO. 1", textX, textTop + 22, { font: font.mono(22), color: t.accentBright, spacing: "0.24em" });
    titleLines.forEach((line, i) => {
      text(line, textX, textTop + titleBase(i), { font: font.display(60), color: t.text0 });
    });
    const pts = String(hero.points);
    text(pts, textX, textTop + pointsBase, { font: font.display(96), color: t.accentBright });
    text("PTS", textX + measure(font.display(96))(pts) + 14, textTop + pointsBase, {
      font: font.mono(24),
      color: t.text1,
      spacing: "0.14em",
    });
    ranked.forEach((line, i) => {
      text(line, textX, textTop + rankedBase(i), { font: font.mono(20), color: t.text2, spacing: "0.08em" });
    });
    if (heroTag) tag(heroTag, textX, textTop + tagTop);
  }

  if (paint) {
    // The season's kanji, printed faintly in the lower corner behind the strip.
    ctx.save();
    ctx.globalAlpha = 0.05;
    text(t.kanji, CARD_WIDTH + 30, ctx.canvas.height - 40, { font: font.display(420), color: t.accentBright, align: "right" });
    ctx.restore();
    // Header, over the backdrop.
    roundRect(ctx, chipX, PAD + 6, chipW, 38, 9);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  text("cour", PAD, PAD + 36, { font: font.display(40), color: t.text0 });
  text(t.kanji, chipX + 10, PAD + 33, { font: font.display(22), color: t.accentBright });
  text(room, roomX, PAD + 32, { font: font.mono(20), color: t.text1, spacing: "0.14em" });
  text(seasonLabel, CARD_WIDTH - PAD, PAD + 32, { font: font.mono(20), color: t.accentBright, spacing: "0.18em", align: "right" });

  // The rest of the scoring positions: a poster strip.
  let y = heroBottom + 70;
  if (rest.length) {
    const label = `THE REST OF THE TOP ${CARD_STANDINGS}`;
    text(label, PAD, y, { font: font.mono(20), color: t.text2, spacing: "0.18em" });
    if (paint) {
      const lx = PAD + measure(font.mono(20), "0.18em")(label) + 20;
      ctx.fillStyle = t.lineStrong;
      ctx.fillRect(lx, y - 7, CARD_WIDTH - PAD - lx, 2);
    }
    y += 32;
    const slots = CARD_STANDINGS - 1;
    const runnerW = Math.min(RUNNER_W, (CARD_WIDTH - PAD * 2 - RUNNER_GAP * (slots - 1)) / slots);
    const runnerH = runnerW * 1.5;
    let stripBottom = y + runnerH;
    rest.forEach((s, i) => {
      const x = PAD + i * (runnerW + RUNNER_GAP);
      poster(s.poster, x, y, runnerW, runnerH, 14);
      if (paint) {
        // A dark foot on the poster so the rank numeral reads on any art.
        ctx.save();
        roundRect(ctx, x, y, runnerW, runnerH, 14);
        ctx.clip();
        const foot = ctx.createLinearGradient(0, y + runnerH * 0.55, 0, y + runnerH);
        foot.addColorStop(0, "rgba(0, 0, 0, 0)");
        foot.addColorStop(1, "rgba(0, 0, 0, 0.82)");
        ctx.fillStyle = foot;
        ctx.fillRect(x, y, runnerW, runnerH);
        ctx.restore();
      }
      text(String(s.rank), x + 16, y + runnerH - 18, { font: font.display(76), color: t.text0 });
      const runnerTag = pickTag(tagMeasure, pickNames(d, s.titleId), runnerW - 20 - 24);
      if (runnerTag) tag(runnerTag, x + 10, y + 10);
      const lines = wrapText(measure(font.title(23)), s.title, runnerW, 2);
      let ty = y + runnerH + 12;
      for (const line of lines) {
        ty += 29;
        text(line, x, ty, { font: font.title(23), color: t.text0 });
      }
      ty += 30;
      text(`${s.points} PTS`, x, ty, { font: font.mono(18), color: t.text2, spacing: "0.12em" });
      stripBottom = Math.max(stripBottom, ty);
    });
    y = stripBottom;
  }

  // Picks that did not make the card.
  const pickRows = pickLines(measure(font.mono(18), "0.06em"), offCardPicks(d), CARD_WIDTH - PAD * 2, 2);
  pickRows.forEach((row, i) => {
    y += i === 0 ? 54 : 30;
    text(row, PAD, y, { font: font.mono(18), color: t.text2, spacing: "0.06em" });
  });

  // Footer.
  y += 76;
  if (paint) {
    ctx.fillStyle = t.line;
    ctx.fillRect(PAD, y - 46, CARD_WIDTH - PAD * 2, 2);
  }
  text(statusLine(d), PAD, y, { font: font.mono(18), color: t.text3, spacing: "0.16em" });
  text("pick the season together.", CARD_WIDTH - PAD, y + 2, { font: font.display(26, 500), color: t.text1, align: "right" });
  const height = y + PAD - 8;

  if (paint) {
    // A hairline frame, inset like a print border.
    ctx.strokeStyle = t.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(FRAME_INSET, FRAME_INSET, CARD_WIDTH - FRAME_INSET * 2, height - FRAME_INSET * 2);
  }
  return height;
};

export interface RenderedCard {
  blob: Blob;
  // False when a font or poster missed the deadline and the card drew without it.
  complete: boolean;
}

/** Renders the standings card as a PNG. */
export const renderStandingsCard = async (d: StandingsCardData): Promise<RenderedCard> => {
  const theme = readTheme(d.season);
  const fonts = document.fonts;
  // True when every card font loaded.
  const fontsReady = fonts
    ? Promise.allSettled([
        fonts.load(`600 60px ${theme.display}`, `standings ${theme.kanji}`),
        fonts.load(`500 26px ${theme.display}`, "pick"),
        fonts.load(`600 23px ${theme.ui}`, "Aa"),
        fonts.load(`500 20px ${theme.mono}`, "A0"),
      ]).then(async (loads) => {
        await fonts.ready;
        return loads.every((load) => load.status === "fulfilled");
      })
    : Promise.resolve(true);
  const sources = d.standings.map((s) => s.poster).filter((s): s is string => !!s);
  const [fontsLoaded, images] = await Promise.all([
    within(fontsReady, ASSET_TIMEOUT_MS, false),
    Promise.all(sources.map(async (s) => [s, await within(loadImage(s), ASSET_TIMEOUT_MS, null)] as const)).then(
      (entries) => new Map(entries),
    ),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  canvas.height = Math.ceil(drawCard(ctx, d, theme, images, false));
  ctx.fillStyle = theme.bg0;
  ctx.fillRect(0, 0, CARD_WIDTH, canvas.height);
  ctx.imageSmoothingQuality = "high";
  drawCard(ctx, d, theme, images, true);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG encoding failed"))), "image/png"),
  );
  return { blob, complete: fontsLoaded && [...images.values()].every((img) => img != null) };
};
