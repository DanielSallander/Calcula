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

// ---------------------------------------------------------------------------
// SVG geometry, for the relationship diagram
// ---------------------------------------------------------------------------
//
// jsdom implements the SVG DOM but none of its GEOMETRY: `createSVGPoint`,
// `getScreenCTM` and `getBBox` are simply absent, and every element reports
// `clientWidth`/`clientHeight` of 0. The Model Editor's relationship diagram
// calls the first two on EVERY mouse event (`svgPoint` in
// RelationshipDiagram.tsx) and the third when fitting to the viewport, so
// without these shims none of its interaction can be tested at all — which is
// why it had 401 lines of pure-function tests and not one component test.
//
// The shims are deliberately IDENTITY transforms, not a layout engine. They let
// a test drive a drag and assert on the coordinates that came out; they do not
// pretend jsdom can lay out an SVG, so a test that depends on real geometry
// will read zeroes and should be a browser test instead. Anything cleverer here
// would be a second, wrong renderer that tests would slowly come to trust.
if (typeof window !== "undefined" && typeof SVGSVGElement !== "undefined") {
  const proto = SVGSVGElement.prototype as unknown as Record<string, unknown>;
  if (!proto.createSVGPoint) {
    proto.createSVGPoint = function createSVGPoint(): DOMPoint {
      const pt = {
        x: 0,
        y: 0,
        // The inverse of an identity CTM is an identity, so a point maps to
        // itself: a test drives clientX/clientY and reads the same numbers back
        // in layout space.
        matrixTransform: (_m: DOMMatrix) => ({ x: pt.x, y: pt.y }),
      };
      return pt as unknown as DOMPoint;
    };
  }
  const elemProto = SVGElement.prototype as unknown as Record<string, unknown>;
  if (!elemProto.getScreenCTM) {
    elemProto.getScreenCTM = function getScreenCTM(): DOMMatrix {
      return { inverse: () => ({}) } as unknown as DOMMatrix;
    };
  }
  if (!elemProto.getBBox) {
    elemProto.getBBox = function getBBox(): DOMRect {
      return { x: 0, y: 0, width: 0, height: 0 } as DOMRect;
    };
  }
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
