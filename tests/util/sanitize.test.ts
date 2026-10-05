import { describe, it, expect } from 'vitest';
import {
  sanitizeRoomNameCanonical,
  sanitizeRoomNameDisplay,
  sanitizeUserName,
} from '../../internal/app/reely/util/sanitize';

describe('sanitizeUserName', () => {
  it('passes ordinary names through, trimmed', () => {
    expect(sanitizeUserName('  user1  ')).toBe('user1');
    expect(sanitizeUserName('AC/DC')).toBe('AC/DC');
    expect(sanitizeUserName('dot.name')).toBe('dot.name');
    expect(sanitizeUserName('user3\u{1F525}')).toBe('user3\u{1F525}');
  });

  it('strips control characters', () => {
    expect(sanitizeUserName('foo\x00bar')).toBe('foobar');
    expect(sanitizeUserName('foo\x1fbar')).toBe('foobar');
    expect(sanitizeUserName('foo\x7fbar')).toBe('foobar');
    expect(sanitizeUserName('\t\ntest\r')).toBe('test');
  });

  it('strips bidi overrides and isolates', () => {
    expect(sanitizeUserName('user1\u{202E}tail')).toBe('user1tail');
    expect(sanitizeUserName('\u{202A}\u{202B}\u{202C}\u{202D}name')).toBe('name');
    expect(sanitizeUserName('user1\u{2066}\u{2067}\u{2068}\u{2069}')).toBe('user1');
  });

  it('strips zero-width spaces, word joiners and byte-order marks', () => {
    expect(sanitizeUserName('user1\u{200B}extra')).toBe('user1extra');
    expect(sanitizeUserName('user1\u{2060}extra')).toBe('user1extra');
    expect(sanitizeUserName('\u{FEFF}user1')).toBe('user1');
  });

  it('strips other invisible and formatting characters', () => {
    expect(sanitizeUserName('user1\u{00AD}')).toBe('user1');
    expect(sanitizeUserName('\u{200E}user1\u{200F}')).toBe('user1');
    expect(sanitizeUserName('user1\u{061C}\u{034F}')).toBe('user1');
    expect(sanitizeUserName('user1\u{0085}')).toBe('user1');
    expect(sanitizeUserName('user1\u{2061}\u{206A}')).toBe('user1');
    expect(sanitizeUserName('\u{3164}\u{FFA0}\u{115F}user1\u{180E}')).toBe('user1');
  });

  it('keeps the joiners that emoji sequences and scripts need inside a name', () => {
    const flag = '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}';
    expect(sanitizeUserName(flag)).toBe(flag);
    const zwnj = 'mi\u{200C}name';
    expect(sanitizeUserName(zwnj)).toBe(zwnj);
  });

  it('trims in linear time, whatever runs of spaces sit inside', () => {
    const name = `a${' '.repeat(60_000)}a`;
    const started = performance.now();
    expect(sanitizeUserName(` ${name} `)).toBe(name);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('drops joiners at either end, where they join nothing', () => {
    expect(sanitizeUserName('\u{200D}user1\u{200C}')).toBe('user1');
    expect(sanitizeUserName(' \u{200D} user1 \u{200C} ')).toBe('user1');
  });

  it('returns an empty string for a name made only of stripped characters', () => {
    expect(sanitizeUserName('\u{202E}\u{200B} \x00')).toBe('');
  });
});

describe('sanitizeRoomNameDisplay', () => {
  it('preserves case', () => {
    expect(sanitizeRoomNameDisplay('Movie Night')).toBe('Movie Night');
    expect(sanitizeRoomNameDisplay("Movie Night's Best")).toBe("Movie Night's Best");
  });

  it('keeps the allowlisted punctuation set', () => {
    expect(sanitizeRoomNameDisplay("!@$-_'")).toBe("!@$-_'");
  });

  it("strips disallowed characters (# ? \" and friends)", () => {
    expect(sanitizeRoomNameDisplay('What#room')).toBe('Whatroom');
    expect(sanitizeRoomNameDisplay('hi?')).toBe('hi');
    expect(sanitizeRoomNameDisplay('say "hi"')).toBe('say hi');
    expect(sanitizeRoomNameDisplay('a&b')).toBe('ab');
    expect(sanitizeRoomNameDisplay('a.b')).toBe('ab');
    expect(sanitizeRoomNameDisplay('a,b')).toBe('ab');
  });

  it('strips control bytes and path-traversal-flavored characters', () => {
    expect(sanitizeRoomNameDisplay('foo\x00bar')).toBe('foobar');
    expect(sanitizeRoomNameDisplay('foo/bar')).toBe('foobar');
    expect(sanitizeRoomNameDisplay('foo\\bar')).toBe('foobar');
  });

  it('collapses internal whitespace runs and trims edges', () => {
    expect(sanitizeRoomNameDisplay('  movie   night  ')).toBe('movie night');
  });

  it('strips tabs / newlines entirely (not in allowlist)', () => {
    // The allowlist accepts the literal space char but not other whitespace.
    // Adjacent tabs disappear rather than collapsing to a space.
    expect(sanitizeRoomNameDisplay('a\t\tb')).toBe('ab');
    expect(sanitizeRoomNameDisplay('foo\nbar')).toBe('foobar');
  });

  it('caps at 48 chars', () => {
    expect(sanitizeRoomNameDisplay('a'.repeat(100))).toBe('a'.repeat(48));
  });

  it('returns empty for entirely-invalid input', () => {
    expect(sanitizeRoomNameDisplay('###???"""')).toBe('');
  });
});

describe('sanitizeRoomNameCanonical', () => {
  it('lowercases the display form', () => {
    expect(sanitizeRoomNameCanonical('Movie Night')).toBe('movie night');
    expect(sanitizeRoomNameCanonical('SHOUTING')).toBe('shouting');
  });

  it('mirrors the display sanitizer otherwise', () => {
    expect(sanitizeRoomNameCanonical("Movie Night's Best!")).toBe("movie night's best!");
    expect(sanitizeRoomNameCanonical('What#Up?')).toBe('whatup');
    expect(sanitizeRoomNameCanonical('foo/bar')).toBe('foobar');
  });

  it('is idempotent', () => {
    const out = sanitizeRoomNameCanonical("Movie Night's Best!");
    expect(sanitizeRoomNameCanonical(out)).toBe(out);
  });

  it('returns empty for entirely-invalid input', () => {
    expect(sanitizeRoomNameCanonical('###?')).toBe('');
  });
});
