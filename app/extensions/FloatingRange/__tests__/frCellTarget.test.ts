//! FILENAME: app/extensions/FloatingRange/__tests__/frCellTarget.test.ts
// PURPOSE: The floating grid as a CELL TARGET (P3, owner finding G3):
//          - `bounds` is the grid's CONTENT extent (window grown to the used
//            range), the most a door may act on;
//          - a stale selection (the grid gone from the store, or on another
//            sheet than the one shown) answers null -- never Core's cell;
//          - the selection is the grid's own (local == backing), grown to
//            whole merges, with the ACTIVE cell named and further areas as
//            `additionalRanges`; the object alone is the whole window;
//          - `selectCells` and `editActiveCell` act on the grid's own
//            selection and editor.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => []),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

const editor = { cell: null as { frId: string; row: number; col: number } | null };
const openFrEditor = vi.fn((frId: string, row: number, col: number, _text: string | null) => {
  editor.cell = { frId, row, col };
});
vi.mock("../editor/frEditor", () => ({
  openFrEditor: (frId: string, row: number, col: number, text: string | null) => openFrEditor(frId, row, col, text),
  getFrEditorCell: () => editor.cell,
  isFrEditorOpen: () => editor.cell !== null,
  layoutFrEditorForFrame: vi.fn(),
}));

import { frCellTarget, frEditActiveCell, frSelectCells } from "../lib/frCellTarget";
import { resetFloatingRangeStore, setFrActiveSheetIndex, upsertFromInfo } from "../lib/floatingRangeStore";
import {
  clearLocalSelection,
  deselectAllFloatingRanges,
  getLocalSelection,
  isFloatingRangeSelected,
  selectFloatingRange,
  setLocalSelection,
} from "../lib/frSelection";
import { recordFrUsedExtent, resetFrExtents } from "../lib/frExtent";
import { recordFrCellRead, resetFrRenderCaches } from "../rendering/frRenderer";
import { styledRead } from "./helpers/frStyledRead";

const FR_ID = "fr-target";

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  hiddenRows: [],
  hiddenCols: [],
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

beforeEach(() => {
  editor.cell = null;
  openFrEditor.mockClear();
  resetFloatingRangeStore();
  resetFrExtents();
  resetFrRenderCaches();
  clearLocalSelection();
  deselectAllFloatingRanges();
  upsertFromInfo(INFO);
  setFrActiveSheetIndex(0);
});

afterEach(() => {
  clearLocalSelection();
  deselectAllFloatingRanges();
  resetFloatingRangeStore();
  resetFrRenderCaches();
});

describe("frCellTarget", () => {
  it("bounds = the CONTENT extent: the window until the used range is known, then grown to it", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    expect(frCellTarget()?.bounds).toEqual({ rows: 4, cols: 3 });
    recordFrUsedExtent(FR_ID, 10, 5);
    expect(frCellTarget()?.bounds).toEqual({ rows: 10, cols: 5 });
  });

  it("names the grid by id (the ref the backend resolves) and by its name (the label)", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 1, anchorCol: 2, endRow: 1, endCol: 2 });
    expect(frCellTarget()).toMatchObject({
      ref: { kind: "floatingRange", id: FR_ID },
      label: "Float1",
      wholeObject: false,
      selection: { startRow: 1, startCol: 2, endRow: 1, endCol: 2, activeRow: 1, activeCol: 2, type: "cells" },
    });
  });

  it("a STALE entry gives null: the selection names a grid the store no longer holds", () => {
    setLocalSelection({ frId: "fr-gone", anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    expect(frCellTarget()).toBeNull();
  });

  it("a grid on another sheet than the one shown gives null", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    setFrActiveSheetIndex(3);
    expect(frCellTarget()).toBeNull();
  });

  it("nothing selected gives null", () => {
    expect(frCellTarget()).toBeNull();
  });

  it("the OBJECT alone is the whole WINDOW with A1 active", () => {
    recordFrUsedExtent(FR_ID, 10, 5);
    selectFloatingRange(FR_ID);
    expect(frCellTarget()).toMatchObject({
      wholeObject: true,
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, activeRow: 0, activeCol: 0 },
    });
  });

  it("grows the selection to whole merges, the active cell kept", () => {
    recordFrCellRead(
      FR_ID,
      { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
      styledRead({ startRow: 0, startCol: 0, endRow: 3, endCol: 2 }, () => null, {}, {
        merges: [{ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }],
      }),
    );
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 1, endCol: 1 });
    expect(frCellTarget()?.selection).toMatchObject({
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 2,
      activeRow: 0,
      activeCol: 0,
    });
  });

  it("further areas ride `additionalRanges`, clamped to the extent", () => {
    setLocalSelection({
      frId: FR_ID,
      anchorRow: 0,
      anchorCol: 0,
      endRow: 0,
      endCol: 0,
      areas: [{ startRow: 2, startCol: 1, endRow: 9, endCol: 9 }],
    });
    expect(frCellTarget()?.selection.additionalRanges).toEqual([{ startRow: 2, startCol: 1, endRow: 3, endCol: 2 }]);
  });
});

describe("frSelectCells", () => {
  it("replaces the grid's selection: the active cell is the anchor, the other corner the end, areas kept", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    frSelectCells({
      startRow: 1,
      startCol: 0,
      endRow: 2,
      endCol: 1,
      activeRow: 2,
      activeCol: 1,
      type: "cells",
      additionalRanges: [{ startRow: 3, startCol: 2, endRow: 3, endCol: 2 }],
    });
    expect(getLocalSelection()).toEqual({
      frId: FR_ID,
      anchorRow: 2,
      anchorCol: 1,
      endRow: 1,
      endCol: 0,
      areas: [{ startRow: 3, startCol: 2, endRow: 3, endCol: 2 }],
    });
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
    // And the target reads it back as the same rectangle and active cell.
    expect(frCellTarget()?.selection).toMatchObject({ startRow: 1, startCol: 0, endRow: 2, endCol: 1, activeRow: 2, activeCol: 1 });
  });

  it("with no active cell named, the END is the active cell (Core's rule)", () => {
    selectFloatingRange(FR_ID);
    frSelectCells({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" });
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1, endRow: 0, endCol: 0 });
  });

  it("does nothing while the grid holds no selection", () => {
    frSelectCells({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" });
    expect(getLocalSelection()).toBeNull();
  });
});

describe("frEditActiveCell", () => {
  it("opens the grid's OWN editor on the active cell, seeded, and says so", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 2, anchorCol: 1, endRow: 3, endCol: 1 });
    expect(frEditActiveCell("=SUM(")).toBe(true);
    expect(openFrEditor).toHaveBeenCalledWith(FR_ID, 2, 1, "=SUM(");
  });

  it("refuses with only the object selected (no active cell to edit)", () => {
    selectFloatingRange(FR_ID);
    expect(frEditActiveCell("=")).toBe(false);
    expect(openFrEditor).not.toHaveBeenCalled();
  });
});
