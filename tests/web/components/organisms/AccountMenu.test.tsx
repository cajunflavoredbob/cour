// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

import { AccountMenu } from '../../../../web/app/src/components/organisms/AccountMenu';

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      user: { userName: 'user1' },
      soundPref: false,
      room: { name: 'couch-coop', joined: true },
      ...slice,
    },
    dispatch,
  ]);
};

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Account' }));

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
});

afterEach(() => {
  cleanup();
});

describe('AccountMenu (popover, passwordless)', () => {
  it('is closed until the avatar is tapped, then shows name + rows', () => {
    render(<AccountMenu />);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    expect(screen.getByRole('menu')).toBeDefined();
    expect(screen.getByText('user1')).toBeDefined();
    expect(screen.getByText('Autoplay PVs with sound')).toBeDefined();
    expect(screen.getByText('Leave room')).toBeDefined();
    // The credential-era rows are gone.
    expect(screen.queryByText('Change password')).toBeNull();
    expect(screen.queryByText('Log out')).toBeNull();
    expect(screen.queryByText('Admin panel')).toBeNull();
  });

  it('the autoplay toggle dispatches the flipped soundPref', () => {
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('switch'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'soundPref',
      payload: { enabled: true },
    });
  });

  it('Leave room dispatches leaveRoom and closes', () => {
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText('Leave room'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'leaveRoom' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides Leave room when not in a room', () => {
    withState({ room: undefined });
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByText('Leave room')).toBeNull();
  });

  it('closes on outside tap and on Escape', () => {
    const { container } = render(<AccountMenu />);
    openMenu();
    fireEvent.click(container.parentElement?.querySelector('[class*="scrim"]') as HTMLElement);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders nothing without an identity', () => {
    withState({ user: undefined });
    const { container } = render(<AccountMenu />);
    expect(container.firstChild).toBeNull();
  });

  const unfinished = {
    total: 3,
    verdicts: [{ titleId: 1, verdict: 'like' as const, updatedAt: 1 }],
    lockedAt: null,
  };
  const handle = (h: string) => document.querySelector(`[data-test-handle="${h}"]`);

  it('Share room copies a join link and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText('Share room'));
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('roomName=couch-coop'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'addToast', payload: expect.objectContaining({ message: 'Room link copied' }) }),
    );
  });

  it('off the deck with an unfinished deck: "Keep going" shows the count and jumps to the deck', () => {
    withState({ route: 'home', review: unfinished });
    render(<AccountMenu />);
    openMenu();
    const kg = handle('menu-keep-going') as HTMLElement;
    expect(kg).not.toBeNull();
    expect(kg.textContent).toContain('2 left');
    // The review link is redundant off the deck.
    expect(handle('menu-review')).toBeNull();
    fireEvent.click(kg);
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'room' } });
  });

  it('on the deck: "See your review" navigates home, and keep-going is hidden', () => {
    withState({ route: 'room', review: unfinished });
    render(<AccountMenu />);
    openMenu();
    expect(handle('menu-keep-going')).toBeNull();
    fireEvent.click(screen.getByText('See your review'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'home' } });
  });

  it('hides keep-going and review once locked in', () => {
    withState({ route: 'home', review: { ...unfinished, lockedAt: 999 } });
    render(<AccountMenu />);
    openMenu();
    expect(handle('menu-keep-going')).toBeNull();
    expect(handle('menu-review')).toBeNull();
    // Share stays available.
    expect(handle('menu-share')).not.toBeNull();
  });

  it('shows the app version injected into the HTML shell', () => {
    document.body.dataset.version = '9.9.9';
    render(<AccountMenu />);
    openMenu();
    expect(handle('menu-version')?.textContent).toBe('v9.9.9');
    delete document.body.dataset.version;
  });
});

describe('AccountMenu audit-17 UX additions', () => {
  it('share falls back to a select-on-focus dialog without a clipboard API (UX 5)', () => {
    // Plain-HTTP LAN: navigator.clipboard is undefined (jsdom may ship
    // one, so force the insecure-context shape). The old fallback was an
    // unselectable toast that vanished in 8 seconds.
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    withState({});
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText('Share room'));
    const input = document.querySelector(
      '[data-test-handle="share-link-input"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toContain('roomName=');
    expect(input.readOnly).toBe(true);
    fireEvent.click(screen.getByText('Done'));
    expect(document.querySelector('[data-test-handle="share-link-input"]')).toBeNull();
  });

  it('reopens the tutorial on demand', () => {
    withState({});
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText('How cour works'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'tutorial', payload: { open: true } });
  });

  it('offers the read-only review peek after lock-in (UX 6)', () => {
    withState({
      review: { verdicts: [], counts: { like: 0, dislike: 0, skip: 0 }, members: [], lockedAt: 111, total: 3 },
    });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(
      document.querySelector('[data-test-handle="menu-locked-review"]') as HTMLElement,
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'viewLockedReview', payload: { open: true } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'navigate', payload: { route: 'home' } });
  });
});
