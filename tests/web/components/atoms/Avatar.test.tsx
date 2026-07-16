// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Avatar } from '../../../../web/app/src/components/atoms/Avatar';

afterEach(() => {
  cleanup();
});

describe('Avatar', () => {
  it('renders the userName\'s first letter uppercased when no avatarUrl is provided', () => {
    const { container } = render(<Avatar userName="user1" />);
    const text = container.querySelector('text');
    expect(text?.textContent).toBe('U');
  });

  it('uses the first letter of the original name (not display-truncated)', () => {
    const { container } = render(<Avatar userName="user-name-13-x" />);
    expect(container.querySelector('text')?.textContent).toBe('U');
  });

  // SCAFFOLDING branch -- paired with User.avatarImage in types/reely.ts.
  // Plex doesn't expose per-user avatars so this branch is unreachable
  // under the current single-provider build, but the test pins the
  // intended Emby/JF behavior so a future audit doesn't strip the code.
  it('renders an <image> from avatarUrl when provided AND omits the letter fallback', () => {
    const { container } = render(<Avatar userName="user1" avatarUrl="http://example/a.png" />);
    const image = container.querySelector('image');
    expect(image).not.toBeNull();
    // jsdom doesn't always project SVG attrs via xlink:href the same way as
    // the browser; xlinkHref is the React prop name and lands as either
    // xlink:href or href on the rendered element. Accept either.
    const href = image?.getAttribute('xlink:href') ?? image?.getAttribute('href');
    expect(href).toBe('http://example/a.png');
    // Letter fallback should NOT render when avatarUrl is present.
    expect(container.querySelector('text')).toBeNull();
  });

  it('renders the progress ring only when progress > 0', () => {
    // progress=0: no progress ring (only the base avatar circle).
    const zero = render(<Avatar userName="user1" />);
    // Two circles render: the base and the mask. NO progress circle.
    expect(zero.container.querySelectorAll('circle').length).toBe(2);
    cleanup();

    const nonzero = render(<Avatar userName="user1" progress={50} />);
    // Three circles render with progress > 0 (base + mask + progress ring).
    expect(nonzero.container.querySelectorAll('circle').length).toBe(3);
  });

  it('injects --hue and --progress as inline CSS variables', () => {
    const { container } = render(<Avatar userName="user1" progress={75} />);
    const svg = container.querySelector('svg');
    const style = svg?.getAttribute('style') ?? '';
    // userHue('user1') = 276 (digits don't contribute; locked hash in tests/web/userHue.test.ts).
    expect(style).toContain('--hue: 276');
    expect(style).toContain('--progress: 75');
  });

  // useId per-render -- two Avatars on the same page must NOT collide on
  // their mask id (SVG ids are global; the prior Date.now() scheme
  // collided when two Avatars rendered in the same millisecond, regen'd
  // every render). Same audit class as Logo #195.
  it('gives each Avatar a unique mask id (useId per render)', () => {
    const { container: a } = render(<Avatar userName="user1" />);
    const { container: b } = render(<Avatar userName="user2" />);
    const maskA = a.querySelector('mask')?.getAttribute('id');
    const maskB = b.querySelector('mask')?.getAttribute('id');
    expect(maskA).toBeTruthy();
    expect(maskB).toBeTruthy();
    expect(maskA).not.toBe(maskB);
  });

  it('is marked aria-hidden (decorative -- name is in the surrounding label)', () => {
    const { container } = render(<Avatar userName="user1" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
