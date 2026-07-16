// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Same isIOS proxy trick as PlexLinks.test.tsx: the module-level const is
// evaluated at import time, so the platform module is mocked with a
// get-accessor the tests can flip per case.
const { isIOSMock } = vi.hoisted(() => ({ isIOSMock: { current: false } }));

vi.mock('../../../../web/app/src/utils/platform', () => ({
  get isIOS() {
    return isIOSMock.current;
  },
}));

import { AnimeLinks } from '../../../../web/app/src/components/atoms/AnimeLinks';
import { makeMedia } from '../../../helpers';

beforeEach(() => {
  isIOSMock.current = false;
});

afterEach(() => {
  cleanup();
});

const anime = (over: Parameters<typeof makeMedia>[0] = {}) =>
  makeMedia({ type: 'anime', anilistId: 12345, ...over });

describe('AnimeLinks', () => {
  it('renders nothing for media without an anilistId', () => {
    const { container } = render(<AnimeLinks media={makeMedia()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the AniList link from anilistId', () => {
    const { getByText } = render(<AnimeLinks media={anime()} />);
    expect(getByText('AniList').getAttribute('href')).toBe(
      'https://anilist.co/anime/12345',
    );
  });

  it('renders the MAL link only when malId is present', () => {
    const { queryByText, rerender, getByText } = render(<AnimeLinks media={anime()} />);
    expect(queryByText('MAL')).toBeNull();
    rerender(<AnimeLinks media={anime({ malId: 999 })} />);
    expect(getByText('MAL').getAttribute('href')).toBe(
      'https://myanimelist.net/anime/999',
    );
  });

  it('uses target="_self" on iOS and "_blank" elsewhere', () => {
    isIOSMock.current = true;
    const { getByText, unmount } = render(<AnimeLinks media={anime()} />);
    expect(getByText('AniList').getAttribute('target')).toBe('_self');
    unmount();
    isIOSMock.current = false;
    const second = render(<AnimeLinks media={anime()} />);
    expect(second.getByText('AniList').getAttribute('target')).toBe('_blank');
  });

  it('sets rel="noopener noreferrer" on both links', () => {
    const { getByText } = render(<AnimeLinks media={anime({ malId: 1 })} />);
    expect(getByText('AniList').getAttribute('rel')).toBe('noopener noreferrer');
    expect(getByText('MAL').getAttribute('rel')).toBe('noopener noreferrer');
  });

  // Same contract as PlexLinks: clicks must not bubble to parent overlays
  // (MatchMoment's overlay onClick dismisses the celebration).
  it('stops click propagation so parent overlay handlers do not fire', () => {
    const parentClick = vi.fn();
    const { getByText } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test wrapper to observe propagation.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test wrapper to observe propagation.
      <div onClick={parentClick}>
        <AnimeLinks media={anime()} />
      </div>,
    );
    getByText('AniList').click();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
