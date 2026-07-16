// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

let dispatch: ReturnType<typeof vi.fn>;
vi.mock('../../../../web/app/src/store', () => ({
  useStore: vi.fn(),
  useDispatch: () => dispatch,
  // VerdictRow disables its buttons while disconnected (audit 17 M7);
  // these tests exercise the connected behavior.
  useSelector: vi.fn().mockReturnValue({ connectionStatus: 'connected' }),
  createStore: vi.fn(),
}));

import { VerdictRow } from '../../../../web/app/src/components/molecules/VerdictRow';

beforeEach(() => {
  dispatch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VerdictRow', () => {
  it('Keep and Pass dispatch their verdicts for the given title', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    fireEvent.click(screen.getByText('Keep'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'like' },
    });
    fireEvent.click(screen.getByText('Pass'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'dislike' },
    });
  });

  it('a quick Skip press-and-release is a single skip', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = screen.getByText('Unsure');
    fireEvent.pointerDown(skip);
    vi.advanceTimersByTime(500); // released well before the 1.5s hold
    fireEvent.pointerUp(skip);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'skip' },
    });
  });

  it('holding Skip for 1.5s fires skipRemaining exactly once (design section 04)', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = screen.getByText('Unsure');
    fireEvent.pointerDown(skip);
    // Mid-hold the label counts down against the remaining total.
    vi.advanceTimersByTime(100);
    expect(screen.getByText(/all 12 unsure/)).toBeDefined();
    vi.advanceTimersByTime(1500);
    expect(dispatch).toHaveBeenCalledWith({ type: 'skipRemaining' });
    // Releasing after the hold completed must NOT add a single skip.
    // (Select by handle -- the label text is mid-transition here.)
    fireEvent.pointerUp(
      document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a second pointer down does not orphan the first hold timer (audit 17 M4)', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    // Two fingers down (pointer events fire per pointerId), quick release:
    // the orphaned first timer used to fire skipRemaining 1.5s later,
    // silently marking the rest of the season unsure.
    fireEvent.pointerDown(skip, { pointerId: 1 });
    fireEvent.pointerDown(skip, { pointerId: 2 });
    fireEvent.pointerUp(skip, { pointerId: 2 });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'skip' },
    });
    vi.advanceTimersByTime(3000);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'skipRemaining' });
  });

  it('disables all three verdict buttons while disconnected (audit 17 M7)', async () => {
    const { useSelector } = await import('../../../../web/app/src/store');
    vi.mocked(useSelector).mockReturnValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: partial store slice; the component only picks connectionStatus.
      { connectionStatus: 'disconnected' } as any,
    );
    render(<VerdictRow titleId={101} remaining={12} />);
    for (const handle of ['verdict-dislike', 'verdict-skip', 'verdict-like']) {
      const btn = document.querySelector(`[data-test-handle="${handle}"]`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
    fireEvent.click(screen.getByText('Keep'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dragging the pointer away cancels the hold with no dispatch', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = screen.getByText('Unsure');
    fireEvent.pointerDown(skip);
    fireEvent.pointerLeave(skip);
    vi.advanceTimersByTime(3000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keyboard Skip is always a single skip (hold is pointer-only)', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    fireEvent.keyDown(screen.getByText('Unsure').closest('button') as HTMLElement, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'skip' },
    });
  });
});

describe('VerdictRow with skip-all disabled (scoped passes)', () => {
  it('a long hold is just a single skip -- no skipRemaining', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} allowSkipAll={false} />);
    const skip = screen.getByText('Unsure');
    fireEvent.pointerDown(skip);
    vi.advanceTimersByTime(3000);
    fireEvent.pointerUp(skip);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'skip' },
    });
  });
});

describe('current-verdict halo (re-review passes)', () => {
  it('halos exactly the button matching the existing verdict', () => {
    render(<VerdictRow titleId={101} remaining={12} currentVerdict="dislike" />);
    const dislike = document.querySelector('[data-test-handle="verdict-dislike"]') as HTMLElement;
    const like = document.querySelector('[data-test-handle="verdict-like"]') as HTMLElement;
    const skip = document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    expect(dislike.getAttribute('data-current')).toBe('true');
    expect(dislike.getAttribute('aria-label')).toContain('your current pick');
    expect(like.getAttribute('data-current')).toBe('false');
    expect(skip.getAttribute('data-current')).toBe('false');
  });

  it('no halo without an existing verdict (the main season flow)', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    for (const handle of ['verdict-like', 'verdict-dislike', 'verdict-skip']) {
      const btn = document.querySelector(`[data-test-handle="${handle}"]`) as HTMLElement;
      expect(btn.getAttribute('data-current')).toBe('false');
    }
  });
});
