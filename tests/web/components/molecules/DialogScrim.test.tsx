// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DialogScrim } from '../../../../web/app/src/components/molecules/DialogScrim';

// An opener button and the dialog it opens, optionally with a control that
// focuses itself (as the share-room link input does).
const Harness = ({ autoFocusInside = false }: { autoFocusInside?: boolean }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <DialogScrim label="Test dialog" onDismiss={() => setOpen(false)} backdropClassName="b" dialogClassName="d">
          {/* biome-ignore lint/a11y/noAutofocus: the case under test. */}
          {autoFocusInside && <input aria-label="Link" autoFocus readOnly />}
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </DialogScrim>
      )}
    </>
  );
};

const opener = () => screen.getByText('Open');
const openDialog = () => {
  opener().focus();
  fireEvent.click(opener());
};

afterEach(cleanup);

describe('DialogScrim', () => {
  it('takes focus when it opens and gives it back to the opener when it closes', () => {
    render(<Harness />);
    openDialog();
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));
    fireEvent.click(screen.getByText('Done'));
    expect(document.activeElement).toBe(opener());
  });

  it('gives focus back to the opener past a control that focused itself', () => {
    render(<Harness autoFocusInside />);
    openDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Link'));
    fireEvent.click(screen.getByText('Done'));
    expect(document.activeElement).toBe(opener());
  });

  it('keeps and gives back focus the same way under StrictMode', () => {
    render(
      <StrictMode>
        <Harness autoFocusInside />
      </StrictMode>,
    );
    openDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Link'));
    fireEvent.click(screen.getByText('Done'));
    expect(document.activeElement).toBe(opener());
  });

  it('cycles Tab and Shift+Tab through its controls, never stopping on the dialog itself', () => {
    render(
      <DialogScrim label="Test dialog" onDismiss={() => {}} backdropClassName="b" dialogClassName="d">
        <button type="button">First</button>
        <button type="button">Last</button>
        <button type="button" disabled>
          Off
        </button>
      </DialogScrim>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(document.activeElement).toBe(dialog);
    // Shift+Tab from the dialog itself lands on the last control that can
    // take focus, past the disabled one after it.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('Last'));
    // Tab past the last control wraps to the first.
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('First'));
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('Last'));
  });

  it('holds Tab on the dialog when it has no controls', () => {
    render(
      <DialogScrim label="Test dialog" onDismiss={() => {}} backdropClassName="b" dialogClassName="d">
        <p>Body</p>
      </DialogScrim>,
    );
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));
  });

  it('dismisses on Escape and on a backdrop click, not on a click inside', () => {
    const onDismiss = vi.fn();
    render(
      <DialogScrim label="Test dialog" onDismiss={onDismiss} backdropClassName="b" dialogClassName="d">
        <p>Body</p>
      </DialogScrim>,
    );
    fireEvent.click(screen.getByText('Body'));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-test-handle="dialog-backdrop"]') as HTMLElement);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('stays open for the second click of the double-click that opened it', () => {
    const onDismiss = vi.fn();
    render(
      <DialogScrim label="Test dialog" onDismiss={onDismiss} backdropClassName="b" dialogClassName="d">
        <p>Body</p>
      </DialogScrim>,
    );
    const backdrop = document.querySelector('[data-test-handle="dialog-backdrop"]') as HTMLElement;
    fireEvent.click(backdrop, { detail: 2 });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(backdrop, { detail: 1 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
