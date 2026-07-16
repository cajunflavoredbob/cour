import type { Media } from "../../../../types/reely";

const FORMAT_LABELS: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV SHORT",
  MOVIE: "MOVIE",
  SPECIAL: "SPECIAL",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "MUSIC",
};

/**
 * The deck/drawer meta line (design: `TV \u00b7 24 EP \u00b7 SUMMER 2026 \u00b7 STUDIO`).
 * Uppercase mono; segments drop out when their data is missing. No
 * ratings anywhere -- these are unaired shows. The season name comes
 * from the caller (client-side detection until the wire carries the
 * room's season).
 */
export const metaLine = (media: Media, season: string): string =>
  [
    media.format ? FORMAT_LABELS[media.format] ?? media.format : undefined,
    media.episodes != null ? `${media.episodes} EP` : undefined,
    media.year != null ? `${season.toUpperCase()} ${media.year}` : undefined,
    media.studio?.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
