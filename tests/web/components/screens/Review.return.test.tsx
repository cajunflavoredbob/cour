// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

// The real reducer behind a real zustand store, so a trip from the review
// page to the deck and back runs through the same state the app uses.
const { storeHolder } = vi.hoisted(() => ({
  storeHolder: { current: undefined as undefined | unknown },
}));

vi.mock('../../../../web/app/src/store/createStore', () => ({
  get useZustandStore() {
    return storeHolder.current;
  },
  createStore: vi.fn(),
}));
vi.mock('../../../../web/app/src/components/organisms/AccountMenu', () => ({
  AccountMenu: () => <div data-testid="account-menu" />,
}));

import { ReviewScreen } from '../../../../web/app/src/components/screens/Review';
import { useStore } from '../../../../web/app/src/store';
import { reducer } from '../../../../web/app/src/store/reducer';
import type { Actions, Store } from '../../../../web/app/src/store/types';
import { makeMedia } from '../../../helpers';

const media = [
  makeMedia({ id: '101', anilistId: 101, title: 'Iron Bloom' }),
  makeMedia({ id: '102', anilistId: 102, title: 'Second Show' }),
  makeMedia({ id: '103', anilistId: 103, title: 'Third Show' }),
];

type TestStore = Store & { dispatch: (action: Actions) => void };

const makeStore = () => {
  const store = create<TestStore>((set) => ({
    connectionStatus: 'connected',
    route: 'home',
    toasts: [],
    toastCounter: 0,
    room: { name: 'couch-club', displayName: 'Couch-Club', joined: true, media },
    review: {
      verdicts: [
        { titleId: 101, verdict: 'like', updatedAt: 1 },
        { titleId: 102, verdict: 'dislike', updatedAt: 2 },
        { titleId: 103, verdict: 'skip', updatedAt: 3 },
      ],
      counts: { like: 1, dislike: 1, skip: 1 },
      members: [],
      lockedAt: null,
      total: 3,
    },
    dispatch: (action) => set((state) => reducer(state, action) as TestStore),
  }));
  storeHolder.current = store;
  return store;
};

// The review page shows on the home route only; the deck replaces it.
const Routed = () => {
  const [{ route }] = useStore(['route']);
  return route === 'home' ? <ReviewScreen /> : <div data-testid="deck" />;
};

const state = () => (storeHolder.current as ReturnType<typeof makeStore>).getState();
const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;
beforeEach(() => {
  makeStore();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  storeHolder.current = undefined;
});

describe('ReviewScreen after a trip to the deck', () => {
  it('lands back on the pile the show was opened from, scrolled where it was', () => {
    render(<Routed />);
    expect(selectedTab()).toBe('Kept 1');
    fireEvent.click(screen.getByText('Passed 1'));
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(340);
    fireEvent.click(screen.getByText('Second Show'));
    expect(screen.getByTestId('deck')).toBeDefined();
    act(() => state().dispatch({ type: 'verdictSuccess', payload: { titleId: 102, verdict: 'like' } }));
    expect(selectedTab()).toBe('Passed 0');
    expect(screen.getByText('nothing passed yet')).toBeDefined();
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 340);
    expect(state().reviewView).toEqual({ pile: 'dislike', showAll: false });
  });

  it('lands back on the pile after backing out of the deck', () => {
    render(<Routed />);
    fireEvent.click(screen.getByText('Unsure 1'));
    fireEvent.click(screen.getByText('Third Show'));
    act(() => state().dispatch({ type: 'exitDeckScope' }));
    expect(selectedTab()).toBe('Unsure 1');
    expect(screen.getByText('Third Show')).toBeDefined();
  });

  it('opens the locked peek on Kept', () => {
    render(<Routed />);
    fireEvent.click(screen.getByText('Passed 1'));
    expect(state().reviewView?.pile).toBe('dislike');
    act(() => state().dispatch({ type: 'viewLockedReview', payload: { open: true } }));
    expect(selectedTab()).toBe('Kept 1');
  });

  it('starts on Kept again after leaving the room', () => {
    render(<Routed />);
    fireEvent.click(screen.getByText('Passed 1'));
    expect(state().reviewView?.pile).toBe('dislike');
    act(() => state().dispatch({ type: 'leaveRoomSuccess' } as Actions));
    expect(state().reviewView).toBeUndefined();
  });
});
