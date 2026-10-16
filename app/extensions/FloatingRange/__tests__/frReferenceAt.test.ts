//! FILENAME: app/extensions/FloatingRange/__tests__/frReferenceAt.test.ts
// PURPOSE: The floating grid's answer to Core's reference-pick question
//          (`OverlayRegistration.referenceAt`, D-PICK): which CELL a pick names
//          at a point -- `{ space: "object", name: <the range's name>, row, col }`
//          over a cell, at the range's SCROLL (the scrolled cell, not the window
//          cell that used to sit there), and null over the title, the headers and
//          outside the frame (a press there during a pick is inert). PURE: no
//          selection write, no dispatch.
// CONTEXT: Core inserts the reference itself (useSpreadsheetSelection's
//          handleFloatingReferencePick); the range only names the cell. The
//          setup mirrors frDoubleClickSeam.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../editor/frEditor", () => ({
  openFrEditor: vi.fn(),
  cancelFrEditor: vi.fn(),
  commitFrEditor: vi.fn(),
  getFrEditorCell: vi.fn(() => null),
  getFrEditorSession: vi.fn(() => null),
  isFrEditorOpen: vi.fn(() => false),
  destroyFrEditor: vi.fn(),
}));

vi.mock("@api/editing", () => ({
  isGlobalFormulaMode: () => true,
  getGlobalIsEditing: () => false,
  insertTextIntoActiveFormula: vi.fn(),
  getExternalFormulaTarget: () => null,
  isFormulaReferencePickActive: () => true,
}));

import { frReferenceAt } from "../index";
import { upsertFromInfo, resetFloatingRangeStore, FLOATING_RANGE_REGION_TYPE } from "../lib/floatingRangeStore";
import { getLocalSelection, clearLocalSelection } from "../lib/frSelection";
import { setFrScroll } from "../lib/frScroll";
import { recordFrUsedExtent, resetFrExtents } from "../lib/frExtent";
import {
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  FR_TITLE_H,
  FR_COL_HDR_H,
  frameWidth,
  frameHeight,
} from "../lib/frDimensions";
import { getFloatingRangeById } from "../lib/floatingRangeStore";
import { frContainerOf } from "../lib/frObjectFormat";
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
  name: "Float2",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

const ORIGIN = { x: 150, y: 120 };

function ctxAt(dx: number, dy: number, frId: string = FR_ID): OverlayHitTestContext {
  const entry = getFloatingRangeById(FR_ID)!;
  const width = frameWidth(entry);
  const height = frameHeight(entry);
  const region: GridRegion = {
    id: "fr-" + FR_ID,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width, height },
    data: { frId },
  };
  return {
    region,
    canvasX: ORIGIN.x + dx,
    canvasY: ORIGIN.y + dy,
    row: 0,
    col: 0,
    floatingCanvasBounds: { x: ORIGIN.x, y: ORIGIN.y, width, height },
  };
}

/** Frame-relative centre of local cell (row, col), every strip shown, unscrolled. */
function cellCentre(row: number, col: number): { dx: number; dy: number } {
  return {
    dx: FR_ROW_HDR_W + col * FR_DEFAULT_COL_W + FR_DEFAULT_COL_W / 2,
    dy: FR_TITLE_H + FR_COL_HDR_H + row * FR_DEFAULT_ROW_H + FR_DEFAULT_ROW_H / 2,
  };
}

beforeEach(() => {
  resetFloatingRangeStore();
  resetFrExtents();
  clearLocalSelection();
  upsertFromInfo(INFO);
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrExtents();
  clearLocalSelection();
  vi.restoreAllMocks();
});

