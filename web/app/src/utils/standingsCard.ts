import type { Media, RankingResults } from "../../../../types/reely";
import { posterSrc } from "./poster";
import type { CourSeason } from "./season";
import { rankingsIn, standingsFinal } from "./standingsText";

export interface CardStanding {
  titleId: number;
  rank: number;
  title: string;
  points: number;
  rankedBy: number;
  rankedByNames: string[];
  poster?: string;
}

export interface CardPick {
  titleId: number;
  userName: string;
  title: string;
}

export interface StandingsCardData {
  season: CourSeason;
  year: number;
  roomName: string;
  submittedCount: number;
  memberCount: number;
  standings: CardStanding[];
  topPicks: CardPick[];
}

// The card shows the scoring positions only.
export const CARD_STANDINGS = 5;

export const buildStandingsCard = (input: {
  results: RankingResults;
  season: CourSeason;
  year: number;
  roomName: string;
  mediaById: Map<number, Media>;
}): StandingsCardData => {
  const { results, mediaById } = input;
  const titleOf = (id: number) => mediaById.get(id)?.title ?? `#${id}`;
  return {
    season: input.season,
    year: input.year,
    roomName: input.roomName,
    submittedCount: results.submittedCount,
    memberCount: results.memberCount,
    standings: results.standings.slice(0, CARD_STANDINGS).map((s) => ({
      titleId: s.titleId,
      rank: s.rank,
      title: titleOf(s.titleId),
      points: s.points,
      rankedBy: s.rankedBy,
      rankedByNames: s.rankedByNames ?? [],
      poster: posterSrc(mediaById.get(s.titleId)?.posterUrl),
    })),
    topPicks: (results.topPicks ?? []).map((p) => ({
      titleId: p.titleId,
      userName: p.userName,
      title: titleOf(p.titleId),
    })),
  };
};

export const statusLine = (d: StandingsCardData): string =>
  `${rankingsIn(d.submittedCount, d.memberCount)} · ${standingsFinal(d.submittedCount, d.memberCount) ? "FINAL" : "SO FAR"}`;

/** Names, upper-cased, of the members whose #1 this show is. */
export const pickNames = (d: StandingsCardData, titleId: number): string[] =>
  d.topPicks.filter((p) => p.titleId === titleId).map((p) => p.userName.toUpperCase());

/** Picks whose show is not on the card. */
export const offCardPicks = (d: StandingsCardData): CardPick[] =>
  d.topPicks.filter((p) => !d.standings.some((s) => s.titleId === p.titleId));

/** A key for what the card shows: equal for equal content, whatever the object. */
export const cardSignature = (d: StandingsCardData): string => JSON.stringify(d);

/** "a", "a and b", "a, b and c". */
export const listOf = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The card in words: the preview image's alt text. */
export const cardAltText = (d: StandingsCardData): string => {
  const rows = d.standings.map((s) => {
    const ranked = s.rankedByNames.length > 0 ? `, ranked by ${listOf(s.rankedByNames)}` : "";
    const picks = d.topPicks.filter((p) => p.titleId === s.titleId).map((p) => `${p.userName}'s number 1`);
    const points = `${s.points} ${s.points === 1 ? "point" : "points"}`;
    return `${s.rank}, ${s.title}, ${points}${ranked}${picks.length > 0 ? `, ${listOf(picks)}` : ""}.`;
  });
  const offCard = offCardPicks(d).map((p) => `${p.userName}'s number 1 is ${p.title}.`);
  const status = `${rankingsIn(d.submittedCount, d.memberCount).toLowerCase()}, ${
    standingsFinal(d.submittedCount, d.memberCount) ? "final" : "so far"
  }.`;
  return [`Standings card for ${d.roomName}, ${d.season.toLowerCase()} ${d.year}.`, ...rows, ...offCard, status].join(" ");
};

export const cardFilename = (d: StandingsCardData): string => {
  const room = d.roomName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `cour-${d.season.toLowerCase()}-${d.year}-${room || "room"}.png`;
};

type Measure = (text: string) => number;

// User-perceived characters, so a cut never lands inside an emoji or a
// combining sequence.
const graphemes = (text: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment)
    : Array.from(text);

/** `text`, cut down with an ellipsis until it fits `max`. */
export const fitText = (measure: Measure, text: string, max: number): string => {
  if (measure(text) <= max) return text;
  const chars = graphemes(text);
  const head = (n: number) => `${chars.slice(0, n).join("").trimEnd()}…`;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(head(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return head(lo);
};

/** Word-wraps `text` to at most `maxLines` lines; the last one is ellipsized. */
export const wrapText = (measure: Measure, text: string, max: number, maxLines: number): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (!line || measure(candidate) <= max) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      return [...lines, fitText(measure, [line, ...words.slice(i)].join(" "), max)];
    }
    lines.push(fitText(measure, line, max));
    line = words[i];
  }
  return line ? [...lines, fitText(measure, line, max)] : lines;
};

/**
 * The "whose #1" tag fitted to `max`: "USER1 + USER2'S #1", else the first
 * name, shortened as needed, with a count of the rest ("USER1 +1'S #1").
 * The "'S #1" is never cut.
 */
export const pickTag = (measure: Measure, names: readonly string[], max: number): string | undefined => {
  if (!names.length) return undefined;
  const suffix = "'S #1";
  const full = `${names.join(" + ")}${suffix}`;
  if (measure(full) <= max) return full;
  const rest = names.length > 1 ? ` +${names.length - 1}` : "";
  return `${fitText(measure, names[0], max - measure(`${rest}${suffix}`))}${rest}${suffix}`;
};

const PICK_GAP = "   ";

/**
 * Off-card picks as up to `maxLines` lines of `max` width ("USER1'S #1 ·
 * Title"), titles shortened to fit, ending with "+N MORE" when some picks
 * do not fit.
 */
export const pickLines = (measure: Measure, picks: readonly CardPick[], max: number, maxLines: number): string[] => {
  const entry = (p: CardPick, room: number) => {
    const lead = `${p.userName.toUpperCase()}'S #1 · `;
    return `${lead}${fitText(measure, p.title, room - measure(lead))}`;
  };
  const text = (line: CardPick[]) => line.map((p) => entry(p, max)).join(PICK_GAP);
  const lines: CardPick[][] = [];
  let placed = 0;
  for (const p of picks) {
    const line = lines.at(-1);
    if (line && measure(text([...line, p])) <= max) line.push(p);
    else if (lines.length < maxLines) lines.push([p]);
    else break;
    placed++;
  }
  const rendered = lines.map(text);
  const last = lines.at(-1);
  if (last && placed < picks.length) {
    let more = picks.length - placed;
    while (last.length > 1 && measure(`${text(last)}${PICK_GAP}+${more} MORE`) > max) {
      last.pop();
      more++;
    }
    const tail = `${PICK_GAP}+${more} MORE`;
    rendered[rendered.length - 1] =
      measure(`${text(last)}${tail}`) <= max ? `${text(last)}${tail}` : `${entry(last[0], max - measure(tail))}${tail}`;
  }
  return rendered;
};
