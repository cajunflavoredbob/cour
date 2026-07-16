import { describe, expect, it } from 'vitest';
import { userHue } from '../../web/app/src/utils/userHue';

// Stable per-username hue for the Avatar / UserPill / UsersPopup color.
// Pure function: same input -> same output, no state, no globals. The
// tests pin the EXACT output for representative names so a future hash
// change is caught and signals a user-visible recolor of every existing
// avatar in every existing room (a big deal -- the recolor would break
// recognition mid-session).

describe('userHue', () => {
  it('returns a number in [0, 359]', () => {
    for (const name of ['user-a', 'user-b', 'k-xy', 'user-name-x', 'Z', 'a']) {
      const h = userHue(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('is deterministic (same name -> same hue across calls)', () => {
    expect(userHue('user-a')).toBe(userHue('user-a'));
    expect(userHue('k-xy')).toBe(userHue('k-xy'));
  });

  it('is case-insensitive (upper/lower of the same name -> same hue)', () => {
    expect(userHue('USER-A')).toBe(userHue('user-a'));
    expect(userHue('K-XY')).toBe(userHue('k-xy'));
  });

  // Audit 12 #265 / audit 13 #336: hyphens are KEPT in the hash because
  // real usernames have them; stripping them would mid-session-recolor
  // every hyphenated user. Other punctuation / whitespace must NOT
  // contribute (so `"user-a "` and `"user-a"` collide; trailing space
  // shouldn't recolor).
  it('keeps hyphens in the hash (audit 12 #265)', () => {
    // The hyphen is a contributing character, so these MUST differ.
    expect(userHue('kxy')).not.toBe(userHue('k-xy'));
  });

  it('strips whitespace and other punctuation (collides into the bare name)', () => {
    expect(userHue('user-a ')).toBe(userHue('user-a'));
    expect(userHue('us.er-a')).toBe(userHue('user-a'));
    expect(userHue('us!er-a?')).toBe(userHue('user-a'));
  });

  it('returns 0 for an empty string (no characters reduce -> initial acc)', () => {
    expect(userHue('')).toBe(0);
  });

  // Lock the specific hash outputs for representative names. A future
  // refactor that changes any of these would mid-session-recolor every
  // existing user with that name in every existing room (mid-game
  // recognition broken). Test failure here means: bump the locked
  // values, add a CHANGELOG note, and consult on UX.
  it('produces the locked-in hue values for representative names', () => {
    expect(userHue('user-a')).toBe(231);
    expect(userHue('user-b')).toBe(267);
    // Hyphen contributes; 'kxy' and 'k-xy' must land on different hues.
    expect(userHue('kxy')).not.toBe(userHue('k-xy'));
  });
});
