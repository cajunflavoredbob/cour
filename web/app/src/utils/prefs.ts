/**
 * Local preferences (0.12.0: the passwordless model). The browser
 * remembers WHO you are and WHERE you sit -- there is no token, no
 * session, nothing to protect. Autoplay preference lives here too
 * (it was a server-side account column when accounts existed).
 */

const NAME_KEY = "courName";
const ROOM_KEY = "courRoom";
const SOUND_KEY = "courAutoplaySound";
// V2 (1.1.2): the 1.1.0 build mistimed the tutorial over the join form,
// and dismissing THAT stored the old key -- so the properly-timed 1.1.1
// version never showed on any browser that saw the broken one. The key
// bump gives every such browser one correct showing. The old key is
// left behind, harmless.
const TUTORIAL_KEY = "courTutorialSeenV2";

// Storage can be entirely unavailable (cookies-blocked settings throw a
// SecurityError on the mere `window.localStorage` property access) or
// reject writes (private modes, zero quota). Preferences are best-effort
// nice-to-haves, so degrade to "no stored prefs" instead of letting a
// boot-time read white-screen the app before the join form ever renders.
const readItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort: the session still works, it just won't be remembered.
  }
};

const removeItem = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort, as above.
  }
};

export const getStoredName = (): string | undefined =>
  readItem(NAME_KEY) ?? undefined;

export const setStoredName = (name: string): void => {
  writeItem(NAME_KEY, name);
};

export const getStoredRoom = (): string | undefined =>
  readItem(ROOM_KEY) ?? undefined;

export const setStoredRoom = (roomName: string): void => {
  writeItem(ROOM_KEY, roomName);
};

export const clearStoredRoom = (): void => {
  removeItem(ROOM_KEY);
};

export const getStoredSoundPref = (): boolean =>
  readItem(SOUND_KEY) === "1";

export const setStoredSoundPref = (enabled: boolean): void => {
  writeItem(SOUND_KEY, enabled ? "1" : "0");
};

// First-login tutorial (audit 17): shown once per browser.
export const getStoredTutorialSeen = (): boolean =>
  readItem(TUTORIAL_KEY) === "1";

export const setStoredTutorialSeen = (): void => {
  writeItem(TUTORIAL_KEY, "1");
};
