import { describe, it, expect } from 'vitest';
import {
  sanitizeInput,
  sanitizeRoomNameCanonical,
  sanitizeRoomNameDisplay,
} from '../../internal/app/reely/util/sanitize';

describe('sanitizeInput', () => {
  it('passes clean strings through unchanged', () => {
    expect(sanitizeInput('hello')).toBe('hello');
    expect(sanitizeInput('My Room 123')).toBe('My Room 123');
    expect(sanitizeInput('movie-night_2')).toBe('movie-night_2');
  });

  it('strips forward and back slashes', () => {
    expect(sanitizeInput('foo/bar')).toBe('foobar');
    expect(sanitizeInput('foo\\bar')).toBe('foobar');
    expect(sanitizeInput('a/b\\c')).toBe('abc');
  });

  it('strips path traversal sequences', () => {
    expect(sanitizeInput('../..')).toBe('');
    expect(sanitizeInput('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeInput('foo/../bar')).toBe('foobar');
    expect(sanitizeInput('....//secret')).toBe('secret');
  });

  it('strips null bytes', () => {
    expect(sanitizeInput('foo\x00bar')).toBe('foobar');
    expect(sanitizeInput('\x00')).toBe('');
  });

  it('strips control characters', () => {
    expect(sanitizeInput('foo\x01bar')).toBe('foobar');
    expect(sanitizeInput('foo\x1fbar')).toBe('foobar');
    expect(sanitizeInput('foo\x7fbar')).toBe('foobar');
    expect(sanitizeInput('\t\ntest\r')).toBe('test'); // tabs/newlines are control chars; trim handles edges
  });

  // Audit 13 #292: Unicode bidi-override + isolate codepoints can
  // reverse rendering direction; an attacker can craft a username
  // that displays as "user1" but stores as something else (or vice
  // versa). Strip the whole U+202A-202E and U+2066-2069 range.
  it('strips Unicode bidi-override and isolate characters', () => {
    expect(sanitizeInput('user1\u{202E}tail')).toBe('user1tail');           // RLO
    expect(sanitizeInput('\u{202A}lefttoright')).toBe('lefttoright');     // LRE
    expect(sanitizeInput('\u{202B}righttoleft')).toBe('righttoleft');     // RLE
    expect(sanitizeInput('\u{202C}pop')).toBe('pop');                     // PDF
    expect(sanitizeInput('\u{202D}override')).toBe('override');           // LRO
    expect(sanitizeInput('user1\u{2066}isolate')).toBe('user1isolate');   // LRI
    expect(sanitizeInput('\u{2067}\u{2068}\u{2069}name')).toBe('name');   // RLI + FSI + PDI
  });

  // Zero-width characters and BOMs make "user1" + ZWSP + "extra"
  // visually identical to "user1" but compare unequal -- the classic
  // impersonation vector.
  it('strips zero-width characters and BOM', () => {
    expect(sanitizeInput('user1\u{200B}extra')).toBe('user1extra');       // ZWSP
    expect(sanitizeInput('user1\u{200C}')).toBe('user1');                  // ZWNJ
    expect(sanitizeInput('user1\u{200D}extra')).toBe('user1extra');       // ZWJ
    expect(sanitizeInput('user1\u{2060}extra')).toBe('user1extra');       // word joiner
    expect(sanitizeInput('\u{FEFF}user1')).toBe('user1');                  // BOM
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
    expect(sanitizeInput('  ')).toBe('');
  });

  it('enforces default maxLength of 64', () => {
    expect(sanitizeInput('a'.repeat(100))).toBe('a'.repeat(64));
    expect(sanitizeInput('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeInput('a'.repeat(63))).toBe('a'.repeat(63));
  });

  it('enforces a custom maxLength', () => {
    expect(sanitizeInput('abcdef', 3)).toBe('abc');
    expect(sanitizeInput('ab', 3)).toBe('ab');
  });

  it('applies maxLength after stripping, not before', () => {
    // '..abc' -> strip '..' -> 'abc'; slice to 2 -> 'ab'
    expect(sanitizeInput('..abc', 2)).toBe('ab');
  });

  it('returns empty string for input composed entirely of stripped characters', () => {
    expect(sanitizeInput('../../../')).toBe('');
    expect(sanitizeInput('/\\\x00\x1f')).toBe('');
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

// Audit 16 #440: the single-pass strip was non-idempotent -- removing a
// stripped character sitting between two dots reconstructed the literal
// '..' the pattern exists to remove. sanitizeInput now strips to a
// fixpoint via the shared stripDangerous helper.
describe('sanitizeInput strip idempotency (audit 16 #440)', () => {
  it.each([
    ['./.', ''],
    ['.\x00.', ''],
    // backslash between dots -- the '.\\.' case named in stripDangerous's
    // own comment (was mistyped '.\.' === '..', which tests dot-collapse
    // but not separator-between-dots)
    ['.\\.', ''],
    ['a./.b', 'ab'],
    ['a.​.b', 'ab'], // zero-width space between dots
    ['....//secret', 'secret'],
  ])('sanitizeInput(%j) contains no ".." (-> %j)', (input, expected) => {
    const out = sanitizeInput(input);
    expect(out).not.toContain('..');
    expect(out).toBe(expected);
  });
});
