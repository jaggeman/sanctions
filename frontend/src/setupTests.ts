import '@testing-library/jest-dom';

// jsdom has no layout engine, so MUI's useMediaQuery (which calls
// window.matchMedia) has nothing to call without this. Defaults every query
// to non-matching (desktop-sized); tests that need a narrow viewport
// override window.matchMedia per-test.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

if (typeof window !== 'undefined' && (!window.localStorage || typeof window.localStorage.getItem !== 'function')) {
  let store: Record<string, string> = {};
  const mockLocalStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  Object.defineProperty(window, 'localStorage', { value: mockLocalStorage, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });
}
