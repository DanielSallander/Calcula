//! FILENAME: app/vitest.setup.ts
// PURPOSE: jsdom shims for APIs that monaco-editor expects at import time.
// CONTEXT: MenuBar.tsx (script editor on menu tabs) pulls monaco into the
//          module graph of many tests; jsdom lacks the legacy clipboard API.

if (typeof document !== "undefined" && !document.queryCommandSupported) {
  document.queryCommandSupported = () => false;
}

// monaco also probes matchMedia in some contributions; jsdom lacks it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
