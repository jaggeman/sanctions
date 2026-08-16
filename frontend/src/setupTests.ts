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
