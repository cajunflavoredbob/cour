// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swallowSecondClick } from '../../web/app/src/utils/overlay';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('swallowSecondClick', () => {
  it("drops a double-click's second press, mousedown and click, and nothing else", () => {
    vi.useFakeTimers();
    const next = document.createElement('button');
    document.body.append(next);
    const clicked = vi.fn();
    next.addEventListener('click', clicked);
    swallowSecondClick();
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    expect(clicked).not.toHaveBeenCalled();
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(clicked).toHaveBeenCalledTimes(1);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
    next.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // A slow double-click setting: still the same double-click at 850ms.
    vi.advanceTimersByTime(850);
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    expect(clicked).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    expect(clicked).toHaveBeenCalledTimes(2);
  });
});
