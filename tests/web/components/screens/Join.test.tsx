// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));
let dispatch: ReturnType<typeof vi.fn>;

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: () => dispatch,
  // The season label reads the server's served season via useSeason
  // (["config"] pick); pin it so the assertion below is clock-independent.
  useSelector: vi.fn().mockReturnValue({
    config: { requiresConfiguration: false, season: 'SUMMER', year: 2026 },
  }),
  createStore: vi.fn(),
}));

import { JoinScreen } from '../../../../web/app/src/components/screens/Join';

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    { connectionStatus: 'connected', ...slice },
    dispatch,
  ]);
};

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-05T12:00:00'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('JoinScreen (passwordless)', () => {
  it('renders name + room fields and the season label -- no password anywhere', () => {
    render(<JoinScreen />);
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.getByLabelText('Room name')).toBeDefined();
    expect(screen.getByText(/SUMMER 2026/)).toBeDefined();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('submits a login and remembers the room (lowercased)', () => {
    render(<JoinScreen />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'User1' } });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Couch-Coop' } });
    fireEvent.click(screen.getByText('open the room'));
    // Room persistence rides the chooseRoom dispatch side-effect now
    // (audit v1.2.0 #4) -- the store layer owns the localStorage write.
    expect(dispatch).toHaveBeenCalledWith({ type: 'chooseRoom', payload: { roomName: 'couch-coop' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'login', payload: { userName: 'User1' } });
  });

  it('prefills from localStorage', () => {
    localStorage.setItem('courName', 'user1');
    localStorage.setItem('courRoom', 'couch-coop');
    render(<JoinScreen />);
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('user1');
    expect((screen.getByLabelText('Room name') as HTMLInputElement).value).toBe('couch-coop');
  });

  it('disables the CTA until both fields are filled and the socket is up', () => {
    withState({ connectionStatus: 'connecting' });
    render(<JoinScreen />);
    const cta = screen.getByText(/connecting/).closest('button') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    cleanup();
    withState();
    render(<JoinScreen />);
    const cta2 = screen.getByText('open the room').closest('button') as HTMLButtonElement;
    expect(cta2.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'user1' } });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'r' } });
    expect(cta2.disabled).toBe(false);
  });

  it('shows join errors even without a submit in this mount (audit 17 M8)', () => {
    // The auto-rejoin's UsernameTakenError (second device, same stored
    // name) lands on a FRESH join form -- the old submit gate hid it.
    withState({ joinError: 'Names are 1 to 32 characters.' });
    render(<JoinScreen />);
    expect(screen.getByRole('alert').textContent).toContain('1 to 32');
  });

  it('submitting dispatches chooseRoom (typed room beats the deep link) then login', () => {
    render(<JoinScreen />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'user1' } });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'My Room' } });
    fireEvent.click(screen.getByText('open the room'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'chooseRoom', payload: { roomName: 'my room' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'login', payload: { userName: 'user1' } });
  });

  it('the submit button resolves a real CSS-module class (audit v1.2.0 #1)', () => {
    // styles.submitBtn resolved undefined (module only defines
    // .ctaButton), shipping an unstyled primary button on the first
    // screen. Typecheck can't catch a CSS-module key typo; this can.
    render(<JoinScreen />);
    const btn = screen.getByRole('button', { name: /open the room|connecting/ });
    expect(btn.className).toContain('ctaButton');
  });

  it('renders the seasonal kanji watermark, hidden from AT', () => {
    render(<JoinScreen />);
    const kanji = screen.getAllByText('夏').find(
      (el) => el.closest('[aria-hidden="true"]') !== null,
    );
    expect(kanji).toBeDefined();
  });
});
