// Room-name rules for the server's sanitizers
// (internal/app/reely/util/sanitize.ts).

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
