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

export const getStoredName = (): string | undefined =>
  localStorage.getItem(NAME_KEY) ?? undefined;

export const setStoredName = (name: string): void => {
  localStorage.setItem(NAME_KEY, name);
};

export const getStoredRoom = (): string | undefined =>
  localStorage.getItem(ROOM_KEY) ?? undefined;

export const setStoredRoom = (roomName: string): void => {
  localStorage.setItem(ROOM_KEY, roomName);
};

export const clearStoredRoom = (): void => {
  localStorage.removeItem(ROOM_KEY);
};

export const getStoredSoundPref = (): boolean =>
  localStorage.getItem(SOUND_KEY) === "1";

export const setStoredSoundPref = (enabled: boolean): void => {
  localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
};

// First-login tutorial (audit 17): shown once per browser.
export const getStoredTutorialSeen = (): boolean =>
  localStorage.getItem(TUTORIAL_KEY) === "1";

export const setStoredTutorialSeen = (): void => {
  localStorage.setItem(TUTORIAL_KEY, "1");
};
