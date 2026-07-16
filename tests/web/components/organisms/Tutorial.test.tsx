// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

let dispatch: ReturnType<typeof vi.fn>;
vi.mock('../../../../web/app/src/store', () => ({
  useDispatch: () => dispatch,
  useSelector: vi.fn(),
}));

import { Tutorial } from '../../../../web/app/src/components/organisms/Tutorial';

// First-login one-pager (audit 17, the owner's pick over deck undo).
describe('Tutorial', () => {
  beforeEach(() => {
    dispatch = vi.fn();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('explains the four beats: verdicts, skip-all hold, review, lock-then-rank', () => {
    render(<Tutorial />);
    expect(screen.getByText('how cour works')).toBeDefined();
    expect(screen.getByText('VERDICT THE SEASON')).toBeDefined();
    expect(screen.getByText('IN A HURRY?')).toBeDefined();
    expect(screen.getByText('NOTHING IS FINAL YET')).toBeDefined();
    expect(screen.getByText('LOCK IN, THEN RANK')).toBeDefined();
  });

  it('the CTA dismisses and stores the seen-flag', () => {
    render(<Tutorial />);
    fireEvent.click(screen.getByText('got it, deal me in'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'tutorial', payload: { open: false } });
    expect(localStorage.getItem('courTutorialSeen')).toBe('1');
  });

  it('Escape counts as seen too -- it must not come back next login', () => {
    render(<Tutorial />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'tutorial', payload: { open: false } });
    expect(localStorage.getItem('courTutorialSeen')).toBe('1');
  });
});
