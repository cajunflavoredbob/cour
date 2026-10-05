// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PillTabs, tabPanelProps } from '../../../../web/app/src/components/molecules/PillTabs';

type Pile = 'like' | 'skip' | 'dislike';

const Harness = () => {
  const [active, setActive] = useState<Pile>('like');
  return (
    <>
      <PillTabs
        label="Piles"
        idPrefix="piles"
        tabs={[
          { id: 'like', label: 'Kept 3' },
          { id: 'skip', label: 'Unsure 1' },
          { id: 'dislike', label: 'Passed 2' },
        ]}
        active={active}
        onSelect={setActive}
      />
      <div {...tabPanelProps('piles', active)}>{active}</div>
    </>
  );
};

afterEach(cleanup);

describe('PillTabs', () => {
  it('is a named tab list whose selected tab labels the panel', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Piles');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual(['piles-panel', 'piles-panel', 'piles-panel']);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0].id);
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[2].id);
  });

  it('is one tab stop, moved with the arrows, Home and End', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('keeps the keys it handles from scrolling the page, and leaves the rest alone', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    // fireEvent returns false once the default was prevented.
    expect(fireEvent.keyDown(tabs[0], { key: 'End' })).toBe(false);
    expect(fireEvent.keyDown(tabs[2], { key: 'ArrowDown' })).toBe(true);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    // Alt+Left is the browser's Back.
    expect(fireEvent.keyDown(tabs[2], { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  });
});
