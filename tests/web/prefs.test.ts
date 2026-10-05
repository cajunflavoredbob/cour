// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRerankTold, setRerankTold } from '../../web/app/src/utils/prefs';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the re-rank round toast flag', () => {
  it('is remembered by the browser per key', () => {
    expect(getRerankTold('room-a:FALL:2026')).toBe(false);
    setRerankTold('room-a:FALL:2026');
    expect(localStorage.getItem('courRerankTold:room-a:FALL:2026')).toBe('1');
    expect(getRerankTold('room-a:FALL:2026')).toBe(true);
    expect(getRerankTold('room-b:FALL:2026')).toBe(false);
  });

  it('still holds for the page when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(getRerankTold('room-c:FALL:2026')).toBe(false);
    setRerankTold('room-c:FALL:2026');
    expect(getRerankTold('room-c:FALL:2026')).toBe(true);
  });
});
