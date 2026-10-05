// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const dispatch = vi.fn();
const { connection } = vi.hoisted(() => ({
  connection: { current: { connectionStatus: 'connected', rejoining: undefined as boolean | undefined } },
}));
vi.mock('../../../../web/app/src/store', () => ({
  useDispatch: () => dispatch,
  useSelector: () => connection.current,
}));

import { LedgerStalled } from '../../../../web/app/src/components/screens/LedgerStalled';

afterEach(() => {
  cleanup();
  dispatch.mockClear();
  connection.current = { connectionStatus: 'connected', rejoining: undefined };
});

describe('LedgerStalled', () => {
  it('says what happened in plain sentences', () => {
    render(<LedgerStalled />);
    expect(screen.getByRole('alert').textContent).toContain(
      "The server isn't answering the review request. It may be restarting. Try again in a moment.",
    );
  });

  it('retries the review fetch', () => {
    render(<LedgerStalled />);
    fireEvent.click(screen.getByText('try again'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'review' });
  });

  it('holds the retry until the room is rejoined', () => {
    connection.current = { connectionStatus: 'connected', rejoining: true };
    render(<LedgerStalled />);
    const retry = screen.getByText('try again') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds the retry while disconnected', () => {
    connection.current = { connectionStatus: 'disconnected', rejoining: undefined };
    render(<LedgerStalled />);
    expect((screen.getByText('try again') as HTMLButtonElement).disabled).toBe(true);
  });
});