describe("frReferenceAt: the cell a pick names", () => {
  it("over every cell: the range's NAME and the local cell", () => {
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        const c = cellCentre(row, col);
        expect(frReferenceAt(ctxAt(c.dx, c.dy)), `(${row},${col})`).toEqual({
          space: "object",
          name: "Float2",
          row,
          col,
        });
      }
    }
  });

  it("the title, the column header, the row header and outside the frame name nothing", () => {
    expect(frReferenceAt(ctxAt(60, 8))).toBeNull(); // title
    expect(frReferenceAt(ctxAt(cellCentre(0, 1).dx, FR_TITLE_H + 4))).toBeNull(); // column header
    expect(frReferenceAt(ctxAt(4, cellCentre(1, 0).dy))).toBeNull(); // row header
    expect(frReferenceAt(ctxAt(-5, cellCentre(1, 0).dy))).toBeNull(); // outside
  });

  it("a SCROLLED range names the scrolled cell, not the window cell", () => {
    // The window is 4 rows; the content reaches row 11. Scrolled by 5 rows the
    // viewport's first cell is (5, 0).
    recordFrUsedExtent(FR_ID, 12, 3);
    setFrScroll(FR_ID, 0, 5 * FR_DEFAULT_ROW_H);
    const c = cellCentre(0, 1);
    expect(frReferenceAt(ctxAt(c.dx, c.dy))).toEqual({ space: "object", name: "Float2", row: 5, col: 1 });
  });

  it("a region whose range is gone, or without bounds, names nothing", () => {
    const c = cellCentre(0, 0);
    expect(frReferenceAt(ctxAt(c.dx, c.dy, "fr-missing"))).toBeNull();
    const noBounds = { ...ctxAt(c.dx, c.dy), floatingCanvasBounds: undefined };
    expect(frReferenceAt(noBounds)).toBeNull();
  });

  it("is PURE: no selection write, no dispatch", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const before = getLocalSelection();
    const c = cellCentre(2, 2);
    frReferenceAt(ctxAt(c.dx, c.dy));
    frReferenceAt(ctxAt(60, 8));
    expect(getLocalSelection()).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("the registration", () => {
  it("registers referenceAt beside zoneAt (one answer per question)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8").replace(/\r\n/g, "\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const block = code.match(/context\.grid\.overlays\.register\(\{[\s\S]*?\}\)/);
    expect(block, "the overlay registration block").not.toBeNull();
    expect(block![0]).toMatch(/type:\s*FLOATING_RANGE_REGION_TYPE/);
    expect(block![0]).toMatch(/zoneAt:\s*frZoneAt/);
    expect(block![0]).toMatch(/referenceAt:\s*frReferenceAt/);
  });
});

describe("frReferenceAt inside a padded container (WP-C S12)", () => {
  const PAD = 12;

  beforeEach(() => {
    upsertFromInfo({ ...INFO, container: { padding: { top: PAD, right: PAD, bottom: PAD, left: PAD } } });
  });

  function padded(dx: number, dy: number) {
    const ctx = ctxAt(dx, dy);
    return { ...ctx, region: { ...ctx.region, container: frContainerOf(getFloatingRangeById(FR_ID)!) } as GridRegion };
  }

  it("the content origin's first cell is A1 of the range: the cell under the pointer, not one off", () => {
    const c = cellCentre(0, 0);
    expect(frReferenceAt(padded(c.dx + PAD, c.dy + PAD))).toEqual({ space: "object", name: "Float2", row: 0, col: 0 });
    // The first pixel of the first cell, right at the content's cell corner.
    expect(frReferenceAt(padded(PAD + FR_ROW_HDR_W + 1, PAD + FR_TITLE_H + FR_COL_HDR_H + 1))).toEqual({
      space: "object",
      name: "Float2",
      row: 0,
      col: 0,
    });
    const c12 = cellCentre(1, 2);
    expect(frReferenceAt(padded(c12.dx + PAD, c12.dy + PAD))).toEqual({ space: "object", name: "Float2", row: 1, col: 2 });
  });

  it("the padding band picks nothing, on every side", () => {
    const e = getFloatingRangeById(FR_ID)!;
    const w = frameWidth(e);
    const h = frameHeight(e);
    expect(frReferenceAt(padded(PAD / 2, h / 2))).toBeNull();
    expect(frReferenceAt(padded(w - PAD / 2, h / 2))).toBeNull();
    expect(frReferenceAt(padded(w / 2, PAD / 2))).toBeNull();
    expect(frReferenceAt(padded(w / 2, h - PAD / 2))).toBeNull();
  });
});
