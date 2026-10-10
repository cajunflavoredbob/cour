// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

let dispatch: ReturnType<typeof vi.fn>;
vi.mock('../../../../web/app/src/store', () => ({
  useStore: vi.fn(),
  useDispatch: () => dispatch,
  // VerdictRow disables its buttons while disconnected (audit 17 M7);
  // these tests exercise the connected behavior.
  useSelector: vi.fn().mockReturnValue({ connectionStatus: 'connected' }),
  createStore: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerdictRow } from '../../../../web/app/src/components/molecules/VerdictRow';
import { HOLD_SHOW_MS, SKIP_ALL_HOLD_MS } from '../../../../web/app/src/utils/hold';

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
    fireEvent.click(screen.getByText('keep'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'like' },
    });
    fireEvent.click(screen.getByText('pass'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'verdict',
      payload: { titleId: 101, verdict: 'dislike' },
    });
  });

  it('a quick Skip press-and-release is a single skip', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = screen.getByText('unsure');
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
    const skip = screen.getByText('unsure');
    fireEvent.pointerDown(skip);
    // The countdown shows once the press outlasts a tap, against the
    // remaining total.
    const button = skip.closest('button') as HTMLElement;
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(button.getAttribute('data-holding')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button.getAttribute('data-holding')).toBe('true');
    expect(screen.getByText(/all 12 unsure/)).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'skipRemaining' });
    expect(button.getAttribute('data-holding')).toBe('false');
    // Releasing after the hold completed must NOT add a single skip.
    // (Select by handle -- the label text is mid-transition here.)
    fireEvent.pointerUp(
      document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('never shows the countdown for a tap', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const button = screen.getByText('unsure').closest('button') as HTMLElement;
    fireEvent.pointerDown(button);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.pointerUp(button);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(button.getAttribute('data-holding')).toBe('false');
    expect(screen.queryByText(/all 12 unsure/)).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'verdict', payload: { titleId: 101, verdict: 'skip' } });
  });

  it('never shows the countdown for a press cut off before it would', () => {
    vi.useFakeTimers();
    const view = render(<VerdictRow titleId={101} remaining={12} />);
    const button = () => document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    fireEvent.pointerDown(button());
    fireEvent.pointerLeave(button());
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(button().getAttribute('data-holding')).toBe('false');
    fireEvent.pointerDown(button());
    // A new title arms the post-advance disable.
    view.rerender(<VerdictRow titleId={102} remaining={11} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(button().getAttribute('data-holding')).toBe('false');
    expect(dispatch).not.toHaveBeenCalled();
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
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'skipRemaining' });
    expect(skip.getAttribute('data-holding')).toBe('false');
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
    fireEvent.click(screen.getByText('keep'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('marks the row offline so the disabled buttons dim', async () => {
    const { useSelector } = await import('../../../../web/app/src/store');
    vi.mocked(useSelector).mockReturnValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: partial store slice; the component only picks connectionStatus.
      { connectionStatus: 'connecting' } as any,
    );
    const { container } = render(<VerdictRow titleId={101} remaining={12} />);
    expect((container.firstElementChild as HTMLElement).dataset.offline).toBe('true');
  });

  it('holds the verdicts until the rejoin lands', async () => {
    const { useSelector } = await import('../../../../web/app/src/store');
    vi.mocked(useSelector).mockReturnValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: partial store slice; the component only picks the connection fields.
      { connectionStatus: 'connected', rejoining: true } as any,
    );
    const { container } = render(<VerdictRow titleId={101} remaining={12} />);
    expect((container.firstElementChild as HTMLElement).dataset.offline).toBe('true');
    fireEvent.click(screen.getByText('keep'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves the row unmarked while connected', () => {
    const { container } = render(<VerdictRow titleId={101} remaining={12} />);
    expect((container.firstElementChild as HTMLElement).dataset.offline).toBe('false');
  });

  it('held Enter/Space on the Unsure button fires ONE skip (audit v1.2.0 #10)', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    fireEvent.keyDown(skip, { key: 'Enter' });
    fireEvent.keyDown(skip, { key: 'Enter', repeat: true });
    fireEvent.keyDown(skip, { key: ' ', repeat: true });
    const verdicts = dispatch.mock.calls.filter(([a]) => a.type === 'verdict');
    expect(verdicts).toHaveLength(1);
  });

  it('briefly refuses presses after the card advances, keeping focus', () => {
    vi.useFakeTimers();
    const { rerender } = render(<VerdictRow titleId={101} remaining={12} />);
    const like = document.querySelector('[data-test-handle="verdict-like"]') as HTMLButtonElement;
    like.focus();
    // The deck advanced: same coordinates, new title.
    rerender(<VerdictRow titleId={102} remaining={11} />);
    expect(like.getAttribute('aria-disabled')).toBe('true');
    // Still a live element: the keyboard's focus stays on it.
    expect(like.disabled).toBe(false);
    expect(document.activeElement).toBe(like);
    fireEvent.click(like);
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(like.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(like);
    expect(dispatch).toHaveBeenCalledWith({ type: 'verdict', payload: { titleId: 102, verdict: 'like' } });
  });

  it('dragging the pointer away cancels the hold with no dispatch', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const skip = screen.getByText('unsure');
    fireEvent.pointerDown(skip);
    fireEvent.pointerLeave(skip);
    vi.advanceTimersByTime(3000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows the deck's U key down as a press, before any countdown", () => {
    render(<VerdictRow titleId={101} remaining={12} keyPressed />);
    const button = document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    expect(button.getAttribute('data-pressed')).toBe('true');
    expect(button.getAttribute('data-holding')).toBe('false');
    expect(screen.getByText('unsure')).toBeDefined();
  });

  it('sweeps the fill over the hold left once the countdown shows', () => {
    const css = readFileSync(join(process.cwd(), 'web/app/src/components/molecules/VerdictRow.module.css'), 'utf8');
    expect(css).toContain(`animation: cour-skip-sweep ${SKIP_ALL_HOLD_MS - HOLD_SHOW_MS}ms linear forwards;`);
  });

  it("shows the deck's U-key hold as its own countdown", () => {
    render(<VerdictRow titleId={101} remaining={12} keyHolding />);
    const button = document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    expect(button.getAttribute('data-holding')).toBe('true');
    expect(screen.getByText(/all 12 unsure/)).toBeDefined();
  });

  it('drops a running hold when the row unmounts', () => {
    vi.useFakeTimers();
    const view = render(<VerdictRow titleId={101} remaining={12} />);
    fireEvent.pointerDown(document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement);
    view.unmount();
    vi.advanceTimersByTime(3000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a right-click press', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={12} />);
    const button = screen.getByText('unsure').closest('button') as HTMLElement;
    fireEvent.pointerDown(button, { button: 2 });
    expect(button.getAttribute('data-pressed')).toBe('false');
    vi.advanceTimersByTime(3000);
    fireEvent.pointerUp(button, { button: 2 });
    // A Mac ctrl+click opens the same menu with the main button.
    fireEvent.pointerDown(button, { button: 0, ctrlKey: true });
    expect(button.getAttribute('data-pressed')).toBe('false');
    vi.advanceTimersByTime(3000);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('drops the pressed pill when the row disables mid-press', () => {
    const view = render(<VerdictRow titleId={101} remaining={12} />);
    const button = () => document.querySelector('[data-test-handle="verdict-skip"]') as HTMLElement;
    fireEvent.pointerDown(button());
    expect(button().getAttribute('data-pressed')).toBe('true');
    // A new title arms the post-advance disable.
    view.rerender(<VerdictRow titleId={102} remaining={11} />);
    expect(button().getAttribute('data-pressed')).toBe('false');
  });

  it('shows the pressed pill only while a press is live', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    const button = screen.getByText('unsure').closest('button') as HTMLElement;
    expect(button.getAttribute('data-pressed')).toBe('false');
    fireEvent.pointerDown(button);
    expect(button.getAttribute('data-pressed')).toBe('true');
    fireEvent.pointerLeave(button);
    expect(button.getAttribute('data-pressed')).toBe('false');
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    expect(button.getAttribute('data-pressed')).toBe('false');
  });

  it('keyboard Skip is always a single skip (hold is pointer-only)', () => {
    render(<VerdictRow titleId={101} remaining={12} />);
    fireEvent.keyDown(screen.getByText('unsure').closest('button') as HTMLElement, { key: 'Enter' });
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
    const skip = screen.getByText('unsure');
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

describe('VerdictRow on the last unverdicted title', () => {
  it('a long hold is just a single skip, with no "all 1" countdown', () => {
    vi.useFakeTimers();
    render(<VerdictRow titleId={101} remaining={1} />);
    const skip = screen.getByText('unsure');
    fireEvent.pointerDown(skip);
    vi.advanceTimersByTime(3000);
    expect(screen.queryByText(/all 1/)).toBeNull();
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
    expect(dislike.getAttribute('aria-label')).toBe('Pass (your current pick)');
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
