import type { Media } from "../../../../../types/reely";
import { buildAnimeLinks } from "../../utils/animeLinks";
import { isIOS } from "../../utils/platform";
import styles from "./AnimeLinks.module.css";

interface AnimeLinksProps {
  media: Media;
}

// External anime-database links: AniList always (it's the data source), MAL
// when AniList knows the mapping. The anime counterpart of PlexLinks --
// same stopPropagation wrapper contract, same iOS target handling.
export const AnimeLinks = ({ media }: AnimeLinksProps) => {
  const links = buildAnimeLinks(media);
  if (!links) return null;

  return (
    // stopPropagation wrapper: prevents link clicks from bubbling up to
    // parent overlays (e.g. MatchMoment's overlay onClick dismisses the
    // match celebration). No own interactive semantics -- it's a layout
    // container around real <a> elements.
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper.
    // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper.
    <div className={styles.row} onClick={(e) => e.stopPropagation()}>
      <a
        className={styles.link}
        href={links.anilistUrl}
        target={isIOS ? "_self" : "_blank"}
        rel="noopener noreferrer"
      >
        AniList
      </a>
      {links.malUrl && (
        <a
          className={styles.link}
          href={links.malUrl}
          target={isIOS ? "_self" : "_blank"}
          rel="noopener noreferrer"
        >
          MAL
        </a>
      )}
    </div>
  );
};
