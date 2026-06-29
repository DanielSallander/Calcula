//! FILENAME: app/vitest.setup.ts
// PURPOSE: jsdom shims for APIs that monaco-editor expects at import time, plus a
//          global test double for the @api formula engine.
// CONTEXT: MenuBar.tsx (script editor on menu tabs) pulls monaco into the
//          module graph of many tests; jsdom lacks the legacy clipboard API.

import { vi } from "vitest";

// Chart filter/calculate evaluate expressions via the REAL Rust engine
// (@api/formulaEval evaluate_scoped, A6). That engine is Rust-over-IPC and not
// available in jsdom, so unit tests evaluate against a faithful Excel-subset
// ORACLE (vitest.fakeFormulaEngine) instead. @api/formulaEval is consumed only by
// the Charts extension, so mocking it globally is safe; real-engine parity is
// covered by the engine's Rust tests + e2e/visual-regression.
vi.mock("@api/formulaEval", async () => {
  const fake = await import("./vitest.fakeFormulaEngine");
  return {
    evaluateScoped: fake.fakeEvaluateScoped,
    evaluateExpression: fake.fakeEvaluateExpression,
  };
});

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
