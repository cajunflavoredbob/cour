// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRerankTold,
  getStoredName,
  getTabJoining,
  getTabName,
  getTabRoom,
  setRerankTold,
  setTabJoining,
  setTabName,
  setTabRoom,
} from '../../web/app/src/utils/prefs';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("the tab's own member and room", () => {
  it('lives in the tab, apart from the browser-wide name', () => {
    setTabName('user1');
    setTabRoom('r1');
    expect([getTabName(), getTabRoom()]).toEqual(['user1', 'r1']);
    expect(sessionStorage.getItem('courTabName')).toBe('user1');
    expect(getStoredName()).toBeUndefined();
    setTabRoom(undefined);
    expect(getTabRoom()).toBeUndefined();
    expect(sessionStorage.getItem('courTabRoom')).toBeNull();
    setTabJoining('r7');
    expect(getTabJoining()).toBe('r7');
    setTabJoining(undefined);
    expect(sessionStorage.getItem('courTabJoining')).toBeNull();
  });

  it('reads as a new tab when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    setTabName('user1');
    setTabRoom('r1');
    setTabRoom(undefined);
    setTabJoining('r7');
    expect([getTabName(), getTabRoom(), getTabJoining()]).toEqual([undefined, undefined, undefined]);
  });
});

describe('the re-rank round toast flag', () => {
  it('is remembered by the browser per key', () => {
    expect(getRerankTold('room-a:FALL:2026')).toBe(false);
    setRerankTold('room-a:FALL:2026');
    expect(localStorage.getItem('courRerankTold:room-a:FALL:2026')).toBe('1');
    expect(getRerankTold('room-a:FALL:2026')).toBe(true);
    expect(getRerankTold('room-b:FALL:2026')).toBe(false);
  });

  it('reads the flag back after a reload', async () => {
    localStorage.setItem('courRerankTold:user1:room-d:FALL:2026', '1');
    vi.resetModules();
    const fresh = await import('../../web/app/src/utils/prefs');
    expect(fresh.getRerankTold('user1:room-d:FALL:2026')).toBe(true);
    fresh.setRerankTold('user1:room-e:FALL:2026');
    vi.resetModules();
    const reloaded = await import('../../web/app/src/utils/prefs');
    expect(reloaded.getRerankTold('user1:room-e:FALL:2026')).toBe(true);
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
