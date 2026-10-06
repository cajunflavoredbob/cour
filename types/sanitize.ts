// Name rules shared by the server's sanitizers
// (internal/app/reely/util/sanitize.ts) and the web client.

// Room-name allowlist: letters, digits, spaces, and a small set of
// common punctuation that's URL- and filesystem-safe. The /i flag
// covers A-Z and a-z without spelling out the case range. Anything
// outside this set is stripped (`# ? "` and any control bytes are
// the main concerns).
export const ROOM_NAME_ALLOWLIST = /[^a-z0-9 !@$\-_']/gi;

// Cap on canonical room names (server-enforced via
// sanitizeRoomNameDisplay; web inputs use the same value for parity
// via the room-name input element's maxLength attribute).
export const ROOM_NAME_MAX_LEN = 48;

// Characters a new user name must not carry: C0 and C1 controls, bidi
// formatting characters and marks (they reorder the text drawn around the
// name), and invisible characters (zero-width space, word joiner, BOM, soft
// hyphen, combining grapheme joiner, invisible operators, fillers). ZWJ and
// ZWNJ stay inside a name, since emoji sequences and some scripts need them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const USER_NAME_STRIP = /[\x00-\x1f\x7f-\x9f\u{00AD}\u{061C}\u{115F}\u{1160}\u{180E}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{3164}\u{FEFF}\u{FFA0}]|\u{034F}/gu;
// Whitespace and joiners, trimmed from either end; a joiner there joins nothing.
const isNameEdge = (unit: string) => unit === '\u200C' || unit === '\u200D' || /\s/u.test(unit);

// A new user name without those characters, trimmed (in linear time).
export const sanitizeUserName = (raw: string): string => {
  const name = raw.replace(USER_NAME_STRIP, '');
  let start = 0;
  let end = name.length;
  while (start < end && isNameEdge(name[start])) start++;
  while (end > start && isNameEdge(name[end - 1])) end--;
  return name.slice(start, end);
};

// Display form of a room name -- what the UI shows. Trim and apply the
// allowlist but preserve case. Returns the empty string if the input has
// no valid characters.
export const sanitizeRoomNameDisplay = (raw: string): string =>
  raw
    .replace(ROOM_NAME_ALLOWLIST, '')
    .replace(/\s+/g, ' ')  // collapse internal whitespace runs
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN)
    // The cut can land just after a space.
    .trimEnd();

// Canonical form -- used as Map key, filename, and URL parameter value.
// Lowercased so case-variant inputs ("Movie Night" / "MOVIE NIGHT") match
// the same room.
export const sanitizeRoomNameCanonical = (raw: string): string =>
  sanitizeRoomNameDisplay(raw).toLowerCase();
