//! FILENAME: app/src/core/hooks/useMouseSelection/layout/__tests__/overlayResizeGuard.test.ts
// PURPOSE: Core's FLOATING resize handles stand down (a) while a formula is
//          picking a reference -- in the grid's editor or an external one (a
//          floating grid's cell editor) -- and (b) for a press that landed on an
//          editable DOM control stacked on the canvas. Both mirror the move
//          path, which the resize scan runs BEFORE.
// CONTEXT: fr-move diagnosis, reviewer correction B. Once a floating grid's
//          handles are live outside Design Mode, a press in the lower-right of
//          another grid's last cell while typing "=" started a row/column count
//          resize instead of inserting "Float2!C5", and a press inside the open
//          cell editor at a frame corner was taken by Core (preventDefault ate
//          the caret placement). Driven through the REAL resize handlers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";

const snapshot = { sheetContext: { activeSheetIndex: 0 } };
vi.mock("../../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

let gridFormulaMode = false;
vi.mock("../../../useEditing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../useEditing")>()),
  isGlobalFormulaMode: () => gridFormulaMode,
}));

import { createOverlayResizeHandlers } from "../overlayResizeHandlers";
import { setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import { registerExternalFormulaTarget } from "../../../../lib/formulaEditTarget";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../../types";

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const RHW = DEFAULT_GRID_CONFIG.rowHeaderWidth ?? 50;
const CHH = DEFAULT_GRID_CONFIG.colHeaderHeight ?? 24;

function region(z?: number): GridRegion {
  return {
    id: "fr-1",
    type: "floating-range",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: { frId: "1", resizable: true },
    floating: { x: 70, y: 70, width: 100, height: 60 },
    ...(z === undefined ? {} : { z }),
  };
}

/** The bottom-right corner of the region, in canvas px. */
const CORNER = { x: RHW + 170, y: CHH + 130 };

function press(target: Element = document.createElement("canvas")): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    ctrlKey: false,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

function handlers() {
  return createOverlayResizeHandlers({
    config: DEFAULT_GRID_CONFIG,
    viewport: VIEWPORT,
    dimensions: undefined,
    freezeConfig: null,
    splitBarSize: 0,
    splitViewport: null,
    containerRef: { current: null },
    setIsOverlayResizing: vi.fn(),
    setCursorStyle: vi.fn(),
    overlayResizeStateRef: { current: null },
  } as unknown as Parameters<typeof createOverlayResizeHandlers>[0]);
}

let unregisterTarget: (() => void) | null = null;

beforeEach(() => {
  gridFormulaMode = false;
});

afterEach(() => {
  unregisterTarget?.();
  unregisterTarget = null;
  setGridRegions([]);
});

describe("floating resize handles stand down", () => {
  it("control: a plain press on the corner starts a resize (both scans)", () => {
    for (const z of [undefined, 3]) {
      setGridRegions([region(z)]);
      const h = handlers();
      expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)?.id).toBe("fr-1");
      expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
    }
  });

  it("while the GRID's formula is picking a reference (both scans)", () => {
    gridFormulaMode = true;
    for (const z of [undefined, 3]) {
      setGridRegions([region(z)]);
      const h = handlers();
      expect(h.checkOverlayResizeHandle(CORNER.x, CORNER.y)).toBeNull();
      const e = press();
      expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, e)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("while an EXTERNAL editor (a floating grid's cell editor) is picking a reference", () => {
    let expecting = true;
    unregisterTarget = registerExternalFormulaTarget({
      isExpectingReference: () => expecting,
      insertReference: vi.fn(),
    });
    setGridRegions([region()]);
    const h = handlers();
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(false);
    // The same editor, NOT expecting a reference: the handle is live again.
    expecting = false;
    expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, press())).toBe(true);
  });

  it("for a press that landed on an editable control stacked on the canvas", () => {
    setGridRegions([region()]);
    const h = handlers();
    for (const tag of ["textarea", "input", "select"]) {
      const e = press(document.createElement(tag));
      expect(h.handleOverlayResizeMouseDown(CORNER.x, CORNER.y, e)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});
