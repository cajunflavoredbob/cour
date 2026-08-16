// Node 26 ships experimental WebStorage: it defines `localStorage` /
// `sessionStorage` getters on globalThis that return undefined unless
// the process was started with --localstorage-file. Vitest's jsdom
// environment populates globals by copying jsdom window properties onto
// the node globalThis (and aliases `window` to that same globalThis),
// but it SKIPS keys globalThis already owns -- so on Node 26 the bare
// `localStorage` in component tests resolved to Node's undefined getter,
// jsdom's real storage was never copied anywhere reachable, and every
// access crashed with "Cannot read properties of undefined".
//
// Fix: when a DOM window is present (the jsdom environment) and the
// storage global is unusable, install a spec-shaped in-memory Storage.
// Fresh per test file (setup files run per worker file), which matches
// the isolation the jsdom-provided storage gave on Node 24. No-op in
// the default node environment and on Node majors without the getters.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.store.delete(String(key));
  }

  clear(): void {
    this.store.clear();
  }
}

if (typeof window !== 'undefined') {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if ((globalThis as Record<string, unknown>)[key] === undefined) {
      const storage = new MemoryStorage();
      // Node's getter is configurable, so it can be replaced in place.
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => storage,
      });
    }
  }
}
