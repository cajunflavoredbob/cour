// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// useSeason picks ["config"] off the store; no store exists in this
// harness, so stub the module (same pattern as the screen tests). An
// undefined return falls useSeason back to the local clock, which the
// fake-timer season assertions below rely on.
vi.mock('../../../../web/app/src/store', () => ({
  useSelector: vi.fn(),
}));

import { Wordmark } from '../../../../web/app/src/components/atoms/Wordmark';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Wordmark', () => {
  it('renders the "cour" set-type wordmark', () => {
    render(<Wordmark />);
    const word = screen.getByText('cour');
    expect(word).toBeDefined();
    // Brand word must never be machine-translated.
    expect(word.getAttribute('translate')).toBe('no');
  });

  it('shows the current season kanji, aria-hidden (decorative)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T12:00:00'));
    render(<Wordmark />);
    const kanji = screen.getByText('夏');
    expect(kanji.getAttribute('aria-hidden')).toBe('true');
  });

  it('rotates the kanji with the season', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00'));
    render(<Wordmark />);
    expect(screen.getByText('秋')).toBeDefined();
  });

  it('honors the size prop on the wordmark text', () => {
    render(<Wordmark size={26} />);
    expect((screen.getByText('cour') as HTMLElement).style.fontSize).toBe('26px');
  });
});
