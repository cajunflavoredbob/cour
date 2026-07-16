import { describe, expect, it } from 'vitest';
import { metaLine } from '../../web/app/src/utils/metaLine';
import { makeMedia } from '../helpers';

describe('metaLine', () => {
  it('renders the full design shape: FORMAT · EP · SEASON YEAR · STUDIO', () => {
    const media = makeMedia({
      format: 'TV',
      episodes: 24,
      year: 2026,
      studio: 'Komorebi Works',
    });
    expect(metaLine(media, 'SUMMER')).toBe('TV \u00b7 24 EP \u00b7 SUMMER 2026 \u00b7 KOMOREBI WORKS');
  });

  it('drops missing segments instead of leaving separators', () => {
    expect(metaLine(makeMedia({ format: 'ONA', year: 2026 }), 'Summer'))
      .toBe('ONA \u00b7 SUMMER 2026');
    expect(metaLine(makeMedia({}), 'SUMMER')).toBe('');
  });

  it('prettifies TV_SHORT and passes unknown formats through', () => {
    expect(metaLine(makeMedia({ format: 'TV_SHORT' }), 'SUMMER')).toBe('TV SHORT');
    expect(metaLine(makeMedia({ format: 'WEIRD_NEW' }), 'SUMMER')).toBe('WEIRD_NEW');
  });
});
