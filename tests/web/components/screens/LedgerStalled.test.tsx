// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const dispatch = vi.fn();
vi.mock('../../../../web/app/src/store', () => ({
  useDispatch: () => dispatch,
}));

import { LedgerStalled } from '../../../../web/app/src/components/screens/LedgerStalled';

afterEach(() => {
  cleanup();
  dispatch.mockClear();
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
});
