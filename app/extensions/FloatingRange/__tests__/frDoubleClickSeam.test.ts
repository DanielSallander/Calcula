//! FILENAME: app/extensions/FloatingRange/__tests__/frDoubleClickSeam.test.ts
// PURPOSE: The Floating Range's double-click, routed through Core's generic
//          overlay seam (`OverlayRegistration.onDoubleClick`, @api/gridOverlays)
//          instead of being inferred from two `floatingObject:bodyDragStart`
//          events within 350 ms.
//
// CONTEXT: The old workaround is the reason the seam had to be feature-neutral.
//          It only ever fired because the FR opts into `claimsBodyDrag` — an
//          overlay that does not claim body drags could not have written it at
//          all — and a timer cannot tell a double-click from two deliberate
//          clicks a third of a second apart. The zone rules survive the move:
//          only a CELL opens an editor, and a reference pick never does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const openFrEditor = vi.fn();

vi.mock("../editor/frEditor", () => ({
  openFrEditor: (...args: unknown[]) => openFrEditor(...args),
  cancelFrEditor: vi.fn(),
  commitFrEditor: vi.fn(),
  getFrEditorCell: vi.fn(() => null),
  isFrEditorOpen: vi.fn(() => false),
  destroyFrEditor: vi.fn(),
}));

const isGlobalFormulaMode = vi.fn(() => false);
const getExternalFormulaTarget = vi.fn((): unknown => null);

vi.mock("@api/editing", () => ({
  isGlobalFormulaMode: () => isGlobalFormulaMode(),
  getGlobalIsEditing: () => false,
  insertTextIntoActiveFormula: vi.fn(),
  getExternalFormulaTarget: () => getExternalFormulaTarget(),
}));

import { handleFrDoubleClick } from "../index";
import { upsertFromInfo, resetFloatingRangeStore, FLOATING_RANGE_REGION_TYPE } from "../lib/floatingRangeStore";
import { getLocalSelection, clearLocalSelection } from "../lib/frSelection";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion, OverlayHitTestContext } from "@api/gridOverlays";

const FR_ID = "fr-uuid-1";

const INFO: FloatingRangeInfo = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 100,
  y: 100,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

/** Frame origin on the canvas; the frame's own chrome is 20px title + 16px header. */
const BOUNDS = { x: 150, y: 120, width: 300, height: 200 };

function ctxAt(dx: number, dy: number): OverlayHitTestContext {
  const region: GridRegion = {
    id: "fr-" + FR_ID,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width: BOUNDS.width, height: BOUNDS.height },
    data: { frId: FR_ID },
  };
  return {
    region,
    canvasX: BOUNDS.x + dx,
    canvasY: BOUNDS.y + dy,
    row: 0,
    col: 0,
    floatingCanvasBounds: BOUNDS,
  };
}

/** Dead centre of local cell (0,0): past the 28px row gutter and 36px of chrome. */
const CELL_00 = { dx: 28 + 10, dy: 20 + 16 + 10 };
/** The title bar. */
const TITLE = { dx: 60, dy: 8 };

beforeEach(() => {
  openFrEditor.mockClear();
  isGlobalFormulaMode.mockReturnValue(false);
  getExternalFormulaTarget.mockReturnValue(null);
  resetFloatingRangeStore();
  clearLocalSelection();
  upsertFromInfo(INFO);
});

afterEach(() => {
  resetFloatingRangeStore();
  clearLocalSelection();
});

describe("the FR double-click arrives through the overlay seam", () => {
  it("opens the editor on the cell that was double-clicked", () => {
    expect(handleFrDoubleClick(ctxAt(CELL_00.dx, CELL_00.dy))).toBe(true);
    expect(openFrEditor).toHaveBeenCalledWith(FR_ID, 0, 0, null);
    expect(getLocalSelection()).toEqual({
      frId: FR_ID,
      anchorRow: 0,
      anchorCol: 0,
      endRow: 0,
      endCol: 0,
    });
  });

  it("takes a SECOND cell without any timer to reset", () => {
    // The old workaround stored one {cell, timestamp} slot and had to clear it
    // by hand on every zone change; two double-clicks in a row on different
    // cells were exactly what it got wrong.
    handleFrDoubleClick(ctxAt(CELL_00.dx, CELL_00.dy));
    const secondRow = ctxAt(CELL_00.dx, CELL_00.dy + 20);
    expect(handleFrDoubleClick(secondRow)).toBe(true);
    expect(openFrEditor).toHaveBeenLastCalledWith(FR_ID, 1, 0, null);
  });

  it("declines the title bar, so Core keeps its own behaviour there", () => {
    expect(handleFrDoubleClick(ctxAt(TITLE.dx, TITLE.dy))).toBe(false);
    expect(openFrEditor).not.toHaveBeenCalled();
  });

  it("declines while a formula is expecting a reference", () => {
    isGlobalFormulaMode.mockReturnValue(true);
    expect(handleFrDoubleClick(ctxAt(CELL_00.dx, CELL_00.dy))).toBe(false);
    expect(openFrEditor).not.toHaveBeenCalled();
  });

  it("declines while an EXTERNAL editor is expecting a reference", () => {
    getExternalFormulaTarget.mockReturnValue({ isExpectingReference: () => true });
    expect(handleFrDoubleClick(ctxAt(CELL_00.dx, CELL_00.dy))).toBe(false);
    expect(openFrEditor).not.toHaveBeenCalled();
  });

  it("declines a region whose floating range is gone", () => {
    resetFloatingRangeStore();
    expect(handleFrDoubleClick(ctxAt(CELL_00.dx, CELL_00.dy))).toBe(false);
    expect(openFrEditor).not.toHaveBeenCalled();
  });
});

// NOTE ON WHAT IS *NOT* ASSERTED HERE: an earlier draft of this file dispatched
// two `floatingObject:bodyDragStart` events and asserted no editor opened, as
// "proof" the 350 ms workaround is gone. That assertion was a no-op — the
// listener it aimed at is installed by `activate()`, which a unit test never
// calls, so it passed with the workaround fully intact. A guard that cannot go
// red is worse than no guard, so it was deleted rather than kept for comfort.
