// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Loading } from '../../../../web/app/src/components/screens/Loading';

// Loading is a full-viewport branded loader: the stylized wordmark (the
// mark is the c) pulses in opacity. Pure presentation; no props, no deps.

afterEach(() => {
  cleanup();
});

describe('Loading', () => {
  it('renders the stylized wordmark: the full dotted mark, then "our"', () => {
    const { container } = render(<Loading />);
    expect(screen.getByText('our')).toBeDefined();
    expect(container.querySelectorAll('svg circle').length).toBeGreaterThan(0);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('58');
  });

  // role=status so assistive tech announces the loading state without
  // shifting focus; aria-label gives the spoken description because the
  // wordmark itself is decorative (aria-hidden).
  it('exposes a status role with the "Loading cour" label', () => {
    const { container } = render(<Loading />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('Loading cour');
  });

  it('marks the wordmark itself as aria-hidden (decorative -- the status role owns the label)', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });
});
